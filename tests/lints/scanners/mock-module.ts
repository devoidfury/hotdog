// mock-module house-rule scanner. Pure function over a repo root.
// Rule text and the fixtures exclusion: ../mock-module.test.ts.

import { readFileSync } from "node:fs";
import { listSourceFiles, lineText, maskCode, normalizeSnippet, relPath, Violation } from "../harness.ts";

const CALL_RE = /\bmock\.module\s*\(/g;

/** Pure scanner over a repo root: mock.module( call sites in src/ + tests/. */
export function scanMockModule(root: string): Violation[] {
  const out: Violation[] = [];
  for (const dir of ["src", "tests"]) {
    for (const abs of listSourceFiles(root, dir, [".ts", ".tsx"])) {
      const rel = relPath(root, abs);
      if (rel.startsWith("tests/lints/fixtures/")) continue; // planted self-test bait
      const raw = readFileSync(abs, "utf8");
      for (const m of maskCode(raw).matchAll(CALL_RE)) {
        out.push({ file: rel, snippet: normalizeSnippet(lineText(raw, m.index)) });
      }
    }
  }
  return out;
}
