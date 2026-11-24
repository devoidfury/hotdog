// Leak contract ("Explicitly NOT core"): core carries ZERO codemode
// knowledge -- a lint scan over src/core/ fails on any hit.
//
// Scope, stated exactly: the case-insensitive substring "codemode" may not
// appear ANYWHERE under src/core/ -- identifiers, strings, JSON values, and
// COMMENTS included. No allowlist, no baseline, no exemptions. The two core
// deltas the feature rides (the nested-call dispatcher on the executor/tool
// context, and the nested_tool_result log source) name the MECHANISM, never
// the feature; comment drift is the leak class this guards as much as code,
// which is why nothing is masked before matching.
//
// Known ceiling: separator variants ("code mode", "code-mode") are NOT
// matched -- the rule is the word, and a wider pattern flags prose ("code
// modeled by...") that is not the leak. Writing "code mode" in a core comment
// evades this lint.
//
// This is a self-baselining zero-violation scan (like
// architecture-core-no-extensions.test.ts): no baselines/ entry, not listed
// in regenerate.ts. The negative probe below proves the scan bites by
// planting the word into a temp tree, never by editing core.

import { describe, it, expect } from "bun:test";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const CORE_RE = /codemode/i;

export interface CoreMention {
  file: string;
  line: number;
  text: string;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

/** Every "codemode" mention (any case) under root/src/core, comments included. */
export function findCodemodeInCore(root: string): CoreMention[] {
  const base = join(root, "src", "core");
  const hits: CoreMention[] = [];
  for (const file of listFiles(base)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (CORE_RE.test(line)) {
        hits.push({ file: file.slice(root.length + 1), line: i + 1, text: line.trim() });
      }
    });
  }
  return hits;
}

describe("lint: no codemode in src/core", () => {
  it("src/core/ carries zero 'codemode' occurrences (any case, comments included)", () => {
    const files = listFiles(join(ROOT, "src", "core"));
    // Vacuity guard: the scan must actually be looking at the core tree.
    expect(files.length).toBeGreaterThan(50);
    expect(findCodemodeInCore(ROOT)).toEqual([]);
  });

  it("the guard bites: planted mentions fire, mechanism wording passes", () => {
    const root = mkdtempSync(join(tmpdir(), "no-codemode-in-core-"));
    try {
      const core = join(root, "src", "core");
      mkdirSync(join(core, "session"), { recursive: true });

      // A real core file, edited to name the feature in a comment -- the
      // comment-drift class this lint exists for.
      copyFileSync(join(ROOT, "src", "core", "tool-executor.ts"), join(core, "tool-executor.ts"));
      writeFileSync(
        join(core, "tool-executor.ts"),
        "// the codemode dispatcher mounts here\n" + readFileSync(join(core, "tool-executor.ts"), "utf8"),
      );
      // Case and surface sweep: identifier, comment, and JSON value.
      writeFileSync(join(core, "session", "planted-ident.ts"), "const CodeModeRunner = 1;\n");
      writeFileSync(join(core, "session", "planted-string.ts"), 'export const S = "CODEMODE leak";\n');
      writeFileSync(join(core, "core.config.json"), '{\n  "codemodeEnabled": true\n}\n');
      // Clean sibling: the sanctioned mechanism wording must NOT fire.
      writeFileSync(
        join(core, "session", "nested-call-entry.ts"),
        "// nested-call dispatcher; nested_tool_result audit record -- no feature name here\n",
      );

      const hits = findCodemodeInCore(root);
      const hitFiles = hits.map((h) => h.file).sort();
      expect(hitFiles).toEqual([
        "src/core/core.config.json",
        "src/core/session/planted-ident.ts",
        "src/core/session/planted-string.ts",
        "src/core/tool-executor.ts",
      ]);
      // The comment hit is caught because NOTHING is masked before matching.
      expect(hits.some((h) => h.file.endsWith("tool-executor.ts") && h.line === 1)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
