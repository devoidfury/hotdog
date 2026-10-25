// Fuzz suite for utils/spoof.ts (SPF-1 spoof neutralization at human render surfaces).
//
// Invariants audited on generated input, not just fixtures:
//   1. Exhaustive sweep 0x0..0x10FFFF (surrogates skipped by prng codePoints), batches of
//      BATCH=500 codepoints per call for speed: output == the independently-built
//      expected string (so no spoof char survives AND every non-spoof char survives),
//      and the output is idempotent under a second pass.
//   2. spoofSafe(spoofSafe(x)) === spoofSafe(x) across sweep chunks and seeded random
//      strings that mix spoof chars. Lone surrogates: REAL policy is pass-through (they
//      are not in the spoof set), pinned here; never crashes.
//   3. SpoofScan reports a hit exactly when a spoof char is present (both directions)
//      and its count/text agree with the literal set on seeded random strings.
//
// The expected spoof set is transcribed below as a literal list from the documented
// policy ("C0 controls except tab/LF, DEL + C1, zero-widths/directional marks, bidi
// embeddings+overrides and isolates, invisible operators, BOM, interlinear controls").
// Assertions use only that transcription -- never spoof.ts's own predicate.
//
// Wall time: the full 1.1M-codepoint sweep (build + spoofSafe + independent expectation
// + zero-spoof scan + idempotence check) measures ~110 ms on dev hardware (budget 3000 ms
// below); the whole file runs in ~0.15 s, well inside the ~2 s the run plan allows. No Math.random / Date.now; fixed seeds.

import { describe, it, expect } from "bun:test";
import { neutralizeSpoofing, spoofSafe } from "@utils/spoof.ts";
import { makeRng, codePoints, type Rng } from "../fuzz/prng.ts";

// ── Literal transcription of the spoof policy (stated independently of the source) ──

const SPOOF_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008], // C0 without TAB (09) and LF (0a); VT (0b) and FF (0c) ARE spoof
  [0x000b, 0x001f], // C0 remainder (incl. CR 0d, ESC 1b)
  [0x007f, 0x009f], // DEL and all C1 controls
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x202a, 0x202e], // bidi embeddings/overrides (trojan-source)
  [0x2060, 0x2064], // word joiner and invisible operators
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // BOM
  [0xfff9, 0xfffb], // interlinear annotation controls
];

const IS_SPOOF = new Uint8Array(0x110000);
const SPOOF_POOL: number[] = [];
for (const [lo, hi] of SPOOF_RANGES) {
  for (let cp = lo; cp <= hi; cp++) {
    IS_SPOOF[cp] = 1;
    SPOOF_POOL.push(cp);
  }
}

function tokenFor(cp: number): string {
  return `[U+${cp.toString(16).toUpperCase().padStart(4, "0")}]`;
}

// Independent restatement of neutralizeSpoofing: replace from the transcription above.
function expectedNeutralize(input: string): { text: string; count: number } {
  let text = "";
  let count = 0;
  let i = 0;
  while (i < input.length) {
    const cp = input.codePointAt(i)!;
    if (IS_SPOOF[cp] === 1) {
      text += tokenFor(cp);
      count++;
    } else {
      text += String.fromCodePoint(cp);
    }
    i += cp > 0xffff ? 2 : 1;
  }
  return { text, count };
}

function containsSpoof(input: string): boolean {
  let i = 0;
  while (i < input.length) {
    const cp = input.codePointAt(i)!;
    if (IS_SPOOF[cp] === 1) return true;
    i += cp > 0xffff ? 2 : 1;
  }
  return false;
}

type Failure = { iter: number; input: string; problem: string };

function record(failures: Failure[], iter: number, input: string, problem: string): void {
  failures.push({ iter, input: JSON.stringify(input).slice(0, 300), problem });
}

// ── 1. Exhaustive codepoint sweep ───────────────────────────────────

describe("spoof fuzz: exhaustive codepoint sweep", () => {
  const BATCH = 500; // codepoints per spoofSafe call

  it("every codepoint: tokens replace the set, everything else survives, sweep < 3s", () => {
    const t0 = performance.now();
    const failures: Failure[] = [];
    let batch: string[] = [];
    let batchIdx = 0;
    let totalSpoof = 0;

    const runBatch = (): void => {
      const input = batch.join("");
      const exp = expectedNeutralize(input);
      totalSpoof += exp.count;
      let out: string;
      try {
        out = spoofSafe(input);
      } catch (e) {
        record(failures, batchIdx, input, `threw ${(e as Error).message}`);
        return;
      }
      if (out !== exp.text) {
        record(failures, batchIdx, input, `output != expected at batch ${batchIdx}`);
      } else {
        // Restate the core property separately from the equality: zero spoof chars survive.
        if (containsSpoof(out)) {
          record(failures, batchIdx, input, "spoof char survived in output");
        }
        // Idempotence of the sweep chunk (tokens are pure ASCII).
        if (spoofSafe(out) !== out) {
          record(failures, batchIdx, input, "sweep chunk not idempotent");
        }
      }
      batch = [];
      batchIdx++;
    };

    for (const cp of codePoints(0x0, 0x10ffff)) {
      batch.push(String.fromCodePoint(cp));
      if (batch.length >= BATCH) runBatch();
    }
    if (batch.length > 0) runBatch();

    const ms = performance.now() - t0;
    // Every spoof-set codepoint appears exactly once across the sweep.
    expect(totalSpoof).toBe(SPOOF_POOL.length);
    expect(failures).toEqual([]);
    expect(ms).toBeLessThan(3000);
  });
});

// ── 2/3. Seeded strings: idempotence + SpoofScan agreement ──────────

// Pool deliberately excludes '[' and ']' so a token round-trip decode cannot collide
// with literal bracket text in the input.
const OK_CHARS = [
  "a", "b", "x", " ", "/", ".", "-", "_", "*", "'", '"', "`", "(", ")", "<", ">", "!",
  "0", "9", "\t", "\n", "\u00e9", "\u4e16", "\u{1F600}", "\u0301", "\uFFFD", "\u2025",
  "\uFF0E", "\u2215",
];

function randomString(rng: Rng, spoofShare: number, includeSurrogates: boolean): string {
  const len = 1 + rng.int(200);
  const parts: string[] = [];
  for (let i = 0; i < len; i++) {
    const roll = rng.float();
    if (roll < spoofShare) {
      parts.push(String.fromCodePoint(rng.pick(SPOOF_POOL)));
    } else if (includeSurrogates && roll < spoofShare + 0.03) {
      // lone surrogates, constructed explicitly (policy: pass through unchanged)
      parts.push(String.fromCharCode(0xd800 + rng.int(0x800)));
    } else {
      parts.push(rng.pick(OK_CHARS));
    }
  }
  return parts.join("");
}

describe("spoof fuzz: seeded strings", () => {
  it("SpoofScan agrees with the literal set in both directions, idempotent", () => {
    const rng = makeRng(0x500f_2024);
    const failures: Failure[] = [];

    for (let i = 0; i < 300; i++) {
      const s = randomString(rng, 0.35, i % 3 === 0);
      const exp = expectedNeutralize(s);
      let scan: { text: string; count: number };
      try {
        scan = neutralizeSpoofing(s);
      } catch (e) {
        record(failures, i, s, `threw ${(e as Error).message}`);
        continue;
      }
      // Hit iff present: both directions.
      if ((scan.count > 0) !== containsSpoof(s)) {
        record(failures, i, s, `count>0 disagrees with presence (count=${scan.count})`);
      }
      if (scan.count !== exp.count) {
        record(failures, i, s, `count ${scan.count} != expected ${exp.count}`);
      }
      // Text (and thus token positions) agree with the independent expectation.
      if (scan.text !== exp.text) {
        record(failures, i, s, "text != expected (position mismatch)");
      }
      if (spoofSafe(s) !== scan.text) {
        record(failures, i, s, "spoofSafe != neutralizeSpoofing().text");
      }
      if (exp.count === 0 && scan.text !== s) {
        record(failures, i, s, "clean input modified");
      }
      // Idempotence.
      if (spoofSafe(spoofSafe(s)) !== spoofSafe(s)) {
        record(failures, i, s, "spoofSafe not idempotent");
      }
      // Token round-trip: decoding the [U+XXXX] tokens restores the original.
      const roundTrip = scan.text.replace(/\[U\+([0-9A-F]{4})\]/g, (_, h) =>
        String.fromCodePoint(parseInt(h, 16)),
      );
      if (roundTrip !== s) {
        record(failures, i, s, "token round-trip != input");
      }
      if (failures.length >= 3) break;
    }
    expect(failures).toEqual([]);
  });

  it("spoof-free strings never trigger and never change", () => {
    const rng = makeRng(0x500f_1ee7);
    for (let i = 0; i < 200; i++) {
      const s = randomString(rng, 0, true);
      expect(containsSpoof(s)).toBe(false);
      const scan = neutralizeSpoofing(s);
      expect(scan.count).toBe(0);
      expect(scan.text).toBe(s);
      expect(spoofSafe(s)).toBe(s);
    }
  });
});

// ── Lone surrogates: the real policy, pinned ────────────────────────

describe("spoof fuzz: lone surrogates", () => {
  it("passes lone surrogates through unchanged (not in the spoof set), idempotent", () => {
    // Transcribed policy contains no surrogate range, so every D800-DFFF code unit
    // survives verbatim; the output stays byte-identical and idempotent.
    const cases = ["\ud800x\udfff", "\udbff\udc00", "\ud800\ud800", "a\udead b"];
    for (const s of cases) {
      expect(spoofSafe(s)).toBe(s);
      expect(neutralizeSpoofing(s).count).toBe(0);
      expect(spoofSafe(spoofSafe(s))).toBe(spoofSafe(s));
    }
    // Mixed with real spoof chars: only the set is tokenized.
    const mix = "\ud800\u202e\udfff";
    expect(spoofSafe(mix)).toBe("\ud800[U+202E]\udfff");
    expect(neutralizeSpoofing(mix).count).toBe(1);
  });
});
