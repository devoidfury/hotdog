/**
 * agent-view.ts -- the live agent.config view (design §4.2, batch B5).
 *
 * `agent.config` on the DEFAULT (store-backed) factory path is a Proxy over
 * the live ConfigStore with a per-agent own-property overlay: overlay own
 * props win (build-time pins, profile-switch writes, per-call overrides);
 * everything else falls through resolved-FIRST, then the config bag
 * (extension blocks + passthrough keys like modelPricing live only there).
 * Resolved-first is the provenance fix: today's authoritative agent values
 * are resolved-sourced (cli layers -- `--max-iterations`, `--tokens` --
 * exist only on the resolved bag), so a config-bag-only base would silently
 * drop the operator's cli flags.
 *
 * MIGRATION RULE (the law of this file): a spread of the view
 * (`{ ...agent.config }`, `Object.keys`, `JSON.stringify`) is a
 * POINT-IN-TIME COPY by definition. Relying on a spread staying current is
 * FORBIDDEN -- consumers that want the live value read a property at the
 * point of use; consumers that snapshot accept the freeze. `has()` means "a
 * value EXISTS" (resolved holds undefined slots for unresolved schema keys;
 * those fall to config, then report absent).
 *
 * Compile shape: target and bag reads go through Record<string | symbol,
 * unknown> casts (symbol keys; strict tsc + noUncheckedIndexedAccess per
 * the repo gate). Everything here is a plain-object target, so no
 * non-configurable-property proxy invariants are involved.
 */
import type { ConfigStore } from "./store.ts";

/** Resolved-only DERIVED artifacts -- the factory consumes them via
 *  resolved.*, never as agent config. Never enumerated into agent.config
 *  (get() still reads through): whole-config spreads/serializations cannot
 *  silently start shipping live objects (the ProfileManager, the model
 *  registry...). §9 test 7 pins this exact set. */
export const AGENT_VIEW_EXCLUDED: ReadonlySet<string> = new Set([
  "model",
  "modelRegistry",
  "profileManager",
  "profileDef",
  "profiles",
  "systemPromptTemplate",
]);

export function liveAgentConfig(
  store: ConfigStore,
  overlay: Record<string, unknown>, // per-agent pins (invariant above)
): Record<string, unknown> {
  const baseValue = (k: string | symbol): unknown => {
    const g = store.current();
    const fromResolved = (g.resolved as Record<string | symbol, unknown> | undefined)?.[k];
    return fromResolved !== undefined
      ? fromResolved
      : (g.config as Record<string | symbol, unknown>)[k];
  };
  const baseKeys = (): (string | symbol)[] => {
    const g = store.current();
    return [...new Set([
      ...Reflect.ownKeys((g.resolved ?? {}) as object),
      ...Reflect.ownKeys(g.config as object),
    ])];
  };
  return new Proxy(overlay, {
    get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : baseValue(k)),
    has: (t, k) => k in t || baseValue(k) !== undefined,
    ownKeys: (t) =>
      [...new Set([...Reflect.ownKeys(t), ...baseKeys()])].filter(
        (k) => !AGENT_VIEW_EXCLUDED.has(k as string),
      ),
    getOwnPropertyDescriptor: (t, k) => ({
      configurable: true,
      enumerable: true,
      value: k in t ? (t as Record<string | symbol, unknown>)[k] : baseValue(k),
    }),
    // Writes land in the overlay ONLY: an agent's own mutation (applyProfile's
    // blacklistTools, a per-session override) pins over the live base exactly
    // like the pre-B5 copied bag did; the store's generation is never touched.
    set: (t, k, v) => {
      (t as Record<string | symbol, unknown>)[k] = v;
      return true;
    },
    // Only overlay keys delete. A base-only delete is REFUSED: false from the
    // trap makes the strict-mode caller THROW (loud, never a silent no-op that
    // pretends the base value vanished).
    deleteProperty: (t, k) => k in t && Reflect.deleteProperty(t, k),
  });
}
