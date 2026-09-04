//
// Provides proper error classes across the codebase so that call sites
// can identify error types by instanceof / .type instead of parsing
// error message strings.
//
// Distinguishes expected errors (cancellations, API failures, CLI mistakes)
// from unexpected errors (bugs, iteration errors, null derefs) so that
// the latter always include a stack trace and context.

export type ErrorType =
  | "unknown"
  | "cancelled"
  | "http"
  | "api"
  | "timeout"
  | "invalid_response"
  | "cli"
  | "tool"
  | "config"
  | "agent"
  | "extension"
  | "parse";

export class AppError extends Error {
  type: ErrorType;

  constructor(message: string, type: ErrorType = "unknown") {
    super(message);
    this.type = type;
  }
}

// ── Domain-specific error classes ───────────────────────────────────────

export class CliError extends AppError {
  /** Set by UnknownSubcommand/UnknownFlag: the offending positional/flag text. */
  subcommand?: string;
  flag?: string;

  constructor(message: string) {
    super(message, "cli");
  }

  static MissingValue(arg: string): CliError {
    return new CliError(`${arg} requires a value`);
  }

  static InvalidValue(arg: string): CliError {
    return new CliError(`${arg} requires a numeric value`);
  }

  static UnknownSubcommand(arg: string): CliError {
    const err = new CliError(`Unknown subcommand: ${arg}`);
    err.subcommand = arg;
    return err;
  }

  /**
   * Unknown flags are fatal (a silently-dropped flag means the run proceeds
   * with wrong config). `suggestions` holds close registered-flag names so a
   * typo self-corrects without a --help round trip.
   */
  static UnknownFlag(arg: string, suggestions?: string[]): CliError {
    const err = new CliError(
      suggestions && suggestions.length > 0
        ? `Unknown flag: ${arg}\nDid you mean: ${suggestions.join(", ")}?`
        : `Unknown flag: ${arg}\nRun hotdog --help to see available flags.`,
    );
    err.flag = arg;
    return err;
  }
}

export class ExtensionError extends AppError {
  constructor(message: string) {
    super(message, "extension");
  }

  static CircularDependency(names: string[]): ExtensionError {
    return new ExtensionError(
      `Circular dependency detected among extensions: ${names.join(", ")}`,
    );
  }

  static ConfigFailed(name: string, msg: string): ExtensionError {
    return new ExtensionError(
      `Extension '${name}' config registration failed: ${msg}`,
    );
  }

  static ShutdownFailed(name: string, msg: string): ExtensionError {
    return new ExtensionError(`Extension '${name}' shutdown failed: ${msg}`);
  }
}

export class ToolError extends AppError {
  constructor(message: string) {
    super(message, "tool");
  }

  static PathNotFound(requested: string): ToolError {
    return new ToolError(`Path not found: ${requested}`);
  }

  static PathOutside(requested: string, boundary: string): ToolError {
    return new ToolError(
      `Path '${requested}' is outside the allowed directory '${boundary}'. ` +
        "File operations are restricted to the boundary directory.",
    );
  }

  static NotWritable(dir: string, msg: string): ToolError {
    return new ToolError(`Directory '${dir}' is not writable: ${msg}`);
  }

  static NotReadable(filePath: string): ToolError {
    return new ToolError(
      `Path '${filePath}' does not exist or is not readable`,
    );
  }

  static MissingArg(key: string): ToolError {
    return new ToolError(`Missing required argument: ${key}`);
  }

  static UnknownMode(mode: string): ToolError {
    return new ToolError(`Unknown mode: ${mode}`);
  }

  static EndExceedsLines(end: number, total: number): ToolError {
    return new ToolError(
      `end_line (${end}) exceeds file length (${total} lines)`,
    );
  }

  static NotAvailable(name: string): ToolError {
    return new ToolError(`${name} not available`);
  }
}

/**
 * Error that signals the LLM assistant should retry the tool call with modified input.
 * Includes a hint to guide the correction.
 */
export class AssistantRetryableError extends ToolError {
  constructor(message: string, public hint?: string) {
    super(message);
  }

  static WithHint(message: string, hint: string): AssistantRetryableError {
    return new AssistantRetryableError(message, hint);
  }
}

/**
 * Error that signals a transient failure (e.g., network timeout) that may
 * resolve upon immediate retry.
 */
export class TransientError extends ToolError {
  constructor(message: string) {
    super(message);
  }
}

export class AgentError extends AppError {
  constructor(message: string) {
    super(message, "agent");
  }

  static MaxIterations(max: number): AgentError {
    return new AgentError(`Max iterations (${max}) reached`);
  }

  static SummarizationFailed(msg: string): AgentError {
    return new AgentError(`Summarization failed: ${msg}`);
  }

  static NotImplemented(): AgentError {
    return new AgentError("execute() not implemented");
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, "config");
  }

  static LoadFailed(path: string, msg: string): ConfigError {
    return new ConfigError(`Error loading config from ${path}: ${msg}`);
  }

  static ValidationError(errors: string[]): ConfigError {
    return new ConfigError(
      `Configuration validation failed: ${errors.join("; ")}`,
    );
  }

  static MissingConfig(name: string): ConfigError {
    return new ConfigError(`Missing required configuration: '${name}'`);
  }
}

export class ParseError extends AppError {
  constructor(message: string) {
    super(message, "parse");
  }

  static FrontmatterNotFound(): ParseError {
    return new ParseError("No YAML frontmatter found");
  }

  static MissingDescription(label: string): ParseError {
    return new ParseError(
      `${label} description is missing or empty (required)`,
    );
  }
}

export class LlmError extends AppError {
  /** HTTP status when the error originated from an HTTP response (type "api"). */
  status?: number;
  /**
   * Server-provided Retry-After hint in ms (type "api"), already parsed and
   * capped (see parseRetryAfterMs). Retry scheduling prefers this over the
   * exponential backoff when present.
   */
  retryAfterMs?: number;

  constructor(message: string, type: ErrorType = "unknown") {
    super(message, type);
  }

  static Http(msg: string): LlmError {
    return new LlmError(msg, "http");
  }

  static Api(msg: string, status?: number, retryAfterMs?: number): LlmError {
    const e = new LlmError(msg, "api");
    if (status !== undefined) {
      e.status = status;
    }
    if (retryAfterMs !== undefined) {
      e.retryAfterMs = retryAfterMs;
    }
    return e;
  }

  static Timeout(msg: string): LlmError {
    return new LlmError(msg, "timeout");
  }

  static Cancelled(msg: string): LlmError {
    return new LlmError(msg, "cancelled");
  }

  static InvalidResponse(msg: string): LlmError {
    return new LlmError(msg, "invalid_response");
  }

  static isCancelled(err: unknown): err is LlmError {
    return err instanceof LlmError && err.type === "cancelled";
  }
}

/**
 * Expected error types that should NOT include a stack trace.
 * These are user-facing or operational errors where the message is sufficient.
 */
const EXPECTED_ERROR_TYPES: ReadonlySet<ErrorType> = new Set([
  "cancelled",
  "http",
  "api",
  "timeout",
  "invalid_response",
  "cli",
  "tool",
  "config",
]);

export function isExpectedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const type = (err as AppError).type || "";
  if (EXPECTED_ERROR_TYPES.has(type as ErrorType)) return true;

  return false;
}

export function formatError(err: unknown): string {
  if (err == null) {
    return String(err);
  }
  if (!(err instanceof Error)) {
    return String(err);
  }
  if (!isExpectedError(err)) {
    return `${err.message}\n${err.stack || "(no stack)"}`;
  }
  return err.message || String(err);
}
