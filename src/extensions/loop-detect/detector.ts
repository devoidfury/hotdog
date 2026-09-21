// Pure tool-loop detection -- no I/O, no hooks, no state.
//
// callSignature(toolName, input) reduces a tool call to a canonical hash:
// JSON arguments are re-serialized with object keys sorted, so cosmetic
// differences (whitespace, {"a":1,"b":2} vs {"b":2,"a":1}) share one hash;
// non-JSON arguments fall back to the trimmed string.
//
// detectLoop() inspects the tail of the signature history for the two spin
// patterns: k consecutive identical calls, or strict two-call alternation
// (ping-pong). escalationLevel() maps the streak onto the ladder:
// 1 = nudge (streak >= t), 2 = stronger nudge (>= 2t), 3 = stop (>= 3t).

export type LoopKind = "repeat" | "ping_pong";

export interface LoopVerdict {
  kind: LoopKind;
  streak: number;
  /** The threshold this verdict crossed (repeat or ping-pong). */
  threshold: number;
}

/** FNV-1a, 32-bit. Enough spread for deduping a window of call hashes. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** JSON re-serialized with object keys sorted; arrays keep their order. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export function callSignature(toolName: string, input: string): string {
  const trimmed = (input ?? "").trim();
  let norm = trimmed;
  if (trimmed) {
    try {
      norm = canonicalize(JSON.parse(trimmed));
    } catch {
      // Non-JSON args (rare, but tool inputs are model-authored): compare raw.
      norm = trimmed;
    }
  }
  // NUL separator: no tool name can contain it, so (name, args) can't collide.
  return fnv1a([toolName, norm].join("\u0000"));
}

/** Length of the identical-suffix run (0 for empty, 1 for a non-looping tail). */
export function repeatRun(sigs: string[]): number {
  const n = sigs.length;
  if (n === 0) return 0;
  let i = n - 1;
  while (i >= 1 && sigs[i] === sigs[i - 1]) i--;
  return n - i;
}

/**
 * Length of the strict-alternation suffix (A,B,A,B,... with A != B).
 * Pure repeats fail the `sigs[i] !== sigs[i-1]` guard, so the two patterns
 * never both fire on the same tail.
 */
export function alternatingRun(sigs: string[]): number {
  const n = sigs.length;
  if (n === 0) return 0;
  let lowest = -1;
  for (let i = n - 1; i >= 2; i--) {
    if (sigs[i] === sigs[i - 2] && sigs[i] !== sigs[i - 1]) lowest = i;
    else break;
  }
  if (lowest === -1) return n >= 2 && sigs[n - 1] !== sigs[n - 2] ? 2 : 1;
  return n - lowest + 2;
}

export function detectLoop(
  sigs: string[],
  opts: { repeatThreshold: number; pingPongThreshold: number },
): LoopVerdict | null {
  const r = repeatRun(sigs);
  if (r >= opts.repeatThreshold) {
    return { kind: "repeat", streak: r, threshold: opts.repeatThreshold };
  }
  const a = alternatingRun(sigs);
  if (a >= opts.pingPongThreshold) {
    return { kind: "ping_pong", streak: a, threshold: opts.pingPongThreshold };
  }
  return null;
}

export function escalationLevel(verdict: LoopVerdict): 1 | 2 | 3 {
  const t = verdict.threshold;
  if (verdict.streak >= 3 * t) return 3;
  if (verdict.streak >= 2 * t) return 2;
  return 1;
}

/** One-line loop description shared by the model-facing notice and the stop message. */
export function describeLoop(kind: LoopKind, streak: number, toolName: string): string {
  return kind === "repeat"
    ? `\`${toolName}\` was called ${streak} times in a row with identical arguments`
    : `tool calls ping-ponged for ${streak} calls in a strict A/B/A/B pattern (last call: \`${toolName}\`)`;
}
