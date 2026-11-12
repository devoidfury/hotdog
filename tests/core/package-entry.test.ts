// Pins the package.json "exports" map from a consumer's seat: every public
// entry resolves by package name, the root carries the host primitives plus
// the full SDK surface, and everything else stays closed (no deep imports).

import { describe, it, expect } from "bun:test";
import pkgJson from "@read-receipt/hotdog/package.json";

const SDK_KEYS = [
  "HOOKS",
  "getExtensionConfig",
  "getConfigSchemaProperties",
  "readKnob",
  "ToolResult",
  "toolDef",
  "param",
  "toolResult",
  "parseToolInput",
  "truncateOutput",
  "resolveToolPath",
  "ToolError",
  "ConfigError",
  "AgentError",
  "LlmError",
  "formatError",
  "logger",
  "spoofSafe",
];

describe("package entry points", () => {
  it("@read-receipt/hotdog/sdk exposes the authoring surface", async () => {
    const sdk: Record<string, unknown> = await import("@read-receipt/hotdog/sdk");
    for (const key of SDK_KEYS) {
      expect(sdk[key], `sdk export "${key}"`).toBeDefined();
    }
  });

  it("@read-receipt/hotdog exposes host primitives plus the SDK surface", async () => {
    const root: Record<string, unknown> = await import("@read-receipt/hotdog");
    for (const fn of ["main", "createCore", "peekConfigFlags", "buildConfig", "loadConfig"]) {
      expect(typeof root[fn], `root export "${fn}"`).toBe("function");
    }
    for (const key of SDK_KEYS) {
      expect(root[key], `root passthrough "${key}"`).toBeDefined();
    }
  });

  it("@read-receipt/hotdog/testing exposes the test kit and boots the loader with no cast", async () => {
    const testing: Record<string, unknown> = await import("@read-receipt/hotdog/testing");
    for (const fn of [
      "createTestCore",
      "fakeQuestionSeam",
      "makeToolContext",
      "toolResultPayload",
      "ExtensionLoader",
      "discoverExtensions",
    ]) {
      expect(typeof testing[fn], `testing export "${fn}"`).toBe("function");
    }
    // Type-level proof lives HERE: TestCore is structurally a LoaderCore, so
    // this feeds the loader with no cast (tsc compiles this file; a widening
    // of the double that breaks assignability fails the check, not a comment).
    const { createTestCore, ExtensionLoader } = await import("@read-receipt/hotdog/testing");
    const core = createTestCore({ config: { myExtension: { enabled: true } } });
    const loader = new ExtensionLoader(core);
    expect(loader).toBeInstanceOf(ExtensionLoader);
    expect(core.config.myExtension).toEqual({ enabled: true });
  });

  it("closes deep imports (exports map is the whitelist)", async () => {
    // The root barrel maps "." -> src/index.ts; reaching implementation files
    // by package subpath must stay refused. (Relative imports still work for
    // in-tree code -- this pins the PUBLISHED boundary.) tsc refuses these
    // specifiers statically (the same verdict, at compile time), so the
    // runtime check goes through a variable to exercise the real resolver.
    const importRuntime = (specifier: string): Promise<unknown> => import(specifier);
    await expect(importRuntime("@read-receipt/hotdog/src/core/main.ts")).rejects.toThrow();
    await expect(importRuntime("@read-receipt/hotdog/src/utils/logger.ts")).rejects.toThrow();
    // The utils wildcard covers ONLY the ./utils/* spelling; the src/ path to
    // the same file stays refused, and so does any other subtree.
    await expect(importRuntime("@read-receipt/hotdog/core/hooks.ts")).rejects.toThrow();
  });

  it("@read-receipt/hotdog/utils/* resolves the utility leaves (flat and nested)", async () => {
    const strings: Record<string, unknown> = await import("@read-receipt/hotdog/utils/strings");
    expect(typeof strings.camelCase).toBe("function");
    expect(typeof strings.suggestCandidates).toBe("function");
    const version: Record<string, unknown> = await import("@read-receipt/hotdog/utils/version");
    expect(typeof version.rangeMatches).toBe("function");
    const diff: Record<string, unknown> = await import("@read-receipt/hotdog/utils/diff");
    expect(typeof diff.computeDiffLines).toBe("function");
    // Nested leaf (the wildcard carries slashes).
    const cliDiff: Record<string, unknown> = await import("@read-receipt/hotdog/utils/cli/diff-render");
    expect(typeof cliDiff.resolveCliDiff).toBe("function");
  });

  it("exposes ./package.json explicitly (npm-idiom tooling escape hatch)", async () => {
    // Bun exempts package.json from exports enforcement; the explicit entry
    // makes Node-strict resolvers agree instead of relying on that.
    expect(pkgJson.name).toBe("@read-receipt/hotdog");
  });
});
