// Fuzz suite for utils/gitignore.ts compileGitignore (path filtering over
// repo-supplied .gitignore content, which is attacker-reachable).
//
// SUPPORTED SUBSET (transcribed from the source; where it deviates from git
// it is noted; disputed cases were checked against `git check-ignore`, see
// the run notes fuzz-path-globbing.md):
//   - lines split on \n; TRAILING whitespace stripped (house: all trailing
//     whitespace; git strips only trailing SPACES -- mildly stricter);
//     empty and leading-# lines skipped; leading `!` negates; a trailing `/`
//     marks directory-only.
//   - directory rules are PATH-ONLY (no fs knowledge): a hit ignores the
//     exact path and everything beneath it, directory or not. Trailing `/`
//     therefore changes nothing on normalized paths.
//   - body containing `/` anchors at the root; otherwise match starts at any
//     segment boundary. A single LEADING `/` anchors and is stripped (git);
//     `//build` matches nothing (git keeps it too).
//   - `*` = run of non-`/`; `?` = one non-`/`; `[abc]`/`[a-z]`/`[!abc]`
//     classes (leading `]` literal member; `-` literal at class edges;
//     unterminated `[` is literal; a class never matches `/`).
//   - boundary `**` (`**/`, `/**`, `/**/`) = whole segments: `**/` and mid
//     `/**/` zero or more, trailing `/**` one or more (git-compatible).
//   - HOUSE DEVIATION (pinned by gitignore.test.ts): `**` NOT adjacent to a
//     `/` boundary is `.*` and CROSSES `/` (git treats it as one `*`).
//   - everything else is literal (no backslash escape mechanism; regex
//     metacharacters are plain chars; POSIX classes and reversed ranges are
//     out of subset and only junk-tested).
//   - rules in order (implicit first), LAST MATCH WINS.
//
// The oracle below re-implements that subset independently (forward string
// recursion vs the product's backward token DP). The generator only emits
// in-subset patterns/paths; junk gets crash/timing assertions only.
// Deterministic: fixed seeds, no Math.random/Date.now, no fs needed (the
// matcher is purely syntactic). Whole file budget: < 1 s wall.

import { describe, it, expect } from "bun:test";
import { posix } from "node:path";
import { compileGitignore } from "@utils/gitignore.ts";
import { makeRng } from "../fuzz/prng.ts";

// ── Independent oracle ──────────────────────────────────────────────

function oracleNormalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else out.push(seg);
  }
  return out.length === 0 ? "." : out.join("/");
}

/** True when the (already body-processed) pattern matches `path` from a legal
 * start position (0 if anchored, any segment boundary otherwise). Forward
 * recursion over the raw pattern string -- deliberately not the product's
 * token DP. */
function oracleRuleMatch(pat: string, path: string, anchored: boolean): boolean {
  const m = (pi: number, pos: number): boolean => {
    if (pi === pat.length) return pos === path.length || path[pos] === "/";
    const ch = pat[pi]!;
    if (ch === "*" && pat[pi + 1] === "*") {
      const boundary =
        (pi === 0 || pat[pi - 1] === "/") &&
        (pi + 2 === pat.length || pat[pi + 2] === "/");
      if (!boundary) {
        // house dialect: `.*`, crosses `/`
        for (let k = pos; k <= path.length; k++) if (m(pi + 2, k)) return true;
        return false;
      }
      if (pi + 2 === pat.length) {
        // trailing `**`; after a slash it means "everything inside" (>=1 char)
        if (pi > 0 && pat[pi - 1] === "/") return pos < path.length;
        for (let k = pos; k <= path.length; k++) if (m(pi + 2, k)) return true;
        return false;
      }
      // `**/`: zero or more whole segments
      if (m(pi + 3, pos)) return true;
      for (let q = pos + 1; q < path.length; q++) {
        if (path[q] === "/" && m(pi + 3, q + 1)) return true;
      }
      return false;
    }
    if (ch === "*") {
      for (let k = pos; k <= path.length; k++) {
        if (k > pos && path[k - 1] === "/") return false;
        if (m(pi + 1, k)) return true;
      }
      return false;
    }
    if (ch === "?") return pos < path.length && path[pos] !== "/" && m(pi + 1, pos + 1);
    if (ch === "[") {
      let j = pi + 1;
      let neg = false;
      if (pat[j] === "!") {
        neg = true;
        j++;
      }
      if (pat[j] === "]") j++;
      while (j < pat.length && pat[j] !== "]") j++;
      if (j === pat.length) return path[pos] === "[" && m(pi + 1, pos + 1);
      if (pos < path.length && path[pos] !== "/") {
        const c = path[pos]!;
        const cls = pat.slice(pi + 1 + (neg ? 1 : 0), j);
        let hit = false;
        for (let k = 0; k < cls.length && !hit; ) {
          if (k + 2 < cls.length && cls[k + 1] === "-") {
            hit = c >= cls[k]! && c <= cls[k + 2]!;
            k += 3;
          } else {
            hit = c === cls[k];
            k += 1;
          }
        }
        if (hit !== neg) return m(j + 1, pos + 1);
      }
      return false;
    }
    return pos < path.length && path[pos] === ch && m(pi + 1, pos + 1);
  };
  if (m(0, 0)) return true;
  if (anchored) return false;
  for (let s = 1; s < path.length; s++) {
    if (path[s - 1] === "/" && m(0, s)) return true;
  }
  return false;
}

interface OracleRule {
  pat: string;
  anchored: boolean;
  negated: boolean;
}

/** Compile a gitignore body per the subset spec. dirOnly is recorded but (as
 * in the product) cannot change matching without fs knowledge. */
function oracleCompile(content: string, implicitPatterns: string[]): OracleRule[] {
  const rules: OracleRule[] = [];
  const full = implicitPatterns.length > 0 ? implicitPatterns.join("\n") + "\n" + content : content;
  for (const raw of full.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    let body = negated ? line.slice(1) : line;
    if (body === "") continue;
    const dirOnly = body.endsWith("/");
    if (dirOnly) body = body.slice(0, -1);
    const anchored = body.includes("/");
    if (body.startsWith("/")) body = body.slice(1);
    if (body === "") continue; // `//`, `/` -- never-match rules
    rules.push({ pat: body, anchored, negated });
  }
  return rules;
}

function oracleKeep(rules: OracleRule[], rawPath: string): boolean {
  const path = oracleNormalize(rawPath);
  let ignored = false;
  for (const r of rules) {
    if (oracleRuleMatch(r.pat, path, r.anchored)) ignored = !r.negated;
  }
  return !ignored;
}

// ── Seeded generator (in-subset only) ───────────────────────────────

const NAME_POOL = [
  "a", "b", "src", "dist", "build", ".env", ".env.local", ".git", "node_modules",
  "index.ts", "file.log", "x.js", ".hidden", "pack_2", "café", "x-y", "deep",
  "sub.dir", "*.weird*", "[brack]", "!bang", "#tag", "s p", "x ", "test", "lib",
] as const;

function genPathSeg(rng: ReturnType<typeof makeRng>): string {
  return rng.pick(NAME_POOL);
}

function genPath(rng: ReturnType<typeof makeRng>): string {
  const depth = 1 + rng.int(6);
  const segs: string[] = [];
  for (let i = 0; i < depth; i++) segs.push(genPathSeg(rng));
  return segs.join("/");
}

function genPatternPiece(rng: ReturnType<typeof makeRng>): string {
  const roll = rng.float();
  if (roll < 0.35) return rng.pick(NAME_POOL);
  if (roll < 0.5) {
    // wildcard shapes
    return rng.pick(["*", "a*", "*a", "*b*", "x?", "?.js", "*.[jl]*", "x*", "*x", "*.log", "*.[a-z]", "[!x]*", "[ab]", "[!ab]", "[.]*", "*.*"]);
  }
  if (roll < 0.6) {
    // house crossStar (greedy, crosses `/`)
    const a = rng.pick(["a", "b", "x", "src", "dist"]);
    const b = rng.pick(["b", "js", "log", "a"]);
    return `${a}**${b}`;
  }
  if (roll < 0.75) return "x".repeat(1 + rng.int(4));
  return rng.pick(["a.b", "x-y", "u_z", "9f", "T.S"]);
}

/** One pattern line (may be blank or a comment). */
function genPatternLine(rng: ReturnType<typeof makeRng>): string {
  const roll = rng.float();
  if (roll < 0.06) return "";
  if (roll < 0.12) return "# " + rng.pick(["note", "comment", "x"]);
  const n = 1 + rng.int(3);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(rng.bool(0.18) ? "**" : genPatternPiece(rng));
  }
  let line = parts.join("/");
  if (rng.bool(0.1)) line = "/" + line; // leading slash (anchor)
  if (rng.bool(0.3)) line = line + "/"; // directory-only
  if (rng.bool(0.2)) line = line + "/**"; // trailing deep
  if (rng.bool(0.35)) line = "!" + line;
  return line;
}

function genContent(rng: ReturnType<typeof makeRng>): string {
  const lines: string[] = [];
  const n = 1 + rng.int(6);
  for (let i = 0; i < n; i++) lines.push(genPatternLine(rng));
  return lines.join("\n");
}

const IMPLICIT_POOL = [[], [], [] as string[], [".git"], ["node_modules", ".venv"], [".git", "dist"]] as const;

// ── Randomized subset agreement ─────────────────────────────────────

describe("gitignore fuzz: oracle agreement", () => {
  it("2500 seeded (content, path) pairs agree with the oracle", () => {
    const rng = makeRng(0x67_1969_0a1);
    const mismatches: { iter: number; content: string; implicit: string[]; path: string }[] = [];
    for (let i = 0; i < 2500; i++) {
      const content = genContent(rng);
      const implicit = [...rng.pick(IMPLICIT_POOL)];
      const path = genPath(rng);
      const filter = compileGitignore(content, { implicitPatterns: implicit });
      const rules = oracleCompile(content, implicit);
      if (filter(path) !== oracleKeep(rules, path)) {
        mismatches.push({ iter: i, content, implicit, path });
        if (mismatches.length >= 3) break;
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("matcher output is deterministic across repeat calls", () => {
    const rng = makeRng(0x67_1969_0b2);
    for (let i = 0; i < 200; i++) {
      const content = genContent(rng);
      const implicit = [...rng.pick(IMPLICIT_POOL)];
      const filter = compileGitignore(content, { implicitPatterns: implicit });
      for (let k = 0; k < 5; k++) {
        const path = genPath(rng);
        expect(filter(path)).toBe(filter(path));
      }
    }
  });
});

// ── Negation monotonicity (last matching rule wins) ─────────────────

describe("gitignore fuzz: negation monotonicity", () => {
  it("appending `!P` flips exactly the P-matching paths to keep; appending P to ignore", () => {
    const rng = makeRng(0x67_1969_0c3);
    const problems: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const base = genContent(rng);
      // single-rule pattern, no leading `!` (that is what we are appending)
      let p = genPatternLine(rng);
      if (p === "" || p.startsWith("#")) p = "a";
      if (p.startsWith("!")) p = p.slice(1);
      p = p.replace(/\s+$/, ""); // line parsing strips trailing whitespace first
      if (p === "") p = "a";
      const path = genPath(rng);
      const norm = posix.normalize(path).replace(/\/+$/, "");
      // mirror the documented body processing: dirOnly strip, then anchor
      // detection, then the single leading-slash strip
      let body = p;
      if (body.endsWith("/")) body = body.slice(0, -1);
      const anchored = body.includes("/");
      if (body.startsWith("/")) body = body.slice(1);
      const hit = body !== "" && oracleRuleMatch(body, norm, anchored);

      const baseFilter = compileGitignore(base, { implicitPatterns: [] });
      const negated = compileGitignore(base + "\n!" + p, { implicitPatterns: [] });
      const expectedNeg = hit ? true : baseFilter(path);
      if (negated(path) !== expectedNeg) {
        problems.push(`!${p} on ${JSON.stringify(base)} vs ${JSON.stringify(path)}: got ${negated(path)} want ${expectedNeg}`);
      }
      const positive = compileGitignore(base + "\n" + p, { implicitPatterns: [] });
      const expectedPos = hit ? false : baseFilter(path);
      if (positive(path) !== expectedPos) {
        problems.push(`${p} on ${JSON.stringify(base)} vs ${JSON.stringify(path)}: got ${positive(path)} want ${expectedPos}`);
      }
      if (problems.length >= 5) break;
    }
    expect(problems).toEqual([]);
  });
});

// ── Brute-force cross-check on a tiny alphabet ──────────────────────

describe("gitignore fuzz: brute-force tiny-alphabet sweep", () => {
  it("every pattern x path combo over {a,b,.} agrees with the oracle", () => {
    const segs = ["a", "b", ".", "*", "a*", "*a", "?", "[ab]", "[!ab]", "**", "a**", ".*", "[a.]", "b.", "?.b", "**a", "*.b", "b*"];
    const bodies: string[] = [];
    for (const s of segs) {
      bodies.push(s, "**/" + s, s + "/", "/" + s, "a/" + s, s + "/b", "!" + s, "**/" + s + "/b");
    }
    bodies.push("a/**/b", "a/**", "b/**", "a/b", "b/./a", "!a/b", "*/**", "**/**", "./a", "a/./b", "!", "//", "/");
    const paths: string[] = [];
    const alpha = ["a", "b", "."];
    for (const a of alpha) {
      paths.push(a);
      for (const b of alpha) {
        paths.push(`${a}/${b}`);
        for (const c of alpha) paths.push(`${a}/${b}/${c}`);
      }
    }
    let checks = 0;
    const mismatches: string[] = [];
    for (const body of bodies) {
      const filter = compileGitignore(body, { implicitPatterns: [] });
      const rules = oracleCompile(body, []);
      for (const path of paths) {
        checks++;
        if (filter(path) !== oracleKeep(rules, path)) {
          mismatches.push(`${JSON.stringify(body)} vs ${JSON.stringify(path)}: impl=${filter(path)} oracle=${oracleKeep(rules, path)}`);
        }
      }
    }
    expect(checks).toBeGreaterThan(5000);
    expect(mismatches.slice(0, 10)).toEqual([]);
  });
});

// ── Junk: never crash, never pathological ───────────────────────────

describe("gitignore fuzz: junk safety", () => {
  const JUNK_PATTERNS = [
    // unbalanced braces (braces are plain literals in gitignore)
    "{a,b", "}", "{}", "a{2}", "{", "x}{y", "{a,{b,c}",
    // regex metacharacters
    "(.*)+", "a|b", "^$", "$&", "(?:x)", "[z-a]", "[a-\\d]", "[[:alpha:]]",
    "[a\\]", "\\", "]", "[]", "[!", "[^^]", "a{2,3}", "\\d\\w", ".*+?^${}()|[]\\", "(|)()",
    // deep // chains
    "//", "///", "/" .repeat(500), "a//b//c", "//".repeat(250) + "a", "/./".repeat(100),
    // ReDoS shapes (were catastrophic under the old regex matcher)
    "*a".repeat(50) + "b", "*a".repeat(200) + "b", "*ab".repeat(60) + "c",
    "*".repeat(3000), "x".repeat(10000), "x".repeat(5000) + "*",
    "!x".repeat(500), "!".repeat(500) + "x", "***", "****", "**//**", "a**/**b",
    // NUL bytes
    "a\u0000*", "\u0000", "x[\u0000-z]y", "!\u0000", "/\u0000/",
    // unicode and surrogates
    "\u{1F600}*", "عربي**x", "\u{10FFFF}", "\ud800", "\udc00", "a\ud800b",
    "\u202e*", "cafe\u0301*", "ｍ全*", "\u{1F468}\u200d\u{1F469}*",
    // odd but structural
    "!", " ", "  ", "\t", "!/", "/**/", "**/", "**/**", "?*?[", "#", "#\n!x",
  ];
  const JUNK_PATHS = [
    "a".repeat(3000), ("x/".repeat(750) + "y"), "x".repeat(1500) + "x",
    "*weird*.js", "[].tsx", "a\u0000b", "\ud800\udc00", "\ud800",
    "café/ünï/deep", "\u{1F600}/x", ".", "..", "../escape", "a/../b", "/",
    "", " ", "a ", "x//y", "a/./b", "!", "#hash", "{brace}", "s p/x",
    "*a".repeat(750) + "x", "a".repeat(1500) + "y",
  ];

  it("no junk pattern/path throws, whole pass well under the time cap", () => {
    const t0 = performance.now();
    for (const pat of JUNK_PATTERNS) {
      const filter = compileGitignore(pat, { implicitPatterns: [] });
      for (const path of JUNK_PATHS) {
        const kept = filter(path);
        if (typeof kept !== "boolean") throw new Error("non-boolean result");
      }
    }
    // a whole file of junk lines exercises the line parser at scale
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push((i % 5 === 0 ? "!" : "") + "[" + (i % 3 === 0 ? "z-a" : "a-z") + "]" + "*".repeat(i % 7) + "x" + (i % 4 === 0 ? "/" : ""));
    }
    const fileFilter = compileGitignore(lines.join("\n"));
    for (const path of JUNK_PATHS.slice(0, 4)) fileFilter(path);
    const ms = performance.now() - t0;
    // Generous cap: the pre-fix regex matcher took >19 s for ONE of these
    // patterns (5 stars, 200-char path); post-fix the whole pass is ~100 ms.
    expect(ms).toBeLessThan(3000);
  });
});

// ── Fix regressions with git-documented rulings (see run notes) ─────

describe("gitignore fuzz: product-fix regressions", () => {
  it("FIX-1: leading slash anchors like git (`/build` hits root build only)", () => {
    const f = compileGitignore("/build", { implicitPatterns: [] });
    expect(f("build")).toBe(false); // git check-ignore: ignored
    expect(f("build/x")).toBe(false); // git: ignored
    expect(f("src/build")).toBe(true); // git: kept
    // git keeps `//build` matching nothing; exactly one slash is stripped
    const f2 = compileGitignore("//build", { implicitPatterns: [] });
    expect(f2("build")).toBe(true);
  });

  it("FIX-2a: trailing `/**` matches everything inside, not the dir itself", () => {
    const f = compileGitignore("a/**", { implicitPatterns: [] });
    expect(f("a")).toBe(true); // git: kept
    expect(f("a/b")).toBe(false); // git: ignored
    expect(f("a/b/c")).toBe(false); // git: ignored
    const bare = compileGitignore("**", { implicitPatterns: [] });
    expect(bare("a")).toBe(false); // git: ignored
    expect(bare("a/b")).toBe(false); // git: ignored
  });

  it("FIX-2: `*a*a*a*a*a*b` shape matches in polynomial time (was a hang)", () => {
    const f = compileGitignore("*a".repeat(12) + "b", { implicitPatterns: [] });
    const t0 = performance.now();
    expect(f("a".repeat(3000) + "x")).toBe(true);
    expect(f("a".repeat(3000) + "ab")).toBe(false);
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it("FIX-3: malformed classes never throw and never match; classes never cross /", () => {
    expect(compileGitignore("[z-a]", { implicitPatterns: [] })("z")).toBe(true);
    expect(compileGitignore("[z-a]", { implicitPatterns: [] })("a")).toBe(true);
    // `[a\]` closes the class at the final `]`; members are `a` and `\`
    expect(compileGitignore("[a\\]", { implicitPatterns: [] })("a")).toBe(false);
    expect(compileGitignore("[a\\]", { implicitPatterns: [] })("a\\]")).toBe(true);
    // git: `x[!ab]` does NOT match "x/y" (a class never matches a separator);
    // the pre-fix regex [^ab] leaked exactly that.
    expect(compileGitignore("x[!ab]", { implicitPatterns: [] })("x/y")).toBe(true);
    expect(compileGitignore("x[!ab]", { implicitPatterns: [] })("xc")).toBe(false);
  });

  it("path normalization pins", () => {
    const f = compileGitignore("a/b\nb", { implicitPatterns: [] });
    expect(f("a//b")).toBe(false);
    expect(f("a/./b")).toBe(false);
    expect(f("./b")).toBe(false);
    expect(f("b/")).toBe(false);
    expect(f("x/../b")).toBe(false);
    expect(f("")).toBe(true); // normalizes to "."; nothing matches it here
    const dot = compileGitignore(".", { implicitPatterns: [] });
    expect(dot("./")).toBe(false);
    expect(dot("a/b")).toBe(true);
  });
});
