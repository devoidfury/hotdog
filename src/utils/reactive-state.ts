/**
 * reactiveState — a tiny reactive atom.
 *
 * Usage:
 *
 *   const count = reactiveState(0);
 *   console.log(count());           // get → 0
 *   count(42);                      // set → triggers effects
 *
 *   const stop = count.effect(() => {
 *     console.log("count is", count());
 *   });
 *   count(1);                       // logs "count is 1"
 *   stop();                         // unsubscribe
 *
 * Effects run synchronously whenever the value changes.
 * Setting to the same primitive value does NOT trigger effects.
 * Setting an object/array value ALWAYS triggers effects (reference
 * equality is unreliable for detecting "real" changes).
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

/** True for values that are compared by reference (objects, arrays, etc.). */
function isObjectLike(v: unknown): v is object {
  return v !== null && typeof v === "object";
}

// ── Atom factory ────────────────────────────────────────────────────────────

/**
 * A reactive atom — getter/setter with effect subscriptions.
 */
export interface Atom<T> {
  (): T;
  (newValue: T): void;
  effect(fn: () => void): () => void;
}

export function reactiveState<T>(initialValue: T): Atom<T> {
  let currentValue = initialValue;
  const effects = new Set<() => void>();

  /** The atom function — getter or setter. */
  function atom(newValue?: T): T {
    if (arguments.length === 0) return currentValue;

    // For primitives: skip if same value (prevents no-op re-triggers)
    // For objects: always fire because internal mutation can't be tracked
    if (!isObjectLike(newValue) && newValue === currentValue) return currentValue;

    currentValue = newValue;

    // Run every registered effect synchronously
    for (const fn of effects) {
      fn();
    }

    return currentValue;
  }

  /**
   * Subscribe to changes. Returns a cleanup function.
   */
  atom.effect = function (fn: () => void): () => void {
    effects.add(fn);
    return () => {
      effects.delete(fn);
    };
  };

  return atom;
}

// ── Multi-dependency effect ─────────────────────────────────────────────────

/**
 * Subscribe an effect to one or more reactive atoms.
 * Runs `fn` immediately, then re-runs whenever any dependency changes.
 *
 * @param fn - the effect callback
 * @param dependencies - array of reactiveState atoms
 * @returns cleanup — call to stop the effect
 */
export function effect(
  fn: () => void,
  dependencies: Atom<unknown>[],
): () => void {
  // Wrap so the same function reference is used across all deps
  const wrapped = (): void => {
    fn();
  };
  const unsubs = dependencies.map((dep) => dep.effect(wrapped));
  // Run immediately to establish initial state
  fn();
  // Return a cleanup that unsubscribes from all deps
  return () => {
    unsubs.forEach((u) => u());
  };
}
