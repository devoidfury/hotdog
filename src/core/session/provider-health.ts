/**
 * Provider-pool health tracking
 *
 * The provider list is the pool and task placement spreads work across it, so a
 * dead provider looks idle/cold -- the PREFERRED placement target -- until a
 * task locks on it, burns maxRetries on connection-refused, and fails. This
 * module keeps the reachability verdicts that placement consults.
 *
 * Reachability is STATUS-AGNOSTIC: any HTTP response (even 404 from a backend
 * without a /health route) means the machine is up; only connection refused /
 * timeout / DNS means down. We test connectivity, not route existence.
 *
 * Two demotion paths, one recovery path:
 * - interval sweep (resolved providerHealthCheckIntervalSecs; 0 disables) probes
 *   every provider with a url on the shared probe timeout (resolved
 *   healthCheckTimeout);
 * - failure-driven markDown (TaskManager chat path) takes a provider out
 *   immediately so the next fanout does not rediscover the corpse between
 *   sweeps;
 * - any successful probe clears both. Recovery additionally fires the
 *   optional onRecover callback so the caller can wake queued tasks -- health
 *   itself knows nothing about placement. TaskManager also calls noteUp when a
 *   task completes on a provider (a round-tripped chat is up-evidence), so
 *   interval 0 has a recovery path too: demotion is never process-permanent.
 *
 * Catalog piggyback: for fetchModels:true providers the sweep GETs
 * <url>/v1/models INSTEAD of /health -- one request serving as both health
 * signal and catalog refresh. Successful bodies upsert "provider/model" keys
 * into the SHARED live modelRegistry with the same local-wins deep merge as
 * boot (buildProviderModels). UPSERT ONLY, never remove: eviction would need
 * in-use checks against TaskManager occupancy (a running task holds a locked
 * placement), so a model the backend deleted stays selectable until restart --
 * a deliberate ceiling, stale beats empty. A provider down at boot simply
 * gains its catalog entries on its first successful sweep.
 */

import { logger } from "@utils/logger.ts";
import { hotdogFetch } from "@utils/fetch.ts";
import { formatError } from "../error.ts";
import {
  buildProviderModels,
  fetchRemoteModelsOutcome,
  type ModelConfig,
  type ProviderDef,
  type ProviderModelEntry,
} from "../config/providers.ts";

/** What one probe pass concluded about a provider. */
export interface ProbeResult {
  /** False only for connection-level failure (refused / timeout / DNS). */
  up: boolean;
  /** fetchModels:true providers only: entries from a 2xx /v1/models body, for the catalog piggyback. */
  models?: ProviderModelEntry[];
  /** Failure summary (formatted) for the transition log. */
  reason?: string;
}

/** Injectable probe (mirrors model-resolver's peekLoaded injection seam). */
export type ProviderProbe = (
  provider: ProviderDef,
  url: string,
  apiKey: string | undefined,
  timeoutMs: number,
) => Promise<ProbeResult>;

export interface ProviderHealthOptions {
  providers: readonly ProviderDef[];
  /** Global fallbacks, inherited exactly like the rest of the config layer. */
  globals?: { baseUrl?: string; apiKey?: string };
  /** Sweep interval in ms (resolved providerHealthCheckIntervalSecs * 1000). <= 0 disables the timer. */
  intervalMs: number;
  /** Per-request probe timeout in ms (resolved healthCheckTimeout * 1000). */
  timeoutMs: number;
  probe?: ProviderProbe;
  /**
   * The SHARED live model registry, mutated in place on a successful
   * fetchModels-provider sweep (upsert-only, never removal -- see header).
   * planSpawn re-reads its keys per call, so new models become spreadable
   * immediately; running tasks keep their locked placements.
   */
  modelRegistry?: Record<string, ModelConfig>;
  /** Resolved contextLimit for entries built by the catalog piggyback. */
  contextLimit?: number;
  /**
   * Fired from noteUp when a down verdict was actually cleared. Health owns no
   * TaskManager knowledge; the caller wires this to its admission pass so a
   * recovered provider wakes queued tasks without waiting for the next
   * terminal transition.
   */
  onRecover?: (name: string) => void;
}

export interface ProviderHealth {
  isDown(name: string): boolean;
  markDown(name: string, reason: string): void;
  noteUp(name: string): void;
  /** Run one sweep now (the interval calls this; `hotdog info` does a single one). */
  sweep(): Promise<void>;
  /** Snapshot for diagnostics (`hotdog info` per-provider up/down). */
  status(): Array<{ name: string; down: boolean; reason: string | null }>;
  stop(): void;
}

const urlOf = (def: ProviderDef, baseUrl?: string): string => def.url || baseUrl || "";

export function makeProviderHealth(options: ProviderHealthOptions): ProviderHealth {
  const { providers, globals = {}, modelRegistry, contextLimit } = options;
  const timeoutMs = options.timeoutMs;

  // Probe failures are operational -- catching dead sockets is the probe's
  // entire job -- so verdicts keep only the first line (Bun's fetch rejects
  // plain Errors, whose full rendering buries the reason in a stack).
  // formatError still owns the formatting, per the project error rule.
  const probeReason = (e: unknown): string =>
    (formatError(e).split("\n")[0] ?? "").trim() || "probe failed";

  if (modelRegistry && contextLimit == null && providers.some((p) => p.fetchModels)) {
    // A fetchModels provider with no resolved contextLimit means piggyback
    // entries the backend gave no limit for will carry 0. All entry points
    // pass the resolved value; embedded hosts must too.
    logger.warn(
      "[health] modelRegistry given without contextLimit: catalog piggyback entries without a remote limit get 0",
    );
  }

  const defaultProbe: ProviderProbe = async (def, url, apiKey) => {
    if (def.fetchModels) {
      // Piggyback: /v1/models answers the health question AND refreshes the catalog.
      const outcome = await fetchRemoteModelsOutcome(url, apiKey, timeoutMs);
      return outcome.reachable
        ? { up: true, models: outcome.entries }
        : { up: false, reason: probeReason(outcome.reason ?? "connection failed") };
    }
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    try {
      // Status-agnostic: hotdogFetch resolves on ANY HTTP response; only
      // refused/timeout/DNS throw. Same endpoint as the LlmClient ping.
      await hotdogFetch(`${url.replace(/\/+$/, "")}/health`, { headers }, timeoutMs);
      return { up: true };
    } catch (e: unknown) {
      return { up: false, reason: probeReason(e) };
    }
  };
  const probe = options.probe ?? defaultProbe;

  // Provider name -> failure reason. Absence means up (fail-open for unknown names).
  const down = new Map<string, string>();

  const markDown = (name: string, reason: string): void => {
    if (!name || down.has(name)) return;
    down.set(name, reason);
    logger.warn(`[health] provider '${name}' marked down: ${reason}`);
  };

  const noteUp = (name: string): void => {
    if (!down.delete(name)) return;
    logger.info(`[health] provider '${name}' recovered`);
    try {
      options.onRecover?.(name);
    } catch (e: unknown) {
      // The verdict already flipped; a faulty admission callback must not
      // abort the rest of the sweep.
      logger.error(`[health] onRecover for '${name}' threw: ${formatError(e)}`);
    }
  };

  let sweeping: Promise<void> | null = null;
  const sweep = (): Promise<void> => {
    // Overlapping sweeps would race on the same probe set; skip if one is in flight.
    if (!sweeping) {
      sweeping = doSweep().finally(() => {
        sweeping = null;
      });
    }
    return sweeping;
  };

  async function doSweep(): Promise<void> {
    // Concurrent probes: a dead backend burns its timeout in parallel with the
    // others, so a sweep costs one timeout, not N (`hotdog info` waits on it).
    await Promise.all(
      providers.map(async (def) => {
        const url = urlOf(def, globals.baseUrl);
        if (!url) return; // nothing to probe: never demote a provider we cannot reach by config
        let result: ProbeResult;
        try {
          result = await probe(def, url, def.apiKey || globals.apiKey, timeoutMs);
        } catch (e: unknown) {
          // A throwing probe (injected or default) says nothing about the provider; leave state alone.
          logger.error(`[health] probe for '${def.name}' threw: ${formatError(e)}`);
          return;
        }
        if (!result.up) {
          markDown(def.name, result.reason ?? "probe failed");
          return;
        }
        noteUp(def.name);
        if (def.fetchModels && modelRegistry && result.models) {
          try {
            // UPSERT ONLY, never remove: eviction would need in-use checks against
            // TaskManager occupancy (running tasks hold locked placements).
            Object.assign(
              modelRegistry,
              await buildProviderModels(def, contextLimit ?? 0, globals, result.models),
            );
          } catch (e: unknown) {
            // Health verdict stands; a bad body just skips this refresh round.
            logger.error(`[health] catalog refresh failed for '${def.name}': ${formatError(e)}`);
          }
        }
      }),
    );
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (options.intervalMs > 0) {
    // Sweep immediately at startup, then on the interval: a provider dead at
    // boot looks idle/cold -- the PREFERRED placement target -- until the
    // first tick, so without this the session's first fanout still burns its
    // retries on it. No onRecover can fire (no verdict exists to clear yet);
    // this pass only demotes and refreshes catalogs.
    void sweep();
    timer = setInterval(() => {
      void sweep();
    }, options.intervalMs);
    // Never hold the process open: one-shot mode must still exit.
    timer.unref?.();
  }

  return {
    isDown: (name: string) => down.has(name),
    markDown,
    noteUp,
    sweep,
    status: () =>
      providers.map((def) => ({
        name: def.name,
        down: down.has(def.name),
        reason: down.get(def.name) ?? null,
      })),
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
