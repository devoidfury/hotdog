// House-rule lint: Published Surface (AGENTS.md).
//
// Quoted rule (AGENTS.md, "Published Surface"):
//   "Public API is exactly the `package.json` `exports` entries: `.`
//    (`src/index.ts`, embedder host primitives + the full author surface),
//    `./sdk` (`src/sdk.ts`, the extension-authoring contract), `./testing`
//    (`src/testing.ts`, the extension test kit: a minimal core double, fakes,
//    and payload builders), and `./utils/*` (every leaf utility under
//    `src/utils/`); plus `./package.json` for tooling. Everything else under
//    `src/` is internal."
//
// What is flagged:
//   - the exports map drifting from the five declared entries, or a target
//     file missing / renamed without the map;
//   - a second wildcard sneaking in (the ONE wildcard is utils/*; a new one
//     opens a subtree nobody ruled public);
//   - src/index.ts silently dropping `export * from "./sdk.ts"` (the root must
//     carry the author surface);
//   - an export target pointing at a directory (the map names files).
//
// The runtime side (entries resolve, deep imports outside the doors refuse) is
// pinned by tests/core/package-entry.test.ts; this lint pins the DECLARATION,
// so a package.json edit that widens or retargets the surface fails even
// before anything imports it.

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8"));

const EXPECTED: Record<string, string> = {
  ".": "./src/index.ts",
  "./sdk": "./src/sdk.ts",
  "./testing": "./src/testing.ts",
  "./utils/*": "./src/utils/*.ts",
  "./package.json": "./package.json",
};

describe("lint: published surface (AGENTS.md Published Surface)", () => {
  it("exports map is exactly the five declared entries", () => {
    const exports = pkg.exports as Record<string, string>;
    expect(exports).toBeDefined();
    expect(Object.keys(exports).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [subpath, target] of Object.entries(EXPECTED)) {
      expect(exports[subpath], `exports["${subpath}"]`).toBe(target);
    }
  });

  it("every export target exists on disk", () => {
    for (const [subpath, target] of Object.entries(pkg.exports as Record<string, string>)) {
      if (target.includes("*")) {
        // Wildcard entry: pin the tree it stands on (a renamed utils dir
        // would strand every mapping).
        expect(existsSync(join(REPO, "./src/utils")), `exports["${subpath}"] -> src/utils/`).toBe(true);
        continue;
      }
      expect(existsSync(join(REPO, target)), `exports["${subpath}"] -> ${target}`).toBe(true);
    }
  });

  it("the root barrel re-exports the SDK surface", () => {
    const index = readFileSync(join(REPO, pkg.exports["."]), "utf-8");
    expect(index).toContain(`export * from "./sdk.ts"`);
  });

  it("no export path reaches outside src/ entry points (deep imports stay closed)", () => {
    // The targets are the whole whitelist; nothing may point into a
    // directory subtree (which would re-open the deep-import door), and the
    // utils wildcard is the ONLY pattern entry.
    for (const [subpath, target] of Object.entries(pkg.exports as Record<string, string>)) {
      expect(target.endsWith("/"), `exports target "${target}" must be a file, not a directory`).toBe(false);
      if (target.includes("*") || subpath.includes("*")) {
        expect(subpath, `wildcard entry (only ./utils/* is public)`).toBe("./utils/*");
      }
    }
  });
});
