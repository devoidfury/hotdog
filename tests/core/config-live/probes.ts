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
 * The providerHealthCheckIntervalSecs row is NOT in the drive table: its
 * observable is the sweep CADENCE (timer-driven), and driving a 60s-scale
 * interval from a test would be theater. The new seam it calls,
 * ProviderHealth.setIntervalSecs, gets a behavior test at its own level
 * (tests/core/provider-health.test.ts: stop+recreate arms a real interval
 * that probes; 0 disables; the failure-driven markDown/noteUp doctrine stays
 * reachable in every state), and the hook itself is pinned in
 * transaction.test.ts (registered, applied, re-arms the shared sweep).
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
  } as never;
}

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
    toolExec: "inline",
    execFence: "probe",
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
];
