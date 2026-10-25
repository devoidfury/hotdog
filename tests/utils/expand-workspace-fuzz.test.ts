// Fuzz suite for utils/workspace.ts expandWorkspacePaths brace expansion
// (the glob engine underneath is Bun.Glob; semantics below were pinned
// empirically against bun 1.4.2, see run notes fuzz-path-globbing.md).
//
// SUPPORTED BRACE SUBSET:
//   - `{alt1,alt2,...}` groups, NESTED up to 10 levels (Bun silently drops
//     alternatives past depth ~10 -- deep nesting is therefore invariant-
//     only, never oracle-checked); concatenation with literals ("a{b,c}")
//     and cartesian groups per segment.
//   - alternatives are single-segment: a `/` inside any alternative matches
//     NOTHING (engine limit); `..` inside a brace alternative matches
//     NOTHING (containment: braces can never walk up); empty alternatives
//     are legal and contribute no path; dotfile alternatives never match
//     (dot-gating: only literal segments starting with `.` reach dotfiles).
//   - `[abc]`, `[!a]`, `*`, `?`, `**` also work but are checked by
//     invariants only (their expansion oracle would need full glob
//     semantics); exact-match oracle covers literals + braces only.
//   - raw (non-brace) `..` segments DO walk up: an absolute config entry is
//     user-supplied and trusted; the security boundary for tool input is
//     Workspace.resolveSafe, not expandWorkspacePaths. Pinned below.
//
// FALLBACK RULE (pinned from the source): glob magic + zero matches +
// literal path exists -> the literal is kept (dirs named `{lit}` work);
// zero matches + literal missing -> entry dropped with a warning; all
// entries dropped -> ConfigError.
//
// Invariants asserted on EVERY generated pattern: never crashes (only
// ConfigError for the all-dropped case); every result is absolute, already
// normalized, exists on disk; for `..`-free rooted patterns every result is
// lexically under the entry root; repeated calls return identical arrays.
// Deterministic: fixed seeds, no Math.random/Date.now, real fs only under
// mkdtemp, cwd untouched (bun test runs files in parallel). Whole file
// budget: < 1.5 s wall.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandWorkspacePaths } from "@utils/workspace.ts";
import { ConfigError } from "@core/error.ts";
import { makeRng } from "../fuzz/prng.ts";

let base: string;
let root: string;
const R = (s: string) => path.join(root, s);

// Names that EXIST directly under root (no dotfiles -- brace alternatives
// never match those; no `/` or `..` -- out of the oracle subset).
const EXISTING = ["a", "b", "c", "x", "café", "ünï", "日本", "n1", "f.txt", "pack_2"];
const MISSING = ["zz", "q9", "nope", "caféx"];

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-ewpfuzz-"));
  root = path.join(base, "root");
  for (const d of EXISTING) {
    if (d.includes(".")) fs.writeFileSync(path.join(root, d), "x");
    else fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  fs.mkdirSync(path.join(root, "x", "y"), { recursive: true });
  fs.mkdirSync(path.join(root, "café", "ünï"), { recursive: true });
  fs.mkdirSync(path.join(root, "n1", "n2", "n3"), { recursive: true });
  fs.mkdirSync(path.join(root, ".hidden"), { recursive: true });
  fs.mkdirSync(path.join(root, "{lit}"), { recursive: true });
  fs.mkdirSync(path.join(root, "sp ace"), { recursive: true });
  fs.writeFileSync(path.join(root, ".hidden", "h"), "1");
  fs.writeFileSync(path.join(root, "{lit}", "g"), "1");
  // deterministic base contents for the raw-`..` pin
  fs.mkdirSync(path.join(base, "sib"), { recursive: true });
  fs.writeFileSync(path.join(base, "peek.txt"), "1");
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

// ── Brace oracle (supported subset: literals + well-formed braces) ──

/** Cartesian-flatten every well-formed brace group. Unclosed groups stay
 * literal (malformed handling is pinned separately, never oracle'd). */
function expandBraces(pat: string): string[] {
  const i = pat.indexOf("{");
  if (i === -1) return [pat];
  let depth = 0;
  let close = -1;
  for (let k = i; k < pat.length; k++) {
    if (pat[k] === "{") depth++;
    else if (pat[k] === "}") {
      depth--;
      if (depth === 0) {
        close = k;
        break;
      }
    }
  }
  if (close === -1) return [pat];
  const alts: string[] = [];
  let d = 0;
  let start = i + 1;
  for (let k = i + 1; k < close; k++) {
    if (pat[k] === "{") d++;
    else if (pat[k] === "}") d--;
    else if (pat[k] === "," && d === 0) {
      alts.push(pat.slice(start, k));
      start = k + 1;
    }
  }
  alts.push(pat.slice(start, close));
  const out: string[] = [];
  for (const alt of alts) {
    for (const expanded of expandBraces(pat.slice(0, i) + alt + pat.slice(close + 1))) {
      out.push(expanded);
    }
  }
  return out;
}

/** Expected expandWorkspacePaths output for one oracle-subset pattern:
 * unique expanded candidates that (a) contain no `..` segment (the engine
 * drops those alternatives), (b) have no empty segment (empty alternatives
 * contribute no path), (c) have no dot-prefixed segment (brace alternatives
 * never match dotfiles), and (d) exist on disk. Empty result => ConfigError.
 */
function oracleExpected(pattern: string): string[] {
  const seen = new Set<string>();
  for (const cand of expandBraces(pattern)) {
    const segs = cand.split("/");
    if (segs.some((s) => s === "..")) continue;
    if (segs.some((s) => s.startsWith("."))) continue;
    if (fs.existsSync(cand)) seen.add(cand);
  }
  return [...seen].sort();
}

function runEwp(entries: string[]): string[] | null {
  try {
    return expandWorkspacePaths(entries);
  } catch (e) {
    if (e instanceof ConfigError) return null;
    throw new Error(
      `expandWorkspacePaths threw non-ConfigError for ${JSON.stringify(entries.map((x) => x.slice(0, 160)))}: ` +
        `${(e as Error).name}: ${(e as Error).message}`,
    );
  }
}

function insideLexically(p: string, r: string): boolean {
  return p === r || p.startsWith(r + "/"); // same `/` convention as workspace.ts within()
}

/** Invariants for any ROOTED-AND-`..`-FREE pattern result set. */
function checkInvariants(out: string[] | null, rootedRoot: string): void {
  if (out === null) return; // all dropped is a legal ConfigError outcome
  for (const o of out) {
    const label = JSON.stringify(o.slice(0, 160));
    expect(path.isAbsolute(o), `not absolute: ${label}`).toBe(true);
    expect(path.normalize(o), `not normalized: ${label}`).toBe(o);
    expect(insideLexically(o, rootedRoot), `result escapes entry root: ${label}`).toBe(true);
    expect(fs.existsSync(o), `result does not exist: ${label}`).toBe(true);
  }
}

// ── Generator ───────────────────────────────────────────────────────

function genBraceExpr(rng: ReturnType<typeof makeRng>, depth: number): string {
  const n = 1 + rng.int(3);
  const alts: string[] = [];
  for (let i = 0; i < n; i++) {
    if (depth > 0 && rng.bool(0.3)) {
      alts.push(genBraceExpr(rng, depth - 1));
    } else {
      alts.push(rng.pick(rng.bool(0.7) ? EXISTING : MISSING));
    }
  }
  return "{" + alts.join(",") + "}";
}

function genSegment(rng: ReturnType<typeof makeRng>): string {
  // 1-3 atoms: literals concatenated with brace groups ("a{b,c}" shapes)
  const atoms: string[] = [];
  const n = 1 + rng.int(3);
  for (let i = 0; i < n; i++) {
    if (rng.bool(0.6)) atoms.push(genBraceExpr(rng, rng.bool(0.4) ? 2 : 1));
    else atoms.push(rng.pick(rng.bool(0.75) ? EXISTING : MISSING));
  }
  // brace-free literal segments would make the entry literal (no magic);
  // guarantee at least one brace so this suite always exercises expansion
  if (!atoms.some((a) => a.includes("{"))) atoms.push(genBraceExpr(rng, 1));
  return atoms.join("");
}

function genPattern(rng: ReturnType<typeof makeRng>): string {
  const depth = 1 + rng.int(2);
  const segs: string[] = [];
  for (let i = 0; i < depth; i++) segs.push(genSegment(rng));
  return R(segs.join("/"));
}

// ── Seeded expansion agreement + invariants ─────────────────────────

describe("workspace brace expansion fuzz", () => {
  it("600 seeded brace patterns expand exactly like the flatten oracle", () => {
    const rng = makeRng(0x5b7e_0001);
    const mismatches: { iter: number; pattern: string; got: string[] | null; want: string[] }[] = [];
    for (let i = 0; i < 600; i++) {
      const pattern = genPattern(rng);
      const out = runEwp([pattern]);
      const want = oracleExpected(pattern);
      const got = out === null ? null : [...out].sort();
      if (JSON.stringify(got) !== JSON.stringify(want.length ? want : null)) {
        mismatches.push({ iter: i, pattern: pattern.slice(root.length), got, want });
      }
      checkInvariants(out, root);
      if (out !== null) {
        // deterministic re-serialization: byte-identical on a repeat call
        expect(runEwp([pattern])).toEqual(out);
      }
      if (mismatches.length >= 3) break;
    }
    expect(mismatches).toEqual([]);
  });

  it("multi-entry calls deduplicate and keep union semantics", () => {
    const rng = makeRng(0x5b7e_0002);
    for (let i = 0; i < 150; i++) {
      const n = 2 + rng.int(3);
      const entries: string[] = [];
      for (let k = 0; k < n; k++) entries.push(genPattern(rng));
      const out = runEwp(entries);
      checkInvariants(out, root);
      const wantAll = [...new Set(entries.flatMap((e) => oracleExpected(e)))].sort();
      if (out === null) {
        expect(wantAll).toEqual([]);
      } else {
        expect(out.length, "duplicates in output").toBe(new Set(out).size);
        expect([...out].sort()).toEqual(wantAll);
        expect(runEwp(entries)).toEqual(out);
      }
    }
  });

  // ── Malformed braces: pinned fallback behavior ────────────────────

  it("pinned: literal-brace dir kept via literal fallback", () => {
    expect(runEwp([R("{lit}")])).toEqual([R("{lit}")]); // glob matches 0; literal exists
  });

  it("pinned: unclosed group matches all COMPLETE alternatives, drops the last", () => {
    expect(runEwp([R("{a,zzz")])).toEqual([R("a")]); // "zzz" is the open alt
    expect(runEwp([R("{a,b")])).toEqual([R("a")]);
    // dropping the last alternative kills the only existing name -> ConfigError
    expect(runEwp([R("{zzz,a")])).toBeNull();
    expect(runEwp([R("{x/y,a")])).toBeNull(); // `/` inside an alt deadens it
  });

  it("pinned: stray braces are literal (and dropped when missing)", () => {
    expect(runEwp([R("{a}}")])).toBeNull(); // extra `}` after a closed group
    expect(runEwp([R("{")])).toBeNull(); // lone brace, literal missing
    expect(runEwp([R("}")])).toBeNull(); // `}` is not magic; literal missing
    expect(runEwp([R("{lit}")])).toEqual([R("{lit}")]); // literal dir survives fallback
  });

  it("pinned: empty alternatives contribute nothing, `{a,}` is just a", () => {
    expect(runEwp([R("{a,}")])).toEqual([R("a")]); // NOT the root dir itself
    expect(runEwp([R("{,}")])).toBeNull();
  });

  // ── Containment ───────────────────────────────────────────────────

  it("containment: `..` inside braces never matches and never walks up", () => {
    expect(runEwp([R("{..,x}/y")])).toEqual([R("x/y")]); // ..-alt contributes nothing
    expect(runEwp([R("{a,..}")])).toEqual([R("a")]);
    expect(runEwp([R("{..}")])).toBeNull();
    // a `/` in ANY alternative kills the whole group (engine limit)
    expect(runEwp([R("{a,../..}")])).toBeNull();
    // sibling/peek are only reachable through raw `..`, never via braces
    for (const out of [runEwp([R("{..,x}/y")]), runEwp([R("*/y")])]) {
      for (const o of out ?? []) expect(insideLexically(o, root)).toBe(true);
    }
  });

  it("pinned: RAW `..` segments walk up (config entries are trusted; boundary is resolveSafe)", () => {
    // Bun.Glob treats literal `..` segments as parent traversal. This is the
    // documented escape hatch for user config; hotdog adds no extra
    // containment here by design. Pinned so a behavior change is noticed.
    const out = runEwp([R("../*")]);
    expect(out).not.toBeNull();
    expect([...out!].sort()).toEqual([R("."), path.join(base, "peek.txt"), path.join(base, "sib")].sort());
    expect(runEwp([R("../sib")])).toEqual([path.join(base, "sib")]);
  });

  // ── No blowup: deep nesting and exponential-shaped patterns ───────

  it("100k-deep nested braces: no crash, no blowup, wall bounded", () => {
    const t0 = performance.now();
    for (const k of [1000, 20000, 100000]) {
      const pattern = R("{a,".repeat(k) + "x" + "}".repeat(k));
      const out = runEwp([pattern]); // may legitimately be [a] or null
      checkInvariants(out, root);
      if (out !== null) for (const o of out) expect(o).toBe(R("a")); // only ever `a`
      expect(performance.now() - t0).toBeLessThan(2000);
    }
  });

  it("exponential brace shapes stay linear (engine walks lazily)", () => {
    const t0 = performance.now();
    expect(runEwp([R("{a,b}".repeat(60))])).toBeNull(); // 2^60 expansions, none exist
    expect(runEwp([R("a{b,c}{d,e}{f,g}".repeat(40))])).toBeNull();
    // one matching prefix must still resolve without enumerating the tail
    const hit = runEwp([R("{a,b}".repeat(2))]); // a/a.. none exist -> null
    expect(hit).toBeNull();
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("unicode segments inside braces expand and match", () => {
    const out = runEwp([R("{café,ünï,日本,zz}")]);
    expect([...(out ?? [])].sort()).toEqual([R("café"), R("ünï"), R("日本")].sort());
    const nested = runEwp([R("{a,{日本,ünï}}")]) ?? [];
    expect([...nested].sort()).toEqual([R("a"), R("ünï"), R("日本")].sort()); // nested, depth 2
    expect(runEwp([R("café/ünï")])).toEqual([R("café/ünï")]); // no magic -> literal
  });

  it("NUL bytes never crash: entry dropped or ConfigError", () => {
    expect(runEwp([R("a\u0000*")])).toBeNull();
    expect(runEwp([R("{a\u0000b,a}")])).toEqual([R("a")]);
    expect(runEwp([R("\u0000")])).toBeNull();
  });

  // ── Wildcard classes/stars: invariant-only fuzz (no expansion oracle) ──

  it("400 seeded wildcard+brace patterns: invariants hold, results exist", () => {
    const rng = makeRng(0x5b7e_0003);
    const PIECES = ["*", "**", "?", "[abc]", "[!a]", "x*", "*.txt", "n1/*", "n1/**", ".hidden/*", ".*", "café/*", "{a,*}", "x/{y,q9}", "**/f.txt"];
    for (let i = 0; i < 400; i++) {
      const segs = [genSegment(rng)];
      const extra = rng.int(2);
      for (let k = 0; k < extra; k++) segs.push(rng.pick(PIECES));
      const pattern = R(segs.join("/"));
      const out = runEwp([pattern]);
      checkInvariants(out, root);
      if (out !== null) expect(runEwp([pattern])).toEqual(out);
    }
  });
});
