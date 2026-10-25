import { describe, it, expect } from "bun:test";
import {
  makeRng,
  randomChunks,
  randomChunksBytes,
  codePoints,
  type ChunkMode,
  type Rng,
} from "./prng.ts";

// Self-test for the shared fuzz PRNG. Six suites build on this module, so the pins here
// are the contract, not implementation notes:
//   1. the splitmix32 stream for seed 1 is frozen (golden vector)
//   2. randomChunks / randomChunksBytes reassemble to the input exactly, every seed,
//      every mode -- checked by direct reassembly, not by prng.ts's own bookkeeping
//   3. int / float / pick never leave their stated ranges over large samples

const BMP_POOL = Array.from(codePoints(0x20, 0xffff));

function genString(rng: Rng, units: number): string {
  let s = "";
  for (let i = 0; i < units; i++) {
    const roll = rng.int(8);
    if (roll === 0) s += String.fromCharCode(0xd800 + rng.int(0x400)); // lone surrogate, explicit
    else if (roll === 1) s += String.fromCodePoint(0x10000 + rng.int(0x100000)); // astral: 2 units
    else s += String.fromCodePoint(rng.pick(BMP_POOL));
  }
  return s;
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

describe("prng: splitmix32 golden vector", () => {
  it("seed 1 produces the frozen stream", () => {
    const rng = makeRng(1);
    expect([rng.next(), rng.next(), rng.next(), rng.next(),
            rng.next(), rng.next(), rng.next(), rng.next()]).toEqual([
      2059928652, 2065299320, 3687352194, 4259397611,
      753350861, 3962282718, 1863348090, 772163239,
    ]);
    // float and bytes consume the stream in order from the same state
    const fresh = makeRng(1);
    expect(fresh.float()).toBe(2059928652 / 2 ** 32);
    expect(Array.from(fresh.bytes(4))).toEqual([120, 247, 25, 123]); // second word, little-endian
  });

  it("same seed replays identically; bool honors p=0 and p=1", () => {
    const a = makeRng(0x686f7464);
    const b = makeRng(0x686f7464);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
    expect(makeRng(7).bool(0)).toBe(false);
    expect(makeRng(7).bool(1)).toBe(true);
    expect(() => makeRng(7).bool(1.5)).toThrow(RangeError);
  });
});

describe("prng: randomChunks reassembly", () => {
  const MODES: readonly ChunkMode[] = ["random", "adversarial"];

  it("string chunks always concat back to the exact input", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 400; seed++) {
      const rng = makeRng(seed * 0x9e3779b9);
      const data = genString(rng, rng.int(64)); // includes "" and lone surrogates
      for (const mode of MODES) {
        const maxPieces = 1 + rng.int(10);
        const parts = randomChunks(rng, data, maxPieces, mode);
        if (parts.join("") !== data) {
          failures.push(`seed ${seed} ${mode}: reassembly mismatch ${JSON.stringify(parts)}`);
          continue;
        }
        if (parts.length < 1 || parts.length > maxPieces) {
          failures.push(`seed ${seed} ${mode}: ${parts.length} pieces > max ${maxPieces}`);
        }
        if (data.length > 0 && parts.some((p) => p.length === 0)) {
          failures.push(`seed ${seed} ${mode}: empty piece in non-empty input`);
        }
        if (mode === "adversarial" && data.length > 0) {
          const fullSplit = data.length <= 16 && maxPieces >= data.length;
          if (fullSplit && parts.some((p) => p.length !== 1)) {
            failures.push(`seed ${seed}: small input not split to single units`);
          }
          // with room for 3 cuts the hard boundaries 1, 2, len-1 must all appear
          if (!fullSplit && maxPieces >= 4 && data.length >= 4) {
            if (parts[0]!.length !== 1 || parts[1]!.length !== 1 ||
                parts[parts.length - 1]!.length !== 1) {
              failures.push(`seed ${seed}: adversarial hard boundaries missing`);
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("bytes chunks always reassemble to the exact input", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 400; seed++) {
      const rng = makeRng(seed * 0x85ebca6b);
      const data = rng.bytes(rng.int(80)); // includes the empty buffer
      for (const mode of MODES) {
        const maxPieces = 1 + rng.int(12);
        const parts = randomChunksBytes(rng, data, maxPieces, mode);
        const joined = joinBytes(parts);
        if (joined.length !== data.length || !data.every((v, i) => v === joined[i])) {
          failures.push(`seed ${seed} ${mode}: byte reassembly mismatch`);
          continue;
        }
        if (parts.length < 1 || parts.length > maxPieces) {
          failures.push(`seed ${seed} ${mode}: piece count ${parts.length} out of bounds`);
        }
        if (data.length > 0 && parts.some((p) => p.length === 0)) {
          failures.push(`seed ${seed} ${mode}: empty piece in non-empty buffer`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("rejects maxPieces < 1", () => {
    expect(() => randomChunks(makeRng(1), "abc", 0)).toThrow(RangeError);
    expect(() => randomChunksBytes(makeRng(1), new Uint8Array(3), -2)).toThrow(RangeError);
  });
});

describe("prng: range guarantees", () => {
  it("int stays in [0, n) for n from 1 to 2**32", () => {
    const rng = makeRng(0xc0ffee);
    const failures: string[] = [];
    for (const n of [1, 2, 3, 7, 1000, 0x7fffffff, 2 ** 32 - 1, 2 ** 32]) {
      for (let i = 0; i < 20000; i++) {
        const v = rng.int(n);
        if (!Number.isInteger(v) || v < 0 || v >= n) {
          failures.push(`int(${n}) returned ${v}`);
          break;
        }
      }
    }
    expect(failures).toEqual([]);
    expect(() => rng.int(0)).toThrow(RangeError);
    expect(() => rng.int(2.5)).toThrow(RangeError);
  });

  it("float stays in [0, 1)", () => {
    const rng = makeRng(0x1234abcd);
    const failures: string[] = [];
    for (let i = 0; i < 200000; i++) {
      const v = rng.float();
      if (!(v >= 0 && v < 1)) {
        failures.push(`float() returned ${v}`);
        break;
      }
    }
    expect(failures).toEqual([]);
  });

  it("pick returns a member and rejects empty arrays", () => {
    const rng = makeRng(99);
    const words = ["a", "bb", "ccc", "dddd"] as const;
    let bad: string | null = null;
    for (let i = 0; i < 100000 && bad === null; i++) {
      const v = rng.pick(words);
      if (!words.includes(v)) bad = `pick returned ${JSON.stringify(v)}`;
    }
    expect(bad).toBeNull();
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it("bytes returns n bytes and replays identically from the same seed", () => {
    const a = makeRng(5);
    const b = makeRng(5);
    for (const n of [0, 1, 3, 4, 5, 17]) {
      const xs = a.bytes(n);
      expect(xs.length).toBe(n);
      expect(Array.from(xs)).toEqual(Array.from(b.bytes(n)));
    }
    expect(() => makeRng(1).bytes(-1)).toThrow(RangeError);
  });
});

describe("prng: codePoints", () => {
  it("is inclusive on both ends and skips the surrogate block", () => {
    expect(Array.from(codePoints(0xd7fe, 0xe002))).toEqual([0xd7fe, 0xd7ff, 0xe000, 0xe001, 0xe002]);
    expect(Array.from(codePoints(0xd800, 0xdfff))).toEqual([]);
    expect(Array.from(codePoints(0x41, 0x41))).toEqual([0x41]);
    expect(Array.from(codePoints(0x42, 0x41))).toEqual([]); // empty when start > end
  });
});
