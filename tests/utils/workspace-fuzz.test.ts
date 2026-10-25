// Fuzz suite for utils/workspace.ts (path boundary: resolveSafe + pathMatchesRule).
//
// THE absolute invariant, checked on EVERY resolveSafe call in this file:
//   either it throws PathEscapeError, or it returns a string that
//     a) contains no NUL (product fix: NUL input is now invalid input; a returned
//        path with a NUL would crash every downstream fs call with a raw TypeError),
//     b) is already normalized (no "." / ".." segments),
//     c) sits lexically inside the workspace root -- verified by our OWN prefix
//        comparison, not Workspace.contains,
//     d) and where the target exists, its realpath sits inside realpath(root),
//        again verified with our own prefix comparison.
// Any OTHER exception type is a failure.
//
// Deny-boundary policy is transcribed below as literal per-rule matchers from the
// documented intent of DEFAULT_DENY_PATTERNS (exact dot-dirs, .?profile/.?rc forms,
// *.local*, .env*, with the single `!.env.example` carve-out; rules are byte-exact /
// case-sensitive, gitignore-style, last match wins across the whole path). The oracle
// is independent code; it also reproduces the matched-rule-name contract of the error
// message. Consequence of last-match-wins flagged in the run notes: a later positive or
// the negation can override an earlier positive at a different depth (e.g.
// ".ssh/x/.env.example" resolves); the oracle states the same documented policy.
//
// Deterministic: fixed seeds, no Math.random/Date.now, real dirs under mkdtemp only,
// env untouched. Whole file budget: < 1.5 s wall.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace, PathEscapeError, pathMatchesRule, DEFAULT_DENY_PATTERNS, type PathEscapeKind } from "@utils/workspace.ts";
import { makeRng } from "../fuzz/prng.ts";

let base: string;
let root: string; // the workspace root
let realRoot: string; // realpath(root), for independent containment checks
let sibling: string; // a directory INSIDE root that links may point at
let outside: string; // a directory that is NOT under any root
let ws: Workspace;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-wsfuzz-"));
  root = path.join(base, "ws");
  sibling = path.join(root, "sibling");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "sub", "deep"), { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.writeFileSync(path.join(sibling, "inner.txt"), "inner");
  fs.writeFileSync(path.join(root, "file.txt"), "hello");
  fs.mkdirSync(path.join(root, "cafe\u0301"), { recursive: true }); // NFD-named dir
  fs.writeFileSync(path.join(root, "caf\u00e9.txt"), "nfc"); // NFC-named file
  realRoot = fs.realpathSync.native(root);
  ws = new Workspace(root);
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

// ── Independent containment oracle ──────────────────────────────────

function insideLexically(p: string, r: string): boolean {
  return p === r || p.startsWith(r + "/");
}

/** The absolute invariant for a single resolveSafe call. Returns the path if allowed. */
function expectBoundary(input: string): string | null {
  let out: string;
  try {
    out = ws.resolveSafe(input);
  } catch (e) {
    if (e instanceof PathEscapeError) return null;
    throw new Error(
      `resolveSafe(${JSON.stringify(input.slice(0, 120))}) threw non-PathEscapeError: ` +
        `${(e as Error).name}: ${(e as Error).message}`,
    );
  }
  const label = JSON.stringify(input.slice(0, 120));
  expect(out.includes("\u0000"), `returned path contains NUL for ${label}`).toBe(false);
  expect(out.split("/"), `returned path has '..' for ${label}`).not.toContain("..");
  expect(out.split("/"), `returned path has '.' for ${label}`).not.toContain(".");
  expect(insideLexically(out, root), `returned path escapes root for ${label}`).toBe(true);
  if (fs.existsSync(out)) {
    const real = fs.realpathSync.native(out);
    expect(
      insideLexically(real, realRoot),
      `realpath of returned path escapes root for ${label}`,
    ).toBe(true);
  }
  return out;
}

function expectKind(input: string, kind: PathEscapeKind): void {
  try {
    ws.resolveSafe(input);
    throw new Error(`expected PathEscapeError(${kind}) for ${JSON.stringify(input.slice(0, 80))}, got success`);
  } catch (e) {
    if (!(e instanceof PathEscapeError)) throw e;
    expect(e.kind, `kind for ${JSON.stringify(input.slice(0, 80))}`).toBe(kind);
  }
}

// ── Unicode trickery against resolveSafe ────────────────────────────

describe("workspace fuzz: unicode trickery", () => {
  const TRICKS: string[] = [
    // fullwidth / leader / ellipsis lookalikes of dots and slashes: literal names on
    // any sane fs, so they must resolve INSIDE the root, never reach /etc.
    "\uFF0E\uFF0E/etc/passwd",
    "\uFF0E\uFF0E\uFF0Fetc/passwd",
    "\u2025/etc",
    "\u2024\u2024/etc/passwd",
    "\u2026\u2026/etc/passwd",
    "\u2025\uFF0Fetc",
    "..\uFF0Fetc",
    "..\u2044etc", // U+2044 fraction slash
    "\uFF0E\uFF0E\uFF0E\uFF0E/",
    // NFD/NFC accented names, standalone and around segments
    "caf\u00e9.txt",
    "cafe\u0301.txt", // NFD: a DIFFERENT name on Linux; must not 404-escape or crash
    "caf\u0065\u0301/../file.txt",
    "cafe\u0301/notes.txt",
    "\u00e9\u0301xotic/file", // double-composed e
    "sub/\u0301\u0301/etc", // bare combining marks as a component
    "a\u0338b/../file.txt", // combining long solidus overlay inside a name
    // case variants of escapes and names
    "../FILE.TXT",
    "sub/../File.txt",
    "..\\..\\etc",
    "./FILE.TXT",
    // interleavings of separators and dots
    ".\\./etc/passwd",
    ".\\\\etc",
    "sub//..//etc/passwd",
    "sub\\\\..\\\\..\\\\etc",
    "./.\\./file.txt",
    "sub/./../sub/deep/../../file.txt",
    // fullwidth-letter decoys of denylist names (byte-exact rules: not denied, no crash)
    "\uFF0E\uFF45\uFF0E/etc",
  ];

  for (const [i, input] of TRICKS.entries()) {
    it(`boundary holds for trick #${i} ${JSON.stringify(input.slice(0, 40))}`, () => {
      expectBoundary(input);
    });
  }

  it("known escapes throw direct", () => {
    for (const p of ["../evil", "/etc/passwd", "/dev/null", "//etc/passwd", "/"]) {
      expectKind(p, "direct");
    }
    expectKind("../../../../etc/passwd", "direct");
    expectKind("../".repeat(10000) + "x", "direct");
    // lexical .. chains that end inside must resolve inside (pinned elsewhere; here
    // only the boundary oracle).
    expect(typeof expectBoundary("sub/deep/../../file.txt")).toBe("string");
    expect(typeof expectBoundary("sub/../../" + path.basename(root) + "/file.txt")).toBe("string");
  });
});

// ── NUL bytes ────────────────────────────────────────────────────────

describe("workspace fuzz: null bytes", () => {
  // Post-fix policy: a NUL anywhere in the input is invalid input; it never reaches the
  // returned string. Pre-fix this returned `${root}/a\u0000b` (see run notes FIX-1).
  const NUL_INPUTS = [
    "\u0000",
    "a\u0000b",
    "sub/\u0000/deep",
    "\u0000/etc/passwd",
    "file.txt\u0000../../etc/passwd",
    ".env\u0000.example",
    "/etc/passwd\u0000",
    "caf\u00e9\u0000.txt",
  ];
  for (const input of NUL_INPUTS) {
    it(`rejects ${JSON.stringify(input)} as invalid`, () => {
      expectKind(input, "invalid");
    });
  }
});

// ── Deny-rule boundaries (transcribed intent) ───────────────────────

// Transcription of DEFAULT_DENY_PATTERNS: every rule is a single path component; a
// positive rule denies that component wherever it appears (any depth); `!.env.example`
// is the ONLY carve-out; rules evaluate in list order and the LAST rule matching ANY
// component decides (gitignore-style). Byte-exact, case-sensitive.
const DENY_RULES: readonly (readonly [rule: string, positive: boolean])[] = [
  [".ssh", true],
  [".config", true],
  [".git", true],
  [".aws", true],
  [".azure", true],
  [".docker", true],
  [".gnupg", true],
  [".kube", true],
  [".*profile", true],
  [".*rc", true],
  ["*.local*", true],
  [".env*", true],
  ["!.env.example", false],
];

function compMatches(comp: string, rule: string): boolean {
  switch (rule) {
    case ".ssh":
    case ".config":
    case ".git":
    case ".aws":
    case ".azure":
    case ".docker":
    case ".gnupg":
    case ".kube":
      return comp === rule;
    case ".*profile":
      return comp.startsWith(".") && comp.endsWith("profile");
    case ".*rc":
      return comp.startsWith(".") && comp.endsWith("rc");
    case "*.local*":
      return comp.includes(".local");
    case ".env*":
      return comp.startsWith(".env");
    case ".env.example":
      return comp === ".env.example";
    default:
      throw new Error(`rule not transcribed into the oracle: ${rule}`);
  }
}

/**
 * Oracle: matched positive rule for the relative components, or null when allowed.
 * ownerComps implements the root exception (a positive rule never fires for a root
 * sitting at/below the denied level); our mkdtemp root matches nothing, but the rule
 * is transcribed anyway.
 */
function denyOracle(components: string[], ownerComps: string[]): string | null {
  let matched: string | null = null;
  let denied = false;
  for (const [rule, positive] of DENY_RULES) {
    const plain = positive ? rule : rule.slice(1); // strip the "!" of negations
    if (positive && ownerComps.some((c) => compMatches(c, plain))) continue;
    if (components.some((c) => compMatches(c, plain))) {
      matched = rule;
      denied = positive;
    }
  }
  return denied ? matched : null;
}

function checkDeny(input: string): void {
  const comps = input.split("/").filter(Boolean);
  const ownerComps = root.split("/").filter(Boolean);
  const rule = denyOracle(comps, ownerComps);
  if (rule === null) {
    const out = expectBoundary(input);
    if (out === null) {
      throw new Error(`expected allowed, got PathEscapeError: ${JSON.stringify(input)}`);
    }
    return;
  }
  try {
    ws.resolveSafe(input);
    throw new Error(`expected denied by ${rule}, got success: ${JSON.stringify(input)}`);
  } catch (e) {
    if (!(e instanceof PathEscapeError)) throw e;
    expect(e.kind, `kind for ${JSON.stringify(input)}`).toBe("denied");
    expect(e.message, `rule name in message for ${JSON.stringify(input)}`).toContain(`(${rule})`);
  }
}

describe("workspace fuzz: deny-rule boundaries", () => {
  // Drift guard for the transcription above against the real table.
  it("the transcribed rule list matches DEFAULT_DENY_PATTERNS", () => {
    expect(DENY_RULES.map(([r]) => r)).toEqual([...DEFAULT_DENY_PATTERNS]);
  });

  const CASES: [input: string, expectDeniedRule: string | null][] = [
    // carve-out only where intended, at depth
    ["nested/.env.example", null],
    ["a/b/c/.env.example", null],
    [".env.example", null],
    ["nested/.env", ".env*"],
    ["a/b/c/.env.production", ".env*"],
    // denied names at every nesting depth
    ["a/b/c/.ssh/config", ".ssh"],
    ["x/y/.git/hooks/pre-commit", ".git"],
    ["x/y/.aws/credentials", ".aws"],
    ["a/.config/tool/settings.json", ".config"],
    ["deep/deeper/.kube/config", ".kube"],
    ["a/b/.bashrc", ".*rc"],
    ["a/b/.bash_profile", ".*profile"],
    ["a/b/c.local.d/x", "*.local*"],
    [".local", "*.local*"],
    // lookalikes are NOT denied
    ["a/ssh/b", null],
    ["a/git/config", null],
    ["env.txt", null],
    ["myrc", null],
    ["profile", null],
    // case-sensitivity (byte-exact rules)
    [".ENV", null],
    [".BASHRC", null],
    [".SSH/key", null],
    [".env.Example", ".env*"], // negation is exact too
    // last-match-wins interactions, transcribed as-is
    [".env.example.local", ".env*"], // .env* is the LAST match in rule order
    [".ssh/x/.env.example", null], // documented policy consequence (see notes)
    [".env/.env.example", null],
    ["x.localy", "*.local*"],
    [".envrc", ".env*"], // matches .*rc then .env*; .env* wins (later in list)
  ];
  for (const [input, rule] of CASES) {
    it(`${JSON.stringify(input)} -> ${rule === null ? "allowed" : "denied by " + rule}`, () => {
      checkDeny(input);
    });
  }

  it("400 seeded component paths agree with the transcribed oracle", () => {
    const rng = makeRng(0xde41_0001);
    const POOL = [
      ".env", ".env.example", ".env.local", ".envrc", ".ENV", ".env.Example", "example",
      "local", ".local", "x.local", ".local.bak", "bashrc", ".bashrc", ".zshrc",
      ".profile", ".bash_profile", "profile", "ssh", ".ssh", ".git", "git", ".config",
      "config", ".aws", "notes.md", "sub", "a", ".rc", ".env.examplex", ".envexampl",
      "..env", ".e", "ENV", ".localrc", "rc.local", ".hidden.rc", ".git.example",
      "sub.local", ".example", ".env.example.txt",
    ];
    for (let i = 0; i < 400; i++) {
      const depth = 1 + rng.int(4);
      const comps: string[] = [];
      for (let d = 0; d < depth; d++) comps.push(rng.pick(POOL));
      checkDeny(comps.join("/"));
    }
  });
});

// ── Symlinks ─────────────────────────────────────────────────────────

describe("workspace fuzz: symlinks", () => {
  it("link to outside dir/file -> symlink kind; sibling link resolves", () => {
    const outDirLink = path.join(root, "out-dir");
    const outFileLink = path.join(root, "out-file");
    const sibLink = path.join(root, "sib-link");
    const deniedLink = path.join(root, "denied-link");
    const chainA = path.join(root, "chain-a");
    const chainB = path.join(root, "chain-b");
    fs.mkdirSync(path.join(root, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(root, ".ssh", "id_rsa"), "k");
    fs.symlinkSync(outside, outDirLink);
    fs.symlinkSync(path.join(outside, "secret.txt"), outFileLink);
    fs.symlinkSync(sibling, sibLink);
    fs.symlinkSync(path.join(root, ".ssh", "id_rsa"), deniedLink);
    fs.symlinkSync(path.join(outside, "secret.txt"), chainA);
    fs.symlinkSync(chainA, chainB);
    try {
      expectKind("out-dir", "symlink");
      expectKind("out-dir/anything", "symlink");
      expectKind("out-file", "symlink");
      expectKind("chain-b", "symlink");
      expectKind("denied-link", "denied"); // deny-on-real-path fires as "denied"
      // Sibling dir link: must succeed, and through it too.
      expect(typeof expectBoundary("sib-link")).toBe("string");
      const through = expectBoundary("sib-link/inner.txt");
      expect(typeof through).toBe("string");
    } finally {
      for (const p of [outDirLink, outFileLink, sibLink, deniedLink, chainA, chainB]) {
        fs.unlinkSync(p);
      }
    }
  });

  it("relative-target link escaping the root -> symlink kind", () => {
    const link = path.join(root, "rel-out");
    fs.symlinkSync("../outside/secret.txt", link);
    try {
      expectKind("rel-out", "symlink");
    } finally {
      fs.unlinkSync(link);
    }
  });
});

// ── Long inputs / pathological sizes ────────────────────────────────

describe("workspace fuzz: long inputs", () => {
  it("100KB single-segment name resolves inside without blowup", () => {
    const t0 = performance.now();
    expect(typeof expectBoundary("a".repeat(100_000))).toBe("string");
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("100KB of ../ chains throws direct without blowup", () => {
    const t0 = performance.now();
    expectKind("../".repeat(25_000) + "x", "direct");
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("deep in-root chain (5000 segments) resolves with a linear ancestor walk", () => {
    const t0 = performance.now();
    expect(typeof expectBoundary("sub/" + "x/".repeat(5000) + "file")).toBe("string");
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("alternating .. chains that re-enter resolve inside", () => {
    const t0 = performance.now();
    expect(typeof expectBoundary("sub/" + "../sub/".repeat(1000) + "file.txt")).toBe("string");
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

// ── pathMatchesRule: direct fuzz + transcribed expectation table ────

// Independent implementation: wildcard backtracking matcher over rule components
// (rule split on "/", empty parts dropped), matching any contiguous window of the
// component list. No regex building -- deliberately a different algorithm than the
// source so an implementation slip cannot echo through.
function segGlobMatch(seg: string, pat: string): boolean {
  let s = 0;
  let p = 0;
  let star = -1;
  let sMatch = 0;
  while (s < seg.length) {
    if (p < pat.length && (pat[p] === "?" || pat[p] === seg[s])) {
      s++;
      p++;
    } else if (p < pat.length && pat[p] === "*") {
      star = p;
      p++;
      sMatch = s;
    } else if (star !== -1) {
      p = star + 1;
      sMatch++;
      s = sMatch;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

function ruleOracle(components: string[], rule: string): boolean {
  const parts = rule.split("/").filter((p) => p !== "");
  if (parts.length === 0) return false;
  for (let i = 0; i + parts.length <= components.length; i++) {
    let ok = true;
    for (let j = 0; j < parts.length; j++) {
      if (!segGlobMatch(components[i + j]!, parts[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

describe("workspace fuzz: pathMatchesRule", () => {
  const TABLE: [components: string[], rule: string, expected: boolean][] = [
    [["a"], "", false],
    [["a"], "/", false],
    [["a", "b"], "//a", true], // empty rule parts are dropped
    [[""], "*", true], // * matches the empty component
    [["a"], "?", true],
    [[""], "?", false],
    [["a", "b", "c"], "b", true],
    [["a", "b", "c"], "a/b", true],
    [["a", "b", "c"], "a/c", false],
    [["a", "b", "c"], "c", true],
    [["a"], "a/*", false],
    [["a", "b"], "a/*", true],
    [["x[y]"], "x[y]", true], // [ ] are literals, not classes
    [["a\\b"], "a\\b", true], // backslash is a literal char, not a separator
    [["AB"], "ab", false], // case-sensitive
    [["a.b"], "*", true],
    [["ab", "c"], "b/c", false], // window must align on component boundaries
    [["a+"], "+", false],
    [["+"], "+", true],
    [["a\u0000b"], "a\u0000b", true], // NUL is a literal char to the matcher
    [[".bashrc"], ".*rc", true],
    [[".env.example"], ".env.example", true],
    [[".env.example"], ".env*", true],
    [["x"], "**", true],
  ];
  for (const [components, rule, expected] of TABLE) {
    it(`table ${JSON.stringify(components)} vs ${JSON.stringify(rule)} = ${expected}`, () => {
      expect(pathMatchesRule(components, rule)).toBe(expected);
    });
  }

  it("600 seeded rule/segment strings match the independent oracle, no crash", () => {
    const rng = makeRng(0xde41_0002);
    const POOL = [
      "a", "b", "", "*", "?", "[", "]", "{", "}", "(", ")", ".", "..", "\\", "x*y",
      "AB", "a\\b", ".env", "\u0000", "**", "a?b", "+", "^", "$", "|", "a+", ".env*",
      "?*", "*?", "-", "a-b",
    ];
    for (let i = 0; i < 600; i++) {
      const comps = Array.from({ length: rng.int(4) }, () => rng.pick(POOL));
      const ruleParts = Array.from({ length: 1 + rng.int(3) }, () => rng.pick(POOL));
      const rule = ruleParts.join("/");
      expect(pathMatchesRule(comps, rule), `comps=${JSON.stringify(comps)} rule=${JSON.stringify(rule)}`).toBe(
        ruleOracle(comps, rule),
      );
    }
  });
});
