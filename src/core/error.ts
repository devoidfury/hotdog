// Centralized error handling utilities.
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

/**
 * Base application error with a type tag.
 * All domain error classes extend this.
 */
export class AppError extends Error {
  type: ErrorType;

  constructor(message: string, type: ErrorType = "unknown") {
    super(message);
    this.type = type;
  }
}

// ── Domain-specific error classes ───────────────────────────────────────

/**
 * CLI argument parsing errors.
 */
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

/**
 * Extension lifecycle errors (circular dependencies, registration, shutdown).
 */
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

/**
 * Tool execution errors (file operations, missing arguments, etc.).
 */
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
 * Agent runtime errors (max iterations, summarization failures).
 */
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

/**
 * Configuration loading errors.
 */
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
}

/**
 * Parsing errors (frontmatter, JSON, etc.).
 */
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

/**
 * LLM client errors (HTTP, API, timeout, cancellation, invalid response).
 */
export class LlmError extends AppError {
  constructor(message: string, type: ErrorType = "unknown") {
    super(message, type);
  }

  static Http(msg: string): LlmError {
    return new LlmError(msg, "http");
  }

  static Api(msg: string): LlmError {
    return new LlmError(msg, "api");
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

/**
 * Check if an error is expected (operational) vs unexpected (bug).
 */
export function isExpectedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const type = (err as AppError).type || "";
  if (EXPECTED_ERROR_TYPES.has(type as ErrorType)) return true;

  return false;
}

/**
 * Format an error for user display.
 * Expected errors: message only.
 * Unexpected errors: message + stack for debugging.
 */
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
 * Wrap an operation with context and centralized error handling.
 * Logs unexpected errors with full stack; expected errors get message only.
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
  } catch (err) {
    if (isExpectedError(err)) {
      throw err; // Let callers handle expected errors
    }
    const wrapped = new Error(`[${label}] ${(err as Error).message}`);
    wrapped.stack = `${wrapped.message}\n${(err as Error).stack || "(no stack)"}`;
    throw wrapped;
  }
}
