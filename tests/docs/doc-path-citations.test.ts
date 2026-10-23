// Docs citation contract: every repo-relative path cited in the agent-facing
// docs must exist.
//
// Why: the docs are the navigation index for agents. A citation to a renamed or
// deleted file is worse than no citation -- an agent that trusts the doc stops
// reading the code and works around a path that is not there. Only existence
// is checked; whether the file says the right thing about it stays human (or
// agent) review.
//
// Rules:
// - Scope: root docs + docs/**. Postmortems are excluded on purpose: they
//   describe states that were deliberately removed.
// - A citation is a token starting at a repo root (`src/`, `docs/`, ...) or a
//   tsconfig path alias (`@core/`, ...), not preceded by a word char, dot or
//   slash (so `/bin/sh` and `https://host/docs/x` are not citations).
// - Extension-less citations resolve `.ts` / `.tsx` / `.js` / `index.ts` the way
//   the bundler does; trailing punctuation the token ran onto is dropped.
// - Globs (`src/extensions/*/extension.json`) need at least one match.
// - Illustrative paths (sample output, invented file names) go in ILLUSTRATIVE
//   with a reason.

import { describe, it, expect } from "bun:test";
import { Glob } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

const DOC_FILES = [
  "AGENTS.md",
  "CONTEXT.md",
  "README.md",
  "SECURITY.md",
  ...Array.from(new Glob("docs/**/*.md").scanSync({ cwd: ROOT })),
].filter((f) => !f.startsWith("docs/postmortems/"));

/** The four tsconfig path aliases, as directory prefixes. */
const ALIASES: Array<[string, string]> = [
  ["@core/", "src/core/"],
  ["@extensions/", "src/extensions/"],
  ["@experimental/", "src/experimental/"],
  ["@utils/", "src/utils/"],
];

const ROOTS = ["src/", "docs/", "tests/", "bin/", "examples/", "evals/", ...ALIASES.map(([a]) => a)];

/**
 * Paths that are illustrative prose rather than claims about this repo,
 * keyed `file: path`. Every entry needs a reason.
 */
const ILLUSTRATIVE = new Set([
  // Sample tool-call header output in the `toolfmt` reference, not a real file.
  "docs/config-reference.md: src/a.ts",
]);

// `*` and `?` are in both classes so a glob citation (`src/*/index.ts`,
// `docs/**/*.md`) is captured whole instead of stopping at a wildcard segment.
const TOKEN_RE = /(?:[A-Za-z0-9_.@*?-]+\/)+[A-Za-z0-9_.@*?-]*/g;

interface Citation {
  file: string;
  line: number;
  /** Repo-relative path, after alias mapping. */
  path: string;
}

/** All repo-relative path citations on one line of markdown. */
function citationsInLine(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(TOKEN_RE)) {
    const raw = m[0];
    if (!ROOTS.some((r) => raw.startsWith(r))) continue;
    // Not a citation when something extends it: a longer path, `/bin/sh`,
    // or a URL segment (`.../docs/foo`).
    const prev = line[(m.index ?? 0) - 1];
    if (prev && /[\w./-]/.test(prev)) continue;
    // Placeholders and ellipses (`<session-id>.baton.json`, `src/...`) name no file.
    if (raw.includes("<") || raw.includes(">") || raw.includes("...")) continue;
    const path = raw.replace(/[.,;:)\]]+$/, "");
    if (path === "" || path === "/") continue;
    out.push(applyAlias(path));
  }
  return out;
}

function applyAlias(path: string): string {
  for (const [alias, target] of ALIASES) {
    if (path.startsWith(alias)) return target + path.slice(alias.length);
  }
  return path;
}

function resolvePath(path: string): boolean {
  const base = join(ROOT, path);
  if (existsSync(base)) return true;
  for (const suffix of [".ts", ".tsx", ".js", "/index.ts"]) {
    if (existsSync(base + suffix)) return true;
  }
  return false;
}

/** Glob citations need one match; plain paths need the file (or an extension). */
function citationResolves(path: string): boolean {
  if (path.includes("*") || path.includes("?")) {
    for (const _ of new Glob(path).scanSync({ cwd: ROOT, onlyFiles: false })) return true;
    return false;
  }
  return resolvePath(path);
}

function collectCitations(): Citation[] {
  const found: Citation[] = [];
  for (const file of DOC_FILES) {
    const lines = readFileSync(join(ROOT, file), "utf-8").split("\n");
    lines.forEach((line, i) => {
      for (const path of citationsInLine(line)) {
        found.push({ file, line: i + 1, path });
      }
    });
  }
  return found;
}

describe("docs path citations", () => {
  it("extractor: repo roots, aliases, globs, trailing punctuation", () => {
    const cited = citationsInLine(
      "See `src/core/agent.ts`, `@utils/logger.ts`, `tool-utils.ts` and " +
        "`src/core/extensions/tool-registry.ts:318`, `src/extensions/*/extension.json`, [docs/](docs/).",
    );
    expect(cited).toEqual([
      "src/core/agent.ts",
      "src/utils/logger.ts", // alias mapped
      "src/core/extensions/tool-registry.ts", // the token ends at the line ref
      "src/extensions/*/extension.json", // glob captured whole
      "docs/",
      "docs/",
    ]);
    // A bare filename with no repo root is not a citation.
    expect(cited).not.toContain("tool-utils.ts");
  });

  it("extractor: URLs, absolute system paths and placeholders are not citations", () => {
    expect(citationsInLine("see https://bun.sh/docs/runtime/http")).toEqual([]);
    expect(citationsInLine("`/bin/sh` may be dash")).toEqual([]);
    expect(citationsInLine("write `<session-id>.baton.json` under `src/...`")).toEqual([]);
    expect(citationsInLine("the `toolfmt` key")).toEqual([]);
    expect(citationsInLine("`src/core/agent.ts` carries it")).toEqual(["src/core/agent.ts"]);
  });

  it("resolver: existing paths, implied extensions, globs, and misses", () => {
    expect(citationResolves("src/core/agent.ts")).toBe(true);
    expect(citationResolves("src/utils/reactive-state")).toBe(true); // .ts implied
    expect(citationResolves("docs")).toBe(true); // directory
    expect(citationResolves("src/extensions/*/extension.json")).toBe(true);
    expect(citationResolves("src/core/no-such-file-here.ts")).toBe(false);
    expect(citationResolves("src/no-such-dir/*/x.ts")).toBe(false);
  });

  it("every cited path in the docs exists", () => {
    const stale = collectCitations().filter(
      (c) => !ILLUSTRATIVE.has(`${c.file}: ${c.path}`) && !citationResolves(c.path),
    );
    expect(stale).toEqual([]);
  });

  it("the sweep actually reads citations (guards a vacuous pass)", () => {
    expect(collectCitations().length).toBeGreaterThan(100);
  });
});
