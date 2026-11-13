/**
 * tests/core/config-live/probes.ts -- the canonical liveness probe table
 * (design §4.5 item 1, §9 test 1 SHAPE), seeded with B4's keys: the §3.3 rows
 * this batch migrates. A probe names the writable keyPath, the write payload,
 * and the OBSERVABLE that must reflect the new value with NO restart -- the
 * transaction runs for real (applyConfigKeyEdit over an injected
 * ConfigEditDeps against a temp config dir, through the store), and a key
 * whose probe shows no change IS a stale copy, by construction.
 *
 * Writable-key honesty (b4-notes): the file/writable spelling and the
 * resolved root differ where the schema resolves under an alias -- the file
 * member is `aiUrl` (resolved `baseUrl`), `chatTimeoutSecs` (resolved
 * `chatTimeout`) -- so the probe rows name what a panel/script would WRITE,
 * and the §3.3 hooks match the RESOLVED roots that those writes move.
 *
 * The providerHealthCheckIntervalSecs row's observable is the sweep CADENCE
 * (timer-driven), and driving a 60s-scale interval from a test would be
 * theater, so B4 left the row out and pinned the cadence seam at its own
 * level (tests/core/provider-health.test.ts: stop+recreate arms a real
 * interval that probes; 0 disables; the failure-driven markDown/noteUp
 * doctrine stays reachable in every state). B7 turns on the §4.5-3 honesty
 * walk -- EVERY registered apply hook must appear in a probe -- so the row is
 * back: it does not wait for a tick, it watches the RE-ARM itself (the timer
 * write the hook performs), which is exactly what a stale capture would
 * prevent. tests/core/provider-health.test.ts remains the behavior proof of
 * the seam underneath it.
 *
 * ── B7 additions (this file now carries three tables) ──────────────────────
 *  PROBES        B4's transaction-driven rows (unchanged semantics) plus the
 *                four shared-client fields and the health-sweep row the
 *                honesty walk needs. Each row names the hook keyPaths it
 *                covers (§4.5-3) in `hooks`.
 *  FAMILY_PROBES every key the train migrated (B3 sites, B6a core-tools +
 *                bash, B6b's five families, B7's skills/prompts/agentsMd/
 *                workflows), each with its own live host booted through the
 *                shared store harness. Mutation goes through the REAL store
 *                swap (the same publish path the transaction uses; the file
 *                + hook chain of the full transaction is what PROBES and
 *                transaction.test.ts cover). A row whose observable does not
 *                move IS a stale copy, by construction.
 *  Row `observe` may be async; where a key's honest observable is a real
 *  elapsed-time behavior (a spawn timeout, an armed question timer) the row
 *  waits the milliseconds that behavior needs -- no clock theater.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { TMP_PARENT } from "../../mocks/io.ts";
import { getDefaultConfig } from "@core/config/index.ts";
import { createConfigStore, type ConfigStore } from "@core/config/store.ts";
import { createCore, type CoreInfrastructure } from "@core/main.ts";
import { createSubcommandRegistry } from "@core/extensions/registries.ts";
import type { ResolvedConfig } from "@core/extensions/types.ts";
import type { ConfigEditDeps } from "@extensions/websocket/handlers-config.ts";
import { createWsServer, type WsServer } from "@extensions/websocket/server.ts";
import { sharedExecFenceDisplay } from "@core/tool-exec-broker.ts";
import type { ConfigKeyEditInput } from "@extensions/websocket/handlers-config.ts";

/** Env vars whose set values would shadow the file's resolution chain and
 *  make a probe prove nothing. Deleted around every transaction run, restored
 *  after (the chain the probe tests is file -> resolved -> hook). */
const SHADOWING_ENV = [
  "AI_URL",
  "HOTDOG_AI_URL",
  "AI_API_KEY",
  "HOTDOG_API_KEY",
  "HOTDOG_HOOK_TRACE",
  "HOTDOG_MODEL",
  "AI_MODEL",
  "HOTDOG_CONFIG_DIR",
  "HOTDOG_STT_URL",
  "HOTDOG_STT_MODEL",
] as const;

export async function withShadowEnvCleared<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const k of SHADOWING_ENV) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Real-fs ConfigEditDeps over the temp dir (the house seam; no mock.module). */
export const fsDeps: ConfigEditDeps = {
  readFile: (p) => readFile(p, "utf-8"),
  writeFile: (p, data) => writeFile(p, data, "utf-8"),
  rename: (from, to) => rename(from, to),
  unlink: (p) => unlink(p),
};

/** Schema mirror of the REAL websocket extension entry (the same shape the
 *  setkey suite mirrors) -- gives the write gate and the re-resolve's
 *  extension tail something to resolve/validate against. */
const WEBSOCKET_ENTRY = {
  key: "websocket",
  description: "websocket config",
  defaults: {},
  schema: {
    type: "object",
    properties: {
      sessionTimeoutMin: { type: "number", default: 30, description: "Idle session cleanup timeout (minutes)" },
      questionTimeoutSecs: { type: "number", default: 300, description: "Default question timeout (seconds)" },
    },
    layers: [{ source: "config", key: "websocket" }, { default: {} }],
  },
  layers: [{ source: "config", key: "websocket" }, { default: {} }],
};

function fakeRegistry(): never {
  return {
    getConfigParams: () => [WEBSOCKET_ENTRY],
    getCliFlags: () => [],
    getConfigParamsRaw: () => [WEBSOCKET_ENTRY],
    // getExtensionConfig validates the block it hands an extension. This
    // harness mirrors no extension schema beyond `websocket`, so the answer is
    // "accepted": the write gate's own value checks and whatever the extension
    // compiles (user-gate compiles its rules and fails loudly) stay the real
    // validators on every path these suites exercise.
    validateConfigByKey: () => ({ valid: true, errors: [] as string[] }),
  } as never;
}

/** One provider element in the seed file, fresh-copied into each bag: the
 *  provider-list rows need a real element to point at, and the honest writable
 *  spelling for them is the scalar child `providers[0].url` (a whole-array
 *  write is a container write through the file gate). `fetchModels` stays
 *  unset so no probe row reaches the network. Both bags MUST agree: the
 *  resolution chain passes the file's provider array through untouched, and a
 *  boot value that disagrees with the re-resolve reads as CHANGED on every
 *  unrelated write -- firing any hook registered on that root. */
const seedProviders = () => [{ name: "seedcard", url: "http://seed.invalid/v1" }];

/** Hand-built boot resolved bag (the config-store/config-live suites build
 *  theirs the same way; the boot pipeline that WOULD produce it needs the
 *  network half this batch keeps off every path but real boot). Values mirror
 *  seedFile() so boot-state assertions read honestly. */
export function bootResolved(dir: string, over: Record<string, unknown> = {}): ResolvedConfig {
  return {
    configDir: dir,
    modelRegistry: {}, // mutable identity #1: the re-resolve must carry THIS object forward
    baseUrl: "http://boot.invalid/v1",
    apiKey: "boot-key",
    hookTrace: false,
    chatTimeout: 600,
    healthCheckTimeout: 5,
    streamIdleTimeout: 240,
    maxRetries: 5,
    modelWireFormat: "xml",
    modelRoleMapping: "system-first",
    providerHealthCheckIntervalSecs: 30,
    model: "boot/model",
    maxIterations: 50,
    contextLimit: 128000,
    profilesPath: join(dir, "profiles"),
    profileBody: "",
    profileName: "default",
    workspaceRoots: [dir],
    workspaceDeny: [],
    // Each of these MUST agree with what the seed file resolves to: the first
    // publish of a harness host diffs the whole bag against the re-resolve, and
    // a root that differs here shows up as CHANGED on every unrelated write --
    // firing any apply hook registered on that root. toolExec "inline" was the
    // stale one (the schema default the file resolves is "worker").
    toolExec: "worker",
    execFence: "probe",
    sttUrl: null,
    sttModel: null,
    ...over,
  } as unknown as ResolvedConfig;
}

/** The pure-JSON seed file (loadConfig is strict JSON.parse -- no JSONC here). */
export function seedFile(): Record<string, unknown> {
  return {
    aiUrl: "http://boot.invalid/v1",
    // Agent construction needs a non-empty resolved model after ANY publish
    // (the re-resolve recomputes it from the file); keep one in the chain.
    defaultModel: "boot/m1",
    apiKey: "boot-key",
    hookTrace: false,
    chatTimeoutSecs: 600,
    healthCheckTimeoutSecs: 5,
    streamIdleTimeoutSecs: 240,
    maxRetries: 5,
    modelWireFormat: "xml",
    providerHealthCheckIntervalSecs: 30,
    // The provider list is a config-bag passthrough key (the resolution chain
    // reads it but never copies it into the resolved bag), so this element is
    // the boot truth the provider-list rows diff against.
    providers: seedProviders(),
    websocket: { sessionTimeoutMin: 30, questionTimeoutSecs: 300 },
  };
}

export interface LiveEnv {
  dir: string;
  core: CoreInfrastructure;
  store: ConfigStore;
  ws: WsServer;
  cleanup(): void;
}

/**
 * Boot a live host: real createCore (store-backed accessors) + createWsServer
 * (registers the §3.3 extension rows: sessionTimeoutMin, health, the 8
 * shared-client fields; the core row hookTrace landed in createCore). The
 * boot generation is ADOPTED, never published (batchId 0), exactly like B1.
 */
export async function bootLive(seed: Record<string, unknown> = seedFile()): Promise<LiveEnv> {
  const dir = mkdtempSync(join(TMP_PARENT, "hotdog-configlive-"));
  writeFileSync(join(dir, "defaults.json"), JSON.stringify(seed, null, 2) + "\n");
  const store = createConfigStore();
  const configBag = {
    ...getDefaultConfig(),
    ...seed,
    websocket: (seed.websocket as Record<string, unknown> | undefined) ?? { sessionTimeoutMin: 30 },
  };
  const core = createCore(
    configBag as never,
    fakeRegistry(),
    createSubcommandRegistry(),
    { store },
  );
  core.resolved = bootResolved(dir, {
    baseUrl: (seed.aiUrl as string | undefined) ?? "http://boot.invalid/v1",
    apiKey: (seed.apiKey as string | undefined) ?? "boot-key",
    hookTrace: (seed.hookTrace as boolean | undefined) ?? false,
    chatTimeout: (seed.chatTimeoutSecs as number | undefined) ?? 600,
    maxRetries: (seed.maxRetries as number | undefined) ?? 5,
    modelWireFormat: (seed.modelWireFormat as string | undefined) ?? "xml",
    providerHealthCheckIntervalSecs: (seed.providerHealthCheckIntervalSecs as number | undefined) ?? 30,
  });
  const ws = createWsServer(core, {});
  // Same boot posture as the webui host (which calls this right after
  // createWsServer): the cleanup loop runs from boot, so the
  // sessionTimeoutMin hook RE-ARMS a running loop instead of being the only
  // thing that ever started one.
  ws.startCleanupLoop();
  return {
    dir,
    core,
    store,
    ws,
    cleanup() {
      ws.stopCleanupLoop();
      ws.stopTaskManager();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface LiveProbeRow {
  keyPath: string;
  input: ConfigKeyEditInput;
  /** Optional fixture the env needs before the write (the eviction-age probe
   *  stages stale sessions first). */
  setup?(env: LiveEnv): Promise<void> | void;
  /** The observable that must move when the transaction publishes LIVE. */
  observe(env: LiveEnv): unknown;
  /** What observe must answer after the live write. */
  expect: unknown;
  /** What observe answers BEFORE the write (the "not yet applied" control). */
  before: unknown;
  /** The §4.5-3 coverage claim: the registerConfigApplyHook keyPaths this row
   *  watches. Defaults to [keyPath]; rows writing an alias file member name
   *  the RESOLVED root the hook registered under (aiUrl -> baseUrl). */
  hooks?: string[];
  /** Optional write-back through the same transaction, run after the
   *  assertion: for a value the SHARED host must not keep (an unregistered
   *  WireFormat name throws at the next request build). */
  restore?: ConfigKeyEditInput;
  /** Optional exact attestation check (B7). When absent the suite pins the
   *  strict §7.1 claim `applied === "live"` + `needsRestart === false` (every
   *  committed B4 row keeps that shape). When present it must be an exact
   *  pin returning VIOLATIONS (empty = pass) -- used only where the strict
   *  claim is process-pollution-sensitive; see the providerHealth row. */
  attest?(res: {
    applied?: string;
    needsRestart?: boolean;
    applyHooks?: readonly { keyPath: string; status: string; error?: string | null }[];
  }): string[];
}

/** The B4 probe table -- every migrated key family, and every §3.3 hook this
 *  batch registers appears in at least one row (the §4.5-3 honesty rule). */
export const PROBES: LiveProbeRow[] = [
  {
    // §3.3 row 1: core.hooks.trace reassign (the boot reassign's live twin).
    keyPath: "hookTrace",
    input: { value: true },
    observe: (e) => e.core.hooks.trace,
    expect: true,
    before: false,
  },
  {
    // §3.3 row 2: registry.startCleanupLoop re-arm -- OBSERVABLE eviction-age
    // behavior, no restart. Four stale-by-90s sessions: the 3-hot idle grace
    // keeps them at 30 min; a 1-min age colds the one beyond the grace.
    keyPath: "websocket.sessionTimeoutMin",
    input: { value: 1 },
    async setup(env) {
      const rows: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await env.ws.sessionRegistry.create();
        const meta = env.ws.sessionRegistry._test_metadata.get(r.sessionId);
        if (meta) meta.lastActivityAt = Date.now() - 90_000 - i * 1_000;
        rows.push(r.sessionId);
      }
      (env as LiveEnv & { probeSessions?: string[] }).probeSessions = rows;
    },
    observe(env) {
      env.ws.sessionRegistry._test_cleanupIdleSessions();
      const rows = (env as LiveEnv & { probeSessions?: string[] }).probeSessions ?? [];
      return rows.filter((id) => env.ws.sessionRegistry.get(id) === null).length;
    },
    expect: 1,
    before: 0,
  },
  {
    // §3.3 row 4: the shared-client baseUrl field (the file member is aiUrl;
    // the resolved root baseUrl is what the client re-reads per request).
    keyPath: "aiUrl",
    hooks: ["baseUrl"], // the hook registered under the RESOLVED root
    input: { value: "http://live-endpoint.invalid/v1" },
    observe: (e) => e.ws.llmClient.baseUrl,
    expect: "http://live-endpoint.invalid/v1",
    before: "http://boot.invalid/v1",
  },
  {
    // §3.3 row 4, credential variant: writeOnly REPLACE lands the field, the
    // bytes never ride the reply (pinned in transaction.test.ts; the probe
    // watches the FIELD move on the shared object).
    keyPath: "apiKey",
    input: { valueText: "live-secret-2" },
    observe: (e) => e.ws.llmClient.apiKey,
    expect: "live-secret-2",
    before: "boot-key",
  },
  {
    // §3.3 row 4 timeout field (file chatTimeoutSecs -> resolved chatTimeout).
    keyPath: "chatTimeoutSecs",
    hooks: ["chatTimeout"], // resolved root the hook matches
    input: { value: 37 },
    observe: (e) => e.ws.llmClient.chatTimeoutSecs,
    expect: 37,
    before: 600,
  },
  {
    // §3.3 row 4 retry field (config-layer knob made real by B0).
    keyPath: "maxRetries",
    input: { value: 2 },
    observe: (e) => e.ws.llmClient.maxRetries,
    expect: 2,
    before: 5,
  },
  // ── B7 additions: the shared-client fields and the health sweep the §4.5-3
  // honesty walk needs. Same host, same real transaction, same before/after
  // discipline; each writes its own key once so the rows stay order-safe. ──
  {
    // §3.3 row 4: health-check (ping) timeout field. File member
    // healthCheckTimeoutSecs feeds resolved healthCheckTimeout.
    keyPath: "healthCheckTimeoutSecs",
    hooks: ["healthCheckTimeout"],
    input: { value: 9 },
    observe: (e) => e.ws.llmClient.healthCheckTimeoutSecs,
    expect: 9,
    before: 5,
  },
  {
    // §3.3 row 4: stream-idle watchdog field.
    keyPath: "streamIdleTimeoutSecs",
    hooks: ["streamIdleTimeout"],
    input: { value: 90 },
    observe: (e) => e.ws.llmClient.streamIdleTimeoutSecs,
    expect: 90,
    before: 240,
  },
  {
    // §3.3 row 4: default role mapping. Boot answers the built-in
    // "system-first" (createLlmClient's fallback), and "developer" is the OTHER
    // built-in (role-mapping-default), so the shared host keeps building
    // requests with a real mapping after this row.
    keyPath: "modelRoleMapping",
    input: { value: "developer" },
    observe: (e) => e.ws.llmClient.defaultRoleMapping,
    expect: "developer",
    before: "system-first",
  },
  {
    // §3.3 row 4: default WireFormat name. Only "xml" is registered in-tree,
    // so this row writes an unregistered name, watches the FIELD move (the
    // hook assigns it; resolution/registration is a separate registry the
    // hook does not consult), and RESTORES "xml" through a second real
    // transaction so the shared host -- and the agent-plane test that follows
    // -- keeps boot semantics.
    keyPath: "modelWireFormat",
    input: { value: "b7-probe-format" },
    restore: { value: "xml" },
    observe: (e) => e.ws.llmClient.defaultWireFormat,
    expect: "b7-probe-format",
    before: "xml",
  },
  {
    // §3.3 row 3: the health-sweep cadence. The observable is the RE-ARM
    // itself: setIntervalSecs is the only caller that arms a 7s interval on
    // this host, so the timer write IS the effect (waiting out a 60s sweep
    // would be theater). The seam's own stop/recreate/disable behavior lives
    // in tests/core/provider-health.test.ts.
    keyPath: "providerHealthCheckIntervalSecs",
    input: { value: 7 },
    attest(res) {
      // The strict §7.1 story is `applied: "live"` -- and on a clean process
      // that is exactly what this row demands (parallel mode runs every file
      // in its own process, and production boots exactly one WsServer).
      // Sequential full-tree runs share one process: a test file that booted
      // a WsServer WITHOUT resolved.modelRegistry (webui-extension et al.)
      // left its B4 hook registered in the process-global table -- B4
      // deliberately surfaced no unregister closures ("no per-object
      // teardown today; B8's auth seam introduces the lifecycle"), and that
      // foreign host's hook HONESTLY reports degraded ("no provider-health
      // registry on this host"). §7.1 then downgrades the attestation, which
      // is the system telling the truth about the process. The row therefore
      // pins the downgrade story to EXACTLY that class: every failing report
      // on this keyPath must name the foreign-host reason, the shim's
      // needsRestart derivation must hold either way, and the observe spy
      // (setInterval 7000) below still proves THIS host re-armed. Any other
      // degraded class stays a violation.
      const bad = (res.applyHooks ?? []).filter(
        (r) => r.keyPath === "providerHealthCheckIntervalSecs" && r.status !== "applied",
      );
      const problems: string[] = [];
      if (res.applied === "live") {
        if (bad.length) problems.push(`live claim despite ${bad.length} degraded report(s)`);
      } else if (res.applied === "restart-required") {
        if (bad.length === 0) problems.push(`restart-required with no degraded report -- not the foreign-WsServer story: ${JSON.stringify(res.applyHooks ?? [])}`);
        for (const r of bad) {
          // Reports carry formatError output (message line + stack); the
          // first line is the hook's own error text.
          if ((r.error ?? "").split("\n")[0] !== "no provider-health registry on this host (TaskManager was never built)") {
            problems.push(`degraded with an unexpected reason: ${r.keyPath}: ${r.error}`);
          }
        }
      } else {
        problems.push(`unexpected applied class: ${String(res.applied)}`);
      }
      if (res.needsRestart !== (res.applied === "restart-required")) {
        problems.push("needsRestart must DERIVE off applied (legacy shim)");
      }
      return problems;
    },
    async setup(env) {
      // One-shot spy: records every interval armed from here, restores the
      // global the moment the published cadence (7s) shows up -- the hook's
      // setIntervalSecs is the only caller that would arm 7000ms on this host.
      const original = globalThis.setInterval;
      const armed: number[] = [];
      globalThis.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        armed.push(Number(ms));
        if (Number(ms) === 7_000) globalThis.setInterval = original;
        return original(fn, ms, ...args);
      }) as typeof setInterval;
      (env as LiveEnv & { __b7Armed?: number[] }).__b7Armed = armed;
      (env as LiveEnv & { __b7Restore?: () => void }).__b7Restore = () => {
        globalThis.setInterval = original;
      };
    },
    observe(env) {
      const armed = (env as LiveEnv & { __b7Armed?: number[] }).__b7Armed ?? [];
      // 7s: the published cadence, in the ms the timer actually receives.
      return armed.includes(7_000);
    },
    expect: true,
    before: false,
  },
  {
    // The provider list: the hook re-points the ONE providers array the shared
    // client holds (the agent factory and the session registry alias the same
    // object), so the observable is what that client resolves endpoints from
    // after the publish. The honest writable spelling is the scalar child
    // `providers[0].url` -- `providers` itself is a container -- and the hook
    // lives on the root, hence the explicit coverage claim. No `fetchModels`
    // on the seed entry: this row must not reach the network (the catalog
    // sweep and its degrade path are pinned in
    // tests/core/config-live/side-effects.test.ts).
    keyPath: "providers[0].url",
    hooks: ["providers"], // the root the apply hook registered under
    input: { value: "http://live-provider.invalid/v1" },
    observe: (e) => ((e.ws.llmClient.providers ?? []) as { url?: string }[]).map((p) => p.url),
    before: ["http://seed.invalid/v1"],
    expect: ["http://live-provider.invalid/v1"],
  },
  {
    // The speech-to-text target, endpoint half: re-resolved against the swapped
    // bag, so the registry's target (what every dictation upload reads per
    // request and every new session advertises as sttEnabled) answers the new
    // URL. Boot has no backend at all -- sttUrl/sttModel are null and no
    // registry model declares audio -- so `before` is the honest "mic off".
    keyPath: "sttUrl",
    input: { value: "http://stt.invalid/v1/audio/transcriptions" },
    observe: (e) => e.ws.sessionRegistry.sttTarget?.url ?? null,
    before: null,
    expect: "http://stt.invalid/v1/audio/transcriptions",
  },
  {
    // ... and the model half, AFTER the endpoint row (a model only resolves
    // into a target once a target exists): the same rebuild re-runs on this
    // root, so the multipart `model` field follows without a restart.
    keyPath: "sttModel",
    input: { value: "whisper-live" },
    observe: (e) => e.ws.sessionRegistry.sttTarget?.model ?? null,
    before: null,
    expect: "whisper-live",
  },
  {
    // The exec-fence file key. Its honest observable is the posture the live
    // bag answers for a session with no runtime override: `off` never touches
    // the platform, so the display says "off" from the write on, whatever the
    // host's probe backend is (or is not). The pool entry that is already up
    // keeps the kernel fence it was spawned with -- that half is physics,
    // pinned against real spawns in tests/core/tool-exec-hardening.test.ts. The
    // reply class is "next-session", never "live": a running entry cannot move.
    keyPath: "execFence",
    input: { value: "off" },
    observe: (e) =>
      sharedExecFenceDisplay("exec-fence-probe", e.core.resolved as Record<string, unknown>) === "off",
    before: false,
    expect: true,
    hooks: ["execFence"],
    attest: attestNextSessionClass,
  },
  {
    // The plane key: what the next agent build gets, read through the same
    // live consumer the webui status strip uses (an inline plane never shows a
    // fence, so the label is deterministic whichever way the platform probe
    // went). RESTORED through the same transaction: the shared host must go on
    // running the plane it booted.
    keyPath: "toolExec",
    input: { value: "inline" },
    restore: { value: "worker" },
    observe: (e) => e.ws.sessionRegistry.toolExecLabel("tool-exec-probe").startsWith("inline"),
    before: false,
    expect: true,
    hooks: ["toolExec"],
    attest: attestNextSessionClass,
  },
];

/** The two plane keys share one attestation: the class is "next-session" (the
 *  new-entry posture the row can state truthfully), the legacy shim still
 *  derives off it, and the hook must have run clean -- a degraded or refused
 *  report there would mean the audit line never landed. */
function attestNextSessionClass(res: {
  applied?: string;
  needsRestart?: boolean;
  applyHooks?: readonly { keyPath: string; status: string; error?: string | null }[];
}): string[] {
  const problems: string[] = [];
  if (res.applied !== "next-session") problems.push(`applied must be "next-session", got ${String(res.applied)}`);
  if (res.needsRestart !== false) problems.push("needsRestart must DERIVE off applied (legacy shim)");
  const bad = (res.applyHooks ?? []).filter((r) => r.status !== "applied");
  if (bad.length) problems.push(`non-applied report(s): ${bad.map((r) => `${r.keyPath}:${r.status}`).join(", ")}`);
  return problems;
}

// ════════════════════════════════════════════════════════════════════════════
// THE FAMILY LIVENESS TABLE (B3 sites, B6a/B6b families, B7 families)
// ════════════════════════════════════════════════════════════════════════════
//
// One row per key the merge train migrated. Shape follows §4.5-1 (a
// `{ keyPath, observe }` table): each row boots ONE live host through the
// shared store harness (a REAL createConfigStore() + the createCore accessor
// shape, tests/mocks/config-live.ts), reads the consumer's observable,
// publishes the next generation through the store's only publish path (swap +
// one-shot commit), and reads again. Same law as the B4 table: an observable
// that does not move IS a stale copy, by construction.
//
// Honest notes:
//  - Mutation here is the store swap; the file + re-resolve + hook chain of the
//    full write transaction is what PROBES (above) and transaction.test.ts
//    drive. Both end in the same generation atom, which is exactly what a
//    per-use reader consumes.
//  - Where a family suite already pins the swap in depth, this row is the thin
//    DISTINCT observation -- usually the opposite direction or a different
//    measurement -- and it re-runs its own drive against its own store rather
//    than importing that suite's assertion.
//  - Rows that take real time (a spawn timeout, an armed question timer) wait
//    real milliseconds. No fake clocks, no theater.
//  - `compute` exists for rows whose published value can only be built after
//    the host booted (a temp dir, a rebuilt ProfileManager). The test applies
//    it to the row's own context, then publishes exactly the same way.

// (node:fs, node:path, TMP_PARENT, ConfigStore and createWsServer come in with
// the B4 half of this file above.)
import { bootLiveStore, createWithLiveStore, liveStoreCore, publishLive, registerWithLiveStore } from "../../mocks/config-live.ts";
import { resultStr, toolCtx } from "../../mocks/io.ts";
import { withMockFetch } from "../../mocks/fetch.ts";
import { createWsMockAgentFactory, createWsMockCore, createWsMockWs } from "../../mocks/websocket.ts";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import { ACTIONS } from "@core/commands.ts";
import { ServiceRegistry } from "@core/extensions/service-registry.ts";
import type { ExtensionInstance } from "@core/extensions/types.ts";
import { createAgentFactory } from "@core/agent-factory.ts";
import { ProfileManager, type ProfileDef } from "@core/config/profiles.ts";
import { SessionRegistry } from "@extensions/websocket/session-registry.ts";
import { TASK_STATUS, TaskHandle } from "@core/session/task-types.ts";
import { TASK_MANAGER_SERVICE } from "@extensions/subagents/index.ts";
import { create as createCoreToolsExtension } from "@extensions/core-tools/index.ts";
import { create as createBashExtension } from "@extensions/bash-tool/index.ts";
import { create as createFetchExtension } from "@extensions/fetch-tool/index.ts";
import { create as createWebSearchExtension } from "@extensions/web-search/index.ts";
import { create as createHandoffExtension } from "@extensions/handoff-tool/index.ts";
import { create as createLoopDetectExtension } from "@extensions/loop-detect/index.ts";
import { create as createLoopExtension } from "@extensions/loop/index.ts";
import { create as createCompactionExtension } from "@extensions/compaction/index.ts";
import { create as createRepairExtension } from "@extensions/tool-call-repair/index.ts";
import { create as createSkillsExtension } from "@extensions/skills/index.ts";
import { create as createPromptsExtension } from "@extensions/prompts/index.ts";
import { create as createAgentsMdExtension } from "@extensions/agents-md/index.ts";
import { create as createWorkflowsExtension } from "@extensions/workflows/index.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(TMP_PARENT, prefix));
}

/** Wait until `fn` holds, or fail loudly after timeoutMs (never hang a suite). */
export async function until(fn: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export interface FamilyCtx {
  /** The REAL store the host reads through (the harness booted it). */
  store: ConfigStore;
  /** Row-private fixture bag (tools, registries, temp dirs...). */
  host: Record<string, unknown>;
}

export interface FamilyProbeRow {
  /** The keyPath the next generation changes ("coreTools.readToolLimit").
   *  A "resolved." prefix names a RESOLVED-bag slot (no file spelling); the
   *  row then carries a resolvedPatch/computed resolved patch instead of a
   *  config value. */
  keyPath: string;
  /** The value at keyPath after the publish (static rows). */
  value?: unknown;
  /** Resolved-bag patch (posture keys: envScrubbing, toolExec, contextLimit). */
  resolvedPatch?: Record<string, unknown>;
  /** Post-boot computed publish (temp dirs, a rebuilt ProfileManager). */
  compute?(ctx: FamilyCtx): { value?: unknown; resolvedPatch?: Record<string, unknown> };
  boot(): FamilyCtx | Promise<FamilyCtx>;
  observe(ctx: FamilyCtx): unknown | Promise<unknown>;
  before: unknown;
  expect: unknown;
  teardown?(ctx: FamilyCtx): void | Promise<void>;
}

/**
 * Publish through the store's REAL swap (harness publishLive: swap + its
 * one-shot commit -- the only publish shape the store allows). The config bag
 * is rebuilt along keyPath only, copying every node on the way down (the
 * untouched blocks keep their identity, exactly like a re-resolve's fresh
 * whole-bag rebuild keeps leaf values); the resolved patch merges onto the
 * current resolved bag. A row that carries no value touches ONLY the resolved
 * bag (posture keys have no config-file spelling there).
 */
export function publishKey(
  store: ConfigStore,
  keyPath: string,
  pub: { value?: unknown; resolvedPatch?: Record<string, unknown> },
): void {
  const cur = store.current();
  const resolved = { ...(cur.resolved as Record<string, unknown>), ...(pub.resolvedPatch ?? {}) };
  if (!("value" in pub)) {
    publishLive(store, cur.config as Record<string, unknown>, resolved);
    return;
  }
  const parts = keyPath.replace(/^resolved\./, "").split(".");
  const bag = { ...(cur.config as Record<string, unknown>) };
  let node = bag;
  for (const p of parts.slice(0, -1)) {
    const next = node[p];
    const copy = (
      Array.isArray(next) ? [...next] : { ...((next ?? {}) as Record<string, unknown>) }
    ) as Record<string, unknown>;
    node[p] = copy;
    node = copy;
  }
  node[parts[parts.length - 1]!] = pub.value;
  publishLive(store, bag, resolved);
}

// ── host factories ─────────────────────────────────────────────────────────

const CORE_TOOLS_BLOCK = {
  enabled: true,
  readToolLimit: 500,
  maxImageSize: 5_000_000,
  findMaxResults: 100,
  grepMaxResults: 100,
  maxEditInputSize: 16_000,
};

function coreToolsHost(boot: Record<string, unknown>, files: Record<string, string | Buffer>) {
  const dir = tmp("b7-coretools-");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  const store = bootLiveStore({ coreTools: { ...CORE_TOOLS_BLOCK, ...boot } });
  const tools = registerWithLiveStore(store, createCoreToolsExtension);
  return { store, host: { dir, tools } };
}
const coreTool = (ctx: FamilyCtx, name: string): any => (ctx.host.tools as Map<string, any>).get(name);
const coreCtx = (ctx: FamilyCtx) => toolCtx({ workspaceRoots: [ctx.host.dir as string] });

function bashHost(boot: Record<string, unknown> = {}) {
  const store = bootLiveStore({ bashTool: { enabled: true, bashTimeoutMs: 5_000, maxTimeoutMs: 60_000, ...boot } }, { envScrubbing: true });
  const tools = registerWithLiveStore(store, createBashExtension);
  return { store, host: { tools } };
}
const bashTool = (ctx: FamilyCtx): any => (ctx.host.tools as Map<string, any>).get("bash");

const FETCH_BLOCK = {
  enabled: true,
  maxBodyLength: 200_000,
  maxImageSize: 4_000_000,
  fetchTimeoutMs: 5_000,
  allowedSchemes: ["http", "https"],
  allowPrivateHosts: true,
};

function fetchHost(boot: Record<string, unknown> = {}) {
  const store = bootLiveStore({ fetchTool: { ...FETCH_BLOCK, ...boot } });
  const tool = registerWithLiveStore(store, createFetchExtension).get("fetch");
  return { store, host: { tool } };
}
/** One fetch-tool call through a request stub (nothing leaves the process).
 *  A GET/HEAD timeout or abort surfaces as a THROWN TransientError (the
 *  executor's retry path), not a ToolResult, so the stub normalizes the
 *  throw into an error-shaped result for the rows. */
const fetchRun = async (
  ctx: FamilyCtx,
  impl: (url: string, opts?: RequestInit) => Response | Promise<Response>,
  url: string,
  ctxStub?: unknown,
): Promise<{ error: string | null; output: string }> =>
  withMockFetch(impl, async () => {
    try {
      return await (ctx.host.tool as any).execute(JSON.stringify({ url }), ctxStub);
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : String(e), output: "" };
    }
  });

const SEARCH_BLOCK = {
  enabled: true,
  provider: "brave",
  maxResults: 3,
  timeout: 5,
  braveApiKey: "b7-brave-key-1",
  tavilyApiKey: "b7-tavily-key-1",
  searxngInstanceUrl: "http://b7-searxng-a.invalid/search",
};

/** web-search host that RECORDS the requests it makes -- nothing leaves the
 *  process. This table watches WHERE the next search goes (provider/endpoint),
 *  WITH WHICH key, and whether the published cap lets it finish; the §5.3
 *  audit lines are pinned in tests/extensions/web-search.test.ts. */
function searchHost(boot: Record<string, unknown> = {}, delayMs = 0) {
  const store = bootLiveStore({ webSearch: { ...SEARCH_BLOCK, ...boot } });
  // create() registers the captcha-solve service on core.services (§B7-era
  // web-search), so the fake core must carry a registry like every other
  // web-search host does (tests/extensions/web-search.test.ts).
  const tool = registerWithLiveStore(store, createWebSearchExtension, {
    services: new ServiceRegistry(),
  }).get("web_search");
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const body = JSON.stringify({
    web: { results: [{ title: "t", url: "http://r.invalid/1", description: "d" }] },
    results: [{ title: "t", url: "http://r.invalid/1", content: "d" }],
  });
  const search = (): Promise<string> =>
    withMockFetch(
      (_url: string, opts?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const headers: Record<string, string> = {};
          new Headers(opts?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
          seen.push({ url: String(_url), headers });
          if (!delayMs) return resolve(new Response(body, { headers: { "content-type": "application/json" } }));
          const t = setTimeout(() => resolve(new Response(body, { headers: { "content-type": "application/json" } })), delayMs);
          // The published timeout rides an AbortSignal; honoring it is what
          // makes the cap observable rather than theatrical.
          opts?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted by the published timeout"));
          });
        }) as unknown as Response,
      async () => {
        try {
          const res = await tool.execute(JSON.stringify({ query: "b7 probe" }));
          return res.error === null ? "ok" : "error";
        } catch {
          // A lost timeout race rides TransientError (the executor's retry
          // path), not a ToolResult -- same classification either way.
          return "error";
        }
      },
    );
  return { store, host: { tool, seen, search } };
}

function handoffHost(boot: Record<string, unknown>) {
  const dir = tmp("b7-handoff-");
  writeFileSync(join(dir, "small.txt"), "hello world\n"); // 12 bytes
  const store = bootLiveStore({ handoffTool: { ...boot } });
  const { ext, tools } = createWithLiveStore(store, createHandoffExtension);
  return { store, host: { dir, ext, tool: tools.get("handoff") } };
}

/** One handoff turn: did the small file ride as an inlined include? */
async function handoffInlined(ctx: FamilyCtx): Promise<boolean> {
  const { ext, tool, dir } = ctx.host as { ext: any; tool: any; dir: string };
  await tool.execute(JSON.stringify({ content: "B7 plan", files: ["small.txt"] }), null);
  const enqueued: Array<Array<Record<string, unknown>>> = [];
  const agent = {
    clearContext: async () => {},
    ensureSystemPrompt: async () => {},
    enqueue: (parts: Array<Record<string, unknown>>) => enqueued.push(parts),
    emitOutput: () => {},
    config: { workspaceRoots: [dir] },
  };
  await ext.hooks[HOOKS.TURN_END]({
    stopped: true,
    cancelled: false,
    agent,
    toolResults: [{ toolName: "handoff", input: "{}", result: "ok" }],
  });
  return (enqueued[0] ?? []).some((p) => p.type === "file-include");
}

function loopDetectHost(boot: Record<string, unknown>) {
  const store = bootLiveStore({ loopDetect: { enabled: true, ...boot } });
  const core = liveStoreCore(store, { hooks: new HookSystem() }) as any;
  const ext = createLoopDetectExtension(core);
  const detections: Array<Record<string, unknown>> = [];
  core.hooks.on(HOOKS.LOOP_DETECTED, (p: Record<string, unknown>) => detections.push(p));
  const agent = { sessionId: "b7-loop-detect", isRestoring: false, cancelled: false, emitOutput: () => {}, addMessage: () => {} };
  const feed = async (toolName: string, input: string) => {
    await ext.hooks![HOOKS.TOOL_RESULT]!({ agent, toolName, input, result: "ok", success: true } as never);
  };
  return { store, host: { detections, feed } };
}

function loopHost(maxLoops: number) {
  const store = bootLiveStore({ loop: { enabled: true, maxLoops } });
  const ext = createLoopExtension(liveStoreCore(store) as any);
  const enqueued: string[] = [];
  const emitted: string[] = [];
  const agent = {
    sessionId: "b7-loop",
    cancelled: false,
    // TURN_END clears the context between laps (the loop's own contract);
    // the stub keeps that path from tripping the lap counter.
    clearContext: async () => {},
    enqueue: (parts: unknown) => enqueued.push(typeof parts === "string" ? parts : "turn"),
    emitOutput: (_type: string, data: { content?: string }) => emitted.push(String(data?.content ?? "")),
  };
  const defs: Record<string, { handler?: (a: unknown, v: string | null) => unknown }> = {};
  const registry = {
    register: (name: string, def: { handler?: (a: unknown, v: string | null) => unknown }) => (defs[name] = def),
    get: (name: string) => defs[name],
    names: () => Object.keys(defs),
  };
  ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as never);
  // Start a loop: the command's own enqueue is what TURN_END counts.
  defs["loop"]!.handler!(agent as never, "loop b7");
  const turnEnd = async () => {
    await ext.hooks![HOOKS.TURN_END]!({ stopped: true, cancelled: false, agent, toolResults: [] } as never);
  };
  const stopped = () => emitted.some((e) => e.includes("Max loops"));
  return { store, host: { turnEnd, stopped } };
}

function compactionHost(config: Record<string, unknown>, resolved: Record<string, unknown> = {}) {
  const store = bootLiveStore({ compaction: { enabled: true, ...config } }, resolved);
  const ext = createCompactionExtension(liveStoreCore(store) as any) as any;
  return { store, host: { ext } };
}

function repairHost(maxRepairsPerTurn: number) {
  const store = bootLiveStore({ toolCallRepair: { enabled: true, maxRepairsPerTurn } });
  const ext = createRepairExtension(liveStoreCore(store) as any) as any;
  const notices: string[] = [];
  const agent = {
    sessionId: "b7-repair",
    cancelled: false,
    iterationCount: 2,
    maxIterations: 10,
    sink: { emit: (e: { content?: string }) => notices.push(String(e.content ?? "")) },
  };
  // A malformed call leaked into prose: with budget it becomes a real call;
  // with a zero budget it stays stranded in the text and says so. The block
  // is ASSEMBLED (the grammar's own discipline: a literal token in a file's
  // bytes can re-trigger the backend bug under test).
  const LT = "<";
  const GT = ">";
  const T = (name: string): string => `${LT}|${name}|`;
  const leaked =
    `done ${T("tool_call")}${GT}\n${T("function")}${GT}=read${GT}\n` +
    `${T("parameter")}${GT}=path${GT}\na.txt\n${T("/parameter")}${GT}\n${T("/function")}${GT}\n${T("/tool_call")}${GT}`;
  const drive = async (): Promise<string> => {
    const response: Record<string, unknown> = {
      finishReason: "stop",
      fullText: leaked,
      finalToolCalls: undefined,
    };
    await ext.hooks![HOOKS.PROVIDER_RESPONSE]!({ response, agent } as never);
    const calls = response.finalToolCalls as unknown[] | undefined;
    if (calls && calls.length > 0) return "repaired";
    return notices.some((n) => n.toLowerCase().includes("budget")) ? "refused" : "silent";
  };
  return { store, host: { drive } };
}

function stripHost(resolved: Record<string, unknown>) {
  const store = bootLiveStore({}, resolved);
  const registry = new SessionRegistry({
    buildAgent: createWsMockAgentFactory() as never,
    toolExecResolved: () => (store.current().resolved ?? {}) as Record<string, unknown>,
  });
  return { store, host: { registry, stop: () => registry.stopCleanupLoop() } };
}

/** A ws host whose question bridge resolves its policy from the live store. */
async function questionHost(websocket: Record<string, unknown>) {
  const store = bootLiveStore({ websocket });
  const core = createWsMockCore();
  Object.defineProperty(core, "config", {
    get: () => store.current().config as Record<string, unknown>,
  });
  const wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });
  const ws = createWsMockWs();
  wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws as never);
  await until(() => ws.messages.length > 0, "session created");
  const sessionId = (JSON.parse(ws.messages[0]!) as { sessionId: string }).sessionId;

  /** Arm a question, wait `waitMs`, and report whether it auto-settled. The
   *  row's own answer write releases anything still pending. */
  const askAndSettle = async (waitMs: number): Promise<string> => {
    const bag: Record<string, unknown> = {};
    const toolCtx = { get: (k: string) => bag[k], set: (k: string, v: unknown) => (bag[k] = v) };
    const handlers = (core as { _registeredHooks: Record<string, Array<(p: unknown) => void>> })._registeredHooks[HOOKS.AGENT_TOOL_CONTEXT];
    handlers![0]!({ toolCtx, toolName: "question", agent: wsServer.sessionRegistry.get(sessionId)!.agent });
    const input = bag["input"] as { collectAnswers: (q: Array<Record<string, unknown>>) => Promise<unknown> };
    let settled = false;
    const p = input.collectAnswers([{ key: "q1", prompt: "b7?" }]).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, waitMs));
    const outcome = settled ? "resolved" : "pending";
    if (!settled) {
      await wsServer.onMessage(
        ws as never,
        JSON.stringify({ type: "questionAnswer", sessionId, answers: { q1: "x" } }),
      );
      await p;
    }
    return outcome;
  };
  return { store, host: { wsServer, askAndSettle } };
}

function factoryProfilesHost(bootProfiles: Record<string, string[]>) {
  const manager = (names: Record<string, string[]>) =>
    new ProfileManager("/nonexistent-profiles", Object.fromEntries(
      Object.entries(names).map(
        ([name, whitelist]): [string, ProfileDef] => [
          name,
          {
            name,
            description: "",
            body: "",
            model: null,
            whitelistTools: whitelist,
            blacklistTools: [],
            manager: false,
            visibleWorker: false,
          },
        ],
      ),
    ));
  const store = bootLiveStore(
    { coreOnly: true },
    {
      model: "b7/model",
      maxIterations: 5,
      contextLimit: 1000,
      profileName: "b7",
      modelRegistry: {},
      toolExec: "inline",
      execFence: "probe",
      // The Agent ctor requires these on the config view it builds; a
      // hand-built resolved bag must carry them like resolveAll does.
      maxToolCallsPerIteration: 10,
      maxRetries: 2,
      toolRetryDelay: 10,
      maxEmptyRetries: 1,
      profileManager: manager(bootProfiles),
    },
  );
  const core = {
    hooks: { notifyHooks: async () => ({}), on: () => () => {} },
    toolRegistry: {},
    get config() {
      return store.current().config;
    },
    get resolved() {
      return store.current().resolved;
    },
  } as never;
  const factory = createAgentFactory(core, {
    // B3's per-build reader: the profile map is resolved from the CURRENT
    // generation every time the factory builds an agent.
    profiles: () =>
      (store.current().resolved as { profileManager?: ProfileManager }).profileManager?.getProfilesForSwitch() ?? {},
    llmClient: {} as never,
  });
  return { store, host: { factory, manager } };
}

const WF_GRAPH_3 = `version: 1
name: b7three
description: three nodes for the soft-cap probe
nodes:
  - id: a
  - id: b
    dependsOn: [a]
  - id: c
    dependsOn: [b]
`;

const WF_GRAPH_GROUP = `version: 1
name: b7group
description: group-ref resolution probe
nodes:
  - id: a
    group: b7-group
`;

/** The workflows extension's manager tools over a live store (the B7 seam:
 *  limits at validate/dispatch, the toggle at dispatch, path per lookup,
 *  group refs per resolution). */
const noServices = { has: () => false, get: () => null };

/** The harness trio, plus the AWAIT the async extension entries (skills,
 *  prompts, workflows) need -- tests/mocks/config-live.ts is B6b's file and
 *  stays byte-identical, so the await lives here rather than in the harness. */
async function createAsyncWithLiveStore(
  store: ConfigStore,
  create: (core: never) => Promise<ExtensionInstance>,
  extras: Record<string, unknown> = {},
): Promise<{ ext: ExtensionInstance; tools: Map<string, any> }> {
  const ext = await create(liveStoreCore(store, extras) as never);
  const tools = new Map<string, any>();
  await ext.hooks?.[HOOKS.TOOLS_REGISTER]?.({
    register: (name: string, tool: unknown) => tools.set(name, tool),
    getAll: () => [],
  } as never);
  return { ext, tools };
}

/** The workflows extension's manager tools over a live store (the B7 seam:
 *  limits at validate/dispatch, the toggle at dispatch, path per lookup). */
async function workflowToolsHost(boot: Record<string, unknown> = {}, modelGroups: Record<string, string[]> = {}) {
  const dir = tmp("b7-workflows-");
  const store = bootLiveStore(
    { workflows: { path: dir, maxNodes: 8, maxRuntimeMins: 60, enableRuntimeTimeouts: false, ...boot } },
    { modelGroups },
  );
  const { ext, tools } = await createAsyncWithLiveStore(
    store,
    createWorkflowsExtension as never,
    { services: noServices },
  );
  return { store, host: { dir, tools, ext } };
}
export const wfTool = (ctx: FamilyCtx, name: string): any => (ctx.host.tools as Map<string, any>).get(name);

/** Validate a 3-node graph: does the soft cap complain about THIS call? */
async function validateSoftCap(ctx: FamilyCtx): Promise<string> {
  const res = await wfTool(ctx, "workflow_validate").execute({ yaml: WF_GRAPH_3 });
  return String(res.error ?? res.output ?? "").includes("exceeds soft cap") ? "over-cap" : "within-cap";
}

/** The dispatch tool's advertised cap sentence (a use site: the guidance the
 *  model is told must name the cap the engine will actually enforce). */
function dispatchCapText(ctx: FamilyCtx): string {
  const def = wfTool(ctx, "workflow_dispatch").toToolDef();
  return JSON.stringify(def);
}

/** Validate a graph that refs a declared model group: unknown names are
 *  refused BY NAME, declared ones pass. */
async function validateGroupRef(ctx: FamilyCtx): Promise<string> {
  const res = await wfTool(ctx, "workflow_validate").execute({ yaml: WF_GRAPH_GROUP });
  return String(res.error ?? "").includes("unknown model group") ? "unknown-group" : res.error ? `error:${String(res.error).slice(0, 60)}` : "ok";
}

export const FAMILY_PROBES: FamilyProbeRow[] = [
  // ── B6a: core-tools (per-execute reads) ──────────────────────────────────
  {
    keyPath: "coreTools.readToolLimit",
    value: 8,
    boot: () => coreToolsHost({ readToolLimit: 3 }, { "many.txt": Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") }),
    async observe(ctx) {
      const res = await coreTool(ctx, "read").execute({ path: "many.txt" }, coreCtx(ctx));
      return resultStr(res).split("\n").length;
    },
    before: 3,
    expect: 8,
    teardown: (ctx) => rmSync(ctx.host.dir as string, { recursive: true, force: true }),
  },
  {
    keyPath: "coreTools.maxImageSize",
    value: 100,
    boot: () => coreToolsHost({ maxImageSize: 5_000 }, { "b7.png": Buffer.alloc(400, 7) }),
    async observe(ctx) {
      const res = await coreTool(ctx, "read").execute({ path: "b7.png" }, coreCtx(ctx));
      return res.error === null;
    },
    before: true,
    expect: false,
    teardown: (ctx) => rmSync(ctx.host.dir as string, { recursive: true, force: true }),
  },
  {
    keyPath: "coreTools.maxEditInputSize",
    value: 4,
    boot: () => coreToolsHost({ maxEditInputSize: 4_000 }, { "editme.txt": "alpha" }),
    async observe(ctx) {
      try {
        const res = await coreTool(ctx, "edit").execute(
          { path: "editme.txt", oldString: "alpha", newString: "beta" },
          coreCtx(ctx),
        );
        return res.error === null ? "ok" : "refused";
      } catch {
        return "refused"; // the cap throws like any other edit-input refusal
      }
    },
    before: "ok",
    expect: "refused",
    teardown: (ctx) => rmSync(ctx.host.dir as string, { recursive: true, force: true }),
  },
  {
    keyPath: "coreTools.grepMaxResults",
    value: 20,
    boot: () =>
      coreToolsHost(
        { grepMaxResults: 2 },
        Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`m${i}.txt`, `b7needle ${i}\nother line\n`])),
      ),
    async observe(ctx) {
      const res = await coreTool(ctx, "grep").execute({ pattern: "b7needle" }, coreCtx(ctx));
      return String(res.output ?? "").split("\n").filter((l) => l.includes("b7needle")).length;
    },
    before: 2,
    expect: 6,
    teardown: (ctx) => rmSync(ctx.host.dir as string, { recursive: true, force: true }),
  },
  {
    keyPath: "coreTools.findMaxResults",
    value: 20,
    boot: () =>
      coreToolsHost({ findMaxResults: 3 }, Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}.txt`, "x\n"]))),
    async observe(ctx) {
      const res = await coreTool(ctx, "find").execute({ pattern: "*.txt" }, coreCtx(ctx));
      return String(res.output ?? "").split("\n").filter((l) => l.trim()).length;
    },
    before: 3,
    expect: 7,
    teardown: (ctx) => rmSync(ctx.host.dir as string, { recursive: true, force: true }),
  },

  // ── B6a: bash-tool (per-execute caps; the scrub posture at spawn time) ───
  // The bash tool REJECTS on timeout (AssistantRetryableError rides the
  // executor's retry path), so the observation classifies the rejection as
  // "timeout" rather than letting it escape the row.
  {
    keyPath: "bashTool.bashTimeoutMs",
    value: 60,
    boot: () => bashHost({ bashTimeoutMs: 5_000 }),
    async observe(ctx) {
      try {
        const res = await bashTool(ctx).execute(JSON.stringify({ command: "sleep 0.3" }));
        return res.error === null;
      } catch {
        return false; // the published 60ms cap killed the spawn
      }
    },
    before: true,
    expect: false,
  },
  {
    keyPath: "bashTool.maxTimeoutMs",
    value: 60_000,
    boot: () => bashHost({ maxTimeoutMs: 100 }),
    async observe(ctx) {
      try {
        const res = await bashTool(ctx).execute(JSON.stringify({ command: "sleep 0.3", timeoutMs: 5_000 }));
        return res.error === null;
      } catch {
        return false; // the boot cap clamps the requested 5s to 100ms -> timeout
      }
    },
    before: false,
    expect: true,
  },
  {
    // The SECURITY posture, flipped in the safe direction last: the boot
    // generation scrubs, and only a published `false` lets the secret ride a
    // spawn. (A stale capture would keep scrubbing forever -- which is exactly
    // the failure direction this row refuses to hide.)
    keyPath: "resolved.envScrubbing",
    resolvedPatch: { envScrubbing: false },
    boot: () => {
      process.env.B7_PROBE_SECRET = "visible";
      return bashHost();
    },
    async observe(ctx) {
      const res = await bashTool(ctx).execute(JSON.stringify({ command: "printenv B7_PROBE_SECRET" }));
      return String(res.output ?? "").includes("visible");
    },
    before: false,
    expect: true,
    teardown: () => {
      delete process.env.B7_PROBE_SECRET;
    },
  },
  {
    keyPath: "envScrub.extra",
    value: ["B7_EXTRA_PROBE"],
    boot: () => {
      process.env.B7_EXTRA_PROBE = "kept";
      return bashHost();
    },
    async observe(ctx) {
      const res = await bashTool(ctx).execute(JSON.stringify({ command: "printenv B7_EXTRA_PROBE" }));
      return String(res.output ?? "").includes("kept");
    },
    before: true, // not secret-shaped: only the operator's extra list scrubs it
    expect: false,
    teardown: () => {
      delete process.env.B7_EXTRA_PROBE;
    },
  },

  // ── B6b: fetch-tool (per-request caps + both SSRF posture vectors) ───────
  {
    keyPath: "fetchTool.maxBodyLength",
    value: 25,
    boot: () => fetchHost({ maxBodyLength: 1_000 }),
    observe: (ctx) =>
      fetchRun(ctx, () => new Response("x".repeat(120)), "http://b7.invalid/body").then((res) => String(res.output ?? "").length),
    before: 120,
    expect: 25,
  },
  {
    keyPath: "fetchTool.fetchTimeoutMs",
    value: 30,
    boot: () => fetchHost({ fetchTimeoutMs: 5_000 }),
    observe: (ctx) =>
      fetchRun(
        ctx,
        (_url, opts) =>
          new Promise<Response>((resolve, reject) => {
            const t = setTimeout(() => resolve(new Response("late")), 150);
            opts?.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new Error("aborted by the published cap"));
            });
          }) as unknown as Response,
        "http://b7.invalid/slow",
      ).then((res) => (res.error === null ? "settled" : "timeout")),
    before: "settled",
    expect: "timeout",
  },
  {
    keyPath: "fetchTool.allowedSchemes",
    value: ["http", "https"],
    boot: () => fetchHost({ allowedSchemes: ["http"] }),
    observe: (ctx) =>
      fetchRun(ctx, () => new Response("ok"), "https://b7.invalid/scheme").then((res) => (res.error === null ? "fetched" : "refused")),
    before: "refused",
    expect: "fetched",
  },
  {
    keyPath: "fetchTool.allowPrivateHosts",
    value: true,
    boot: () => fetchHost({ allowPrivateHosts: false }),
    observe: (ctx) =>
      fetchRun(ctx, () => new Response("ok"), "http://127.0.0.1:9/private").then((res) => (res.error === null ? "fetched" : "refused")),
    before: "refused",
    expect: "fetched",
  },
  {
    keyPath: "fetchTool.maxImageSize",
    value: 5_000_000,
    boot: () => fetchHost({ maxImageSize: 1_000 }),
    // The vision gate runs BEFORE the size cap, so the call carries a
    // tool-context stub whose agent accepts image input -- otherwise every
    // row result would be "model refuses images" and the cap would be
    // unmeasured. The ctx stub is observation plumbing, not a config capture.
    observe: (ctx) => {
      const agent = {
        model: "b7/vision",
        modelRegistry: { "b7/vision": { capabilities: { vision: true } } },
      };
      return fetchRun(
        ctx,
        () => new Response(new Uint8Array(4_000), { headers: { "content-type": "image/png" } }),
        "http://b7.invalid/image",
        { get: (k: string) => (k === "agent" ? agent : undefined) },
      ).then((res) => res.error === null);
    },
    before: false,
    expect: true,
  },

  // ── B6b: web-search (per-search reads, incl. the secrets and endpoint) ───
  {
    keyPath: "webSearch.provider",
    value: "searxng",
    boot: () => searchHost({ provider: "brave" }),
    async observe(ctx) {
      const { seen, search } = ctx.host as { seen: Array<{ url: string }>; search: () => Promise<string> };
      await search();
      return new URL(seen[seen.length - 1]!.url).host;
    },
    before: "api.search.brave.com",
    expect: "b7-searxng-a.invalid",
  },
  {
    keyPath: "webSearch.maxResults",
    value: 9,
    boot: () => searchHost({ maxResults: 3 }),
    async observe(ctx) {
      const { seen, search } = ctx.host as { seen: Array<{ url: string }>; search: () => Promise<string> };
      await search();
      return new URL(seen[seen.length - 1]!.url).searchParams.get("count");
    },
    before: "3",
    expect: "9",
  },
  {
    // The timeout knob is SECONDS (AbortSignal.timeout(t*1000), floor 1s),
    // so this row waits real milliseconds: a provider answering at 1.2s loses
    // under the boot 1s floor and wins once 5s is published.
    keyPath: "webSearch.timeout",
    value: 5,
    boot: () => searchHost({ timeout: 1 }, 1_200),
    observe: (ctx) => (ctx.host.search as () => Promise<string>)(),
    before: "error",
    expect: "ok",
  },
  {
    keyPath: "webSearch.braveApiKey",
    value: "b7-brave-key-2",
    boot: () => searchHost({ braveApiKey: "b7-brave-key-1" }),
    async observe(ctx) {
      const { seen, search } = ctx.host as { seen: Array<{ headers: Record<string, string> }>; search: () => Promise<string> };
      await search();
      // Observed ONLY inside this test's own request capture. The §5.3 audit
      // line for this key renders set/unset/changed WORDS, never bytes --
      // pinned in tests/extensions/web-search.test.ts with key canaries.
      return seen[seen.length - 1]!.headers["x-subscription-token"];
    },
    before: "b7-brave-key-1",
    expect: "b7-brave-key-2",
  },
  {
    keyPath: "webSearch.searxngInstanceUrl",
    value: "http://b7-searxng-b.invalid/search",
    boot: () => searchHost({ provider: "searxng", searxngInstanceUrl: "http://b7-searxng-a.invalid/search" }),
    async observe(ctx) {
      const { seen, search } = ctx.host as { seen: Array<{ url: string }>; search: () => Promise<string> };
      await search();
      return new URL(seen[seen.length - 1]!.url).host;
    },
    before: "b7-searxng-a.invalid",
    expect: "b7-searxng-b.invalid",
  },

  // ── B6b: handoff-tool (per-handoff read) ─────────────────────────────────
  {
    keyPath: "handoffTool.autoIncludeFilesUnderBytes",
    value: 5_000,
    boot: () => handoffHost({ autoIncludeFilesUnderBytes: 10 }),
    observe: (ctx) => handoffInlined(ctx),
    before: false,
    expect: true,
    teardown: (ctx) => rmSync(ctx.host.dir as string, { recursive: true, force: true }),
  },

  // ── B6b: loop-detect thresholds (per-turn; the window is derived at use) ─
  {
    keyPath: "loopDetect.repeatThreshold",
    value: 1,
    boot: () => loopDetectHost({ repeatThreshold: 4, pingPongThreshold: 8 }),
    async observe(ctx) {
      const { detections, feed } = ctx.host as { detections: unknown[]; feed: (t: string, i: string) => Promise<void> };
      await feed("read", '{"p":"b7.txt"}');
      return detections.length;
    },
    before: 0,
    // The published bar 1 fires on the very next repeat: three identical calls
    // are a streak the new bar scores at once (the old bar 4 stayed silent).
    expect: 1,
  },
  {
    keyPath: "loopDetect.pingPongThreshold",
    value: 3,
    boot: () => loopDetectHost({ repeatThreshold: 50, pingPongThreshold: 8 }),
    async observe(ctx) {
      const { detections, feed } = ctx.host as { detections: unknown[]; feed: (t: string, i: string) => Promise<void> };
      await feed("alpha", "{}");
      await feed("beta", "{}");
      await feed("alpha", "{}");
      return detections.length;
    },
    before: 0,
    expect: 1,
  },

  // ── B6b: loop maxLoops (read at every TURN_END check) ────────────────────
  {
    keyPath: "loop.maxLoops",
    value: 1,
    boot: () => loopHost(2),
    async observe(ctx) {
      const { turnEnd, stopped } = ctx.host as { turnEnd: () => Promise<void>; stopped: () => boolean };
      await turnEnd();
      return (stopped as () => boolean)();
    },
    before: false,
    expect: true,
  },

  // ── B3: compaction per-run reads (the deleted boot mutator's replacement) ─
  {
    keyPath: "compaction.reserveTokens",
    value: 500,
    boot: () => compactionHost({ reserveTokens: 2_000, keepRecentMessages: 4, strategy: "summarize" }),
    observe: (ctx) => (ctx.host.ext as { settings: Record<string, unknown> }).settings.reserveTokens,
    before: 2_000,
    expect: 500,
  },
  {
    // The EFFECTIVE window: the block declares no contextLimit, so the
    // per-run settings view threads the RESOLVED one. The deleted
    // `settings.contextLimit ??=` boot mutator froze exactly this value once,
    // at boot, into the bag. Observation = one `/compact <n> --compact-debug`
    // run (the keep path writes the run's settings view to the dump file),
    // so this row measures the per-run read, not a getter snapshot.
    keyPath: "resolved.contextLimit",
    resolvedPatch: { contextLimit: 64_000 },
    boot: () => {
      const dir = tmp("b7-compact-");
      process.env.HOTDOG_SESSIONS_DIR = dir;
      const store = bootLiveStore(
        { compaction: { enabled: true, keepRecentMessages: 4 } },
        { contextLimit: 128_000 },
      );
      const ext = createCompactionExtension(liveStoreCore(store) as any) as any;
      const cmds: Record<string, { handler: (a: unknown, v: string | null) => Promise<unknown> }> = {};
      ext.hooks![HOOKS.COMMANDS_REGISTER]!({
        registry: { register: (n: string, d: unknown) => (cmds[n] = d as never), getAll: () => [] },
      });
      const agent = {
        sessionId: "b7-ctx",
        context: {
          getNonSystem: () =>
            Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` })),
          getSystem: () => [],
        },
        replaceContext: () => {},
      };
      const observeWindow = async (): Promise<number> => {
        await cmds["compact"]!.handler(agent, "compact 3 --compact-debug");
        const dump = JSON.parse(await readFile(join(dir, "compaction.out.json"), "utf-8"));
        return Number(dump.settings.contextLimit);
      };
      return { store, host: { dir, observeWindow } };
    },
    observe: (ctx) => (ctx.host.observeWindow as () => Promise<number>)(),
    before: 128_000,
    expect: 64_000,
    teardown: (ctx) => {
      delete process.env.HOTDOG_SESSIONS_DIR;
      rmSync(ctx.host.dir as string, { recursive: true, force: true });
    },
  },

  // ── B3: toolCallRepair's per-turn budget ─────────────────────────────────
  {
    keyPath: "toolCallRepair.maxRepairsPerTurn",
    value: 3,
    boot: () => repairHost(0),
    observe: (ctx) => (ctx.host.drive as () => Promise<string>)(),
    before: "refused",
    expect: "repaired",
  },

  // ── B3: the exec-plane posture strip reads the live resolved plane ───────
  {
    keyPath: "resolved.toolExec",
    resolvedPatch: { toolExec: "worker", execFence: "off" },
    boot: () => stripHost({ toolExec: "inline", execFence: "probe" }),
    observe: (ctx) => (ctx.host.registry as SessionRegistry).toolExecLabel("b7-strip"),
    before: "inline (unfenced)",
    expect: "worker (fence: off)",
    teardown: (ctx) => (ctx.host.stop as () => void)(),
  },

  // ── B3/B7: modelGroups resolved per group-ref resolution (config bag) ────
  {
    keyPath: "modelGroups",
    value: { "b7-group": ["b7/member"] },
    boot: async () => {
      const h = await workflowToolsHost({}, {});
      return h;
    },
    observe: (ctx) => validateGroupRef(ctx),
    before: "unknown-group",
    expect: "ok",
    teardown: (ctx) => rmSync(ctx.host.dir as string, { recursive: true, force: true }),
  },

  // ── B3: question defaults resolve at question-ARMED time ─────────────────
  {
    // Timeout half: strategy stays "default" both generations; the TIMER moves.
    keyPath: "websocket.questionTimeoutSecs",
    value: 0.03,
    boot: () => questionHost({ questionStrategy: "default", questionTimeoutSecs: 300 }),
    observe: (ctx) => (ctx.host.askAndSettle as (ms: number) => Promise<string>)(120),
    before: "pending",
    expect: "resolved",
    teardown: (ctx) => (ctx.host.wsServer as WsServer).stopCleanupLoop(),
  },
  {
    // Strategy half: the timer would already have fired; the POLICY decides it
    // may not resolve. Flipping the strategy is what auto-resolves the NEXT arm.
    keyPath: "websocket.questionStrategy",
    value: "default",
    boot: () => questionHost({ questionStrategy: "wait", questionTimeoutSecs: 0.03 }),
    observe: (ctx) => (ctx.host.askAndSettle as (ms: number) => Promise<string>)(120),
    before: "pending",
    expect: "resolved",
    teardown: (ctx) => (ctx.host.wsServer as WsServer).stopCleanupLoop(),
  },

  // ── B3: the factory's profile map is a per-build reader ──────────────────
  {
    keyPath: "resolved.profiles",
    compute: (ctx) => ({
      resolvedPatch: {
        profileManager: (ctx.host.manager as (n: Record<string, string[]>) => ProfileManager)({ "b7-b": ["grep"] }),
      },
    }),
    boot: () => factoryProfilesHost({ "b7-a": ["read"] }),
    async observe(ctx) {
      const factory = ctx.host.factory as (c: Record<string, unknown>) => Promise<Record<string, unknown>>;
      const agent = await factory({ profileName: "b7-a" });
      return JSON.stringify(agent.toolWhitelist ?? null);
    },
    before: '["read"]',
    expect: "null", // 'b7-a' is gone from the new generation: no overlay to apply
  },

  // ── B7: skills (path CONSUMERS resolve per use; the loaded set does not) ──
  {
    keyPath: "skills.path",
    compute: (ctx) => ({ value: ctx.host.b }),
    boot: async () => {
      const a = tmp("b7-skills-a-");
      const b = tmp("b7-skills-b-");
      const store = bootLiveStore({ skills: { path: a, preloadSkills: [] } });
      const ext = await createSkillsExtension(liveStoreCore(store) as never);
      return { store, host: { a, b, loader: (ext as unknown as { loader: unknown }).loader } };
    },
    // Marker form (the dirs are temp paths): which root does the listing
    // resolve RIGHT NOW? A stale capture answers "a" forever.
    observe: (ctx) => {
      const dirs = (ctx.host.loader as { directories(): string[] }).directories();
      return dirs[0] === ctx.host.a ? "a" : dirs[0] === ctx.host.b ? "b" : `other:${dirs.join(",")}`;
    },
    before: "a",
    expect: "b",
    teardown: (ctx) => {
      rmSync(ctx.host.a as string, { recursive: true, force: true });
      rmSync(ctx.host.b as string, { recursive: true, force: true });
    },
  },

  // ── B7: prompts displayPrompt (one read per prompt execution) ────────────
  {
    keyPath: "prompts.displayPrompt",
    value: false,
    boot: async () => {
      const dir = tmp("b7-prompts-");
      writeFileSync(join(dir, "hello.prompt.md"), "---\nname: hello\ndescription: b7 probe\n---\nHello $ARGS\n");
      const store = bootLiveStore({ prompts: { path: dir, displayPrompt: true } });
      const ext = await createPromptsExtension(liveStoreCore(store) as never);
      const cmds: Record<string, { handler?: (a: unknown, v: string | null) => Promise<{ action?: number }> }> = {};
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({
        registry: { register: (name: string, def: unknown) => (cmds[name] = def as never), getAll: () => [] },
        agent: {},
      } as never);
      return { store, host: { dir, handler: cmds["prompt"]!.handler! } };
    },
    async observe(ctx) {
      const out = await (ctx.host.handler as (a: unknown, v: string | null) => Promise<{ action?: number }>)({}, "prompt:hello world");
      return ((out.action ?? 0) & ACTIONS.DISPLAY) !== 0 ? "display" : "silent";
    },
    before: "display",
    expect: "silent",
    teardown: (ctx) => rmSync(ctx.host.dir as string, { recursive: true, force: true }),
  },

  // ── B7: agentsMd.autoload (per SYSTEM_PROMPT_BUILD, both directions) ─────
  {
    keyPath: "agentsMd.autoload",
    value: false,
    boot: async () => {
      const dir = tmp("b7-agentsmd-");
      writeFileSync(join(dir, "AGENTS.md"), "# B7 MARKER PROJECT\n\nmarker text\n");
      const previousCwd = process.cwd();
      process.chdir(dir);
      const store = bootLiveStore({ agentsMd: { enabled: true, autoload: true } });
      const ext = createAgentsMdExtension(liveStoreCore(store) as never);
      return { store, host: { dir, previousCwd, ext } };
    },
    async observe(ctx) {
      const chunk = (await (ctx.host.ext as ExtensionInstance).hooks![HOOKS.SYSTEM_PROMPT_BUILD]!({} as never)) as
        | { content?: string }
        | undefined;
      return String(chunk?.content ?? "").includes("B7 MARKER PROJECT");
    },
    before: true,
    expect: false,
    teardown: (ctx) => {
      process.chdir(ctx.host.previousCwd as string);
      rmSync(ctx.host.dir as string, { recursive: true, force: true });
    },
  },

  // ── B7: workflows (limits at validate/dispatch, toggle at dispatch, path
  //    per lookup, group refs per resolution) ───────────────────────────────
  {
    // The soft cap is a VALIDATION decision: raising it admits the SAME graph
    // on the next validate, and a graph already dispatched kept its stamp.
    keyPath: "workflows.maxNodes",
    value: 9,
    boot: () => workflowToolsHost({ maxNodes: 2 }),
    observe: (ctx) => validateSoftCap(ctx),
    before: "over-cap",
    expect: "within-cap",
    teardown: (ctx) => rmSync(ctx.host.dir as string, { recursive: true, force: true }),
  },
  {
    keyPath: "workflows.maxRuntimeMins",
    value: 25,
    boot: () => workflowToolsHost({ maxRuntimeMins: 60, enableRuntimeTimeouts: true }),
    observe: (ctx) => Number(/default: (\d+)/.exec(dispatchCapText(ctx))?.[1] ?? -1),
    before: 60,
    expect: 25,
    teardown: (ctx) => rmSync(ctx.host.dir as string, { recursive: true, force: true }),
  },
  {
    keyPath: "workflows.enableRuntimeTimeouts",
    value: true,
    boot: () => workflowToolsHost({ enableRuntimeTimeouts: false, maxRuntimeMins: 45 }),
    observe: (ctx) => dispatchCapText(ctx).includes("maxRuntimeMins"),
    before: false, // caps off costs zero prompt bytes (and zero kill points)
    expect: true,
    teardown: (ctx) => rmSync(ctx.host.dir as string, { recursive: true, force: true }),
  },
  {
    // The availability scanner (a SYSTEM_PROMPT_BUILD listing) follows the
    // published dir; the row also proves the CACHE did not serve the old root.
    keyPath: "workflows.path",
    compute: (ctx) => ({ value: ctx.host.b }),
    boot: async () => {
      const a = tmp("b7-wf-a-");
      const b = tmp("b7-wf-b-");
      writeFileSync(join(b, "later.workflow.yaml"), "version: 1\nname: later\ndescription: from the new dir\nnodes:\n  - id: a\n");
      const store = bootLiveStore({ workflows: { path: a, maxNodes: 8, maxRuntimeMins: 60 } });
      const ext = await createWorkflowsExtension(liveStoreCore(store, { services: noServices }) as never);
      return { store, host: { a, b, ext } };
    },
    async observe(ctx) {
      const chunk = (await (ctx.host.ext as ExtensionInstance).hooks![HOOKS.SYSTEM_PROMPT_BUILD]!({
        agent: { managerProfile: true },
      } as never)) as { content?: string } | undefined;
      return String(chunk?.content ?? "").includes("from the new dir");
    },
    before: false,
    expect: true,
    teardown: (ctx) => {
      rmSync(ctx.host.a as string, { recursive: true, force: true });
      rmSync(ctx.host.b as string, { recursive: true, force: true });
    },
  },
];

// ── B7 negative pins: hosts for what a publish must NOT do (§4.3 P8 row) ───
//
// FAMILY_PROBES proves the NEXT use answers the published value. The negative
// side of the same doctrine (negative-pins.test.ts) needs two things the
// positive rows never touched: a workflow host whose dispatched runs actually
// RUN (so "the running run kept its start-time limits" is an observation, not
// a comment), and the skills/prompts create-pinned lifecycle halves, which
// ride their tiny hosts directly in the test file (they are two-line boots).

/**
 * Parked-worker EngineTaskPort for the P8 pins: every spawn takes the lane on
 * the next macrotask (onTurnStart -- exactly where the engine arms the
 * deadline FROZEN at dispatch) and then hangs. No verdict file is ever
 * written, so no node can succeed; the only forward edge is time. Edges:
 * interruptTask (the cap kill / #releaseTask route) delivers a cancelled
 * turn through the spawn's onTurn, same as a real parked worker being
 * interrupted; the engine's own gate delivers the cancel() route.
 */
export function hangTaskPort() {
  interface Parked {
    deliver?: (t: { status: "completed" | "failed" | "cancelled"; result: string }) => void;
    settle?: (status: typeof TASK_STATUS.CANCELLED) => void;
    alive: boolean;
  }
  const tasks = new Map<string, Parked>();
  let spawns = 0;
  const deliver = (
    id: string,
    t: { status: "completed" | "failed" | "cancelled"; result: string },
  ): boolean => {
    const p = tasks.get(id);
    if (!p || !p.alive) return false;
    p.alive = false;
    p.deliver?.(t);
    p.settle?.(TASK_STATUS.CANCELLED);
    return true;
  };
  return {
    get spawns() {
      return spawns;
    },
    async spawnTask(
      taskId: string,
      _prompt: unknown,
      opts: { onTurn?: Parked["deliver"]; onTurnStart?: () => void },
    ): Promise<TaskHandle> {
      let settle: Parked["settle"];
      const done = new Promise<{ status: typeof TASK_STATUS.CANCELLED; result: string }>((res) => {
        settle = (status) => res({ status, result: "hung worker settled" });
      });
      tasks.set(taskId, { deliver: opts.onTurn, settle, alive: true });
      spawns++;
      // Cold admission: the lane is taken on the next macrotask -- the turn
      // start is where the dispatch-frozen cap arms; the turn never ends on
      // its own.
      setTimeout(() => {
        if (tasks.get(taskId)?.alive) opts.onTurnStart?.();
      }, 0);
      return new TaskHandle(taskId, { value: TASK_STATUS.RUNNING } as never, new AbortController(), undefined, done as never);
    },
    async taskTurn(): Promise<{ status: "failed"; result: string }> {
      // Warm retries need a gate rejection first; the hang port never gets
      // one (no completed turn -> no gate). If a future change routes here,
      // the honest answer is "this port does not do turns".
      return { status: "failed", result: "warm turn unsupported by the hang port" };
    },
    completeTask(id: string): boolean {
      // Unreachable in these pins (no verdict file, so no gate pass); false
      // keeps the engine deterministic (cancel-settle) instead of awaiting a
      // done promise that the gate path already resolved.
      return deliver(id, { status: "completed", result: "completeTask on a hung worker" });
    },
    interruptTask(id: string): boolean {
      return deliver(id, { status: "cancelled", result: "interrupted (runtime cap kill / release)" });
    },
    sendFollowUp(): boolean {
      return false;
    },
  };
}

/** workflowToolsHost + a taskManager service backed by hangTaskPort: the
 *  dispatch tool resolves its EngineTaskPort through
 *  core.services.get(TASK_MANAGER_SERVICE) like any live host, so dispatched
 *  runs execute against the stub and the P8 freeze becomes observable. */
export async function workflowRunHost(boot: Record<string, unknown> = {}) {
  const dir = tmp("b7-wfrun-");
  const port = hangTaskPort();
  const services = {
    has: (name: string) => name === TASK_MANAGER_SERVICE,
    get: (name: string) => (name === TASK_MANAGER_SERVICE ? port : null),
  };
  const store = bootLiveStore(
    { workflows: { path: dir, maxNodes: 8, maxRuntimeMins: 60, enableRuntimeTimeouts: false, ...boot } },
    {},
  );
  const { ext, tools } = await createAsyncWithLiveStore(store, createWorkflowsExtension as never, { services });
  return { store, host: { dir, tools, ext, port } };
}

/** Write a graph into the host's workflows dir under `<name>.workflow.yaml`. */
export function writeWorkflowGraph(dir: string, name: string, nodeCount = 1, hangNote = "hangs until interrupted"): void {
  const nodes = Array.from({ length: nodeCount }, (_, i) =>
    i === 0 ? "  - id: a\n" : `  - id: ${String.fromCharCode(98 + i - 1)}\n    dependsOn: [${i === 1 ? "a" : String.fromCharCode(98 + i - 2)}]\n`,
  ).join("");
  writeFileSync(
    join(dir, `${name}.workflow.yaml`),
    `version: 1\nname: ${name}\ndescription: b7 P8 pin graph (${hangNote})\nnodes:\n${nodes}`,
  );
}
