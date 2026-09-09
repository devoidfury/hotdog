// Logger — centralized, swappable logging via the hook system.
//
// Singleton pattern: import `logger` and use it directly.
// Calls made before `initializeLogger()` are buffered and emitted once initialized.
// Once initialized, emits to the "log" hook. A default handler writes to stderr.
// Alternate implementations register their own "log" hook handler.

// ── Log Level Constants ─────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogTarget = "stderr" | "stdout" | "none";

export interface LogEvent {
  level: LogLevel;
  message: string;
  metadata?: Record<string, unknown>;
}

export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function resolveLogLevel(configLevel?: string): LogLevel {
  const envLevel = process.env.HOTDOG_LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVELS) return envLevel as LogLevel;
  if (configLevel && configLevel in LOG_LEVELS) return configLevel as LogLevel;
  return "info";
}

export function resolveLogTarget(configTarget?: string): LogTarget {
  const envTarget = process.env.HOTDOG_LOG_TARGET?.toLowerCase();
  if (envTarget && ["stderr", "stdout", "none"].includes(envTarget))
    return envTarget as LogTarget;
  if (configTarget && ["stderr", "stdout", "none"].includes(configTarget))
    return configTarget as LogTarget;
  return "stderr";
}

// ── Singleton Logger ────────────────────────────────────────────────────────

interface HookSystem {
  on<H extends string>(hookName: H, handler: (data: unknown) => void | Promise<void> | unknown, source?: string): () => void;
  notifyHooks<H extends string>(hookName: H, data: unknown): void;
}

let _hooks: HookSystem | null = null;

let _minLevelNum: number = LOG_LEVELS.warn;

let _initialized: boolean = false;

/** queue for messages emitted before initialization */
let _preloadQueue: [LogLevel, string, Record<string, unknown> | undefined][] =
  [];

export interface InitializeLoggerOptions {
  hooks: HookSystem;
  minLevel?: LogLevel;
  target?: LogTarget;
}

/**
 * Reset the logger singleton state. Use only in tests to avoid cross-test pollution.
 */
export function resetLoggerForTesting(): void {
  _hooks = null;
  _minLevelNum = LOG_LEVELS.warn;
  _initialized = false;
  _preloadQueue = [];
}

/**
 * Initialize the singleton logger.
 * Must be called once during bootstrap.
 */
export function initializeLogger({
  hooks,
  minLevel = "warn",
  target = "stderr",
}: InitializeLoggerOptions): void {
  if (_initialized) return;
  _hooks = hooks;
  _minLevelNum = LOG_LEVELS[minLevel] ?? LOG_LEVELS.warn;
  _initialized = true;

  if (target !== "none") {
    const stream = target === "stdout" ? process.stdout : process.stderr;
    hooks.on("log", (data) => {
      const { level, message, metadata } = data as LogEvent;
      if (LOG_LEVELS[level] < _minLevelNum) return;
      const ts = new Date().toISOString().slice(11, 19);
      const prefix = `[${level.toUpperCase()}] ${ts}`;
      const line = metadata
        ? `${prefix} ${message} ${JSON.stringify(metadata)}`
        : `${prefix} ${message}`;
      stream.write(line + "\n");
    });
  }

  for (const msg of _preloadQueue) {
    _emit(...msg);
  }
  _preloadQueue = [];
}

function _emit(
  level: LogLevel,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  if (!_initialized) {
    // prevent unbounded growth
    if (_preloadQueue.length < 2000) {
      _preloadQueue.push([level, message, metadata]);
    }
    return;
  }
  if (LOG_LEVELS[level] < _minLevelNum) return;
  if (_hooks) {
    _hooks.notifyHooks("log", { level, message, metadata });
  }
}

export interface Logger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export const logger: Logger = {
  debug: (message, metadata) => _emit("debug", message, metadata),
  info: (message, metadata) => _emit("info", message, metadata),
  warn: (message, metadata) => _emit("warn", message, metadata),
  error: (message, metadata) => _emit("error", message, metadata),
};
