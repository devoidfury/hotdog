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
 */

function isObjectLike(v: unknown): v is object {
  return v !== null && typeof v === "object";
}

export interface Atom<T> {
  (): T;
  (newValue: T): T;
  effect(fn: () => void): () => void;
}

export function reactiveState<T>(initialValue: T): Atom<T> {
  let currentValue = initialValue;
  const effects = new Set<() => void>();

  function atom(newValue?: T): T {
    if (arguments.length === 0) return currentValue;

    // Primitives: skip no-op sets. Objects always fire -- internal mutation
    // can't be tracked, so reference equality would miss real changes.
    if (newValue !== undefined && !isObjectLike(newValue) && newValue === currentValue) return currentValue;

    currentValue = newValue as T;

    for (const fn of effects) {
      fn();
    }

    return currentValue;
  }

  atom.effect = function (fn: () => void): () => void {
    effects.add(fn);
    return () => {
      effects.delete(fn);
    };
  };

  return atom;
}

/** Subscribe an effect to one or more atoms; runs immediately and on change. */
export function effect(fn: () => void, dependencies: { effect(fn: () => void): () => void }[]): () => void {
  // One shared reference across all deps so each fires the same effect.
  const wrapped = (): void => {
    fn();
  };
  const unsubs = dependencies.map((dep) => dep.effect(wrapped));
  fn();
  return () => {
    unsubs.forEach((u) => u());
  };
}
