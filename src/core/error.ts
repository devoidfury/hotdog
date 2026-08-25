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
    return new CliError(`Unknown subcommand: ${arg}`);
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

  constructor(message: string, type: ErrorType = "unknown") {
    super(message, type);
  }

  static Http(msg: string): LlmError {
    return new LlmError(msg, "http");
  }

  static Api(msg: string, status?: number): LlmError {
    const e = new LlmError(msg, "api");
    if (status !== undefined) {
      e.status = status;
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
export const EXPECTED_ERROR_TYPES: ReadonlySet<ErrorType> = new Set([
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

/**
 * Wrap an operation, tagging unexpected errors with the context label.
 * Expected errors pass through unwrapped so callers can classify them.
 *
 * Usage:
 *   await withContext("building agent", async () => {
 *     return await builder.buildAgent(sink);
 *   });
 */
export async function withContext<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (isExpectedError(err)) {
      throw err; // Let callers handle expected errors
    }
    const wrapped = new Error(
      `[${label}] ${err instanceof Error ? err.message : String(err)}`,
    );
    wrapped.stack =
      `${wrapped.message}\n${err instanceof Error ? err.stack || "(no stack)" : "(no stack)"}`;
    throw wrapped;
  }
}
