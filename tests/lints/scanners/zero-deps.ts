// zero-deps house-rule scanner. Pure function over a repo root.
// Rule text: ../zero-deps.test.ts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSnippet, Violation } from "../harness.ts";

/** Pure scanner over a repo root: one violation per runtime dependency. */
export function scanZeroDeps(root: string): Violation[] {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  return Object.entries(deps).map(([name, version]) => ({
    file: "package.json",
    snippet: normalizeSnippet(`"${name}": "${version}" in "dependencies"`),
  }));
}
