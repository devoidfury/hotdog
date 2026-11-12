// Boots the starter extension through the REAL discovery + loader path, so
// `bun run test` compiles and exercises the published authoring contract:
// extension.json discovery, the "@read-receipt/hotdog/sdk" package-name import (self-reference), registration
// onto a live ToolRegistry, and config read at execute time.

import { describe, it, expect } from "bun:test";
import { dirname, join } from "node:path";

import {
  createTestCore,
  discoverExtensions,
  ExtensionLoader,
  getExtensionConfigDefaults,
  sdkCompatibilityWarning,
  ToolResult,
} from "@read-receipt/hotdog/testing";
import pkgJson from "@package.json";

const STARTER_DIR = import.meta.dir;
// extensionPaths accepts a bundle ROOT (discovery scans subdirectories for
// extension.json) or a single extension directory. examples/ holds exactly
// one manifest today: this starter.
const EXAMPLES_DIR = dirname(STARTER_DIR);

function bootStarter(topWords: number) {
  const core = createTestCore({
    config: { extensionStarter: { enabled: true, topWords } },
  });
  const loader = new ExtensionLoader(core);
  return { core, loader };
}

async function loadStarter(topWords: number) {
  const { core, loader } = bootStarter(topWords);
  const inst = await loader.load("extension-starter", join(STARTER_DIR, "index.ts"));
  expect(inst).not.toBeNull();
  const tool = core.toolRegistry.get("word_count");
  expect(tool).toBeDefined();
  return { core, tool: tool! };
}

describe("extension-starter: discovery", () => {
  it("loads when extensionPaths points directly at the extension directory", async () => {
    const discovered = await discoverExtensions([STARTER_DIR]);
    expect(discovered).toHaveLength(1);
    const meta = discovered[0]!;
    expect(meta.name).toBe("extension-starter");
    expect(meta.provides).toContain("tools");
    expect(meta.manifestError).toBeUndefined();
    expect(meta.sdk).toBe(">=0.16");
    // The shipped example must stay compatible with the tree that ships it.
    expect(sdkCompatibilityWarning(meta, pkgJson.version)).toBeNull();
    expect(meta.configSchema).not.toBeNull();
    // Direct specs still get a ROOT_DIR-relative entry point ("../examples/...").
    expect(meta.path!.endsWith(join("examples", "extension-starter", "index.ts"))).toBe(true);
  });

  it("finds the starter by scanning a bundle root", async () => {
    const discovered = await discoverExtensions([EXAMPLES_DIR]);
    // examples/ holds the starter and the redactor; the scan finds both.
    expect(discovered.map((d) => d.name).sort()).toEqual([
      "extension-redactor",
      "extension-starter",
    ]);
  });

  it("extracts config defaults from extension.json alone", async () => {
    const defaults = await getExtensionConfigDefaults([EXAMPLES_DIR]);
    const entry = defaults.find((d) => d.key === "extensionStarter");
    expect(entry).toBeDefined();
    expect(entry!.defaults).toEqual({ enabled: true, topWords: 5 });
  });
});

describe("extension-starter: load through the real ExtensionLoader", () => {
  it("resolves the @read-receipt/hotdog/sdk import by package name (self-reference)", async () => {
    const { tool } = await loadStarter(3);
    // Tool.toToolDef() may be async or return null (contract); assert, then narrow.
    const def = await tool.toToolDef();
    if (!def) throw new Error("word_count returned no tool def");
    expect(def.function.name).toBe("word_count");
    expect(def.function.parameters.required).toEqual(["text"]);
    expect(Object.keys(def.function.parameters.properties as Record<string, unknown>)).toEqual([
      "text",
    ]);
    expect(tool.metadata.sideEffects).toBe(false);
    expect(tool.metadata.tags).toEqual(["utility"]);
  });

  it("counts words and ranks frequencies deterministically (count desc, then lexicographic)", async () => {
    const { tool } = await loadStarter(3);
    const res = (await tool.execute({ text: "one two two three two four one" })) as ToolResult;
    expect(res.error).toBeNull();
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed).toEqual({
      words: 7,
      lines: 1,
      characters: 30,
      uniqueWords: 4,
      top: [["two", 3], ["one", 2], ["four", 1]],
    });
  });

  it("accepts a JSON-string input exactly like an in-tree tool", async () => {
    const { tool } = await loadStarter(1);
    const res = (await tool.execute('{"text":"a b\\na b a"}')) as ToolResult;
    expect(res.error).toBeNull();
    const parsed = JSON.parse(res.output);
    expect(parsed.words).toBe(5);
    expect(parsed.lines).toBe(2);
    expect(parsed.top).toEqual([["a", 3]]);
  });

  it("honors topWords: 0 (ranking disabled)", async () => {
    const { tool } = await loadStarter(0);
    const res = (await tool.execute({ text: "x y x" })) as ToolResult;
    expect(JSON.parse(res.output).top).toEqual([]);
  });

  it("reads config at execute time, not at load time", async () => {
    const { core, tool } = await loadStarter(3);
    const before = (await tool.execute({ text: "a a b b c c d" })) as ToolResult;
    expect(JSON.parse(before.output).top).toHaveLength(3);
    // Flip the knob on the live config bag; the NEXT execute must answer with it.
    (core.config.extensionStarter as { topWords: number }).topWords = 1;
    const res = (await tool.execute({ text: "a a b b c c d" })) as ToolResult;
    expect(JSON.parse(res.output).top).toEqual([["a", 2]]);
  });

  it("returns error results for missing or unparsable input", async () => {
    const { tool } = await loadStarter(5);
    const missing = (await tool.execute({})) as ToolResult;
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("'text' is required");

    const garbage = (await tool.execute("not json")) as ToolResult;
    expect(garbage.success).toBe(false);
    expect(garbage.error).toContain("Error parsing");
  });
});
