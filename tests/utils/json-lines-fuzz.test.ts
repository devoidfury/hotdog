// Fuzz suite for parseJsonLines (src/utils/json-lines.ts).
// Untrusted input: session logs and JSONL files written by other tools.
//
// Pinned contracts (read from source, asserted here):
//   1. parseJsonLines is a whole-text, stateless line parser: split("\n"),
//      trim, drop blanks, JSON.parse; unparsable lines are DROPPED under both
//      policies ("skip" silent, "warn" logs). It never throws on junk.
//   2. Torn-line rule: a trailing line without a final newline is a complete
//      candidate line for THIS call (kept if it parses, dropped if not).
//      There is no buffering across calls: feeding chunks per-call loses any
//      record torn by a chunk boundary (fragments fail JSON.parse and drop).
//      For object/array/string/bool/null docs no proper prefix or suffix is
//      valid JSON, so per-chunk feeding yields EXACTLY the records of un-torn
//      lines, in order. Two documented phantom exceptions, pinned below: bare
//      numeric records ("12345" as "1"+"2345" yields two records), and middle
//      fragments (two boundaries inside one line can isolate a substring like
//      the `0` of `{"0":1}` which parses as its own record).
//   3. Junk (garbage, whitespace runs, 100KB single lines, NUL bytes) is
//      skipped, never crashes, never shifts later records' order or content.
//   4. trim() strips \r (CRLF records parse), BOM, and NBSP padding.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { parseJsonLines } from "@utils/json-lines.ts";
import { initializeLogger, resetLoggerForTesting, type LogEvent } from "@utils/logger.ts";
import { HookSystem } from "@core/hooks.ts";
import { makeRng, randomChunks, randomChunksBytes, type Rng } from "../fuzz/prng.ts";

let warned: string[] = [];

beforeAll(() => {
  resetLoggerForTesting();
  const hooks = new HookSystem();
  hooks.on("log", (data) => {
    const { level, message } = data as LogEvent;
    if (level === "warn") warned.push(message);
  });
  initializeLogger({ hooks, minLevel: "debug", target: "none" });
});

afterAll(() => {
  resetLoggerForTesting();
});

// ── Seeded corpus builder ───────────────────────────────────────────

const UNI_STRINGS = [
  "héllo",
  "日本語テキスト",
  "\u{1f32d}", // hot dog emoji (surrogate pair in UTF-16)
  "a\u{1f32d}b\u{1f32d}c",
  "é", // e + combining acute
  "\u202eRTL",
  "\u200bzwsp",
  "tab\tinside",
  "nl\ninside",
  "cr\rinside",
  'quote"inside',
  "back\\slash",
  "\u0000nul",
  "\u0085next",
  "\u00a0nbsp",
  "",
  "x",
  "line1\nline2\nline3",
  "long ".repeat(30),
];

function genValue(rng: Rng, depth: number): unknown {
  const roll = rng.int(depth >= 3 ? 4 : 6);
  switch (roll) {
    case 0:
      return rng.pick(UNI_STRINGS);
    case 1:
      return rng.bool() ? null : rng.bool();
    case 2:
      return rng.int(1000) - 500;
    case 3:
      return rng.float();
    case 4: {
      const n = rng.int(4);
      const arr: unknown[] = [];
      for (let i = 0; i < n; i++) arr.push(genValue(rng, depth + 1));
      return arr;
    }
    default: {
      const n = 1 + rng.int(4);
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        obj[rng.pick(["a", "key", "\u{1f32d}", "nested key", "q\"x", "k\u00e9", String(i)])] = genValue(rng, depth + 1);
      }
      return obj;
    }
  }
}

// Top level restricted to object/array/string/bool/null (never bare numbers)
// so the per-chunk exactness property holds (see notes: phantom rule).
function genTopRecord(rng: Rng): unknown {
  let value = genValue(rng, 1);
  while (typeof value === "number") value = genValue(rng, 1); // numbers: phantom exception
  return value;
}

const JUNK_PAYLOADS = [
  "not json",
  "{",
  '{"a":',
  "[1,",
  "}{",
  "nullnull",
  '"unterminated',
  "\u0000\u0000",
  "plain \u{1f32d} junk",
  "42x",
  "{\"a\":1,}",
  "nan",
];

interface GenLine {
  padding: string; // leading whitespace before the payload
  payload: string; // serialized JSON or junk; never begins/ends with whitespace
  trailing: string; // trailing whitespace + optional \r before the \n
  record: unknown; // parsed value, or a sentinel when the line is junk/blank
  isRecord: boolean; // payload is valid JSON with non-whitespace content
  bad: boolean; // non-blank but unparsable (warn-policy bookkeeping)
}

interface Corpus {
  text: string;
  lines: GenLine[];
  spans: { start: number; cStart: number; cEnd: number; recordIndex: number }[];
  records: unknown[]; // expected whole-feed output, in order
  badCount: number;
}

function genCorpus(rng: Rng, opts: { maxLines?: number; junk: boolean; withBlanks: boolean; crlf: boolean; trailingNewline: boolean }): Corpus {
  const maxLines = opts.maxLines ?? 30;
  const nLines = 1 + rng.int(maxLines);
  const raw: { padding: string; payload: string; trailing: string; record: unknown; isRecord: boolean; bad: boolean }[] = [];
  const records: unknown[] = [];
  for (let i = 0; i < nLines; i++) {
    const roll = rng.float();
    let line: GenLine;
    if (opts.withBlanks && roll < 0.15) {
      line = { padding: "", payload: "", trailing: rng.pick(["", " ", "  ", "\t", " \t "]), record: undefined, isRecord: false, bad: false };
    } else if (opts.junk && roll < 0.4) {
      const payload = rng.pick(JUNK_PAYLOADS);
      line = { padding: rng.pick(["", " ", "  "]), payload, trailing: "", record: undefined, isRecord: false, bad: true };
    } else {
      const value = genTopRecord(rng);
      const payload = JSON.stringify(value);
      line = { padding: rng.pick(["", "", "", " ", "\t"]), payload, trailing: "", record: value, isRecord: true, bad: false };
    }
    if (line.isRecord) records.push(line.record);
    raw.push(line);
  }
  // Assemble text, tracking spans. payload is always non-whitespace at both
  // ends EXCEPT the blank-line case (payload ""), which has no content.
  let text = "";
  const spans: Corpus["spans"] = [];
  const badLines: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!;
    const start = text.length;
    text += line.padding;
    const cStart = text.length;
    text += line.payload;
    const cEnd = text.length;
    text += line.trailing;
    if (opts.crlf && rng.bool(0.4)) text += "\r";
    if (i < raw.length - 1 || opts.trailingNewline) text += "\n";
    if (line.bad) badLines.push(i);
    // recordIndex assigned by reindex(); blank lines have no content span.
    spans.push({ start, cStart, cEnd: line.isRecord || line.bad ? cEnd : cStart, recordIndex: -1 });
  }
  return { text, lines: raw, spans, records, badCount: badLines.length };
}

// Assign recordIndex: each contributing line's position within `records`.
function reindex(corpus: Corpus): void {
  let r = 0;
  for (let i = 0; i < corpus.spans.length; i++) {
    if (corpus.lines[i]!.isRecord) corpus.spans[i]!.recordIndex = r++;
  }
}

function makeCorpus(rng: Rng, opts: Parameters<typeof genCorpus>[1]): Corpus {
  const c = genCorpus(rng, opts);
  reindex(c);
  return c;
}

// ── 1. Reassembly differential: chunked bytes decode + parse == one feed ──

describe("json-lines fuzz: chunk reassembly equals one feed", () => {
  const SEED = 0x6a73_6f6c; // "jsol"

  it("random and adversarial UTF-8 chunk splits decode to the same text and records", () => {
    const rng = makeRng(SEED);
    const enc = new TextEncoder();
    for (let iter = 0; iter < 60; iter++) {
      const corpus = makeCorpus(rng, { junk: rng.bool(0.3), withBlanks: true, crlf: rng.bool(), trailingNewline: rng.bool() });
      const bytes = enc.encode(corpus.text);
      const whole = parseJsonLines<unknown>(corpus.text);
      expect(whole).toEqual(corpus.records);

      const modes: ("random" | "adversarial")[] = ["random", "adversarial"];
      for (const mode of modes) {
        const pieces = randomChunksBytes(rng, bytes, mode === "adversarial" ? 12 : 8, mode);
        // concat must be byte-identical to the input
        let total = 0;
        for (const p of pieces) total += p.length;
        expect(total).toBe(bytes.length);

        const dec = new TextDecoder();
        let decoded = "";
        for (let i = 0; i < pieces.length; i++) decoded += dec.decode(pieces[i], { stream: i < pieces.length - 1 });
        expect(decoded).toBe(corpus.text);
        expect(parseJsonLines<unknown>(decoded)).toEqual(whole);
      }
    }
  });

  it("byte-at-a-time decode (small corpus) and mid-multibyte cuts parse identically", () => {
    const rng = makeRng(0x6279_7465); // "byte"
    const enc = new TextEncoder();
    for (let iter = 0; iter < 12; iter++) {
      const corpus = makeCorpus(rng, { maxLines: 4, junk: false, withBlanks: true, crlf: rng.bool(), trailingNewline: rng.bool() });
      const bytes = enc.encode(corpus.text);
      const whole = parseJsonLines<unknown>(corpus.text);
      const dec1 = new TextDecoder();
      let s1 = "";
      for (let i = 0; i < bytes.length; i++) s1 += dec1.decode(bytes.subarray(i, i + 1), { stream: i < bytes.length - 1 });
      expect(parseJsonLines<unknown>(s1)).toEqual(whole);
      // cuts placed inside every multibyte sequence of the text
      const cuts: number[] = [];
      let off = 0;
      for (const ch of corpus.text) {
        const w = enc.encode(ch);
        for (let k = 1; k < w.length; k++) cuts.push(off + k);
        off += w.length;
      }
      const dec2 = new TextDecoder();
      let s2 = "";
      let prev = 0;
      for (const c of cuts) {
        s2 += dec2.decode(bytes.subarray(prev, c), { stream: true });
        prev = c;
      }
      s2 += dec2.decode(bytes.subarray(prev));
      expect(parseJsonLines<unknown>(s2)).toEqual(whole);
    }
  });

  it("string-domain chunks (may bisect surrogate pairs) rejoin and parse identically", () => {
    const rng = makeRng(0x7574_6631_36); // "utf16"
    for (let iter = 0; iter < 40; iter++) {
      const corpus = makeCorpus(rng, { junk: false, withBlanks: true, crlf: rng.bool(), trailingNewline: rng.bool() });
      const whole = parseJsonLines<unknown>(corpus.text);
      const pieces = randomChunks(rng, corpus.text, 8, rng.bool() ? "adversarial" : "random");
      expect(pieces.join("")).toBe(corpus.text);
      expect(parseJsonLines<unknown>(pieces.join(""))).toEqual(whole);
    }
  });
});

// ── 2. Per-call chunk feeding: the real torn-line rule ──────────────

describe("json-lines fuzz: per-call feeding pins the torn-line rule", () => {
  // Clean corpus (no junk, no bare-number lines): feeding string chunks as
  // SEPARATE parseJsonLines calls yields exactly the records of the lines no
  // boundary crossed; torn records vanish (fragments fail JSON.parse).
  const SEED = 0x746f_726e; // "torn"

  // Records survive iff no chunk boundary lands inside the line content.
  // Caveat: with TWO boundaries inside one line, the middle fragment is an
  // arbitrary substring and may itself be valid JSON (e.g. `0` torn out of
  // `{"0":0.95}` parses as the record 0). Predicting middle-fragment phantoms
  // would require re-running the parse, so the exactness assertion runs on
  // line-safe splits (at most one boundary per line content); arbitrary
  // splits are still exercised for no-crash coverage in the suites above.
  function lineSafeChunks(rng: Rng, text: string, spans: { cStart: number; cEnd: number }[], maxPieces: number): string[] {
    for (let attempt = 0; attempt < 40; attempt++) {
      const pieces = randomChunks(rng, text, maxPieces, rng.bool() ? "adversarial" : "random");
      const bounds: number[] = [];
      let pos = 0;
      for (let i = 0; i < pieces.length - 1; i++) {
        pos += pieces[i]!.length;
        bounds.push(pos);
      }
      const safe = spans.every((s) => bounds.filter((b) => b > s.cStart && b < s.cEnd).length <= 1);
      if (safe) return pieces;
    }
    return [text];
  }

  it("records survive iff no chunk boundary lands inside the line content", () => {
    const rng = makeRng(SEED);
    for (let iter = 0; iter < 60; iter++) {
      const corpus = makeCorpus(rng, { junk: false, withBlanks: true, crlf: rng.bool(), trailingNewline: rng.bool() });
      const pieces = lineSafeChunks(rng, corpus.text, corpus.spans, 8);
      const bounds: number[] = [];
      let pos = 0;
      for (let i = 0; i < pieces.length - 1; i++) {
        pos += pieces[i]!.length;
        bounds.push(pos);
      }
      const expected: unknown[] = [];
      for (const span of corpus.spans) {
        const torn = span.recordIndex >= 0 && bounds.some((b) => b > span.cStart && b < span.cEnd);
        if (span.recordIndex >= 0 && !torn) expected.push(corpus.records[span.recordIndex]);
      }
      const fed: unknown[] = [];
      for (const p of pieces) fed.push(...parseJsonLines<unknown>(p));
      expect(fed).toEqual(expected);
    }
  });

  it("splitting exactly at line boundaries is a lossless differential", () => {
    const rng = makeRng(0x6e6c_6665); // "nlfe"
    for (let iter = 0; iter < 40; iter++) {
      const corpus = makeCorpus(rng, { junk: rng.bool(0.3), withBlanks: true, crlf: rng.bool(), trailingNewline: true });
      const parts = corpus.text.split(/(?<=\n)/);
      const fed: unknown[] = [];
      for (const p of parts) fed.push(...parseJsonLines<unknown>(p));
      expect(fed).toEqual(corpus.records);
    }
  });
});

// ── 3. Junk handling: skip vs warn, ordering, never-crash ───────────

describe("json-lines fuzz: junk never crashes, never shifts records", () => {
  const SEED = 0x6a75_6e6b; // "junk"

  it("skip and warn policies return identical records; warn count == bad lines", () => {
    const rng = makeRng(SEED);
    for (let iter = 0; iter < 40; iter++) {
      const corpus = makeCorpus(rng, { junk: true, withBlanks: true, crlf: rng.bool(), trailingNewline: rng.bool() });
      warned = [];
      const skipped = parseJsonLines<unknown>(corpus.text, "skip");
      expect(warned.length).toBe(0);
      warned = [];
      const warnedOut = parseJsonLines<unknown>(corpus.text, "warn", "fuzz");
      expect(warnedOut).toEqual(skipped);
      expect(warned.length).toBe(corpus.badCount);
      expect(skipped).toEqual(corpus.records);
    }
    warned = [];
  });

  it("hostile singles: 100KB junk line, 100KB valid line, NUL runs, lone surrogates, and ordering is preserved", () => {
    const good1 = JSON.stringify({ seq: 1, s: "\u{1f32d}\u0000escaped" });
    const good2 = JSON.stringify({ seq: 2, arr: [1, [2, [3, ["deep \t \" \\ "]]]] });
    const bigJunk = "y".repeat(100_000);
    const bigValid = JSON.stringify({ seq: 1.5, blob: "z".repeat(100_000) });
    const text = [
      good1,
      bigJunk,
      "\u0000\u0000\u0000",
      "\ud800lone",
      bigValid,
      "   ",
      "{not json at all \u{1f32d}",
      good2,
    ].join("\n");
    const t0 = performance.now();
    const out = parseJsonLines<unknown>(text, "warn");
    const ms = performance.now() - t0;
    expect(out.length).toBe(3);
    expect((out[0] as { seq: number }).seq).toBe(1);
    expect((out[1] as { seq: number }).seq).toBe(1.5);
    expect((out[2] as { seq: number }).seq).toBe(2);
    expect(out).toEqual(parseJsonLines<unknown>([good1, bigValid, good2].join("\n"), "warn"));
    expect(ms).toBeLessThan(2000);
    warned = [];
  });
});

// ── 4. Torn-tail and trim fixtures (pinned real behavior) ───────────

describe("json-lines fixtures: torn tail, phantom numbers, trim set", () => {
  it("a trailing line without a newline is a complete candidate line", () => {
    expect(parseJsonLines<unknown>('{"a":1}\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parseJsonLines<unknown>('{"a":1}\n{"b"')).toEqual([{ a: 1 }]); // torn tail drops
    expect(parseJsonLines<unknown>('{"a":1}\r\n')).toEqual([{ a: 1 }]); // CRLF trims
  });

  it("no cross-call buffering: per-call feeding drops torn records", () => {
    const fed: unknown[] = [];
    for (const chunk of ['{"a":', '1}\n{"b":2}\n']) fed.push(...parseJsonLines<unknown>(chunk));
    expect(fed).toEqual([{ b: 2 }]);
  });

  it("numeric records are the phantom exception", () => {
    expect(parseJsonLines<unknown>("12345")).toEqual([12345]);
    const fed: unknown[] = [];
    for (const chunk of ["1", "2345"]) fed.push(...parseJsonLines<unknown>(chunk));
    expect(fed).toEqual([1, 2345]); // two phantoms replace one record
  });

  it("a middle fragment can mint a phantom record even from an object line", () => {
    // Two boundaries isolating the `0` inside {"0":1}: fragments `{"` and `":1}`
    // fail, but the middle chunk parses as the record 0. Real behavior, pinned.
    expect(parseJsonLines<unknown>('{"0":1}')).toEqual([{ "0": 1 }]);
    expect(["{\"", "0", "\":1}"].flatMap((c) => parseJsonLines<unknown>(c))).toEqual([0]);
  });

  it("trim strips BOM, NBSP, and tabs around a record", () => {
    expect(parseJsonLines<unknown>('\uFEFF{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseJsonLines<unknown>('\u00a0{"a":1}\t')).toEqual([{ a: 1 }]);
  });

  it("warn policy snippet caps at 80 chars and names the 1-based line", () => {
    warned = [];
    parseJsonLines<unknown>(`bad1\n${"e".repeat(200)}`, "warn", "lab");
    expect(warned.length).toBe(2);
    expect(warned[0]).toContain("line 1");
    expect(warned[1]).toContain(`${"e".repeat(80)}...`);
    warned = [];
  });
});
