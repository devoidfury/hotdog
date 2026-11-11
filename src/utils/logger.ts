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

// Closed target set; mirrors the logTarget enum in core.config.json.
export const LOG_TARGETS: readonly LogTarget[] = ["stderr", "stdout", "none"];

/**
 * env > config > default. `configLevel` is the RAW config-file entry from the
 * early boot peek (hence unknown): out-of-set values ("verbos", 3, ...) fall
 * to the default like unset ones, and logBootConfigWarnings() names them once
 * so the fallback is never silent. null reads as absent, the way every config
 * layer reads null (validateConfig skips nulls too).
 */
export function resolveLogLevel(configLevel?: unknown): LogLevel {
  const envLevel = process.env.HOTDOG_LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVELS) return envLevel as LogLevel;
  if (typeof configLevel === "string" && configLevel in LOG_LEVELS)
    return configLevel as LogLevel;
  return "info";
}

/** Same precedence as resolveLogLevel; same tolerance + named-fallback rule. */
export function resolveLogTarget(configTarget?: unknown): LogTarget {
  const accepted: readonly string[] = LOG_TARGETS;
  const envTarget = process.env.HOTDOG_LOG_TARGET?.toLowerCase();
  if (envTarget && accepted.includes(envTarget)) return envTarget as LogTarget;
  if (typeof configTarget === "string" && accepted.includes(configTarget))
    return configTarget as LogTarget;
  return "stderr";
}

/**
 * One-time boot warnings for raw config-file entries (the shape
 * peekLogBootPosture returns) that resolveLogLevel/resolveLogTarget had to
 * reject: an out-of-set value falls back to the default instead of being
 * silently swallowed, and the line names the offending value and the
 * accepted set. A value only merits a warn when it would have applied --
 * env beats config, so a valid env value makes the config line moot; null
 * reads as absent, matching the resolvers. Call AFTER initializeLogger: a
 * pre-init warn would ride the preload queue anyway, but this keeps the
 * ordering explicit. With logTarget "none" the warn is suppressed by design
 * -- the user asked for silence and no writer is attached -- do not fight
 * it.
 */
export function logBootConfigWarnings(config: {
  logLevel?: unknown;
  logTarget?: unknown;
}): string[] {
  const warns: string[] = [];
  const check = (
    name: string,
    envKey: string,
    raw: unknown,
    accepted: readonly string[],
    def: string,
  ): void => {
    if (raw === undefined || raw === null) return;
    if (typeof raw === "string" && accepted.includes(raw)) return;
    const env = process.env[envKey]?.toLowerCase();
    if (env && accepted.includes(env)) return; // env beats config: the value never applied
    warns.push(
      `Config "${name}" = ${JSON.stringify(raw)} is not one of ${accepted.join(" | ")}; using the default "${def}".`,
    );
  };
  check("logLevel", "HOTDOG_LOG_LEVEL", config.logLevel, Object.keys(LOG_LEVELS), "info");
  check("logTarget", "HOTDOG_LOG_TARGET", config.logTarget, LOG_TARGETS, "stderr");
  return warns;
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
