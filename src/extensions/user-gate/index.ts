// user-gate: tool-call approvals, ABOVE the spawn boundary.
//
// One TOOL_CALL hook: decide -> (session memo) -> ask -> allow (no opinion,
// no verdict adopted) or block.
// This decides whether a call runs at all -- once a process is spawned there is no mediation inside it.
// This is NOT enforcement: the bash triage it builds on has a documented bail list, and the answer to
// "can a determined model get around this?" is yes.
//
// Fail-closed: no seam, a non-interactive UI, a throwing/rejecting prompt, an abort, or an empty
// answer all become an explicit block carrying the reason and the config line that would have allowed it.
// The handler never throws (TOOL_CALL pipeline is failOnError, throwing would surface as an execution error instead of a clean denial).
//
// Prompts are queued one-at-a-time process-wide: parallel tool calls ask in turn, so only one question is ever live in the UI.
//
// "Always allow" is a per-session memo (tool + required target values, keyed by
// payload.agent.sessionId) plus a printed config line. Nothing is ever written to config from here.

import { HOOKS, type GateAction } from "@core/hooks.ts";
import {
  CoreContext,
  ExtensionInstance,
  getExtensionConfig,
} from "@core/extensions/types.ts";
import type { HookPayloads } from "@core/extensions/types.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import {
  compileApprovalRules,
  decide,
  type ApprovalCall,
  type ApprovalRules,
  type UserGateConfig,
} from "@utils/approvals/rules.ts";
import { extractTargets, suggestRuleLine } from "@utils/approvals/index.ts";
import { spoofSafe } from "@utils/spoof.ts";

type ToolCallPayload = HookPayloads["tool:call"];

/** The question-tool seam: the one route from an extension to the human. */
interface InputLike {
  isInteractive(): boolean;
  /** `signal` is the run's abort: the input bails out of its prompt loop and releases readline when the run is cancelled. */
  collectAnswers(
    questions: Record<string, unknown>[],
    signal?: AbortSignal | null,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}

const ANSWER_KEY = "approve";
const OPTIONS = ["allow once", "allow for session", "deny"];
/** Args are echoed to the human, bounded so one call can't flood the prompt. */
const MAX_ARGS_ECHO = 400;

/** How the human answered an ask. */
type AskOutcome =
  | { action: "allow"; session: boolean }
  | { action: "deny"; reason: string };

/**
 * Process-wide one-at-a-time prompt queue. Anything that decides to prompt
 * (any session, any parallel tool call) takes its turn here, so the UI never
 * has two live questions.
 */
let queueTail: Promise<unknown> = Promise.resolve();

export function enqueuePrompt<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => {});
  return run;
}

/** Parse the call's JSON arguments; a bail reason on anything else. */
function parseToolArgs(
  input: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    return { ok: false, reason: `tool arguments are not valid JSON (${formatError(e)})` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "tool arguments are not a JSON object" };
  }
  return { ok: true, args: parsed as Record<string, unknown> };
}

/**
 * Key for the session memo: the tool plus EVERY extracted value. Deliberately
 * stricter than "the values that needed allowing" -- an allow for
 * `git status` must not silently cover `git push origin main` just because
 * both are covered by one `bash.cmd=git` rule.
 */
function memoKey(call: ApprovalCall): string {
  const parts = call.targets.map((t) => `${t.param}=${t.value}`).sort();
  return `${call.tool}\u0000${parts.join("\u0001")}`;
}

/** What the human sees. Bounded, and always ends with the persistence hint. */
function approvalPromptText(call: ApprovalCall, reasons: string[], argsEcho: string): string {
  const targets = call.targets
    .filter((t) => !t.denyOnly)
    .slice(0, 6)
    .map((t) => `${t.param}: ${t.value}`);
  const lines = [
    `Approve this tool call? (${call.tool})`,
    `  args: ${argsEcho.length > MAX_ARGS_ECHO ? `${argsEcho.slice(0, MAX_ARGS_ECHO)}…` : argsEcho}`,
  ];
  if (targets.length > 0) lines.push(`  targets: ${targets.join(" | ")}`);
  lines.push(`  why: ${reasons.join("; ")}`);
  lines.push(`  ${suggestRuleLine(call)}`);
  return spoofSafe(lines.join("\n"));
}

/**
 * One ask -> one prompt -> allow/deny. Never throws: every non-allow is a deny
 * with a reason, including a UI that explodes mid-prompt.
 */
async function askUser(
  call: ApprovalCall,
  reasons: string[],
  argsEcho: string,
  input: InputLike | null | undefined,
  signal: AbortSignal | null,
): Promise<AskOutcome> {
  try {
    if (signal?.aborted) return { action: "deny", reason: "cancelled before the prompt" };
    if (!input || !input.isInteractive()) {
      return { action: "deny", reason: `no interactive UI to approve ${call.tool} (${reasons.join("; ")})` };
    }

    const question = {
      key: ANSWER_KEY,
      prompt: approvalPromptText(call, reasons, argsEcho),
      options: OPTIONS,
      required: true,
      default: "deny",
      allowOther: false,
    };

    const collect = Promise.resolve().then(() => input.collectAnswers([question], signal));
    // A prompt nobody will answer (run cancelled) must resolve toward deny
    // rather than dangle: race the agent's run abort.
    let onAbort: (() => void) | null = null;
    const aborted = signal
      ? new Promise<"aborted">((resolve) => {
          onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : null;

    let outcome: unknown;
    try {
      outcome = await (aborted ? Promise.race([collect, aborted]) : collect);
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
    if (outcome === "aborted") {
      collect.catch(() => {});
      return { action: "deny", reason: "cancelled while awaiting approval" };
    }

    const answer = String((outcome as Record<string, unknown> | undefined)?.[ANSWER_KEY] ?? "")
      .trim()
      .toLowerCase();
    if (answer === "allow once") return { action: "allow", session: false };
    if (answer === "allow for session") return { action: "allow", session: true };
    return { action: "deny", reason: `user denied (${answer || "no answer"})` };
  } catch (e) {
    return { action: "deny", reason: `approval UI failed, denied: ${formatError(e)}` };
  }
}

function blockText(reasons: string[], hint: string | null): string {
  return [
    `Tool call blocked: ${reasons.join("; ")}`,
    ...(hint ? [hint] : []),
    "Do not re-attempt it. Tell the user what you were trying to do and let them decide.",
  ].join("\n");
}

/** The agent's per-run abort, when there is one (null in standalone callers). */
function runSignal(agent: unknown): AbortSignal | null {
  const controller = (agent as { runAbortController?: AbortController | null } | null)?.runAbortController;
  return controller?.signal ?? null;
}

export function create(core: CoreContext): ExtensionInstance {
  const raw = getExtensionConfig<UserGateConfig>(core, "userGate");
  // OFF by default: with `default: "ask"` an on-by-default gate would prompt
  // every existing user on every tool call.
  if (raw.enabled !== true) return {};

  let rules: ApprovalRules;
  try {
    rules = compileApprovalRules(raw);
  } catch (e) {
    // A malformed rule must not be silently dropped, and must not fail open:
    // every call is blocked until the config is fixed or the gate is disabled.
    const why = formatError(e);
    logger.error(`[user-gate] invalid userGate config: ${why}`);
    return {
      hooks: {
        [HOOKS.TOOL_CALL]: (): GateAction => ({
          action: "block",
          result: blockText([`the userGate config is invalid (${why})`], null),
        }),
      },
    };
  }

  /**
   * In-memory only: allows die with the process, by design.
   * Keyed by the requesting agent's sessionId: one process serves many webui/ws
   * sessions, and a grant made while talking to one of them must not silence
   * prompts in another. A call with no session id gets no memo (fail toward
   * prompting: "allow for session" degrades to "allow once").
   */
  const sessionGrants = new Map<string, Set<string>>();

  const handler = async (payload: ToolCallPayload): Promise<GateAction | undefined> => {
    try {
      const parsedArgs = parseToolArgs(payload.input);
      const workspace = payload.toolCtx?.get("workspace");
      let call: ApprovalCall;
      if (!parsedArgs.ok) {
        call = { tool: payload.toolName, recognized: false, targets: [], bailReason: parsedArgs.reason };
      } else if (!workspace) {
        call = {
          tool: payload.toolName,
          recognized: false,
          targets: [],
          bailReason: "no workspace on the tool context",
        };
      } else {
        call = extractTargets(payload.toolName, parsedArgs.args, workspace, rules);
      }

      const decision = decide(call, rules);
      // Allow returns NOTHING (no-opinion), matching how file-watch defers:
      // an explicit `{ action: "continue" }` is still adopted onto the
      // payload and rewrites an earlier handler's verdict record. With the
      // gate's shouldStop a returned block/handled can no longer be
      // disarmed, but the no-opinion form stays the correct allow shape --
      // the gate never claims a verdict it did not make.
      if (decision.verdict === "allow") return;
      if (decision.verdict === "deny") {
        logger.info(`[user-gate] deny: ${decision.reasons.join("; ")}`);
        // A deny rule has no in-session remedy, and saying so stops the model
        // negotiating. A default-deny block DOES have one: the allow-list line
        // that would have matched, which is what makes an allowlist-only run
        // (nobody at the keyboard) debuggable from its own transcript.
        const hint =
          decision.deniedBy === "default"
            ? suggestRuleLine(call)
            : "A deny rule cannot be overridden mid-run; edit userGate.deny to change that.";
        return { action: "block", result: blockText(decision.reasons, hint) };
      }

      const key = memoKey(call);
      const rawSessionId = (payload.agent as { sessionId?: unknown } | undefined)?.sessionId;
      const grantKey = typeof rawSessionId === "string" ? rawSessionId : null;
      if (grantKey !== null && sessionGrants.get(grantKey)?.has(key)) return;

      const outcome = await enqueuePrompt(() =>
        askUser(
          call,
          decision.reasons,
          payload.input,
          (payload.toolCtx?.get("input") as InputLike | undefined) ?? null,
          runSignal(payload.agent),
        ),
      );

      if (outcome.action === "allow") {
        // Without a session to remember by, "allow for session" degrades to
        // "allow once" -- and the log line says what actually happened.
        const remembered = outcome.session && grantKey !== null;
        if (remembered) {
          let mine = sessionGrants.get(grantKey);
          if (!mine) {
            mine = new Set();
            sessionGrants.set(grantKey, mine);
          }
          mine.add(key);
        }
        const what = call.bailReason ? "(unparsed call)" : key.split("\u0000")[1] || "it";
        logger.info(
          `[user-gate] allowed${remembered ? " for session" : " once"}: ${payload.toolName} ${what}\n  ${suggestRuleLine(call)}`,
        );
        return;
      }

      logger.info(`[user-gate] deny: ${outcome.reason}`);
      return { action: "block", result: blockText([outcome.reason], suggestRuleLine(call)) };
    } catch (e) {
      // Belt and braces: the handler must never throw into a failOnError hook
      // pipeline, or the denial reads as a tool crash instead of a denial.
      return {
        action: "block",
        result: blockText([`the approvals layer failed (${formatError(e)})`], null),
      };
    }
  };

  return {
    hooks: {
      [HOOKS.TOOL_CALL]: handler,
      // A dead session must not keep its grants alive forever: in a 24/7
      // host (webui/ws) sessionGrants would grow with every session that
      // ever said "allow for session". Fires on session delete and on task
      // agent teardown (same reclaim hook file-watch/loop-detect use); the
      // grants are in-memory-only anyway, so dropping them only forgets
      // what could never be honoured again.
      [HOOKS.SESSION_END]: ({ sessionId }: { sessionId: string }) => {
        sessionGrants.delete(sessionId);
      },
    },
  };
}
