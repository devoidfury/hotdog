/**
 * Safely access a nested property path on an object.
 */
export function getNested<T = unknown>(obj: unknown, path: string): T | undefined {
  if (!obj || !path) return undefined;

  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current as T | undefined;
}

/**
 * Strip null fields from an object for serialization.
 */
export function stripNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null) {
      result[k] = v;
    }
  }
  return result as Partial<T>;
}

/**
 * Deep-merge objects together, like Object.assign but recursive.
 *
 * - Nested plain objects are merged key-by-key.
 * - Arrays (and other non-object values) from later sources replace earlier ones.
 * - null/undefined sources are skipped.
 * - Returns a new object — source objects are not mutated.
 */
export function deepMerge(
  ...sources: (Record<string, any> | null | undefined | unknown)[]
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const source of sources) {
    if (source == null || typeof source !== "object") continue;

    for (const [key, value] of Object.entries(source)) {
      if (
        value != null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (result as Record<string, unknown>)[key] != null &&
        typeof (result as Record<string, unknown>)[key] === "object" &&
        !Array.isArray((result as Record<string, unknown>)[key])
      ) {
        // Both are plain objects → recurse
        (result as Record<string, unknown>)[key] = deepMerge(
          (result as Record<string, unknown>)[key] as object,
          value as object,
        );
      } else {
        // Arrays, primitives, or first-seen value → replace
        (result as Record<string, unknown>)[key] = value;
      }
    }
  }

  return result;
}
