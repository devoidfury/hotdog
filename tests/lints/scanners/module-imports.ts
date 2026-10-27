import { readFileSync } from "node:fs";
// module-imports house-rule scanner. Pure function over a repo root.
// Rule text and ceilings: ../module-imports.test.ts.

import { dirname, join, normalize, sep } from "node:path";
import {
  listSourceFiles,
  lineText,
  maskCommentsOnly,
  normalizeSnippet,
  relPath,
  Violation,
} from "../harness.ts";

/** Alias scopes as repo-relative directory prefixes (tsconfig paths). */
const SCOPES = ["src/core", "src/extensions", "src/experimental", "src/utils"];

function scopeOf(relPosix: string): string | null {
  for (const s of SCOPES) if (relPosix === s || relPosix.startsWith(s + "/")) return s;
  return null;
}

const SPEC_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](\.{1,2}\/[^"']*)["']/g;

/** Pure scanner over a repo root: cross-alias-scope relative imports in src/. */
export function scanModuleImports(root: string): Violation[] {
  const out: Violation[] = [];
  for (const abs of listSourceFiles(root, "src", [".ts", ".tsx"])) {
    const rel = relPath(root, abs);
    const own = scopeOf(rel);
    if (own === null) continue; // outside the four alias scopes; rule does not bind
    const raw = readFileSync(abs, "utf8");
    const masked = maskCommentsOnly(raw);
    for (const m of masked.matchAll(SPEC_RE)) {
      const spec = m[1]!;
      const resolved = normalize(join(dirname(rel), spec)).split(sep).join("/");
      const target = scopeOf(resolved);
      if (target !== null && target !== own) {
        out.push({ file: rel, snippet: normalizeSnippet(lineText(raw, m.index)) });
      }
    }
  }
  return out;
}
