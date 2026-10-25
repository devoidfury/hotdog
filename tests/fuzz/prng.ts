// Shared deterministic PRNG + split helpers for the fuzz suites (zero dependencies).
// splitmix32 over xorshift32: same cost, full-period counter state, one call decorrelates
// nearby seeds, so derived seeds (seed + suiteId) stay independent.

export interface Rng {
  next(): number; // uint32
  float(): number; // uniform in [0, 1)
  int(n: number): number; // uniform integer in [0, n), rejection-sampled (no modulo bias)
  pick<T>(arr: readonly T[]): T; // uniform element; throws on empty array
  bool(p?: number): boolean; // true with probability p (default 0.5)
  bytes(n: number): Uint8Array; // n uniform bytes
}

export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return (z ^ (z >>> 14)) >>> 0;
  };
  const float = (): number => next() / 2 ** 32;
  const int = (n: number): number => {
    if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new RangeError(`int: n must be an integer in [1, 2**32], got ${n}`);
    const limit = 2 ** 32 - (2 ** 32 % n); // rejection bound kills modulo bias
    let r: number;
    do r = next(); while (r >= limit);
    return r % n;
  };
  return {
    next,
    float,
    int,
    pick: (arr) => {
      if (arr.length === 0) throw new RangeError("pick: empty array");
      return arr[int(arr.length)]!;
    },
    bool: (p = 0.5) => {
      if (!(p >= 0 && p <= 1)) throw new RangeError(`bool: p must be in [0, 1], got ${p}`);
      return float() < p;
    },
    bytes: (n) => {
      if (!Number.isInteger(n) || n < 0) throw new RangeError(`bytes: n must be a non-negative integer, got ${n}`);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i += 4) {
        const w = next();
        out[i] = w & 0xff;
        if (i + 1 < n) out[i + 1] = (w >>> 8) & 0xff;
        if (i + 2 < n) out[i + 2] = (w >>> 16) & 0xff;
        if (i + 3 < n) out[i + 3] = (w >>> 24) & 0xff;
      }
      return out;
    },
  };
}

export type ChunkMode = "random" | "adversarial";

const SMALL_INPUT = 16; // at or below this length, adversarial mode splits every unit if the budget allows

// Cut points shared by both chunk variants: unique, sorted, each in [1, len).
// "random" picks 0..budget cuts uniformly. "adversarial" spends its budget on the
// off-by-one boundaries (after unit 1, after unit 2, before the last unit), fills the
// rest randomly, and splits every unit for small inputs when maxPieces >= len.
function boundaries(rng: Rng, len: number, maxPieces: number, mode: ChunkMode): number[] {
  if (!Number.isInteger(maxPieces) || maxPieces < 1) throw new RangeError(`maxPieces must be a positive integer, got ${maxPieces}`);
  const budget = Math.min(maxPieces, len) - 1; // every piece is at least one unit long
  if (budget <= 0) return [];
  const cuts = new Set<number>();
  if (mode === "adversarial") {
    if (len <= SMALL_INPUT && maxPieces >= len) {
      for (let b = 1; b < len; b++) cuts.add(b);
    } else {
      for (const b of [1, 2, len - 1]) {
        if (cuts.size >= budget) break;
        if (b >= 1 && b < len) cuts.add(b);
      }
    }
  }
  const target = mode === "adversarial" ? budget : rng.int(budget + 1);
  while (cuts.size < target) cuts.add(1 + rng.int(len - 1));
  return [...cuts].sort((a, b) => a - b);
}

// Splits data into 1..maxPieces pieces that cover it exactly (concat of parts === input).
// String cuts fall on UTF-16 code-unit boundaries and may bisect a surrogate pair:
// consumers must cope with lone-surrogate chunks. Empty input yields [""].
export function randomChunks(
  rng: Rng,
  data: string,
  maxPieces: number,
  mode: ChunkMode = "random",
): string[] {
  const out: string[] = [];
  let at = 0;
  for (const b of boundaries(rng, data.length, maxPieces, mode)) {
    out.push(data.slice(at, b));
    at = b;
  }
  out.push(data.slice(at));
  return out;
}

// Bytes variant. Pieces are views into data (zero-copy); reassembly must not mutate them.
export function randomChunksBytes(
  rng: Rng,
  data: Uint8Array,
  maxPieces: number,
  mode: ChunkMode = "random",
): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  for (const b of boundaries(rng, data.length, maxPieces, mode)) {
    out.push(data.subarray(at, b));
    at = b;
  }
  out.push(data.subarray(at));
  return out;
}

// Inclusive integer range with the surrogate block (D800-DFFF) skipped: callers who
// want lone surrogates construct them explicitly.
export function* codePoints(start: number, end: number): Generator<number> {
  for (let cp = start; cp <= end; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    yield cp;
  }
}
