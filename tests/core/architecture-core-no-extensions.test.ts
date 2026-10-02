// Architecture contract: core must never import from extensions or experimental.
// Core defines the extension plumbing (src/core/extensions/); the actual
// extensions (src/extensions/, src/experimental/) plug into core, never the
// other way around. Any new edge here inverts the dependency law.

import { describe, it, expect } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SRC = join(ROOT, "src");
const FORBIDDEN_DIRS = [join(SRC, "extensions"), join(SRC, "experimental")];

// Matches static imports, side-effect imports, re-exports, and dynamic imports.
const SPEC_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

const ALIAS_DIRS: Record<string, string> = {
  "@core": join(SRC, "core"),
  "@extensions": join(SRC, "extensions"),
  "@experimental": join(SRC, "experimental"),
  "@utils": join(SRC, "utils"),
};

function resolveSpec(spec: string, importerFile: string): string | null {
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return resolve(dirname(importerFile), spec);
  }
  for (const [alias, dir] of Object.entries(ALIAS_DIRS)) {
    if (spec === alias || spec.startsWith(`${alias}/`)) {
      return join(dir, spec.slice(alias.length));
    }
  }
  return null; // bare specifier (node builtin) or @package.json — never forbidden
}

function isForbidden(resolved: string): boolean {
  return FORBIDDEN_DIRS.some((d) => resolved === d || resolved.startsWith(d + "/"));
}

describe("architecture: core never imports extensions", () => {
  it("no file in src/core imports from src/extensions or src/experimental", async () => {
    const files: string[] = [];
    for await (const rel of new Glob("**/*.{ts,tsx}").scan(join(SRC, "core"))) {
      files.push(join(SRC, "core", rel));
    }
    // Sanity: if the scan silently finds nothing, the test must not pass vacuously.
    expect(files.length).toBeGreaterThan(50);

    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const match of line.matchAll(SPEC_RE)) {
          const spec = match[1]!;
          const resolved = resolveSpec(spec, file);
          if (resolved && isForbidden(resolved)) {
            violations.push(`${file.replace(ROOT + "/", "")}:${i + 1}  imports "${spec}"`);
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it("resolveSpec distinguishes src/core/extensions (allowed) from src/extensions (forbidden)", () => {
    const importer = join(SRC, "core", "session", "message-bus.ts");
    // The extension-plumbing directory lives inside core; climbing to it is fine.
    expect(isForbidden(resolveSpec("../extensions/types.ts", importer)!)).toBe(false);
    // Climbing out of core into the extensions tree is the violation this guards.
    expect(isForbidden(resolveSpec("../../extensions/skills/index.ts", importer)!)).toBe(true);
    expect(isForbidden(resolveSpec("@extensions/skills/index.ts", importer)!)).toBe(true);
    expect(isForbidden(resolveSpec("@experimental/show-me/tool.ts", importer)!)).toBe(true);
    expect(isForbidden(resolveSpec("@core/error.ts", importer)!)).toBe(false);
    expect(isForbidden(resolveSpec("@utils/logger.ts", importer)!)).toBe(false);
    expect(resolveSpec("node:path", importer)).toBeNull();
  });
});
