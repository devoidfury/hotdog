// Logger — centralized, swappable logging via the hook system.
//
// Singleton pattern: import `logger` and use it directly.
// Calls made before `initializeLogger()` are buffered and emitted once initialized.
// Once initialized, emits to the "log" hook. A default handler writes to stderr.
// Alternate implementations register their own "log" hook handler.
//
// Usage:
//   import { logger } from "./core/logger.js";
//   logger.debug("Starting session", { sessionId: "abc123" });
//   logger.info("Connected to provider");
//   logger.warn("Skill description exceeds 1024 chars");
//   logger.error("Failed to connect to MCP server", { server: "my-server" });

// ── Log Level Constants ─────────────────────────────────────────────────────

/**
 * Log levels with numeric ordering for comparison.
 */
export const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Resolve a log level from env var or default.
 * Env var OA_LOG_LEVEL takes precedence.
 *
 * @param {string} [configLevel] - Level from config (fallback)
 * @returns {string} Resolved level name
 */
export function resolveLogLevel(configLevel) {
  const envLevel = process.env.OA_LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVELS) return envLevel;
  if (configLevel && configLevel in LOG_LEVELS) return configLevel;
  return "warn";
}

/**
 * Resolve log output target from env var or default.
 * Env var OA_LOG_TARGET takes precedence.
 *
 * @param {string} [configTarget] - Target from config (fallback)
 * @returns {string} Resolved target ("stderr", "stdout", or "none")
 */
export function resolveLogTarget(configTarget) {
  const envTarget = process.env.OA_LOG_TARGET?.toLowerCase();
  if (envTarget && ["stderr", "stdout", "none"].includes(envTarget)) return envTarget;
  if (configTarget && ["stderr", "stdout", "none"].includes(configTarget)) return configTarget;
  return "stderr";
}

// ── Singleton Logger ────────────────────────────────────────────────────────

/** @type {HookSystem | null} */
let _hooks = null;

/** @type {number} */
let _minLevelNum = LOG_LEVELS.warn;

/** @type {boolean} */
let _initialized = false;

/** queue for messages emitted before initialization */
let _preloadQueue = [];

/**
 * Initialize the singleton logger.
 * Must be called once during bootstrap.
 *
 * @param {Object} options
 * @param {HookSystem} options.hooks — Hook system to emit log events
 * @param {string} [options.minLevel="warn"] — Minimum log level to emit
 * @param {string} [options.target="stderr"] — Output target: stderr, stdout, none
 */
export function initializeLogger({ hooks, minLevel = "warn", target = "stderr" }) {
  if (_initialized) return; // Already initialized
  _hooks = hooks;
  _minLevelNum = LOG_LEVELS[minLevel] ?? LOG_LEVELS.warn;
  _initialized = true;

  // Register default handler if target is not "none"
  if (target !== "none") {
    const stream = target === "stdout" ? process.stdout : process.stderr;
    hooks.on("log", ({ level, message, metadata }) => {
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

/**
 * Internal emit — checks initialization and level before emitting to hooks.
 */
function _emit(level, message, metadata) {
  if (!_initialized) {
    if (_preloadQueue.length < 2000) {  // prevent unbounded growth
      _preloadQueue.push([level, message, metadata]);
    }
    return;
  }
  if (LOG_LEVELS[level] < _minLevelNum) return;
  if (_hooks) {
    _hooks.emit("log", { level, message, metadata });
  }
}

/**
 * Singleton logger instance.
 * Safe to import and use from any module. Calls before initialization are buffered and emitted once initialized.
 */
export const logger = {
  debug: (message, metadata) => _emit("debug", message, metadata),
  info: (message, metadata) => _emit("info", message, metadata),
  warn: (message, metadata) => _emit("warn", message, metadata),
  error: (message, metadata) => _emit("error", message, metadata),
};

// Keep createLogger for backward compatibility / testing
export { createLogger } from "./logger-factory.js";
