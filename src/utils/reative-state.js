/**
 * reativeState — a tiny reactive atom.
 *
 * Usage:
 *
 *   const count = reativeState(0);
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
 *
 * @param {*} initialValue
 * @returns {Function} state(val?) — getter/setter, plus .effect(fn)
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

/** True for values that are compared by reference (objects, arrays, etc.). */
function isObjectLike(v) {
  return v !== null && typeof v === "object";
}

// ── Atom factory ────────────────────────────────────────────────────────────

export function reativeState(initialValue) {
  let currentValue = initialValue;
  const effects = new Set();

  /** The atom function — getter or setter. */
  function atom(newValue) {
    if (arguments.length === 0) return currentValue;

    // For primitives: skip if same value (prevents no-op re-triggers)
    // For objects: always fire because internal mutation can't be tracked
    if (!isObjectLike(newValue) && newValue === currentValue) return;

    currentValue = newValue;

    // Run every registered effect synchronously
    for (const fn of effects) {
      fn();
    }
  }

  /**
   * Subscribe to changes. Returns a cleanup function.
   * @param {Function} fn - called whenever the value changes
   * @returns {Function} unsubscribe
   */
  atom.effect = function (fn) {
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
 * @param {Function} fn - the effect callback
 * @param {Array<Function>} dependencies - array of reativeState atoms
 * @returns {Function} cleanup — call to stop the effect
 *
 * Usage:
 *   const stop = effect(() => {
 *     console.log("count:", count(), "name:", name());
 *   }, [count, name]);
 */
export function effect(fn, dependencies) {
  // Wrap so the same function reference is used across all deps
  const wrapped = () => { fn(); };
  const unsubs = dependencies.map(dep => dep.effect(wrapped));
  // Run immediately to establish initial state
  fn();
  // Return a cleanup that unsubscribes from all deps
  return () => { unsubs.forEach(u => u()); };
}
