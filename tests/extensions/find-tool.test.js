import { describe, it, expect } from "bun:test";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { FindTool } from "../../src/extensions/core-tools/find.js";
import { ToolContext } from "../../src/core/extensions/tool-context.js";
import { DEFAULT_FIND_MAX_RESULTS } from "../../src/extensions/core-tools/defaults.js";
import { resultStr, getDisplay, tmpDir, toolCtx } from "../helpers.js";

// ── Tool Definition ─────────────────────────────────────────────────────────

describe("FindTool.toToolDef", () => {
  it("returns a tool definition with correct name", () => {
    const def = new FindTool().toToolDef();
    expect(def.type).toBe("function");
    expect(def.function.name).toBe("find");
  });

  it("requires only pattern", () => {
    const def = new FindTool().toToolDef();
    expect(def.function.parameters.required).toEqual(["pattern"]);
  });
});

// ── callDisplay ─────────────────────────────────────────────────────────────

describe("FindTool.callDisplay", () => {
  it("shows pattern and path with default max", () => {
    const display = new FindTool().callDisplay({
      pattern: "*.js",
      path: "src",
    });
    expect(display).toContain("*.js");
    expect(display).toContain("src");
    expect(display).toContain(`max ${DEFAULT_FIND_MAX_RESULTS}`);
  });

  it("shows file type filter", () => {
    const display = new FindTool().callDisplay({
      pattern: "*.js",
      file_type: "f",
      max_results: 100,
    });
    expect(display).toContain("*.js");
    expect(display).toContain("f");
    expect(display).toContain("max 100");
  });

  it("handles invalid input gracefully", () => {
    const fallback = `* in . (max ${DEFAULT_FIND_MAX_RESULTS})`;
    expect(new FindTool().callDisplay("not json")).toContain(fallback);
    expect(new FindTool().callDisplay({})).toContain(fallback);
    expect(new FindTool().callDisplay(null)).toContain(fallback);
  });
});

// ── execute: basic find ─────────────────────────────────────────────────────

describe("FindTool.execute — basic find", () => {
  it("finds files matching pattern", async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, "hello.txt"), "hello");
    fsSync.writeFileSync(path.join(dir, "world.txt"), "world");
    fsSync.writeFileSync(path.join(dir, "data.json"), '{"key": "value"}');

    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: "*.txt", path: dir },
      toolCtx(),
    );

    expect(getDisplay(result)).toContain("hello.txt");
    expect(getDisplay(result)).toContain("world.txt");
    expect(getDisplay(result)).not.toContain("data.json");
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it("finds files recursively", async () => {
    const dir = tmpDir();
    fsSync.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fsSync.writeFileSync(path.join(dir, "root.txt"), "root");
    fsSync.writeFileSync(path.join(dir, "sub", "nested.txt"), "nested");

    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: "**/*.txt", path: dir },
      toolCtx(),
    );

    expect(getDisplay(result)).toContain("root.txt");
    expect(getDisplay(result)).toContain("nested.txt");
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('returns "No files found" when nothing matches', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, "hello.txt"), "hello");

    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: "*.xyz", path: dir },
      toolCtx(),
    );

    expect(getDisplay(result)).toContain("No files found");
    fsSync.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: file type filter ───────────────────────────────────────────────

describe("FindTool.execute — file type filter", () => {
  it("finds only files with file_type f", async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, "file.txt"), "file");
    fsSync.mkdirSync(path.join(dir, "subdir"));

    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: "*", file_type: "f", path: dir },
      toolCtx(),
    );

    expect(getDisplay(result)).toContain("file.txt");
    expect(getDisplay(result)).not.toContain("subdir");
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it("finds only directories with file_type d", async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, "file.txt"), "file");
    fsSync.mkdirSync(path.join(dir, "subdir"));

    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: "*", file_type: "d", path: dir },
      toolCtx(),
    );

    expect(getDisplay(result)).toContain("subdir");
    expect(getDisplay(result)).not.toContain("file.txt");
    fsSync.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: max_results ────────────────────────────────────────────────────

describe("FindTool.execute — max_results", () => {
  it("limits results to max_results", async () => {
    const dir = tmpDir();
    for (let i = 0; i < 10; i++) {
      fsSync.writeFileSync(path.join(dir, `file${i}.txt`), `content ${i}`);
    }

    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: "*.txt", path: dir, max_results: 3 },
      toolCtx(),
    );

    // Should have at most 3 results
    const lines = getDisplay(result)
      .split("\n")
      .filter((l) => l.includes("file"));
    expect(lines.length).toBeLessThanOrEqual(3);
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it("uses default max_results when not specified", async () => {
    const dir = tmpDir();
    for (let i = 0; i < 5; i++) {
      fsSync.writeFileSync(path.join(dir, `file${i}.txt`), `content ${i}`);
    }

    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: "*.txt", path: dir },
      toolCtx(),
    );

    const lines = getDisplay(result)
      .split("\n")
      .filter((l) => l.includes("file"));
    expect(lines.length).toBe(5);
    fsSync.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: error cases ────────────────────────────────────────────────────

describe("FindTool.execute — error cases", () => {
  it("returns error on invalid JSON input", async () => {
    const tool = new FindTool();
    const result = await tool.execute("not json", toolCtx());
    expect(getDisplay(result)).toContain("Error parsing arguments");
  });

  it("returns error on missing pattern", async () => {
    const tool = new FindTool();
    const result = await tool.execute({ path: "." }, toolCtx());
    expect(getDisplay(result)).toContain("Error parsing arguments");
  });

  it("handles non-existent search path gracefully", async () => {
    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: "*", path: "/nonexistent/path/that/does/not/exist" },
      toolCtx(),
    );
    // Should not crash and should indicate no files or an error
    expect(getDisplay(result)).toBeTruthy();
    expect(typeof getDisplay(result)).toBe("string");
  });
});
