import { describe, it, expect } from "bun:test";
import {
  AppError,
  CliError,
  ExtensionError,
  ToolError,
  AgentError,
  ConfigError,
  ParseError,
  LlmError,
  EXPECTED_ERROR_TYPES,
  isExpectedError,
  formatError,
  withContext,
} from "../../src/core/error.js";

describe("AppError", () => {
  it("creates error with type", () => {
    const err = new AppError("test message", "my_type");
    expect(err.message).toBe("test message");
    expect(err.type).toBe("my_type");
    expect(err).toBeInstanceOf(Error);
  });

  it("defaults type to unknown", () => {
    const err = new AppError("test");
    expect(err.type).toBe("unknown");
  });
});

describe("CliError", () => {
  it("creates CLI error with type", () => {
    const err = new CliError("bad args");
    expect(err.type).toBe("cli");
  });

  it("MissingValue factory", () => {
    const err = CliError.MissingValue("--model");
    expect(err.message).toBe("--model requires a value");
    expect(err.type).toBe("cli");
  });

  it("InvalidValue factory", () => {
    const err = CliError.InvalidValue("--timeout");
    expect(err.message).toBe("--timeout requires a numeric value");
  });

  it("UnknownSubcommand factory", () => {
    const err = CliError.UnknownSubcommand("foobar");
    expect(err.message).toBe("Unknown subcommand: foobar");
  });
});

describe("ExtensionError", () => {
  it("creates extension error with type", () => {
    const err = new ExtensionError("load failed");
    expect(err.type).toBe("extension");
  });

  it("CircularDependency factory", () => {
    const err = ExtensionError.CircularDependency("a, b, c");
    expect(err.message).toContain("Circular dependency detected");
    expect(err.message).toContain("a, b, c");
  });

  it("ConfigFailed factory", () => {
    const err = ExtensionError.ConfigFailed("my-ext", "missing field");
    expect(err.message).toContain("my-ext");
    expect(err.message).toContain("config registration failed");
  });

  it("ShutdownFailed factory", () => {
    const err = ExtensionError.ShutdownFailed("my-ext", "timeout");
    expect(err.message).toContain("my-ext");
    expect(err.message).toContain("shutdown failed");
  });
});

describe("ToolError", () => {
  it("creates tool error with type", () => {
    const err = new ToolError("file not found");
    expect(err.type).toBe("tool");
  });

  it("PathNotFound factory", () => {
    const err = ToolError.PathNotFound("/missing/file");
    expect(err.message).toContain("Path not found: /missing/file");
  });

  it("PathOutside factory", () => {
    const err = ToolError.PathOutside("/etc/passwd", "/workspace");
    expect(err.message).toContain("/etc/passwd");
    expect(err.message).toContain("/workspace");
    expect(err.message).toContain("outside the allowed directory");
  });

  it("NotWritable factory", () => {
    const err = ToolError.NotWritable("/readonly", "EACCES");
    expect(err.message).toContain("/readonly");
    expect(err.message).toContain("not writable");
  });

  it("NotReadable factory", () => {
    const err = ToolError.NotReadable("/missing");
    expect(err.message).toContain("not readable");
  });

  it("MissingArg factory", () => {
    const err = ToolError.MissingArg("path");
    expect(err.message).toBe("Missing required argument: path");
  });

  it("UnknownMode factory", () => {
    const err = ToolError.UnknownMode("badmode");
    expect(err.message).toBe("Unknown mode: badmode");
  });

  it("EndExceedsLines factory", () => {
    const err = ToolError.EndExceedsLines(100, 50);
    expect(err.message).toContain("100");
    expect(err.message).toContain("50");
  });

  it("NotAvailable factory", () => {
    const err = ToolError.NotAvailable("mcp-tool");
    expect(err.message).toBe("mcp-tool not available");
  });
});

describe("AgentError", () => {
  it("creates agent error with type", () => {
    const err = new AgentError("max iterations");
    expect(err.type).toBe("agent");
  });

  it("MaxIterations factory", () => {
    const err = AgentError.MaxIterations(100);
    expect(err.message).toContain("100");
  });

  it("SummarizationFailed factory", () => {
    const err = AgentError.SummarizationFailed("API error");
    expect(err.message).toContain("Summarization failed");
  });

  it("NotImplemented factory", () => {
    const err = AgentError.NotImplemented();
    expect(err.message).toBe("execute() not implemented");
  });
});

describe("ConfigError", () => {
  it("creates config error with type", () => {
    const err = new ConfigError("bad config");
    expect(err.type).toBe("config");
  });

  it("LoadFailed factory", () => {
    const err = ConfigError.LoadFailed("/path/to/config", "ENOENT");
    expect(err.message).toContain("/path/to/config");
  });

  it("ValidationError factory", () => {
    const err = ConfigError.ValidationError(["field1: required", "field2: invalid"]);
    expect(err.message).toContain("field1");
    expect(err.message).toContain("field2");
  });
});

describe("ParseError", () => {
  it("creates parse error with type", () => {
    const err = new ParseError("bad yaml");
    expect(err.type).toBe("parse");
  });

  it("FrontmatterNotFound factory", () => {
    const err = ParseError.FrontmatterNotFound();
    expect(err.message).toContain("No YAML frontmatter found");
  });

  it("MissingDescription factory", () => {
    const err = ParseError.MissingDescription("skill");
    expect(err.message).toContain("skill description is missing");
  });
});

describe("EXPECTED_ERROR_TYPES", () => {
  it("contains expected error types", () => {
    expect(EXPECTED_ERROR_TYPES.has("cancelled")).toBe(true);
    expect(EXPECTED_ERROR_TYPES.has("http")).toBe(true);
    expect(EXPECTED_ERROR_TYPES.has("api")).toBe(true);
    expect(EXPECTED_ERROR_TYPES.has("timeout")).toBe(true);
    expect(EXPECTED_ERROR_TYPES.has("cli")).toBe(true);
    expect(EXPECTED_ERROR_TYPES.has("tool")).toBe(true);
    expect(EXPECTED_ERROR_TYPES.has("config")).toBe(true);
  });

  it("does not contain unexpected error types", () => {
    expect(EXPECTED_ERROR_TYPES.has("agent")).toBe(false);
    expect(EXPECTED_ERROR_TYPES.has("unknown")).toBe(false);
  });
});

describe("isExpectedError", () => {
  it("returns true for expected error types", () => {
    const err = new LlmError("timeout", "timeout");
    expect(isExpectedError(err)).toBe(true);
  });

  it("returns false for unexpected error types", () => {
    const err = new Error("bug");
    err.type = "agent";
    expect(isExpectedError(err)).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isExpectedError("string")).toBe(false);
    expect(isExpectedError(null)).toBe(false);
    expect(isExpectedError(42)).toBe(false);
  });

  it("returns false for Error without type", () => {
    expect(isExpectedError(new Error("no type"))).toBe(false);
  });
});

describe("formatError", () => {
  it("formats null", () => {
    expect(formatError(null)).toBe("null");
  });

  it("formats non-Error value", () => {
    expect(formatError("just a string")).toBe("just a string");
    expect(formatError(42)).toBe("42");
  });

  it("formats expected error without stack", () => {
    const err = LlmError.Timeout("timed out");
    const formatted = formatError(err);
    expect(formatted).toBe("timed out");
    expect(formatted).not.toContain("stack");
  });

  it("formats unexpected error with stack", () => {
    const err = new Error("something broke");
    const formatted = formatError(err);
    expect(formatted).toContain("something broke");
    expect(formatted).toContain("at ");
  });

  it("formats error with empty message using String(err)", () => {
    const err = new Error("");
    err.type = "http";
    // formatError uses err.message || String(err) — empty string falls through
    expect(formatError(err)).toBe("Error");
  });
});

describe("withContext", () => {
  it("returns the result of a successful async function", async () => {
    const result = await withContext("test label", async () => "success");
    expect(result).toBe("success");
  });

  it("re-throws expected errors as-is", async () => {
    const err = new Error("api failure");
    err.type = "api";
    await expect(
      withContext("test label", async () => { throw err; }),
    ).rejects.toBe(err);
  });

  it("wraps unexpected errors with context label", async () => {
    try {
      await withContext("building agent", async () => {
        throw new Error("null reference");
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e.message).toContain("[building agent]");
      expect(e.message).toContain("null reference");
      expect(e.stack).toContain("null reference");
    }
  });

  it("wraps unexpected errors preserving stack trace", async () => {
    try {
      await withContext("processing", async () => {
        const obj = null;
        obj.foo; // TypeError
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e.message).toContain("[processing]");
      expect(e.stack).toContain("at "); // stack preserved
    }
  });

  it("handles sync functions", async () => {
    const result = await withContext("sync test", () => "sync result");
    expect(result).toBe("sync result");
  });
});
