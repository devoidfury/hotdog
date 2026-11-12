// Minimal version + range matching for the extension manifest `sdk` field.
//
// Contract, deliberately small (no pre-release, wildcards, caret, tilde, or ||):
//   version      1-3 dot-separated numeric segments, missing segments read as 0
//                e.g. "0.16" == "0.16.0"
//   range        comparators joined by whitespace; ALL must hold (AND)
//   comparator   ">=" | ">" | "<=" | "<" | "=" followed by a version;
//                a bare version means "="
// Examples: ">=0.16"  ">=0.16 <1.0"  "=0.16.2"
//
// The manifest reader fail-closes on an unparsable range (broken manifest),
// so parsing strictness lives here: anything the grammar above does not
// produce is null, never a permissive fallback.

export type RangeOp = ">=" | ">" | "<=" | "<" | "=";

export interface VersionComparator {
  op: RangeOp;
  segments: number[];
}

const COMPARATOR_RE = /^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2})$/;

/** Parses "0.16.2" into segments; null on anything non-numeric or >3 segments. */
export function parseVersion(input: string): number[] | null {
  if (!/^\d+(?:\.\d+){0,2}$/.test(input)) return null;
  return input.split(".").map(Number);
}

/** Parses a full range; null if any comparator is malformed or the range is empty. */
export function parseVersionRange(range: string): VersionComparator[] | null {
  // Join ">= 0.16" (operator-space, npm-tolerated) before splitting, so
  // comparators are the only whitespace-separated units.
  const parts = range
    .trim()
    .replace(/(>=|<=|>|<|=)\s+/g, "$1")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return null;
  const comparators: VersionComparator[] = [];
  for (const part of parts) {
    const m = COMPARATOR_RE.exec(part);
    if (!m) return null;
    const segments = parseVersion(m[2]!);
    if (segments === null) return null;
    comparators.push({ op: (m[1] ?? "=") as RangeOp, segments });
  }
  return comparators;
}

/** Segment-wise compare with zero-padding. Inputs must be parsed (validated) versions. */
function compareSegments(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True if `version` satisfies every comparator. Null version/range reads as no-match. */
export function rangeMatches(
  version: string,
  comparators: readonly VersionComparator[] | null,
): boolean {
  if (!comparators || comparators.length === 0) return false;
  const v = parseVersion(version.trim());
  if (v === null) return false;
  for (const { op, segments } of comparators) {
    const c = compareSegments(v, segments);
    switch (op) {
      case ">=":
        if (c < 0) return false;
        break;
      case ">":
        if (c <= 0) return false;
        break;
      case "<=":
        if (c > 0) return false;
        break;
      case "<":
        if (c >= 0) return false;
        break;
      case "=":
        if (c !== 0) return false;
        break;
    }
  }
  return true;
}
