// Tests for core/extensions/tool-utils.ts — tool definition helpers,
// argument parsing, result formatting, and XML utilities.

import { describe, it, expect, beforeAll } from "bun:test";
import {
  toolDef,
  param,
  toolResult,
  truncateOutput,
  generateDiff,
  getRequiredStr,
  ToolResult,
  TOOL_STOP_LOOP,
} from "@core/extensions/tool-utils.ts";
import type { ToolResultPart } from "@core/context/wrappers.ts";

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


  it("chains withImages", () => {
    const images = [{ type: "image_url", mimeType: "image/png", data: "base64..." }];
    const r = ToolResult.ok("img").withImages(images);
    expect(r.images).toBe(images);
  });

  it("chains withHint", () => {
    const r = ToolResult.err("boom").withHint("try a different path");
    expect(r.hint).toBe("try a different path");
  });

  it("hint defaults to null", () => {
    expect(ToolResult.ok("ok").hint).toBe(null);
    expect(ToolResult.err("nope").hint).toBe(null);
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

  it("toDisplay appends HINT after the error", () => {
    const r = ToolResult.err("File not found: x").withHint("check the path");
    expect(r.toDisplay()).toBe("Error: File not found: x\nHINT: check the path");
  });

  it("toApiContent success no metadata", () => {
    const part = ToolResult.ok("hello world").toApiContent("bash");
    expect(part).toEqual({
      type: "tool-result",
      tool: "bash",
      status: "success",
      meta: [],
      error: null,
      hint: null,
      output: "hello world",
    });
  });

  it("toApiContent failure with error", () => {
    const part = ToolResult.err("command not found").toApiContent("bash");
    expect(part.status).toBe("failure");
    expect(part.error).toBe("command not found");
    // The payload stays empty -- the error never rides in as output.
    expect(part.output).toBe("");
  });

  it("toApiContent failure carries the hint as its own field", () => {
    const part = ToolResult.err("File not found: x").withHint("check the path").toApiContent("edit");
    expect(part.status).toBe("failure");
    expect(part.hint).toBe("check the path");
    // Hint and error stay separate fields; the renderer places the hint
    // element after the error element (pinned in core/wrappers.test.ts).
    expect(part.error).toBe("File not found: x");
  });

  it("toApiContent success with hint", () => {
    const part = ToolResult.ok("done")
      .withHint("truncated; use offset for more")
      .toApiContent("read");
    expect(part.status).toBe("success");
    expect(part.hint).toBe("truncated; use offset for more");
  });

  it("toApiContent leaves hint null when unset", () => {
    expect(ToolResult.err("boom").toApiContent("bash").hint).toBeNull();
    expect(ToolResult.ok("fine").toApiContent("bash").hint).toBeNull();
  });

  it("toApiContent with metadata keeps declaration order", () => {
    const part = ToolResult.ok("output").withEntry("key1", "val1").withEntry("key2", "val2").toApiContent("read_file");
    expect(part.tool).toBe("read_file");
    expect(part.status).toBe("success");
    expect(part.meta).toEqual([["key1", "val1"], ["key2", "val2"]]);
    expect(part.output).toBe("output");
  });

  it("toApiContent leaves error null on success; an error metadata entry stays metadata", () => {
    const part = ToolResult.ok("ok").withEntry("error", "stale").toApiContent("bash");
    expect(part.error).toBeNull();
    expect(part.meta).toEqual([["error", "stale"]]);
  });

  it("toApiContent drops a tool-authored metadata entry keyed like the error on failure", () => {
    // Tool code cannot overwrite (or impersonate) the harness error element.
    const part = ToolResult.err("real failure").withEntry("error", "masquerade").toApiContent("bash");
    expect(part.error).toBe("real failure");
    expect(part.meta).toEqual([]);
  });


  it("toApiContent keeps short metadata as ordinary entries", () => {
    // Attribute vs element is the RENDERER's choice (the canonical form is
    // pinned in core/wrappers.test.ts); the part is order-preserving pairs.
    const part = ToolResult.ok("output")
      .withEntry("truncated", "true")
      .withEntry("page", "1")
      .withEntry("total_pages", "3")
      .withEntry("duration_ms", "42")
      .withEntry("diff", "--- a/file\n+++ b/file")
      .toApiContent("edit");
    expect(part.meta).toEqual([
      ["truncated", "true"],
      ["page", "1"],
      ["total_pages", "3"],
      ["duration_ms", "42"],
      ["diff", "--- a/file\n+++ b/file"],
    ]);
  });

  it("toApiContent does NOT escape output content", () => {
    // The part holds the payload as the tool produced it; escaping (and only
    // of tool-authored fields) happens at the wire.
    expect(ToolResult.ok("a < b & c > d").toApiContent("bash").output).toBe("a < b & c > d");
  });

  it("toolResult passes through ToolResult via toDisplay()", () => {
    const r = ToolResult.ok("hello").withEntry("x", "1");
    expect(toolResult(r)).toBe("hello");

    const err = ToolResult.err("boom");
    expect(toolResult(err)).toBe("Error: boom");
  });

  it("toolResult with toolName builds a part from a ToolResult", () => {
    expect(toolResult(ToolResult.ok("hello"), "bash")).toEqual({
      type: "tool-result",
      tool: "bash",
      status: "success",
      meta: [],
      error: null,
      hint: null,
      output: "hello",
    });
  });

  it("toolResult with toolName builds a part from a string payload", () => {
    const part = toolResult("plain text", "read") as ToolResultPart;
    expect(part.tool).toBe("read");
    expect(part.status).toBe("success");
    expect(part.meta).toEqual([]);
    expect(part.output).toBe("plain text");
  });

  it("toolResult with toolName keeps a plain object wholly as the payload", () => {
    // Which keys ride a format's wrapper tag is the FORMAT's business
    // (extensions/wire-format-xml), so the builder never splits them out:
    // metadata comes from ToolResult.withEntry, not from a key-name guess.
    const part = toolResult({ page: 2, key: "val" }, "fetch") as ToolResultPart;
    expect(part.tool).toBe("fetch");
    expect(part.meta).toEqual([]);
    expect(part.output).toBe('{"page":2,"key":"val"}');
  });

  it("toolResult with toolName builds a part from a number payload", () => {
    const part = toolResult(42, "calc") as ToolResultPart;
    expect(part.tool).toBe("calc");
    expect(part.output).toBe("42");
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

  it("ToolResult.from() accepts metadata", () => {
    const metadata = new Map();
    metadata.set("key", "value");
    const r = ToolResult.from({ output: "out", error: null, metadata });
    expect(r.metadata).toBe(metadata);
  });

  it("ToolResult.from() accepts images", () => {
    const images = [{ type: "image_url", mimeType: "image/png", data: "base64..." }];
    const r = ToolResult.from({ output: "img", images });
    expect(r.images).toBe(images);
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


describe("parseToolInput", () => {
  let parseToolInput: (input: string | Record<string, unknown> | null) => Record<string, unknown> | null;

  beforeAll(async () => {
    const mod = await import("@core/extensions/tool-utils.ts");
    parseToolInput = mod.parseToolInput;
  });

  it("parses valid JSON string", () => {
    expect(parseToolInput('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("returns null for invalid JSON string", () => {
    expect(parseToolInput("not json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseToolInput("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseToolInput("   ")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseToolInput(null)).toBeNull();
  });

  it("returns object as-is", () => {
    const obj = { key: "value" };
    expect(parseToolInput(obj)).toBe(obj);
  });
});

describe("defaultCallDisplay", () => {
  let defaultCallDisplay: (
    input: string | Record<string, unknown> | null,
    templateFn: (args: Record<string, unknown>) => string,
    options?: string | ((input: string | Record<string, unknown> | null) => string) | { fallback?: string | ((input: string | Record<string, unknown> | null) => string); returnRawOnParseError?: boolean } | undefined,
  ) => string;

  beforeAll(async () => {
    const mod = await import("@core/extensions/tool-utils.ts");
    defaultCallDisplay = mod.defaultCallDisplay;
  });

  it("renders template from valid JSON input", () => {
    const result = defaultCallDisplay('{"path": "/tmp"}', (args) => args.path as string);
    expect(result).toBe("/tmp");
  });

  it("renders template from object input", () => {
    const result = defaultCallDisplay({ path: "/tmp" }, (args) => args.path as string);
    expect(result).toBe("/tmp");
  });

  it("returns fallback string on parse error", () => {
    const result = defaultCallDisplay("not json", () => "template", "fallback");
    expect(result).toBe("fallback");
  });

  it("returns fallback function result on parse error", () => {
    const result = defaultCallDisplay("not json", () => "template", (input) => `raw: ${input}`);
    expect(result).toBe("raw: not json");
  });

  it("returns raw input on parse error when returnRawOnParseError is true", () => {
    const result = defaultCallDisplay("not json", () => "template", { returnRawOnParseError: true });
    expect(result).toBe("not json");
  });

  it("returns empty string for null input", () => {
    const result = defaultCallDisplay(null, () => "template");
    expect(result).toBe("");
  });

  it("returns empty string for empty string input", () => {
    const result = defaultCallDisplay("", () => "template");
    expect(result).toBe("");
  });
});

describe("formatToolResult", () => {
  let formatToolResult: (
    result: unknown,
    toolName: string,
    success: boolean,
    hint?: string,
  ) => ToolResultPart;

  beforeAll(async () => {
    const mod = await import("@core/extensions/tool-utils.ts");
    formatToolResult = mod.formatToolResult;
  });

  it("delegates to toApiContent for ToolResult instances", () => {
    const part = formatToolResult(ToolResult.ok("hello"), "bash", true);
    expect(part.tool).toBe("bash");
    expect(part.status).toBe("success");
    expect(part.output).toBe("hello");
  });

  it("builds a success part for a plain payload", () => {
    expect(formatToolResult("output", "read", true)).toEqual({
      type: "tool-result",
      tool: "read",
      status: "success",
      meta: [],
      error: null,
      hint: null,
      output: "output",
    });
  });

  it("keeps the thrown-error status spelling on failure", () => {
    // "error" here vs "failure" from ToolResult.toApiContent(): both pre-seam
    // spellings, pinned so the wire bytes don't drift.
    expect(formatToolResult("output", "read", false).status).toBe("error");
  });

  it("stringifies object payloads raw", () => {
    expect(formatToolResult({ key: "val" }, "fetch", true).output).toBe('{"key":"val"}');
  });

  it("leaves markup in the payload for the wire serializer to mangle", () => {
    // No XML escaping at the builder any more: mangling is the wire's job, and
    // a payload escaped here could never be recovered unescaped.
    expect(formatToolResult("a < b", "bash", true).output).toBe("a < b");
  });

  it("carries the thrown-error hint on the part", () => {
    expect(formatToolResult("boom", "bash", false, "use the find tool").hint).toBe("use the find tool");
    expect(formatToolResult("boom", "bash", true).hint).toBeNull();
  });
});

describe("ToolResult.stop()", () => {
  it("creates a result that signals loop stop", () => {
    const r = ToolResult.stop("waiting for input");
    expect(r.success).toBe(true);
    expect(r.output).toBe("waiting for input");
    expect(r[TOOL_STOP_LOOP]).toBe(true);
  });
});

describe("ToolResult.withStopLoop()", () => {
  it("marks an existing result to stop the loop", () => {
    const r = ToolResult.ok("done").withStopLoop();
    expect(r.success).toBe(true);
    expect(r.output).toBe("done");
    expect(r[TOOL_STOP_LOOP]).toBe(true);
  });

  it("is chainable", () => {
    const r = ToolResult.ok("output")
      .withEntry("key", "value")
      .withStopLoop();
    expect(r.metadata!.get("key")).toBe("value");
    expect(r[TOOL_STOP_LOOP]).toBe(true);
  });
});
