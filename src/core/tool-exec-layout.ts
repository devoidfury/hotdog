// Process-layout constants shared by the tool exec plane's programs: the
// supervisor (`tool-exec-broker.ts`), the broker child
// (`tool-exec-broker-main.ts`), and anything else that must name the runner
// or the repo root. One home so the knob the supervisor hands down on argv
// and the default the child parses can never drift apart.

import { fileURLToPath } from "node:url";

export const RUNNER_ENTRY = fileURLToPath(new URL("../workers/tool-exec.ts", import.meta.url));

/**
 * The hard-egress netns shim (fetchPolicy.hardEgress). Part of the fence
 * argv for hardened entries: it builds the private user+net namespace and
 * raises the jail's loopback before exec-ing the rest of the chain.
 */
export const NETNS_SHIM_ENTRY = fileURLToPath(new URL("../utils/netns-shim.ts", import.meta.url));

/**
 * Hotdog's repo root (where tsconfig.json lives). Child processes are spawned
 * with this cwd so Bun resolves the `@core`/`@extensions`/`@utils` path
 * aliases no matter where the user launched hotdog from.
 */
export const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * How long a pool entry may sit with no calls before the broker drops it.
 * Generous: re-spawn costs ~100ms and only a session that went
 * quiet pays it, so the cheap direction is to keep entries.
 */
const DEFAULT_IDLE_REAP_MS = 5 * 60_000;

/**
 * Resolve the idle-reap knob: the value the supervisor has (option / argv
 * flag), else this module's default. The constant stays private here (the
 * owning-module precedent) so the spawn argv and the child's parse of it
 * share one default with no drift.
 */
export function idleReapMsOrDefault(idleReapMs?: number): number {
  return idleReapMs ?? DEFAULT_IDLE_REAP_MS;
}
