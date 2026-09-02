import { describe, it, expect } from "bun:test";
import {
  AppError,
  CliError,
  ExtensionError,
  ToolError,
  AssistantRetryableError,
  TransientError,
  AgentError,
  ConfigError,
  ParseError,
  LlmError,

  isExpectedError,
  formatError,
} from "../../src/core/error.ts";

describe("Error types", () => {
  const errorClasses = [
    {
      cls: AppError,
      type: "app",
      msg: "test message",
      args: ["test message", "app"],
    },
    { cls: CliError, type: "cli", msg: "bad args", args: ["bad args"] },
    {
      cls: ExtensionError,
      type: "extension",
      msg: "load failed",
      args: ["load failed"],
    },
    {
      cls: ToolError,
      type: "tool",
      msg: "file not found",
      args: ["file not found"],
    },
    {
      cls: AgentError,
      type: "agent",
      msg: "max iterations",
      args: ["max iterations"],
    },
    {
      cls: ConfigError,
      type: "config",
      msg: "bad config",
      args: ["bad config"],
    },
    { cls: ParseError, type: "parse", msg: "bad yaml", args: ["bad yaml"] },
    { cls: LlmError, type: "llm", msg: "test", args: ["test", "llm"] },
  ];

  for (const { cls, type, msg, args } of errorClasses) {
    describe(cls.name, () => {
      it(`creates error with type "${type}"`, () => {
        const err = new (cls as new (...a: string[]) => AppError)(...(args as string[]));
        expect(err.message).toBe(msg);
        expect(err.type).toBe(type as any);
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
      expect(err.subcommand).toBe("foobar");
    });

    it("UnknownFlag with suggestions", () => {
      const err = CliError.UnknownFlag("--modl", ["--model"]);
      expect(err.message).toContain("Unknown flag: --modl");
      expect(err.message).toContain("Did you mean: --model?");
      expect(err.flag).toBe("--modl");
      expect(err.type).toBe("cli");
    });

    it("UnknownFlag without suggestions points to --help", () => {
      const err = CliError.UnknownFlag("--zzzzz");
      expect(err.message).toContain("Unknown flag: --zzzzz");
      expect(err.message).toContain("--help");
      expect(err.flag).toBe("--zzzzz");
    });
  });

  describe("ExtensionError factories", () => {
    it("CircularDependency", () => {
      const err = ExtensionError.CircularDependency(["a", "b", "c"]);
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
      expect(ToolError.PathNotFound("/missing/file").message).toContain(
        "Path not found: /missing/file",
      );
    });

    it("PathOutside", () => {
      const err = ToolError.PathOutside("/etc/passwd", "/workspace");
      expect(err.message).toContain("/etc/passwd");
      expect(err.message).toContain("outside the allowed directory");
    });

    it("NotWritable", () => {
      expect(ToolError.NotWritable("/readonly", "EACCES").message).toContain(
        "not writable",
      );
    });

    it("NotReadable", () => {
      expect(ToolError.NotReadable("/missing").message).toContain(
        "not readable",
      );
    });

    it("MissingArg", () => {
      expect(ToolError.MissingArg("path").message).toBe(
        "Missing required argument: path",
      );
    });

    it("UnknownMode", () => {
      expect(ToolError.UnknownMode("badmode").message).toBe(
        "Unknown mode: badmode",
      );
    });

    it("EndExceedsLines", () => {
      const err = ToolError.EndExceedsLines(100, 50);
      expect(err.message).toContain("100");
      expect(err.message).toContain("50");
    });

    it("NotAvailable", () => {
      expect(ToolError.NotAvailable("mcp-tool").message).toBe(
        "mcp-tool not available",
      );
    });
  });

  describe("AssistantRetryableError", () => {
    it("creates error with message and optional hint", () => {
      const err = new AssistantRetryableError("bad input", "use --flag instead");
      expect(err.message).toBe("bad input");
      expect(err.hint).toBe("use --flag instead");
      expect(err.type).toBe("tool");
    });

    it("WithHint creates error with hint", () => {
      const err = AssistantRetryableError.WithHint("invalid format", "expected JSON");
      expect(err.message).toBe("invalid format");
      expect(err.hint).toBe("expected JSON");
      expect(err).toBeInstanceOf(AssistantRetryableError);
    });
  });

  describe("TransientError", () => {
    it("creates error for transient failures", () => {
      const err = new TransientError("connection timeout");
      expect(err.message).toBe("connection timeout");
      expect(err.type).toBe("tool");
      expect(err).toBeInstanceOf(ToolError);
    });
  });

  describe("AgentError factories", () => {
    it("MaxIterations", () => {
      expect(AgentError.MaxIterations(100).message).toContain("100");
    });

    it("SummarizationFailed", () => {
      expect(AgentError.SummarizationFailed("API error").message).toContain(
        "Summarization failed",
      );
    });

    it("NotImplemented", () => {
      expect(AgentError.NotImplemented().message).toBe(
        "execute() not implemented",
      );
    });
  });

  describe("ConfigError factories", () => {
    it("LoadFailed", () => {
      expect(
        ConfigError.LoadFailed("/path/to/config", "ENOENT").message,
      ).toContain("/path/to/config");
    });

    it("ValidationError", () => {
      const err = ConfigError.ValidationError([
        "field1: required",
        "field2: invalid",
      ]);
      expect(err.message).toContain("field1");
      expect(err.message).toContain("field2");
    });
  });

  describe("ParseError factories", () => {
    it("FrontmatterNotFound", () => {
      expect(ParseError.FrontmatterNotFound().message).toContain(
        "No YAML frontmatter found",
      );
    });

    it("MissingDescription", () => {
      expect(ParseError.MissingDescription("skill").message).toContain(
        "skill description is missing",
      );
    });
  });
});


describe("isExpectedError", () => {
  it("returns true for expected error types", () => {
    const err = new LlmError("timeout", "timeout");
    expect(isExpectedError(err)).toBe(true);
  });

  it("returns false for unexpected error types", () => {
    const err = new Error("bug") as Error & { type: string };
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
    const err = new Error("") as Error & { type: string };
    err.type = "http";
    // formatError uses err.message || String(err) — empty string falls through
    expect(formatError(err)).toBe("Error");
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

  it("Api carries the HTTP status when provided", () => {
    expect(LlmError.Api("HTTP 500", 500).status).toBe(500);
    expect(LlmError.Api("bad input").status).toBeUndefined();
  });
});
