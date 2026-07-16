import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
import {
  toolDef,
  param,
  parseToolArgs,
  toolResult,
  truncateOutput,
  generateDiff,
  getRequiredStr,
  ToolResult,
} from "../../src/core/extensions/tool-utils.ts";
import { validateCwdBoundary, writeFileWithParents, fileSize, resolvePathAndValidate, checkWritable, checkReadable, IOError } from "../../src/utils/file-utils.ts";
import { ToolRegistry } from "../../src/core/extensions/tool-registry.ts";
import { ToolContext } from "../../src/core/extensions/tool-context.ts";

describe("toolDef", () => {
  it("creates a tool definition", () => {
    const def = toolDef("test", "A test tool", {
      properties: { x: { type: "string" } },
    });
    expect(def).toEqual({
      type: "function",
      function: {
        name: "test",
        description: "A test tool",
        parameters: {
          schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { x: { type: "string" } },
          required: [],
        },
      },
    });
  });

  it("includes required fields", () => {
    const def = toolDef("test", "desc", { required: ["x", "y"] });
    expect(def.function.parameters.required).toEqual(["x", "y"]);
  });

  it("handles missing parameters", () => {
    const def = toolDef("test", "desc", {});
    expect(def.function.parameters.properties).toEqual({});
    expect(def.function.parameters.required).toEqual([]);
  });
});

describe("param", () => {
  it("creates a parameter with description", () => {
    expect(param("string", "A path")).toEqual({
      type: "string",
      description: "A path",
    });
  });

  it("creates a parameter without description", () => {
    expect(param("integer", "")).toEqual({ type: "integer", description: "" });
  });
});

describe("parseToolArgs", () => {
  it("parses valid JSON string", () => {
    expect(parseToolArgs('{"x": 1}')).toEqual({ x: 1 });
  });

  it("returns raw string on parse failure", () => {
    expect(parseToolArgs("not json")).toEqual({ input: "not json" });
  });

  it("returns object as-is", () => {
    const obj = { x: 1 };
    expect(parseToolArgs(obj)).toBe(obj);
  });
});

describe("toolResult", () => {
  it("returns string as-is", () => {
    expect(toolResult("result")).toBe("result");
  });

  it("stringifies objects", () => {
    expect(toolResult({ key: "val" })).toBe('{"key":"val"}');
  });

  it("converts numbers to string", () => {
    expect(toolResult(42)).toBe("42");
  });

  it("converts null to string", () => {
    expect(toolResult(null)).toBe("null");
  });
});

describe("truncateOutput", () => {
  it("returns empty string for null", () => {
    expect(truncateOutput(null as any, 10)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(truncateOutput(undefined as any, 10)).toBe("");
  });

  it("returns text under limit", () => {
    const text = "line1\nline2\nline3";
    expect(truncateOutput(text, 10)).toBe(text);
  });

  it("truncates text over limit", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line${i + 1}`).join(
      "\n",
    );
    const result = truncateOutput(lines, 3);
    expect(result).toContain("line3");
    expect(result).toContain("[truncated, 2 more lines]");
  });

  it("handles single line", () => {
    expect(truncateOutput("single", 1)).toBe("single");
  });

  it("handles zero max lines", () => {
    const result = truncateOutput("line1\nline2", 0);
    expect(result).toBe("\n--- [truncated, 2 more lines] ---");
  });
});

describe("generateDiff", () => {
  it("returns empty for identical text", () => {
    expect(generateDiff("hello", "hello")).toBe("");
  });

  it("shows changed lines", () => {
    const oldText = "line1\nold\nline3";
    const newText = "line1\nnew\nline3";
    const diff = generateDiff(oldText, newText);
    expect(diff).toContain("- old");
    expect(diff).toContain("+ new");
  });

  it("shows added lines", () => {
    const diff = generateDiff("a", "a\nb");
    expect(diff).toContain("+ b");
  });

  it("shows removed lines", () => {
    const diff = generateDiff("a\nb", "a");
    expect(diff).toContain("- b");
  });

  it("limits comparison phase", () => {
    const oldLines = Array.from({ length: 50 }, (_, i) => `old${i}`).join("\n");
    const newLines = Array.from({ length: 50 }, (_, i) => `new${i}`).join("\n");
    const diff = generateDiff(oldLines, newLines, 5);
    // maxLines limits comparison phase; remaining lines still added
    const diffLines = diff.split("\n");
    expect(diffLines.length).toBeGreaterThan(10);
  });
});

describe("validateCwdBoundary", () => {
  it("returns null when no boundary", () => {
    expect(validateCwdBoundary("/any/path", undefined)).toBeNull();
  });

  it("returns null for path within boundary", () => {
    expect(
      validateCwdBoundary("/home/user/project/file.txt", "/home/user/project"),
    ).toBeNull();
  });

  it("returns null for boundary itself", () => {
    expect(
      validateCwdBoundary("/home/user/project", "/home/user/project"),
    ).toBeNull();
  });

  it("returns error string for path outside boundary", () => {
    const result = validateCwdBoundary(
      "/home/other/file.txt",
      "/home/user/project",
    );
    expect(typeof result).toBe("string");
    expect(result).toContain("outside cwd boundary");
  });
});

describe("ToolRegistry", () => {
  it("registers and retrieves tools", () => {
    const reg = new ToolRegistry();
    reg.register("bash", {});
    expect(reg.get("bash")).toBeDefined();
  });

  it("checks tool existence", () => {
    const reg = new ToolRegistry();
    reg.register("bash", {});
    expect(reg.has("bash")).toBe(true);
    expect(reg.has("write")).toBe(false);
  });

  it("lists all tools", () => {
    const reg = new ToolRegistry();
    reg.register("bash", {});
    reg.register("write", {});
    const all = reg.getAll();
    expect(all).toHaveLength(2);
    expect(all.map(([name]) => name)).toContain("bash");
  });

  it("filters by whitelist", () => {
    const reg = new ToolRegistry();
    reg.register("bash", {});
    reg.register("write", {});
    reg.register("read", {});
    const filtered = reg.filter(["bash", "write"], undefined);
    expect(filtered.getAll()).toHaveLength(2);
  });

  it("filters by blacklist", () => {
    const reg = new ToolRegistry();
    reg.register("bash", {});
    reg.register("write", {});
    reg.register("read", {});
    const filtered = reg.filter(undefined, ["bash"]);
    expect(filtered.getAll()).toHaveLength(2);
  });

  it("filters by both whitelist and blacklist", () => {
    const reg = new ToolRegistry();
    reg.register("bash", {});
    reg.register("write", {});
    reg.register("read", {});
    // whitelist wins: only bash and write allowed, but bash is blacklisted
    const filtered = reg.filter(["bash", "write"], ["bash"]);
    expect(filtered.getAll()).toHaveLength(1);
    expect(filtered.has("bash")).toBe(false);
    expect(filtered.has("write")).toBe(true);
  });

  it("removes a single tool", () => {
    const reg = new ToolRegistry();
    reg.register("bash", {});
    reg.register("write", {});
    expect(reg.remove("bash")).toBe(true);
    expect(reg.has("bash")).toBe(false);
    expect(reg.has("write")).toBe(true);
  });

  it("removeAll removes multiple tools and returns count", () => {
    const reg = new ToolRegistry();
    reg.register("bash", {});
    reg.register("write", {});
    reg.register("read", {});
    const count = reg.removeAll(["bash", "read", "nonexistent"]);
    expect(count).toBe(2);
    expect(reg.has("bash")).toBe(false);
    expect(reg.has("read")).toBe(false);
    expect(reg.has("write")).toBe(true);
  });

  it("clears all tools", () => {
    const reg = new ToolRegistry();
    reg.register("bash", {});
    reg.register("write", {});
    reg.clear();
    expect(reg.getAll()).toHaveLength(0);
  });
});

describe("ToolContext", () => {
  it("creates context with defaults", () => {
    const ctx = new ToolContext();
    expect(ctx.get("skills")).toBeUndefined();
    expect(ctx.get("allSkills")).toBeUndefined();
    expect(ctx.get("skillDirectories")).toBeUndefined();
    expect(ctx.get("modelRegistry")).toBeUndefined();
    expect(ctx.get("cwdBoundary")).toBeUndefined();
  });

  it("accepts custom options", () => {
    const ctx = new ToolContext({
      skills: ["skill1"],
      cwdBoundary: "/project",
    });
    expect(ctx.get("skills")).toEqual(["skill1"]);
    expect(ctx.get("cwdBoundary")).toBe("/project");
  });

  it("handles cancelled callback", () => {
    let cancelled = false;
    const ctx = new ToolContext();
    ctx.set("isCancelled", () => cancelled);
    expect((ctx.get("isCancelled") as () => boolean)()).toBe(false);
    cancelled = true;
    expect((ctx.get("isCancelled") as () => boolean)()).toBe(true);
  });

  it("mounts and retrieves properties via get()", () => {
    const ctx = new ToolContext();
    ctx.mount({
      workspaceRoot: "/project",
      currentFile: "/project/src/main.js",
      modelNames: ["qwen3.5-0.8b", "qwen3.5-4b"],
      activeProvider: "openai",
    });
    expect(ctx.get("workspaceRoot")).toBe("/project");
    expect(ctx.get("currentFile")).toBe("/project/src/main.js");
    expect(ctx.get("modelNames")).toEqual(["qwen3.5-0.8b", "qwen3.5-4b"]);
    expect(ctx.get("activeProvider")).toBe("openai");
  });

  it("returns undefined for unmounted properties", () => {
    const ctx = new ToolContext();
    expect(ctx.get("workspaceRoot")).toBeUndefined();
    expect(ctx.get("currentFile")).toBeUndefined();
    expect(ctx.get("modelNames")).toBeUndefined();
    expect(ctx.get("activeProvider")).toBeUndefined();
  });
});

describe("ToolResult", () => {
  it("creates success result with ok()", () => {
    const r = ToolResult.ok("hello");
    expect(r.success).toBe(true);
    expect(r.output).toBe("hello");
    expect(r.error).toBeNull();
    expect(r.isOk()).toBe(true);
    expect(r.isErr()).toBe(false);
  });

  it("creates error result with err()", () => {
    const r = ToolResult.err("not found");
    expect(r.success).toBe(false);
    expect(r.output).toBe("");
    expect(r.error).toBe("not found");
    expect(r.isOk()).toBe(false);
    expect(r.isErr()).toBe(true);
  });

  it("chains withEntry to add metadata", () => {
    const r = ToolResult.ok("out").withEntry("key", "val");
    expect(r.metadata!).toBeInstanceOf(Map);
    expect(r.metadata!.get("key")).toBe("val");
  });

  it("chains withEntries to add multiple metadata", () => {
    const r = ToolResult.ok("out").withEntries({ a: "1", b: "2" });
    expect(r.metadata!.get("a")).toBe("1");
    expect(r.metadata!.get("b")).toBe("2");
  });

  it("chains withOutputTag", () => {
    const r = ToolResult.ok("data").withOutputTag("result");
    expect(r.outputTag).toBe("result");
  });

  it("toDisplay returns output", () => {
    expect(ToolResult.ok("hello world").toDisplay()).toBe("hello world");
  });

  it("toDisplay appends error for failures", () => {
    const r = ToolResult.err("command failed");
    expect(r.toDisplay()).toBe("Error: command failed");
  });

  it("toDisplay combines output + error", () => {
    const r = ToolResult.ok("partial output").withEntry("x", "1");
    r.success = false;
    r.error = "partial failure";
    expect(r.toDisplay()).toBe("partial output\nError: partial failure");
  });

  it("toApiContent success no metadata", () => {
    const r = ToolResult.ok("hello world");
    const content = r.toApiContent("bash");
    expect(content).toBe(
      '<tool name="bash" status="success">\n  <output>hello world</output>\n</tool>',
    );
  });

  it("toApiContent failure with error", () => {
    const r = ToolResult.err("command not found");
    const content = r.toApiContent("bash");
    expect(content).toContain('<tool name="bash" status="failure">');
    expect(content).toContain("<error>command not found</error>");
    expect(content).toContain("<output></output>");
  });

  it("toApiContent with metadata", () => {
    const r = ToolResult.ok("output")
      .withEntry("key1", "val1")
      .withEntry("key2", "val2");
    const content = r.toApiContent("read_file");
    expect(content).toContain('<tool name="read_file" status="success">');
    expect(content).toContain("<output>output</output>");
    expect(content).toContain("<key1>val1</key1>");
    expect(content).toContain("<key2>val2</key2>");
  });

  it("toApiContent no error when success", () => {
    const content = ToolResult.ok("ok").toApiContent("bash");
    expect(content).not.toContain("<error>");
  });

  it("toApiContent custom output tag", () => {
    const content = ToolResult.ok("hello world")
      .withOutputTag("result")
      .toApiContent("bash");
    expect(content).toBe(
      '<tool name="bash" status="success">\n  <result>hello world</result>\n</tool>',
    );
  });

  it("toApiContent short metadata as attributes", () => {
    const r = ToolResult.ok("output")
      .withEntry("truncated", "true")
      .withEntry("page", "1")
      .withEntry("total_pages", "3")
      .withEntry("duration_ms", "42")
      .withEntry("diff", "--- a/file\n+++ b/file");
    const content = r.toApiContent("edit");
    expect(content).toContain('name="edit"');
    expect(content).toContain('status="success"');
    expect(content).toContain('duration_ms="42"');
    expect(content).toContain('page="1"');
    expect(content).toContain('total_pages="3"');
    expect(content).toContain('truncated="true"');
    expect(content).toContain("<diff>--- a/file\n+++ b/file</diff>");
    expect(content).toContain("<output>output</output>");
  });

  it("toApiContent does NOT escape output content", () => {
    const r = ToolResult.ok("a < b & c > d");
    const content = r.toApiContent("bash");
    // Output content is raw (not XML-escaped)
    expect(content).toContain("a < b & c > d");
  });

  it("toolResult passes through ToolResult via toDisplay()", () => {
    const r = ToolResult.ok("hello").withEntry("x", "1");
    expect(toolResult(r)).toBe("hello");

    const err = ToolResult.err("boom");
    expect(toolResult(err)).toBe("Error: boom");
  });

  it("toolResult with toolName wraps ToolResult in XML", () => {
    const r = ToolResult.ok("hello");
    const result = toolResult(r, "bash");
    expect(result).toContain('<tool name="bash"');
    expect(result).toContain('status="success"');
    expect(result).toContain("<output>hello</output>");
  });

  it("toolResult with toolName wraps string in XML", () => {
    const result = toolResult("plain text", "read");
    expect(result).toContain('<tool name="read"');
    expect(result).toContain("<output>plain text</output>");
  });

  it("toolResult with toolName wraps object in XML", () => {
    const result = toolResult({ key: "val" }, "fetch");
    expect(result).toContain('<tool name="fetch"');
    expect(result).toContain("<output>");
    expect(result).toContain('{"key":"val"}');
  });

  it("toolResult with toolName wraps number in XML", () => {
    const result = toolResult(42, "calc");
    expect(result).toContain('<tool name="calc"');
    expect(result).toContain("<output>42</output>");
  });

  it("ToolResult.from() creates a result with defaults", () => {
    const r = ToolResult.from({ output: "hello", error: null });
    expect(r.success).toBe(true);
    expect(r.output).toBe("hello");
    expect(r.error).toBeNull();
  });

  it("ToolResult.from() auto-fails when error provided", () => {
    const r = ToolResult.from({ output: "", error: "fail" });
    expect(r.success).toBe(false);
    expect(r.error).toBe("fail");
  });

  it("ToolResult.from() overrides success when error provided (even if success=true)", () => {
    const r = ToolResult.from({ output: "partial", error: "warning", success: true });
    expect(r.success).toBe(false); // error overrides success
    expect(r.output).toBe("partial");
    expect(r.error).toBe("warning");
  });

  it("ToolResult.from() preserves success=false with error", () => {
    const r = ToolResult.from({ output: "partial", error: "warning", success: false });
    expect(r.success).toBe(false);
    expect(r.output).toBe("partial");
    expect(r.error).toBe("warning");
  });

  it("ToolResult.from() accepts metadata and outputTag", () => {
    const metadata = new Map();
    metadata.set("key", "value");
    const r = ToolResult.from({ output: "out", error: null, metadata, outputTag: "result" });
    expect(r.metadata).toBe(metadata);
    expect(r.outputTag).toBe("result");
  });

  it("ToolResult.from() accepts images", () => {
    const images = [{ type: "image_url", mimeType: "image/png", data: "base64..." }];
    const r = ToolResult.from({ output: "img", images });
    expect(r.images).toBe(images);
  });
});

describe("writeFileWithParents", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-test-writefile-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes file and creates parent dirs", async () => {
    const filePath = path.join(tmpDir, "a", "b", "c", "test.txt");
    await writeFileWithParents(filePath, "content");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("content");
  });

  it("overwrites existing file", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await writeFileWithParents(filePath, "v1");
    await writeFileWithParents(filePath, "v2");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("v2");
  });
});

describe("resolvePathAndValidate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-test-resolve-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves existing path", async () => {
    const existingFile = path.join(tmpDir, "exists.txt");
    fs.writeFileSync(existingFile, "content");
    const resolved = await resolvePathAndValidate(existingFile);
    expect(resolved).toBe(existingFile);
  });

  it("throws for non-existent path", async () => {
    await expect(resolvePathAndValidate(path.join(tmpDir, "nonexistent.txt"))).rejects.toThrow(
      "Path not found",
    );
  });

  it("throws when path escapes boundary", async () => {
    await expect(resolvePathAndValidate("/etc/passwd", tmpDir)).rejects.toThrow(
      "outside the allowed directory",
    );
  });

  it("allows path within boundary", async () => {
    const existingFile = path.join(tmpDir, "inside.txt");
    fs.writeFileSync(existingFile, "content");
    const resolved = await resolvePathAndValidate(existingFile, tmpDir);
    expect(resolved).toBe(existingFile);
  });

  it("allows path outside cwd when no boundary is set", async () => {
    // When cwdBoundary is null, paths outside the current directory should be allowed
    const existingFile = path.join(tmpDir, "outside.txt");
    fs.writeFileSync(existingFile, "content");
    const resolved = await resolvePathAndValidate(existingFile);
    expect(resolved).toBe(existingFile);
  });
});

describe("fileSize", () => {
  it("returns file size in bytes", async () => {
    const size = await fileSize(path.join(ROOT, "src/core/extensions/tool-registry.ts"));
    expect(typeof size).toBe("number");
    expect(size).toBeGreaterThan(0);
  });
});

describe("checkWritable", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-test-writable-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true for writable file", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "data");
    expect(await checkWritable(filePath)).toBe(true);
  });

  it("returns true for new file in writable dir", async () => {
    const filePath = path.join(tmpDir, "new-file.txt");
    expect(await checkWritable(filePath)).toBe(true);
  });

  it("throws for unwritable directory", async () => {
    // Create a read-only directory
    const roDir = path.join(tmpDir, "readonly");
    fs.mkdirSync(roDir, { recursive: true });
    fs.chmodSync(roDir, 0o555);
    const filePath = path.join(roDir, "test.txt");
    await expect(checkWritable(filePath)).rejects.toThrow("not writable");
    fs.chmodSync(roDir, 0o755);
  });

  it("returns true for existing read-only file (parent dir is writable)", async () => {
    const filePath = path.join(tmpDir, "readonly-file.txt");
    fs.writeFileSync(filePath, "data");
    fs.chmodSync(filePath, 0o444);
    // checkWritable returns true for existing files in writable directories
    // (it only throws for unwritable parent directories)
    expect(await checkWritable(filePath)).toBe(true);
    fs.chmodSync(filePath, 0o644);
  });
});

describe("checkReadable", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-test-readable-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true for readable file", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "data");
    expect(await checkReadable(filePath)).toBe(true);
  });

  it("throws for non-existent path", async () => {
    await expect(checkReadable("/nonexistent/path/file.txt")).rejects.toThrow(
      "does not exist",
    );
  });

  it("throws for unreadable file", async () => {
    const filePath = path.join(tmpDir, "no-read.txt");
    fs.writeFileSync(filePath, "data");
    fs.chmodSync(filePath, 0o000);
    await expect(checkReadable(filePath)).rejects.toThrow("not readable");
    fs.chmodSync(filePath, 0o644);
  });
});

describe("getRequiredStr", () => {
  it("returns string value", () => {
    expect(getRequiredStr({ name: "Alice" }, "name")).toBe("Alice");
  });

  it("throws for missing key", () => {
    expect(() => getRequiredStr({ name: "Alice" }, "age")).toThrow(
      "Missing required argument: age",
    );
  });

  it("throws for non-string value", () => {
    expect(() => getRequiredStr({ count: 42 }, "count")).toThrow(
      "Missing required argument: count",
    );
  });

  it("throws for null input", () => {
    expect(() => getRequiredStr(null as any, "key")).toThrow(
      "Missing required argument: key",
    );
  });
});

