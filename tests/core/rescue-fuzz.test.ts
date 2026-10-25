// Fuzz suite for the config rescue utilities (src/core/config/rescue.ts):
// stripJsonc, findJsonError, diagnoseConfigFile and the `rescue fix` write
// path (runRescue with fix=true, driven against mkdtemp dirs only).
//
// INVARIANTS:
//   fix path:   the repaired text JSON.parse's DEEP-EQUAL to the known
//               generated value (never a silent value change); the change is
//               comments/comma-only, checked with an independent
//               significant-character stream on both sides; the .bak backup is
//               byte-identical to the broken original; a schema-valid config
//               comes out with a clean second pass.
//   stripJsonc: no comment tokens survive on generated inputs; the
//               significant stream is unchanged; and strings carrying // or
//               /* sequences are NOT stripped (dedicated trap corpus where the
//               output must be byte-identical).
//   findJsonError: differential against an independent iterative JSON prefix
//               acceptor (the machine below) over seeded byte-corruptions of
//               valid docs. When it returns an index, the machine agrees the
//               doc is invalid and the index sits inside the offending token's
//               span; when the doc is valid the result is null. Divergences
//               found are pinned in the run notes, not asserted away.
//   crash corpus (mkdtemp files): truncated-mid-escape, opener-at-EOF,
//               unclosed strings, 20k-deep nesting, BOM oddities -- diagnose
//               and fix never throw.
//
// Pins (actual behavior, recorded in the run notes): negative/zero handling
// inside stripJsonc's comment skipper, the comma-before-comment interplay
// ("[1,/*c*/]" is deliberately NOT auto-fixable), and findJsonError's
// give-up-at-depth-2000 (unguarded recursion threw RangeError at 50k-deep
// nesting on bun/JSC before this suite's fix; V8 blows near 10k).

import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  stripJsonc,
  findJsonError,
  diagnoseConfigFile,
  runRescue,
} from "@core/config/rescue.ts";
import { makeRng, type Rng } from "../fuzz/prng.ts";
import { captureConsole } from "../test-helpers.ts";

// ── Independent JSONC significant-stream scanner (oracle) ───────────
// Deliberately a separate implementation from stripJsonc: token stream with
// accounting, used to assert "comments-only, never a value change".
// sig = significant chars (whitespace dropped, strings verbatim inside
// quotes, comment chars removed, TRAILING commas -- a comma whose next
// significant char is } or ] -- removed to match what repair does).

interface Scan {
  sig: string;
  commentChars: number;
  lineComments: number;
  blockComments: number;
  trailingCommas: number;
  bom: boolean;
  unterminated: boolean;
}

function scanSigc(src: string): Scan {
  let i = 0;
  const n = src.length;
  let sig = "";
  let commentChars = 0;
  let lineComments = 0;
  let blockComments = 0;
  let trailingCommas = 0;
  let unterminated = false;
  const bom = src.charCodeAt(0) === 0xfeff;
  if (bom) i = 1;
  while (i < n) {
    const c = src[i]!;
    if (c === '"') {
      sig += c;
      i++;
      while (i < n) {
        const s = src[i]!;
        sig += s;
        i++;
        if (s === "\\" && i < n) {
          sig += src[i]!;
          i++;
          continue;
        }
        if (s === '"') break;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      lineComments++;
      while (i < n && src[i] !== "\n") {
        commentChars++;
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      blockComments++;
      i += 2;
      commentChars += 2;
      let closed = false;
      while (i < n) {
        if (src[i] === "*" && src[i + 1] === "/") {
          i += 2;
          commentChars += 2;
          closed = true;
          break;
        }
        commentChars++;
        i++;
      }
      if (!closed) unterminated = true;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(src[j]!)) j++;
      if (src[j] === "}" || src[j] === "]") {
        trailingCommas++;
        i++;
        continue;
      }
      sig += c;
      i++;
      continue;
    }
    if (!/\s/.test(c)) sig += c;
    i++;
  }
  return { sig, commentChars, lineComments, blockComments, trailingCommas, bom, unterminated };
}

// ── Independent JSON prefix acceptor (findJsonError oracle) ─────────
// Iterative (no recursion), returns null when the WHOLE text is a valid JSON
// document, else { lo, hi } -- a range covering where a grammar scanner may
// legitimately point for the first offending token (token start vs the
// offending continuation char differ between implementations; the range
// absorbs exactly that, nothing more).

interface Dead {
  lo: number;
  hi: number;
}

function grammarDead(text: string): Dead | null {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const wsCh = (c: string | undefined): boolean =>
    c === " " || c === "\t" || c === "\n" || c === "\r";

  type Ctx = "top" | "done" | "arr:v" | "arr:c" | "obj:k" | "obj-colon" | "obj:v" | "obj:c";
  const stack: Ctx[] = [];
  let ctx: Ctx = "top";
  // a comma was just consumed: an immediate closer is a trailing comma, not
  // an empty container (the flag resets when a new container opens)
  let afterComma = false;
  // string / escape state
  let inStr = false;
  let strAfter: Ctx = "done";
  let esc: 0 | 1 | 2 = 0; // 1 = next char is escape char, 2 = \u hex digits pending
  let hexLeft = 0;
  // number state: "" none | "-" sign | "0" | "int" | "dot" | "frac" | "e" | "esig" | "exp"
  let num = "";
  let numStart = 0;
  // keyword
  let kw = "";
  let kwStart = 0;

  const startValue = (c: string, at: number): boolean => {
    if (c === "{") {
      stack.push(ctx === "obj:v" ? "obj:c" : ctx === "arr:v" ? "arr:c" : "done");
      ctx = "obj:k";
      afterComma = false;
      return true;
    }
    if (c === "[") {
      stack.push(ctx === "obj:v" ? "obj:c" : ctx === "arr:v" ? "arr:c" : "done");
      ctx = "arr:v";
      afterComma = false;
      return true;
    }
    if (c === '"') {
      inStr = true;
      strAfter =
        ctx === "obj:k" ? "obj-colon"
        : ctx === "arr:v" ? "arr:c"
        : ctx === "obj:v" ? "obj:c"
        : "done";
      return true;
    }
    if (c === "-") {
      num = "-";
      numStart = at;
      return true;
    }
    if (c >= "0" && c <= "9") {
      num = c === "0" ? "0" : "int";
      numStart = at;
      return true;
    }
    if (c === "t") {
      kw = "rue";
      kwStart = at;
      return true;
    }
    if (c === "f") {
      kw = "alse";
      kwStart = at;
      return true;
    }
    if (c === "n") {
      kw = "ull";
      kwStart = at;
      return true;
    }
    return false;
  };

  const finishValue = (): void => {
    ctx = ctx === "obj:v" ? "obj:c" : ctx === "arr:v" ? "arr:c" : "done";
  };

  const finishContainer = (): void => {
    // the container completed as a value: resume the parent context pushed
    // when the container was opened ("done" for the top level)
    ctx = stack.pop() ?? "done";
  };

  while (i < n) {
    const c = text[i]!;
    if (inStr) {
      if (esc === 1) {
        if ('"\\/bfnrtu'.indexOf(c) === -1) return { lo: i, hi: i };
        if (c === "u") {
          esc = 2;
          hexLeft = 4;
        } else esc = 0;
        i++;
        continue;
      }
      if (esc === 2) {
        if (!/[0-9a-fA-F]/.test(c)) return { lo: i, hi: i };
        hexLeft--;
        if (hexLeft === 0) esc = 0;
        i++;
        continue;
      }
      if (c === "\\") {
        esc = 1;
        i++;
        continue;
      }
      if (c === '"') {
        inStr = false;
        ctx = strAfter;
        i++;
        continue;
      }
      if (c.charCodeAt(0) < 0x20) return { lo: i, hi: i };
      i++;
      continue;
    }
    if (num !== "") {
      const isDig = c >= "0" && c <= "9";
      if (isDig) {
        if (num === "0") return { lo: i, hi: i }; // leading zero followed by digit
        if (num === "-") num = c === "0" ? "0" : "int";
        else if (num === "dot") num = "frac";
        else if (num === "e" || num === "esig") num = "exp";
        i++;
        continue;
      }
      if (c === "." && (num === "int" || num === "0")) {
        num = "dot";
        i++;
        continue;
      }
      if ((c === "e" || c === "E") && (num === "int" || num === "0" || num === "frac")) {
        num = "e";
        i++;
        continue;
      }
      if ((c === "+" || c === "-") && num === "e") {
        num = "esig";
        i++;
        continue;
      }
      // number ends here; reprocess c in the container context
      if (num === "-" || num === "dot" || num === "e" || num === "esig") {
        return { lo: numStart, hi: i }; // "-" / "1." / "1e" / "1e+" cannot end the number
      }
      num = "";
      finishValue();
      continue; // same c, no i++
    }
    if (kw !== "") {
      if (c === kw[0]) {
        kw = kw.slice(1);
        if (kw === "") finishValue();
        i++;
        continue;
      }
      return { lo: kwStart, hi: i };
    }
    if (wsCh(c)) {
      i++;
      continue;
    }
    switch (ctx as Ctx) {
      case "arr:v":
        if (c === "]" && !afterComma) {
          // empty array: nothing consumed yet, the closer completes it
          finishContainer();
          i++;
          continue;
        }
        if (!startValue(c, i)) return { lo: i, hi: i };
        i++;
        continue;
      case "top":
      case "obj:v":
        if (!startValue(c, i)) return { lo: i, hi: i };
        i++;
        continue;
      case "arr:c":
        if (c === ",") {
          ctx = "arr:v";
          afterComma = true;
          i++;
          continue;
        }
        if (c === "]") {
          finishContainer();
          i++;
          continue;
        }
        return { lo: i, hi: i };
      case "obj:k":
        if (c === "}" && !afterComma) {
          finishContainer();
          i++;
          continue;
        }
        if (c === '"') {
          inStr = true;
          strAfter = "obj-colon";
          i++;
          continue;
        }
        return { lo: i, hi: i };
      case "obj-colon":
        if (c === ":") {
          ctx = "obj:v";
          i++;
          continue;
        }
        return { lo: i, hi: i };
      case "obj:c":
        if (c === ",") {
          ctx = "obj:k";
          afterComma = true;
          i++;
          continue;
        }
        if (c === "}") {
          finishContainer();
          i++;
          continue;
        }
        return { lo: i, hi: i };
      case "done":
        return { lo: i, hi: i }; // trailing garbage
    }
  }
  // EOF: strings and half-written tokens are dead; a complete number is fine.
  if (inStr) return { lo: n, hi: n };
  if (kw !== "") return { lo: kwStart, hi: n };
  if (num === "dot" || num === "e" || num === "esig" || num === "-") return { lo: numStart, hi: n };
  if (num !== "") {
    num = "";
    finishValue();
  }
  if (ctx === "done" && stack.length === 0) return null;
  return { lo: n, hi: n };
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ── Seeded value + JSONC generators ─────────────────────────────────

const TRAP_STRINGS = [
  "http://example.com/path",
  "a // b",
  "/* inside a string */",
  "/*unterminated",
  "unterminated*/",
  "*/ /*",
  "quote \" then //",
  "backslash \\\\ end",
  "backslash \\ then /*",
  "\n\t in-string escapes \u00e9\u4e2d\ud83d\ude00",
  "",
  "//",
  "/*",
  "*/",
] as const;

function genValue(rng: Rng, depth: number): unknown {
  const roll = rng.float();
  if (depth > 0 && roll < 0.18) {
    const n = rng.int(4);
    const arr: unknown[] = [];
    for (let i = 0; i < n; i++) arr.push(genValue(rng, depth - 1));
    return arr;
  }
  if (depth > 0 && roll < 0.4) {
    const n = rng.int(4);
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) obj[rng.pick(["k0", "k1", "k_2", "key three", "\u4e2d\u6587", '"q"', "a\\b"])] = genValue(rng, depth - 1);
    return obj;
  }
  if (roll < 0.55) return rng.pick(TRAP_STRINGS);
  if (roll < 0.65) return rng.pick([true, false, null]);
  return rng.pick([0, -1, 3.5, 1e21, 1e-7, 2000000, -0.5, 42]);
}

const LINE_COMMENTS = ["// x\n", "//\n", "// http://x /*y*/\n", "// unicode \u4e2d\u6587\n"];
const BLOCK_COMMENTS = ["/*x*/", "/**/", "/* // */", "/* line1\nline2 */", "/*\r\n*/"];

interface WriteStats {
  trailingCommas: number;
  comments: number;
}

function wsOnly(rng: Rng): string {
  let s = "";
  const n = rng.int(3);
  for (let i = 0; i < n; i++) s += rng.pick([" ", "  ", "\t", "\n", "\r\n"]);
  return s;
}

// optional decoration: comment + whitespace. `beforeCloser` decorations may
// not carry a comment when a trailing comma is emitted for the same slot
// (stripJsonc cannot repair a comma hidden behind a comment -- pinned gap,
// recorded in notes; the generator respects it so the invariant stays strong).
function decorate(rng: Rng, stats: WriteStats, allowComment = true): string {
  let s = "";
  if (allowComment && rng.bool(0.35)) {
    s += rng.bool() ? rng.pick(LINE_COMMENTS) : rng.pick(BLOCK_COMMENTS);
    stats.comments++;
  }
  s += wsOnly(rng);
  return s;
}

function renderValue(rng: Rng, v: unknown, stats: WriteStats): string {
  if (v === null || typeof v === "boolean" || typeof v === "number") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    let s = "[";
    v.forEach((el, idx) => {
      s += decorate(rng, stats) + renderValue(rng, el, stats);
      if (idx < v.length - 1) s += "," + decorate(rng, stats);
    });
    // before closer: trailing comma XOR comment (see decorate note)
    if (rng.bool(0.3)) {
      s += ",";
      stats.trailingCommas++;
      s += wsOnly(rng);
    } else {
      s += decorate(rng, stats);
    }
    return s + "]";
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  let s = "{";
  entries.forEach(([k, val], idx) => {
    s += decorate(rng, stats) + JSON.stringify(k) + ":" + decorate(rng, stats, false) + renderValue(rng, val, stats);
    if (idx < entries.length - 1) s += "," + decorate(rng, stats);
  });
  if (rng.bool(0.3)) {
    s += ",";
    stats.trailingCommas++;
    s += wsOnly(rng);
  } else {
    s += decorate(rng, stats);
  }
  return s + "}";
}

function genJsoncDoc(rng: Rng): { text: string; value: unknown; stats: WriteStats; bom: boolean } {
  const stats: WriteStats = { trailingCommas: 0, comments: 0 };
  const value = (() => {
    const n = 1 + rng.int(4);
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) obj[rng.pick(["k0", "k1", "cfg", "\u4e2d\u6587", '"q"'])] = genValue(rng, 3);
    return obj;
  })();
  let text = "";
  const bom = rng.bool(0.2);
  if (bom) text += "\uFEFF";
  text += decorate(rng, stats);
  text += renderValue(rng, value, stats);
  if (rng.bool(0.4)) text += decorate(rng, stats);
  if (rng.bool(0.7)) text += "\n";
  if (stats.comments === 0 && stats.trailingCommas === 0 && !bom) {
    text = "// forced\n" + text;
    stats.comments++;
  }
  return { text, value, stats, bom };
}

// Schema-valid flat config with comments (for the clean second pass).
function genSchemaCleanDoc(rng: Rng): { text: string; value: Record<string, unknown> } {
  const value: Record<string, unknown> = {
    provider: "someprovider",
    maxIterations: 1 + rng.int(50),
    showTokenUse: rng.bool(),
  };
  const stats: WriteStats = { trailingCommas: 0, comments: 0 };
  const src = renderValue(rng, value, stats);
  return { text: (rng.bool(0.3) ? "\uFEFF" : "") + (stats.comments === 0 ? "// ok\n" : "") + src + "\n", value };
}

// ── runRescue harness ───────────────────────────────────────────────
// In-process, configDirArg pinned to a mkdtemp dir: the user's config
// chain is never consulted, no env is touched, and everything is removed in
// finally.

async function rescue(
  dir: string,
  fix: boolean,
): Promise<{ code: number; out: string[] }> {
  // captureConsole terminates each line with "\n"; split back into the string[] shape callers use.
  const { output, result } = await captureConsole(() =>
    runRescue({ configDirArg: dir, configFileArg: null, fix }),
  );
  const out = output === "" ? [] : output.split("\n");
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return { code: result, out };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("rescue fuzz: stripJsonc", () => {
  it("trap corpus: strings carrying comment openers are untouched, byte-identical output", () => {
    const rng = makeRng(0x53747231); // "Str1"
    const failures: { iter: number; detail: string }[] = [];
    for (let iter = 0; iter < 400; iter++) {
      // Pure valid JSON whose STRINGS carry the trap tokens; compact render.
      const arr: unknown[] = [];
      for (let i = 0; i < 1 + rng.int(6); i++) {
        arr.push({ [rng.pick(TRAP_STRINGS) || "k"]: rng.pick(TRAP_STRINGS) });
      }
      const src = JSON.stringify({ a: arr, b: rng.pick(TRAP_STRINGS) });
      const { text, issues } = stripJsonc(src);
      if (issues.length !== 0) failures.push({ iter, detail: `issues on clean JSON: ${JSON.stringify(issues)}` });
      if (text !== src) failures.push({ iter, detail: "comment-looking string content was stripped" });
      if (failures.length >= 3) break;
    }
    expect(failures).toEqual([]);
  });

  it("generated JSONC: no comment tokens remain, significant stream unchanged", () => {
    const rng = makeRng(0x53747232); // "Str2"
    const failures: { iter: number; detail: string }[] = [];
    for (let iter = 0; iter < 300; iter++) {
      const { text } = genJsoncDoc(rng);
      const before = scanSigc(text);
      const { text: stripped } = stripJsonc(text);
      const after = scanSigc(stripped);
      if (after.commentChars !== 0) failures.push({ iter, detail: "comment tokens survived" });
      if (after.sig !== before.sig) failures.push({ iter, detail: "significant stream changed" });
      if (after.trailingCommas !== 0) failures.push({ iter, detail: "trailing comma survived" });
      if (after.bom) failures.push({ iter, detail: "BOM survived" });
      if (!parses(stripped)) failures.push({ iter, detail: "stripped text does not parse" });
      if (failures.length >= 3) break;
    }
    expect(failures).toEqual([]);
  });
});

describe("rescue fuzz: fix path (runRescue fix, mkdtemp only)", () => {
  it("repaired file parses deep-equal to the generated value; comments-only change; .bak preserved", async () => {
    const rng = makeRng(0x46697831); // "Fix1"
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-fuzz-fix-"));
    try {
      for (let iter = 0; iter < 24; iter++) {
        // fresh subdir each iteration: repairFile never overwrites an existing
        // .bak (it chains .bak.1...), so one dir per doc keeps the backup pin
        // meaningful
        const sub = path.join(dir, `i${iter}`);
        await fs.mkdir(sub, { recursive: true });
        const cfg = path.join(sub, "defaults.json");
        const { text, value, stats } = genJsoncDoc(rng);
        // The generated doc must itself be genuinely JSONC, not plain JSON.
        expect(stats.comments + stats.trailingCommas + (text.charCodeAt(0) === 0xfeff ? 1 : 0)).toBeGreaterThan(0);
        await fs.writeFile(cfg, text, "utf-8");
        const { code, out } = await rescue(sub, true);
        const repaired = await fs.readFile(cfg, "utf-8");
        // 1. Deep-equality with the oracle value -- never a silent change.
        let reparsed: unknown = null;
        let ok = true;
        try {
          reparsed = JSON.parse(repaired);
        } catch {
          ok = false;
        }
        if (!ok) {
          expect({ iter, fixed: out.join("|") }).toEqual({ iter, fixed: "REPAIR PRODUCED UNPARSEABLE TEXT" });
        }
        expect(reparsed).toEqual(value);
        // 2. Comments-only: significant streams agree; the scanner counts
        //    the exact comment/trailing-comma budget the generator inserted.
        const before = scanSigc(text);
        const after = scanSigc(repaired);
        expect(before.trailingCommas).toBe(stats.trailingCommas);
        expect(after.commentChars).toBe(0);
        expect(after.trailingCommas).toBe(0);
        expect(after.sig).toBe(before.sig);
        // 3. Backup is byte-identical to the broken original.
        const bak = await fs.readFile(cfg + ".bak", "utf-8");
        expect(bak).toBe(text);
        expect([0, 1]).toContain(code);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("schema-valid doc: fix then clean second pass", async () => {
    const rng = makeRng(0x46697832); // "Fix2"
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-fuzz-ok-"));
    try {
      const cfg = path.join(dir, "defaults.json");
      for (let iter = 0; iter < 8; iter++) {
        const { text, value } = genSchemaCleanDoc(rng);
        await fs.writeFile(cfg, text, "utf-8");
        const first = await rescue(dir, true);
        expect(first.out.join("\n")).toContain("FIXED");
        expect(JSON.parse(await fs.readFile(cfg, "utf-8"))).toEqual(value);
        const again = await rescue(dir, true);
        expect(again.code).toBe(0);
        expect(again.out.join("\n")).toContain("No problems found.");
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rescue fuzz: findJsonError differential", () => {
  it("seeded corruptions: verdict agrees with the grammar machine; index lands on the offending span", () => {
    const rng = makeRng(0x436f7231); // "Cor1"
    const alphabet = [...'{}[]",:', "t", "r", "u", "e", "f", "a", "l", "n", "0", "1", "9", ".", "-", "+", "e", " ", "\n", "/", "*", "\\", "\uFEFF", "x", "\t"];
    const failures: { iter: number; detail: string; text: string }[] = [];
    for (let iter = 0; iter < 500; iter++) {
      const value = { a: genValue(rng, 2), b: [genValue(rng, 2), genValue(rng, 2)] };
      const base = JSON.stringify(value);
      let text = base;
      const muts = 1 + rng.int(3);
      for (let m = 0; m < muts; m++) {
        const at = rng.int(text.length);
        const op = rng.int(4);
        if (op === 0) text = text.slice(0, at) + text.slice(at + 1);
        else if (op === 1) text = text.slice(0, at) + text[at] + text.slice(at);
        else if (op === 2) text = text.slice(0, at) + rng.pick(alphabet) + text.slice(at + 1);
        else text = text.slice(0, at) + rng.pick(alphabet) + text.slice(at);
      }
      const dead = grammarDead(text);
      // The machine must agree with the JSON.parse oracle on VALIDITY.
      if ((dead === null) !== parses(text)) {
        failures.push({ iter, detail: "oracle machine disagrees with JSON.parse", text });
        if (failures.length >= 3) break;
        continue;
      }
      const fje = findJsonError(text);
      if (dead === null) {
        if (fje !== null) failures.push({ iter, detail: `valid text but fje=${fje}`, text });
      } else {
        if (fje === null) {
          failures.push({ iter, detail: `invalid text but fje=null (divergence candidate)`, text });
        } else if (!(fje >= dead.lo && fje <= dead.hi)) {
          failures.push({ iter, detail: `fje=${fje} outside offending span [${dead.lo},${dead.hi}]`, text });
        }
      }
      if (failures.length >= 3) break;
    }
    expect(failures).toEqual([]);
  });

  it("pinned: findJsonError scans where JSON.parse can, and gives up (null) past the depth cap instead of crashing", () => {
    // RangeError regression: unguarded recursion blew the stack on deep
    // nesting (measured: fine at 20k-30k, RangeError at 50k on bun/JSC;
    // V8 nearer 10k) while JSON.parse handles these depths fine.
    const broken = "[".repeat(20000) + "]".repeat(19999);
    expect(() => findJsonError(broken)).not.toThrow();
    expect(findJsonError(broken)).toBeNull(); // gave up: unlocatable, not wrong
    const ok = "[".repeat(50000) + "]".repeat(50000);
    expect(findJsonError(ok)).toBeNull();
    // Shallow errors keep their exact pins.
    expect(findJsonError('{"a": 1} x')).toBe(9);
    expect(findJsonError('{"a":"x\\ay"}')).toBe(8);
    expect(findJsonError("")).not.toBeNull();
    expect(findJsonError("  ")).toBe(2);
    expect(findJsonError('{"a":1}' + "\uFEFF")).toBe(7); // mid-text BOM
    expect(findJsonError('{"a":"\\ud800"}')).toBeNull(); // lone-surrogate escape is valid JSON
  });
});

describe("rescue fuzz: crash corpus (mkdtemp, never user dirs)", () => {
  const EDGE_FILES: Array<[string, string]> = [
    ["trunc-mid-escape", `{"a":"x\\`],
    ["trunc-mid-uescape", '{"a":"\\u12'],
    ["unclosed-string", '{"a":"no end'],
    ["block-opener-eof", '{"a":1}/*'],
    ["line-comment-eof", '{"a":1}// x'],
    ["block-only", "/*"],
    ["line-only", "//"],
    ["bom-only", "\uFEFF"],
    ["bom-trailing-comma", "\uFEFF{\"a\":1,}"],
    ["deep-broken", "[".repeat(20000) + "]".repeat(19999)],
    ["deep-valid", "[".repeat(20000) + "]".repeat(20000)],
    ["raw-control-char", '{"a":"x\u0001y"}'],
    ["lone-surrogate-escape", '{"a":"\\ud800"}'],
    ["comma-behind-comment", "[1,/*c*/]"],
    ["crlf-comment", '{"a":1}\r\n// tail\r\n'],
    ["nul-literal", '{"a":nul}'],
    ["kw-truncated", "tru"],
    ["kw-extra", '{"a":nulll}'],
    ["double-comma", '{"a":1,,}'],
    ["just-comma", ","],
    ["empty", ""],
  ];

  it("diagnoseConfigFile never throws; fix writes only when fixable; fixable matches its contract", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-fuzz-edge-"));
    try {
      for (const [name, body] of EDGE_FILES) {
        const file = path.join(dir, name + ".json");
        await fs.writeFile(file, body, "utf-8");
        const report = await diagnoseConfigFile(file);
        expect(["ok", "broken", "missing"]).toContain(report.status);
        if (report.status === "broken") {
          const { text, issues } = stripJsonc(body);
          expect(report.fixable).toBe(issues.length > 0 && parses(text));
          expect(report.errorIndex).toBe(findJsonError(body));
          if (report.fixable) {
            expect(parses(report.parsedText ?? "")).toBe(true);
          }
        }
        // Drive the CLI-equivalent fix path over the same file.
        const sub = path.join(dir, name);
        await fs.mkdir(sub, { recursive: true });
        await fs.writeFile(path.join(sub, "defaults.json"), body, "utf-8");
        const { code } = await rescue(sub, true);
        expect([0, 1]).toContain(code);
        const after = await fs.readFile(path.join(sub, "defaults.json"), "utf-8");
        if (report.fixable) {
          expect(parses(after)).toBe(true);
        } else {
          expect(after).toBe(body); // untouched when nothing is repairable
        }
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
