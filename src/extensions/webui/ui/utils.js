// Shared utilities for the WebUI frontend.
// Also includes the reactive state atom (reativeState) and multi-dep effect.

// ── Reactive state helpers ─────────────────────────────────────────────────

/** True for values that are compared by reference (objects, arrays, etc.). */
function isObjectLike(v) {
  return v !== null && typeof v === "object";
}

/**
 * Create a reactive atom — getter/setter with effect subscriptions.
 *
 * @param {*} initialValue
 * @returns {Function} state(val?) — getter/setter, plus .effect(fn)
 */
export function reativeState(initialValue) {
  let currentValue = initialValue;
  const effects = new Set();

  function atom(newValue) {
    if (arguments.length === 0) return currentValue;

    // For primitives: skip if same value (prevents no-op re-triggers)
    // For objects: always fire because internal mutation can't be tracked
    if (!isObjectLike(newValue) && newValue === currentValue) return;

    currentValue = newValue;

    for (const fn of effects) {
      fn();
    }
  }

  atom.effect = function (fn) {
    effects.add(fn);
    return () => {
      effects.delete(fn);
    };
  };

  return atom;
}

/**
 * Subscribe an effect to one or more reactive atoms.
 * Runs `fn` immediately, then re-runs whenever any dependency changes.
 *
 * @param {Function} fn
 * @param {Array<Function>} dependencies - array of reativeState atoms
 * @returns {Function} cleanup
 */
export function effect(fn, dependencies) {
  const wrapped = () => { fn(); };
  const unsubs = dependencies.map(dep => dep.effect(wrapped));
  fn();
  return () => { unsubs.forEach(u => u()); };
}

// ── Formatting & sanitisation ───────────────────────────────────────────────

export function formatTime(ts) {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

export function shortId(sessionId) {
  return sessionId ? sessionId.slice(0, 8) : "???";
}

export function sanitize(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&#34;")
    .replace(/'/g, "&#39;");
}

export function escapeJson(str) {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}
