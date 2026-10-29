// fetch-policy: origin-level allow/ask/deny for model-triggered HTTP.
//
// Two enforcement points, one evaluator (deny > allow > default; allows
// merge the config list with the persisted <config-dir>/fetch-policy.json):
//
// 1. The fetch tool: a gate attached on TOOLS_REGISTER (load order puts us
//    after fetch-tool), checked on the request URL and every redirect hop.
// 2. The policy proxy (utils/fetch-policy/proxy.ts): a loopback CONNECT
//    proxy children reach through injected HTTP_PROXY/HTTPS_PROXY. Started
//    lazily on the first getProxyEnv() call (the exec plane / stdio-MCP
//    spawner -- see the env-injection layer). Per-session tokens in the
//    proxy URL attribute connections to a session (grants land in the right
//    memo) and keep unrelated local processes off the relay.
//
// "ask" prompts through the shared process-wide queue: allow once / allow
// origin for session / always allow (persist) / deny. Fail-closed everywhere
// else (no interactive UI, abort, a throwing prompt, empty answer, a proxy
// ask past proxyAskTimeoutMs): block with the reason and the config line
// that would have allowed it. A deny rule has no in-session remedy, ever.
//
// Proxy prompts need a human: the AGENT_TOOL_CONTEXT hook captures the
// input seam (and the run's abort signal) per session while tools run.
//
// Session grants are in-memory, keyed by sessionId, dropped on SESSION_END.
// "Always allow" writes to the state file; a lost write is warned and the
// session grant still stands.
//
// Invalid config fails closed: the tool gate blocks every fetch and the
// proxy (if started) blocks every connect until fixed -- matching user-gate.
//
// This is NOT enforcement: children bypass env vars at will (raw sockets).
// The hard `no-egress` fence tier (--unshare-net, utils/exec-plan.ts) is the
// kernel-enforced layer.

import { join } from "node:path";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HOOKS } from "@core/hooks.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { enqueuePrompt } from "@utils/prompt-queue.ts";
import {
  compileFetchPolicy,
  decideOrigin,
  originOf,
  type Origin,
  type OriginVerdict,
  type FetchPolicyRules,
} from "@utils/fetch-policy/policy.ts";
import {
  FETCH_POLICY_STATE_FILENAME,
  appendAllowEntry,
  readAllowEntries,
} from "@utils/fetch-policy/store.ts";
import { startPolicyProxy, type PolicyProxy, type ProxyAttribution } from "@utils/fetch-policy/proxy.ts";
import {
  getHardEgressProvider,
  getSpawnEnvProvider,
  HARD_EGRESS_PROXY_URL,
  isMcpOwnerSession,
  setHardEgressProvider,
  setSpawnEnvProvider,
  type HardEgressDirective,
} from "@utils/spawn-env.ts";
import { hardEgressProbe, hardEgressRefusal } from "@utils/exec-plan.ts";
import { NETNS_SHIM_ENTRY } from "@core/tool-exec-layout.ts";
import { spoofSafe } from "@utils/spoof.ts";
import { FetchTool, type OriginGate } from "@extensions/fetch-tool/index.ts";
import {
  type CoreContext,
  type ExtensionInstance,
  type HookPayloads,
  type InfoValue,
  type ToolContext,
  type ToolsRegisterPayload,
  getExtensionConfig,
} from "@core/extensions/types.ts";

interface FetchPolicyConfig {
  enabled?: boolean;
  default?: OriginVerdict;
  allow?: string[];
  deny?: string[];
  proxyEnabled?: boolean;
  proxyAskTimeoutMs?: number;
  hardEgress?: boolean;
  hardEgressLoopback?: boolean;
}

/** The question-tool seam: the one route from an extension to the human. */
interface InputLike {
  isInteractive(): boolean;
  /** `signal` is the run's abort: the input bails out of its prompt loop when the run is cancelled. */
  collectAnswers(
    questions: Record<string, unknown>[],
    signal?: AbortSignal | null,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}

const ANSWER_KEY = "approve";
const OPTIONS = ["allow once", "allow origin for session", "always allow (persist)", "deny"];
/** The echoed URL is bounded so one call cannot flood the prompt. */
const MAX_URL_ECHO = 300;
/** Injected NO_PROXY: local dev services stay reachable directly; the
 * policy never sees loopback traffic -- documented gap. */
export const PROXY_NO_PROXY = "127.0.0.1,localhost,::1";

type AskOutcome =
  | { action: "allow"; memo: boolean; persist: boolean }
  | { action: "deny"; reason: string };

/** One pending human decision, from the tool gate or a proxy connect. */
interface ApprovalRequest {
  origin: Origin;
  /** Full URL for tool asks; the origin + context line for proxy asks. */
  echo: string;
  /** True when a child process reached the policy through the proxy. */
  viaProxy: boolean;
  reasons: string[];
  sessionId: string | null;
  input: InputLike | null | undefined;
  signal: AbortSignal | null;
}

function blockText(reasons: string[], hint: string | null): string {
  return [
    `Fetch blocked: ${reasons.join("; ")}`,
    ...(hint ? [hint] : []),
    "Do not re-attempt it. Tell the user what you were trying to do and let them decide.",
  ].join("\n");
}

/** The config line that would have allowed it, for the block text and the prompt hint. */
function ruleHint(originText: string): string {
  return `to persist:  "fetchPolicy": { "allow": [${JSON.stringify(originText)}] }`;
}

/** What the human sees. Spoof-neutralized: URLs are model/external text. */
function approvalPromptText(req: ApprovalRequest): string {
  return spoofSafe(
    [
      req.viaProxy
        ? `Allow this child-process network request? (origin policy proxy; session ${req.sessionId ?? "?"})`
        : `Allow this network request? (origin policy, applied to ${req.origin.origin})`,
      `  url: ${req.echo.length > MAX_URL_ECHO ? `${req.echo.slice(0, MAX_URL_ECHO)}…` : req.echo}`,
      `  why: ${req.reasons.join("; ")}`,
      `  ${ruleHint(req.origin.origin)}`,
    ].join("\n"),
  );
}

/**
 * One ask -> one prompt -> outcome. Never throws: every non-allow is a deny
 * with a reason, including a UI that explodes mid-prompt. Abort-raced so a
 * cancelled run never dangles on the question.
 */
async function askUser(req: ApprovalRequest): Promise<AskOutcome> {
  try {
    if (req.signal?.aborted) return { action: "deny", reason: "cancelled before the prompt" };
    if (!req.input || !req.input.isInteractive()) {
      return {
        action: "deny",
        reason: `no interactive UI to approve '${req.origin.origin}' (${req.reasons.join("; ")})`,
      };
    }

    const question = {
      key: ANSWER_KEY,
      prompt: approvalPromptText(req),
      options: OPTIONS,
      required: true,
      default: "deny",
      allowOther: false,
    };

    const collect = Promise.resolve().then(() => req.input!.collectAnswers([question], req.signal));
    let onAbort: (() => void) | null = null;
    const aborted = req.signal
      ? new Promise<"aborted">((resolve) => {
          onAbort = () => resolve("aborted");
          req.signal!.addEventListener("abort", onAbort, { once: true });
        })
      : null;

    let outcome: unknown;
    try {
      outcome = await (aborted ? Promise.race([collect, aborted]) : collect);
    } finally {
      if (req.signal && onAbort) req.signal.removeEventListener("abort", onAbort);
    }
    if (outcome === "aborted") {
      collect.catch(() => {});
      return { action: "deny", reason: "cancelled while awaiting approval" };
    }

    const answer = String((outcome as Record<string, unknown> | undefined)?.[ANSWER_KEY] ?? "")
      .trim()
      .toLowerCase();
    if (answer === "allow once") return { action: "allow", memo: false, persist: false };
    if (answer === "allow origin for session") return { action: "allow", memo: true, persist: false };
    if (answer === "always allow (persist)") return { action: "allow", memo: true, persist: true };
    return { action: "deny", reason: `user denied (${answer || "no answer"})` };
  } catch (e) {
    return { action: "deny", reason: `approval UI failed, denied: ${formatError(e)}` };
  }
}

/** The run's abort when there is one: the wired tool-context signal first. */
function runSignal(ctx?: ToolContext): AbortSignal | null {
  const fromCtx = ctx?.get?.("abortSignal") as AbortSignal | null | undefined;
  if (fromCtx) return fromCtx;
  const agent = ctx?.get?.("agent") as { runAbortController?: AbortController | null } | null;
  return agent?.runAbortController?.signal ?? null;
}

function sessionIdOf(ctx?: ToolContext): string | null {
  const agent = ctx?.get?.("agent") as { sessionId?: unknown } | undefined;
  return typeof agent?.sessionId === "string" ? agent.sessionId : null;
}

/** Proxy userinfo must not carry ':'/'@'/etc -- unusual ids get hashed (stable per session). */
function proxyUser(sessionId: string): string {
  return /^[A-Za-z0-9._-]+$/.test(sessionId) ? sessionId : `sid-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Loopback shapes an Origin host can carry. */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "[::1]" ||
    h.startsWith("127.") ||
    h.startsWith("[::ffff:127.") ||
    /^::ffff:7f/.test(h)
  );
}

export function create(core: CoreContext): ExtensionInstance {
  const raw = getExtensionConfig<FetchPolicyConfig>(core, "fetchPolicy");
  if (raw.enabled === false) return {};

  const configDir = core.resolved?.configDir;
  const statePath =
    typeof configDir === "string" && configDir !== ""
      ? join(configDir, FETCH_POLICY_STATE_FILENAME)
      : null;
  const persisted = statePath ? readAllowEntries(statePath) : [];
  // hardEgress implies the proxy: the jail's only exit IS the policy proxy
  // (over a unix socket), so "no proxy" is not a state that exists there.
  const hardEgress = raw.hardEgress === true;
  const hardEgressLoopback = raw.hardEgressLoopback === true;
  const proxyEnabled = raw.proxyEnabled !== false || hardEgress;
  // The schema layer resolves proxyAskTimeoutMs for real hosts (default 60s).
  // A hand-built host that resolves none gets NO timeout (absence, not a
  // second default): an unanswered proxy ask then waits on its run's abort.
  const askTimeoutMs =
    typeof raw.proxyAskTimeoutMs === "number" && raw.proxyAskTimeoutMs > 0 ? raw.proxyAskTimeoutMs : 0;

  /**
   * In-memory only: grants die with the process (persisted ones live in the
   * state file). Keyed by sessionId -- one process serves many webui/ws
   * sessions, and a grant made in one must not silence prompts in another.
   * No sessionId means no memo: "for session" degrades to "once".
   */
  const sessionGrants = new Map<string, Set<string>>();
  /** The input seam + run signal per session, captured while any tool runs. */
  const liveContexts = new Map<string, { input: InputLike | null; signal: AbortSignal | null }>();
  /** proxyUser -> { sessionId, token }. Issued on first getProxyEnv per session. */
  const proxyAuth = new Map<string, { sessionId: string; token: string }>();
  /**
   * Hard egress tier: owner id -> its policy-proxy UNIX socket path. The
   * socket IS the attribution (a jailed process can only see its own bind
   * mount / its own bridge), so no token rides the wire.
   */
  const hardSockets = new Map<string, string>();
  let hardSocketDir: string | null = null;
  /**
   * Most recently captured live session, used only as the prompt route for
   * children with no session of their own (stdio MCP servers boot at
   * extension load). Grants never ride it -- the memo stays keyed by the
   * child's own attribution id.
   */
  let lastLiveSessionId: string | null = null;
  let proxyPromise: Promise<PolicyProxy> | null = null;
  let proxyInstance: PolicyProxy | null = null;

  let gate: OriginGate;
  let admit: (origin: Origin, attribution: ProxyAttribution) => Promise<string | null>;
  let posture: Array<{ key: string; value: InfoValue }>;

  // -- shared ask machinery (tool gate + proxy accept the same shape) --------

  function granted(sid: string | null, key: string): boolean {
    return sid !== null && sessionGrants.get(sid)?.has(key) === true;
  }

  function remember(sid: string | null, key: string): void {
    if (sid === null) return;
    let mine = sessionGrants.get(sid);
    if (!mine) {
      mine = new Set();
      sessionGrants.set(sid, mine);
    }
    mine.add(key);
  }

  async function persistGrant(originText: string): Promise<void> {
    if (statePath === null) {
      logger.warn(
        `[fetch-policy] no config dir -- "always allow" for ${originText} stands for this session only`,
      );
      return;
    }
    try {
      await appendAllowEntry(statePath, originText, "approved in prompt");
    } catch (e) {
      logger.warn(
        `[fetch-policy] could not persist ${originText} (${formatError(e)}) -- the grant stands for this session`,
      );
    }
  }

  /** Memo -> (queue: memo re-check, prompt) -> grant bookkeeping. */
  async function approveRequest(req: ApprovalRequest): Promise<{ ok: true } | { ok: false; reason: string }> {
    const key = req.origin.origin;
    if (granted(req.sessionId, key)) return { ok: true };
    const outcome = await enqueuePrompt(async () => {
      // Re-check the memo at the head of the queue: a prompt queued ahead of
      // this one may already have granted this origin.
      if (granted(req.sessionId, key)) return { action: "allow", memo: true, persist: false } as AskOutcome;
      return askUser(req);
    });
    if (outcome.action === "deny") return { ok: false, reason: outcome.reason };
    if (outcome.memo || outcome.persist) remember(req.sessionId, key);
    if (outcome.persist) await persistGrant(key);
    const how = outcome.persist ? " (persisted)" : outcome.memo ? " for session" : " once";
    logger.info(`[fetch-policy] allowed${how}: ${key}${req.viaProxy ? " (child via proxy)" : ""}`);
    return { ok: true };
  }

  async function decideAndMaybeAsk(
    origin: Origin,
    echo: string,
    viaProxy: boolean,
    sessionId: string | null,
    input: InputLike | null | undefined,
    signal: AbortSignal | null,
    rules: FetchPolicyRules,
  ): Promise<string | null> {
    const decision = decideOrigin(origin, rules);
    if (decision.verdict === "allow") return null;
    if (decision.verdict === "deny") {
      logger.info(`[fetch-policy] deny: ${decision.reasons.join("; ")}`);
      return blockText(
        decision.reasons,
        "A fetchPolicy deny rule cannot be overridden mid-run; edit fetchPolicy.deny to change that.",
      );
    }
    let outcome = await approveRequest({ origin, echo, viaProxy, reasons: decision.reasons, sessionId, input, signal });
    return outcome.ok ? null : blockText([outcome.reason], ruleHint(origin.origin));
  }

  try {
    const rules = compileFetchPolicy({
      // The schema layer guarantees a default; hand-built hosts get the same one.
      default: raw.default ?? "ask",
      allow: [...persisted.map((e) => e.origin), ...(raw.allow ?? [])],
      deny: raw.deny ?? [],
    });
    posture = [
      { key: "default", value: rules.default },
      { key: "allowRules", value: (raw.allow ?? []).length },
      { key: "persistedAllows", value: persisted.length },
      { key: "denyRules", value: rules.deny.length },
      { key: "stateFile", value: statePath ?? "(no config dir -- approvals not persistable)" },
    ];

    gate = async (url: string, ctx?: ToolContext): Promise<string | null> => {
      const origin = originOf(url);
      if (!origin) {
        return blockText([`could not determine an origin from '${url}'`], null);
      }
      return decideAndMaybeAsk(
        origin,
        url,
        false,
        sessionIdOf(ctx),
        (ctx?.get?.("input") as InputLike | undefined) ?? null,
        runSignal(ctx),
        rules,
      );
    };

    admit = async (origin: Origin, attribution: ProxyAttribution): Promise<string | null> => {
      // Hard egress tier: under the jail there is no host loopback to leak
      // to, so a loopback destination is either refused outright (default --
      // "hard means hard") or joins the normal flow when the operator opted
      // in. This gate exists because the injected NO_PROXY is empty in hard
      // mode: loopback connects genuinely arrive, and they are policy.
      if (hardEgress && isLoopbackHost(origin.host) && !hardEgressLoopback) {
        return blockText(
          [`loopback destination ${origin.origin} is out of policy while fetchPolicy.hardEgress is on (no host loopback exists through the jail)`],
          'to make loopback connects ask like any origin:  "fetchPolicy": { "hardEgressLoopback": true }',
        );
      }
      // An MCP-attributed child has no session of its own (the server booted
      // before any run existed), so its prompt goes to whichever session's UI
      // is live -- and nowhere, failing closed, when none is. The grant memo
      // still keys on the child's own id: a human approving in session A does
      // not silence prompts for session B's sessions, only for this server.
      const live =
        liveContexts.get(attribution.sessionId) ??
        (isMcpOwnerSession(attribution.sessionId) && lastLiveSessionId !== null
          ? liveContexts.get(lastLiveSessionId)
          : undefined);
      // Two abort sources for a proxy ask: the proxy ask timeout, and the
      // captured run signal (a cancelled run must not hang the child).
      const controller = new AbortController();
      let timedOut = false;
      const timer =
        askTimeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, askTimeoutMs)
          : null;
      try {
        const signal = live?.signal ? AbortSignal.any([live.signal, controller.signal]) : controller.signal;
        const blocked = await decideAndMaybeAsk(
          origin,
          `${origin.origin} (connect from a child process)`,
          true,
          attribution.sessionId,
          live?.input ?? null,
          signal,
          rules,
        );
        if (blocked !== null && timedOut) {
          return blockText([`approval timed out after ${askTimeoutMs}ms`], ruleHint(origin.origin));
        }
        return blocked;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
  } catch (e) {
    // Malformed config blocks every fetch AND every proxied connect (and
    // says why) rather than running an audit trail of a policy nobody
    // configured right.
    const why = formatError(e);
    logger.error(`[fetch-policy] invalid fetchPolicy config: ${why}`);
    posture = [{ key: "config", value: `INVALID: ${why}` }];
    gate = async () => blockText([`the fetchPolicy config is invalid (${why})`], null);
    admit = async () => blockText([`the fetchPolicy config is invalid (${why})`], null);
  }

  // -- proxy plumbing --------------------------------------------------------

  function authenticateForProxy(user: string, pass: string): ProxyAttribution | null {
    const entry = proxyAuth.get(user);
    if (!entry || !constantTimeEquals(entry.token, pass)) return null;
    return { sessionId: entry.sessionId, kind: "connect" };
  }

  /** Hard tier lane: WHICH unix socket a connection arrived on is HALF the
   * attribution; the other half is the per-owner token in the usual Basic
   * header. Same-uid processes (an unsandboxed MCP server) can discover and
   * connect to another session's socket -- without that session's token the
   * pair never matches, and borrowing stays impossible. */
  function authenticateUnixSocket(localPath: string): ProxyAttribution | null {
    for (const [sessionId, path] of hardSockets) {
      if (path === localPath) return { sessionId, kind: "connect" };
    }
    return null;
  }

  async function ensureProxy(): Promise<PolicyProxy> {
    if (!proxyPromise) {
      proxyPromise = startPolicyProxy({
        authenticate: authenticateForProxy,
        authenticateUnixSocket,
        admit,
      }).then((p) => {
        proxyInstance = p;
        logger.info(`[fetch-policy] proxy listening on 127.0.0.1:${p.port} (loopback, token-authenticated)`);
        return p;
      });
    }
    return proxyPromise;
  }

  /**
   * Proxy env vars for a session's spawned children (inline bash, the tool-exec
   * plane, stdio MCP servers). The URL embeds the session user + a random
   * token: attribution for grants, and no open relay for local processes.
   * Returns null only when the proxy is disabled -- which is also the operator's
   * opt-out for a machine that already has its own proxy (this relay dials
   * origins directly; it does not chain upstream proxies).
   */
  async function resolveProxyEnv(sessionId: string): Promise<Record<string, string> | null> {
    if (hardEgress) {
      // The hard posture answers with the JAIL url (token AND socket both
      // attribute: see authenticateUnixSocket) or refuses. Handing out the
      // cooperative loopback-TCP URL while claiming the hard tier would be
      // the fail-open this layer is named for.
      if (hardEgressProbe(NETNS_SHIM_ENTRY) === null) {
        throw new Error(hardEgressRefusal());
      }
      await ensureProxy();
      const user = proxyUser(sessionId);
      let entry = proxyAuth.get(user);
      if (!entry) {
        entry = { sessionId, token: randomBytes(24).toString("base64url") };
        proxyAuth.set(user, entry);
      }
      const jailUrl = `http://${user}:${entry.token}@${HARD_EGRESS_PROXY_URL.slice("http://".length)}`;
      return {
        HTTP_PROXY: jailUrl,
        HTTPS_PROXY: jailUrl,
        ALL_PROXY: jailUrl,
        http_proxy: jailUrl,
        https_proxy: jailUrl,
        all_proxy: jailUrl,
        // Empty on purpose: loopback goes THROUGH the policy too (see the
        // admit() loopback gate). The cooperative NO_PROXY gap closes here.
        NO_PROXY: "",
        no_proxy: "",
      };
    }
    if (!proxyEnabled) return null;
    const proxy = await ensureProxy();
    const user = proxyUser(sessionId);
    let entry = proxyAuth.get(user);
    if (!entry) {
      entry = { sessionId, token: randomBytes(24).toString("base64url") };
      proxyAuth.set(user, entry);
    }
    const proxyUrl = `http://${user}:${entry.token}@127.0.0.1:${proxy.port}`;
    return {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      all_proxy: proxyUrl,
      NO_PROXY: PROXY_NO_PROXY,
      no_proxy: PROXY_NO_PROXY,
    };
  }

  /**
   * Hard egress directive for one owner id (session or `mcp:<server>`):
   * refuses when the shim cannot run here, otherwise ensures the owner's
   * policy-proxy unix socket and hands back its host path (the supervisor
   * bind-mounts it into the jail / bridges it for MCP servers).
   */
  async function resolveHardEgress(sessionId: string): Promise<HardEgressDirective | null> {
    if (!hardEgress) return null;
    if (hardEgressProbe(NETNS_SHIM_ENTRY) === null) {
      throw new Error(hardEgressRefusal());
    }
    const proxy = await ensureProxy();
    let path = hardSockets.get(sessionId);
    if (!path) {
      if (hardSocketDir === null) {
        hardSocketDir = mkdtempSync(join(tmpdir(), "hotdog-policy-")); // 0700
      }
      const safe = /^[A-Za-z0-9._-]+$/.test(sessionId)
        ? sessionId
        : `sid-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
      path = join(hardSocketDir, `${safe}.sock`);
      await proxy.listenUnix(path);
      hardSockets.set(sessionId, path);
    }
    return { socketPath: path, strict: true };
  }

  // The one route from a spawner to this policy: every child process hotdog
  // starts asks the spawn-env seam, and gets these vars merged last.
  setSpawnEnvProvider(resolveProxyEnv);
  // The hard tier's directive (null when off): the supervisor plans the netns
  // fence from it, and its refusal is fatal to the spawn either way.
  setHardEgressProvider(resolveHardEgress);

  return {
    getProxyEnv: resolveProxyEnv,

    hooks: {
      [HOOKS.TOOLS_REGISTER]: (payload: ToolsRegisterPayload) => {
        for (const [name, tool] of payload.getAll()) {
          if (name === FetchTool.TOOL_NAME && tool instanceof FetchTool) {
            tool.setOriginGate(gate);
          }
        }
      },
      // The proxy has no tool context of its own: while ANY tool runs for a
      // session, we learn that session's input seam (and run signal), so a
      // CONNECT from a child process can ask the human.
      [HOOKS.AGENT_TOOL_CONTEXT]: ({ toolCtx, agent }: HookPayloads["agent:toolContext"]) => {
        const sid = (agent as { sessionId?: unknown } | undefined)?.sessionId;
        if (typeof sid !== "string") return;
        liveContexts.set(sid, {
          input: (toolCtx?.get?.("input") as InputLike | null) ?? null,
          signal: (toolCtx?.get?.("abortSignal") as AbortSignal | null) ?? null,
        });
        lastLiveSessionId = sid;
      },
      // Dead sessions keep neither grants, contexts, nor relay tokens.
      [HOOKS.SESSION_END]: ({ sessionId }: { sessionId: string }) => {
        sessionGrants.delete(sessionId);
        liveContexts.delete(sessionId);
        if (lastLiveSessionId === sessionId) lastLiveSessionId = null;
        for (const [user, entry] of proxyAuth) {
          if (entry.sessionId === sessionId) proxyAuth.delete(user);
        }
        // The hard tier's socket dies with its session (in-flight tunnels
        // finish; new connects 403 because the attribution entry is gone).
        const hardPath = hardSockets.get(sessionId);
        if (hardPath !== undefined) {
          hardSockets.delete(sessionId);
          try {
            unlinkSync(hardPath);
          } catch {
            // already gone
          }
        }
      },
    },

    shutdown: async () => {
      if (getSpawnEnvProvider() === resolveProxyEnv) setSpawnEnvProvider(null);
      if (getHardEgressProvider() === resolveHardEgress) setHardEgressProvider(null);
      if (proxyInstance) await proxyInstance.stop();
      if (hardSocketDir !== null) {
        try {
          rmSync(hardSocketDir, { recursive: true, force: true });
        } catch {
          // tmp policy
        }
        hardSocketDir = null;
      }
    },

    infoPanel: () => ({
      name: "fetch-policy",
      sections: [
        {
          fields: [
        ...posture,
        { key: "proxy", value: proxyEnabled ? (proxyInstance ? `127.0.0.1:${proxyInstance.port}` : "on demand") : "disabled" },
        ...(hardEgress
          ? [
              {
                key: "hardEgress",
                value:
                  hardEgressProbe(NETNS_SHIM_ENTRY) !== null
                    ? `armed (jail exit ${HARD_EGRESS_PROXY_URL}; loopback ${hardEgressLoopback ? "asks" : "denied"})`
                    : "UNAVAILABLE -- children refused (no userns/bwrap jail here)",
              },
            ]
          : []),
      ],
        },
      ],
    }),
  };
}
