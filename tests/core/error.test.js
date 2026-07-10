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
} from "../../src/core/error.ts";

describe("Error types", () => {
  const errorClasses = [
    { cls: AppError, type: "app", msg: "test message", args: ["test message", "app"] },
    { cls: CliError, type: "cli", msg: "bad args", args: ["bad args"] },
    { cls: ExtensionError, type: "extension", msg: "load failed", args: ["load failed"] },
    { cls: ToolError, type: "tool", msg: "file not found", args: ["file not found"] },
    { cls: AgentError, type: "agent", msg: "max iterations", args: ["max iterations"] },
    { cls: ConfigError, type: "config", msg: "bad config", args: ["bad config"] },
    { cls: ParseError, type: "parse", msg: "bad yaml", args: ["bad yaml"] },
    { cls: LlmError, type: "llm", msg: "test", args: ["test", "llm"] },
  ];

  for (const { cls, type, msg, args } of errorClasses) {
    describe(cls.name, () => {
      it(`creates error with type "${type}"`, () => {
        const err = new cls(...args);
        expect(err.message).toBe(msg);
        expect(err.type).toBe(type);
        expect(err).toBeInstanceOf(Error);
      });
    });
  }

  it("AppError defaults type to unknown", () => {
    expect(new AppError("test").type).toBe("unknown");
  });

  describe("CliError factories", () => {
    it("MissingValue", () => {
      const err = CliError.MissingValue("--model");
      expect(err.message).toBe("--model requires a value");
      expect(err.type).toBe("cli");
    });

    it("InvalidValue", () => {
      const err = CliError.InvalidValue("--timeout");
      expect(err.message).toBe("--timeout requires a numeric value");
    });

    it("UnknownSubcommand", () => {
      const err = CliError.UnknownSubcommand("foobar");
      expect(err.message).toBe("Unknown subcommand: foobar");
    });
  });

  describe("ExtensionError factories", () => {
    it("CircularDependency", () => {
      const err = ExtensionError.CircularDependency("a, b, c");
      expect(err.message).toContain("Circular dependency detected");
      expect(err.message).toContain("a, b, c");
    });

    it("ConfigFailed", () => {
      const err = ExtensionError.ConfigFailed("my-ext", "missing field");
      expect(err.message).toContain("my-ext");
      expect(err.message).toContain("config registration failed");
    });

    it("ShutdownFailed", () => {
      const err = ExtensionError.ShutdownFailed("my-ext", "timeout");
      expect(err.message).toContain("my-ext");
      expect(err.message).toContain("shutdown failed");
    });
  });

  describe("ToolError factories", () => {
    it("PathNotFound", () => {
      expect(ToolError.PathNotFound("/missing/file").message).toContain("Path not found: /missing/file");
    });

    it("PathOutside", () => {
      const err = ToolError.PathOutside("/etc/passwd", "/workspace");
      expect(err.message).toContain("/etc/passwd");
      expect(err.message).toContain("outside the allowed directory");
    });

    it("NotWritable", () => {
      expect(ToolError.NotWritable("/readonly", "EACCES").message).toContain("not writable");
    });

    it("NotReadable", () => {
      expect(ToolError.NotReadable("/missing").message).toContain("not readable");
    });

    it("MissingArg", () => {
      expect(ToolError.MissingArg("path").message).toBe("Missing required argument: path");
    });

    it("UnknownMode", () => {
      expect(ToolError.UnknownMode("badmode").message).toBe("Unknown mode: badmode");
    });

    it("EndExceedsLines", () => {
      const err = ToolError.EndExceedsLines(100, 50);
      expect(err.message).toContain("100");
      expect(err.message).toContain("50");
    });

    it("NotAvailable", () => {
      expect(ToolError.NotAvailable("mcp-tool").message).toBe("mcp-tool not available");
    });
  });

  describe("AgentError factories", () => {
    it("MaxIterations", () => {
      expect(AgentError.MaxIterations(100).message).toContain("100");
    });

    it("SummarizationFailed", () => {
      expect(AgentError.SummarizationFailed("API error").message).toContain("Summarization failed");
    });

    it("NotImplemented", () => {
      expect(AgentError.NotImplemented().message).toBe("execute() not implemented");
    });
  });

  describe("ConfigError factories", () => {
    it("LoadFailed", () => {
      expect(ConfigError.LoadFailed("/path/to/config", "ENOENT").message).toContain("/path/to/config");
    });

    it("ValidationError", () => {
      const err = ConfigError.ValidationError(["field1: required", "field2: invalid"]);
      expect(err.message).toContain("field1");
      expect(err.message).toContain("field2");
    });
  });

  describe("ParseError factories", () => {
    it("FrontmatterNotFound", () => {
      expect(ParseError.FrontmatterNotFound().message).toContain("No YAML frontmatter found");
    });

    it("MissingDescription", () => {
      expect(ParseError.MissingDescription("skill").message).toContain("skill description is missing");
    });
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

describe("LlmError", () => {
  it("factory methods create typed errors", () => {
    expect(LlmError.Http("fail").type).toBe("http");
    expect(LlmError.Api("bad input").type).toBe("api");
    expect(LlmError.Timeout("timed out").type).toBe("timeout");
    expect(LlmError.Cancelled("cancelled").type).toBe("cancelled");
    expect(LlmError.InvalidResponse("malformed").type).toBe("invalid_response");
  });

  it("isCancelled checks type", () => {
    expect(LlmError.isCancelled(LlmError.Cancelled("x"))).toBe(true);
    expect(LlmError.isCancelled(LlmError.Http("x"))).toBe(false);
    expect(LlmError.isCancelled(new Error("x"))).toBe(false);
  });
});
