import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fsSync from "node:fs";
import path from "node:path";
import { GrepTool } from "../../src/extensions/core-tools/grep.ts";
import { resultStr, getDisplay, tmpDir, toolCtx, cleanupDir } from "../helpers.ts";

let dir: string;

beforeAll(() => {
  dir = tmpDir();
});

afterAll(() => {
  cleanupDir(dir);
});

describe("GrepTool.toToolDef", () => {
  it("returns a tool definition with correct name", () => {
    const def = new GrepTool().toToolDef();
    expect(def.type).toBe("function");
    expect(def.function.name).toBe("grep");
  });

  it("requires only pattern", () => {
    const def = new GrepTool().toToolDef();
    expect(def.function.parameters.required).toEqual(["pattern"]);
  });
});

describe("GrepTool.callDisplay", () => {
  it("shows pattern and path", () => {
    const display = new GrepTool().callDisplay({
      pattern: "hello",
      path: "src",
    });
    expect(display).toBe("'hello' in src");
  });

  it("shows dot for default path", () => {
    const display = new GrepTool().callDisplay({ pattern: "foo" });
    expect(display).toBe("'foo' in .");
  });

  it("handles invalid input gracefully", () => {
    expect(new GrepTool().callDisplay("not json")).toBe("not json");
    expect(new GrepTool().callDisplay({})).toBe("");
    expect(new GrepTool().callDisplay(null)).toBe("");
  });
});

describe("GrepTool.execute", () => {
  it("finds matches in files", async () => {
    fsSync.writeFileSync(
      path.join(dir, "hello.js"),
      'console.log("hello world")',
    );
    fsSync.writeFileSync(path.join(dir, "other.js"), 'console.log("goodbye")');

    const tool = new GrepTool();
    const result = getDisplay(
      await tool.execute({ pattern: "hello", path: dir }, toolCtx()),
    );

    expect(resultStr(result)).toContain("hello.js");
    expect(resultStr(result)).toContain("hello world");
  });

  it("finds regex matches", async () => {
    fsSync.writeFileSync(
      path.join(dir, "test.py"),
      "item1 = 1\nitem2 = 2\nfoo = 3",
    );

    const tool = new GrepTool();
    const result = getDisplay(
      await tool.execute({ pattern: "item\\d+", path: dir }, toolCtx()),
    );

    expect(resultStr(result)).toContain("test.py");
    expect(resultStr(result)).toContain("item1");
    expect(resultStr(result)).toContain("item2");
  });

  it("filters by file type", async () => {
    fsSync.writeFileSync(path.join(dir, "test.js"), "hello world");
    fsSync.writeFileSync(path.join(dir, "test.py"), "hello world");
    fsSync.writeFileSync(path.join(dir, "test.txt"), "hello world");

    const tool = new GrepTool();
    const result = getDisplay(
      await tool.execute(
        { pattern: "hello", path: dir, type: "py" },
        toolCtx(),
      ),
    );

    expect(resultStr(result)).toContain("test.py");
    expect(result).not.toContain("test.js");
    expect(result).not.toContain("test.txt");
  });

  it("respects max_results", async () => {
    for (let i = 0; i < 10; i++) {
      fsSync.writeFileSync(
        path.join(dir, `file${i}.js`),
        `line with hello ${i}`,
      );
    }

    const tool = new GrepTool();
    const result = getDisplay(
      await tool.execute(
        { pattern: "hello", path: dir, max_results: 3 },
        toolCtx(),
      ),
    );

    // Should have at most 3 results
    const lines = result.split("\n").filter((l) => l.includes("file"));
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it("returns no matches when nothing found", async () => {
    fsSync.writeFileSync(path.join(dir, "file.txt"), "hello world");

    const tool = new GrepTool();
    const result = getDisplay(
      await tool.execute({ pattern: "zzzznotfound", path: dir }, toolCtx()),
    );

    expect(resultStr(result)).toContain("No matches found");
  });

  it("rejects invalid regex", async () => {
    const tool = new GrepTool();
    const result = getDisplay(
      await tool.execute({ pattern: "[invalid", path: dir }, toolCtx()),
    );

    expect(resultStr(result)).toContain("Invalid regex");
  });

  it("returns error on invalid JSON input", async () => {
    const tool = new GrepTool();
    const result = getDisplay(await tool.execute("not json", toolCtx()));
    expect(resultStr(result)).toContain("Error parsing arguments");
  });

  it("returns error on missing pattern", async () => {
    const tool = new GrepTool();
    const result = getDisplay(await tool.execute({ path: "." }, toolCtx()));
    expect(resultStr(result)).toContain("Error parsing arguments");
  });

  it("handles input as string JSON", async () => {
    fsSync.writeFileSync(path.join(dir, "file.js"), "hello world");

    const tool = new GrepTool();
    const result = getDisplay(
      await tool.execute(
        JSON.stringify({ pattern: "hello", path: dir }),
        toolCtx(),
      ),
    );

    expect(resultStr(result)).toContain("file.js");
    expect(resultStr(result)).toContain("hello world");
  });

  it("searches recursively", async () => {
    fsSync.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fsSync.writeFileSync(path.join(dir, "root.js"), "hello");
    fsSync.writeFileSync(path.join(dir, "sub", "nested.js"), "hello");

    const tool = new GrepTool();
    const result = getDisplay(
      await tool.execute({ pattern: "hello", path: dir }, toolCtx()),
    );

    expect(resultStr(result)).toContain("root.js");
    expect(resultStr(result)).toContain("nested.js");
  });
});
