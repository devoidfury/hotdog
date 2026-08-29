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
 * Recursive Object.assign: nested plain objects merge key-by-key; arrays and
 * other values replace. Returns a new object; sources are not mutated.
 */
export function deepMerge(
  ...sources: (Record<string, unknown> | null | undefined | unknown)[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

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
        (result as Record<string, unknown>)[key] = deepMerge(
          (result as Record<string, unknown>)[key] as object,
          value as object,
        );
      } else {
        (result as Record<string, unknown>)[key] = value;
      }
    }
  }

  return result;
}
