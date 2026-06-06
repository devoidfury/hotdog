/**
 * Strip null fields from an object for serialization.
 */
export function stripNulls(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null) {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Deep-merge objects together, like Object.assign but recursive.
 *
 * - Nested plain objects are merged key-by-key.
 * - Arrays (and other non-object values) from later sources replace earlier ones.
 * - null/undefined sources are skipped.
 * - Returns a new object — source objects are not mutated.
 */
export function deepMerge(...sources) {
  const result = {};

  for (const source of sources) {
    if (source == null || typeof source !== "object") continue;

    for (const [key, value] of Object.entries(source)) {
      if (
        value != null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        result[key] != null &&
        typeof result[key] === "object" &&
        !Array.isArray(result[key])
      ) {
        // Both are plain objects → recurse
        result[key] = deepMerge(result[key], value);
      } else {
        // Arrays, primitives, or first-seen value → replace
        result[key] = value;
      }
    }
  }

  return result;
}
