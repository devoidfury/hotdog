/**
 * Config apply-hook registry -- config-as-side-effect (design §3.1/§3.2, batch B4).
 *
 * One typed table (not scattered `if (keyPath === ...)` in the write handler):
 * a hook declares a keyPath PREFIX matched against the changed ROOTS of the
 * candidate generation ("" matches every publish), a phase, and an optional
 * per-hook timeout. Registration returns the unregister closure; hooks run in
 * REGISTRATION ORDER (deterministic: core hooks register before extension
 * hooks by load order -- createCore runs before extension create()).
 *
 * Phase semantics (the validate-then-swap spine, §2.4):
 * - "prepare" runs BEFORE the store swap. A throw REFUSES the swap: the store
 *   keeps the previous generation, the value stays persisted in the file, the
 *   reply says restart-required + the refuse reason. This is what makes
 *   recompile/rebuild classes safe (the risky part runs while refusal is free).
 * - "apply" runs AFTER the swap and may NOT veto: a throw or timeout is a
 *   degraded report (§3.2: a failed apply hook NEVER re-swaps the store --
 *   the store's contract is "what the persisted+verified config says", and
 *   the file write is already authoritative).
 *
 * Timeout doctrine (§2.4): the transaction runs inside the non-reentrant
 * config-edit lock, so a hung hook is a hung panel. Default 2000ms, cap
 * 15000ms, mandatory-by-review on any hook that awaits I/O. A timed-out hook
 * keeps running in the background (JS offers no cooperative cancel); the
 * transaction proceeds past it -- that is why every awaited side effect needs
 * its own timeoutMs, and why timers are the one resource to cap, not trust.
 */
import { formatError } from "@core/error.ts";
import type { ConfigStore } from "./store.ts";
import type { CoreContext } from "../extensions/types.ts";

export type HookStatus = "applied" | "degraded" | "refused";

export interface ConfigApplyContext {
  store: ConfigStore;
  /** Audit-notice fan-out: logger.warn("[config-live] ...") (the §5.3 floor;
   *  the shared session/log-surface notice rides the same helper in B8).
   *  Secret-free by construction: callers pass human text, never raw values
   *  for secret paths. */
  notice: (text: string) => void;
  /** The live core (registries, services) for rebuild hooks that need it. */
  core: CoreContext;
}

export interface ConfigApplyHook {
  /** Prefix over changed keyPaths: "webui.port", "userGate.deny",
   *  "providers", "" (every publish). Registered once, at create(). */
  keyPath: string;
  /** Runs BEFORE the swap and may VETO (throw aborts the swap ->
   *  restart-required + reason). Runs AFTER the swap and may NOT veto (a
   *  throw/timeout is a degraded report; the store stays on the new value). */
  phase: "prepare" | "apply";
  /** Mandatory for anything that awaits I/O; default 2000ms, cap 15000ms. */
  timeoutMs?: number;
  /** previous/next: values at this hook's keyPath (prepare reads both from
   *  args -- the store still holds the old generation). They are the generic
   *  config-bag reads; an apply hook that needs the resolution chain's
   *  authoritative value reads `ctx.store.current().resolved` itself (the
   *  swap completed before apply hooks run, §1.5). */
  handle(ctx: ConfigApplyContext, previous: unknown, next: unknown): void | Promise<void>;
}

/** The one hook table. Registration order is run order; unregister removes
 *  the exact entry (identity), so a test or an extension lifecycle can attach
 *  and detach without reordering the rest. */
const hooks: ConfigApplyHook[] = [];

export const DEFAULT_HOOK_TIMEOUT_MS = 2000;
export const HOOK_TIMEOUT_CAP_MS = 15000;

/** Registration returns the unregister fn; hooks run in registration order
 *  (deterministic; core hooks register before extension hooks by load order). */
export function registerConfigApplyHook(hook: ConfigApplyHook): () => void {
  hooks.push(hook);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const i = hooks.indexOf(hook);
    if (i >= 0) hooks.splice(i, 1);
  };
}

/** Snapshot copy of the table (§4.5 hook-coverage walk + tests). */
export function registeredHooks(): readonly ConfigApplyHook[] {
  return [...hooks];
}

/** Effective per-hook timeout: default when unset/non-finite/non-positive,
 *  always capped. (A hook cannot opt out of the cap -- the edit lock is
 *  shared with the panel's own reply.) */
export function hookTimeoutMs(hook: ConfigApplyHook): number {
  const t = hook.timeoutMs;
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
    return DEFAULT_HOOK_TIMEOUT_MS;
  }
  return Math.min(t, HOOK_TIMEOUT_CAP_MS);
}

/** Prefix match against the generation's changed ROOTS: the hook's FIRST path
 *  segment must be one of the differing roots; "" matches every publish.
 *  Root-segment equality, not string prefix ("web" never matches "webui").
 *
 *  THE RULE, written down (B4 review): matching is ROOT-granular against
 *  generation.changed, so a sibling write under the same top-level root FIRES
 *  the row -- observed: a `websocket.questionTimeoutSecs` write fires the
 *  `sessionTimeoutMin` hook (harmless today: it re-arms the age it just read
 *  from the swapped bag; the cost is a noisy audit line). Fine-grained rows
 *  that rebind/recompile (webui.port vs webui.apiKey, userGate.allow vs deny
 *  -- B8's set) MUST NOT trust this match alone: they add a value-changed
 *  guard (compare generationValueAt(previous/next, keyPath)) or they act on
 *  sibling writes. */
export function hookMatchesChangedRoot(hookKeyPath: string, changedRoots: readonly string[]): boolean {
  if (hookKeyPath === "") return true;
  return changedRoots.includes(hookKeyPath.split(".")[0]!);
}

/** The hooks for one phase, in registration order, filtered by the candidate's
 *  changed roots. */
export function hooksForPhase(
  phase: "prepare" | "apply",
  changedRoots: readonly string[],
): ConfigApplyHook[] {
  return hooks.filter((h) => h.phase === phase && hookMatchesChangedRoot(h.keyPath, changedRoots));
}

/** Per-hook run ledger entry -- the truth of the side effects, reply-bound (§7.1). */
export interface ApplyHookRunReport {
  keyPath: string;
  phase: "prepare" | "apply";
  status: HookStatus;
  error?: string;
}

/**
 * Run one hook under its timeout. Never throws: the outcome is a report.
 * prepare failure = "refused" (the transaction aborts the swap on it);
 * apply failure = "degraded" (value stays new, old side effect keeps running).
 */
export async function runConfigApplyHook(
  ctx: ConfigApplyContext,
  hook: ConfigApplyHook,
  previous: unknown,
  next: unknown,
): Promise<ApplyHookRunReport> {
  const ms = hookTimeoutMs(hook);
  const attempt = (async () => hook.handle(ctx, previous, next))();
  // A rejection AFTER a timeout races past the report; nobody is listening
  // anymore -- swallow it so a late throw cannot become an unhandled
  // rejection (the degraded report for this run is already decided).
  attempt.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      attempt,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`apply hook "${hook.keyPath}" (${hook.phase}) timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
    return { keyPath: hook.keyPath, phase: hook.phase, status: "applied" };
  } catch (e) {
    return {
      keyPath: hook.keyPath,
      phase: hook.phase,
      status: hook.phase === "prepare" ? "refused" : "degraded",
      error: formatError(e),
    };
  } finally {
    clearTimeout(timer);
  }
}
