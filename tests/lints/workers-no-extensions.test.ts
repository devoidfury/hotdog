// Contract: the live runner entry ships ZERO static imports from the
// extension trees -- the register frame's descriptors are the only route to
// a tool module. The scan covers every src/workers file's bytes, counting
// static, re-export, and quoted-dynamic specifiers alike. One exclusion:
// the legacy `tool-exec.ts`, byte-frozen until its post-restart removal
// (the exclusion-size pin below holds it alone).

import { describe, it, expect } from "bun:test";
import { Glob } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SRC = join(ROOT, "src");
const WORKERS = join(SRC, "workers");
const FORBIDDEN_DIRS = [join(SRC, "extensions"), join(SRC, "experimental")];

/** The one exclusion: the byte-frozen legacy runner, deleted on post-restart cleanup. */
const EXCLUDED_PENDING_CLEANUP = new Set(["tool-exec.ts"]);

// Static imports, side-effect imports, re-exports, and dynamic imports: a
// quoted dynamic "@extensions/..." is still a hardcoded edge, so it counts.
const SPEC_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

function forbiddenSpec(spec: string, importerFile: string): boolean {
  if (spec === "@extensions" || spec.startsWith("@extensions/")) return true;
  if (spec === "@experimental" || spec.startsWith("@experimental/")) return true;
  let resolvedPath: string | null = null;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    resolvedPath = resolve(dirname(importerFile), spec);
  }
  return (
    resolvedPath !== null &&
    FORBIDDEN_DIRS.some((d) => resolvedPath === d || resolvedPath.startsWith(d + "/"))
  );
}

/** The scanned worker files: everything except the named cleanup-pending exclusions. */
function scannedWorkerFiles(): string[] {
  const files: string[] = [];
  for (const rel of new Glob("**/*.{ts,tsx}").scanSync(WORKERS)) {
    if (!EXCLUDED_PENDING_CLEANUP.has(rel)) files.push(join(WORKERS, rel));
  }
  return files.sort();
}

describe("architecture: the live runner entry imports no extensions (descriptor loading only)", () => {
  it("scans the real bytes of src/workers/tool-exec-dynamic.ts (the RUNNER_ENTRY)", () => {
    const runner = join(WORKERS, "tool-exec-dynamic.ts");
    expect(existsSync(runner)).toBe(true);
    const bytes = readFileSync(runner, "utf8");
    const violations: string[] = [];
    bytes.split("\n").forEach((line, i) => {
      for (const match of line.matchAll(SPEC_RE)) {
        if (forbiddenSpec(match[1]!, runner)) {
          violations.push(`tool-exec-dynamic.ts:${i + 1}  imports "${match[1]}"`);
        }
      }
    });
    expect(violations).toEqual([]);
  });

  it("every non-excluded file under src/workers stays extension-free", () => {
    const files = scannedWorkerFiles();
    // Non-vacuous: the scan set must actually hold the runner entry (and the
    // legacy file must be the ONLY exclusion, so nothing new hides under it).
    expect(files.some((f) => f.endsWith("tool-exec-dynamic.ts"))).toBe(true);
    const legacy = join(WORKERS, "tool-exec.ts");
    const excludedOnDisk =
      existsSync(legacy) && !files.some((f) => f.endsWith("tool-exec.ts"));
    if (existsSync(legacy)) expect(excludedOnDisk).toBe(true);
    // The exclusion Set itself is pinned: while the legacy runner exists the
    // exclusion is exactly it (one name); once it is deleted, none may remain.
    expect(EXCLUDED_PENDING_CLEANUP.size).toBe(existsSync(legacy) ? 1 : 0);

    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const match of line.matchAll(SPEC_RE)) {
          if (forbiddenSpec(match[1]!, file)) {
            violations.push(`${file.replace(ROOT + "/", "")}:${i + 1}  imports "${match[1]}"`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });
});

describe("forbiddenSpec predicate (the edge shapes the scan counts)", () => {
  const importer = join(WORKERS, "tool-exec-dynamic.ts");
  it("names the alias edge, dynamic alias imports, and relative climbs", () => {
    expect(forbiddenSpec("@extensions/bash-tool/index.ts", importer)).toBe(true);
    expect(forbiddenSpec("@experimental/show-me/tool.ts", importer)).toBe(true);
    expect(forbiddenSpec("../extensions/bash-tool/index.ts", importer)).toBe(true);
    expect(forbiddenSpec("../experimental/show-me/tool.ts", importer)).toBe(true);
    // A dynamic quoted alias import goes through the same regex + predicate
    // as a static one.
    const dynamicLine = `const mod = await import("@extensions/core-tools/index.ts");`;
    const specs = [...dynamicLine.matchAll(SPEC_RE)].map((m) => m[1]!);
    expect(specs.some((s) => forbiddenSpec(s, importer))).toBe(true);
  });
  it("spares the core/utils edges and the descriptor route itself", () => {
    // The descriptor path imports a RUNTIME-VALIDATED file URL held in a
    // variable -- no quoted specifier, nothing for the scan to flag.
    expect(forbiddenSpec("@core/tool-exec-protocol.ts", importer)).toBe(false);
    expect(forbiddenSpec("@core/tool-exec-layout.ts", importer)).toBe(false);
    expect(forbiddenSpec("@utils/workspace.ts", importer)).toBe(false);
    expect(forbiddenSpec("node:path", importer)).toBe(false);
    expect(forbiddenSpec("node:url", importer)).toBe(false);
  });
});
