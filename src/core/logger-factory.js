// Logger factory — kept for backward compatibility and testing.
// The singleton `logger` export from logger.js is preferred for normal use.

import { LOG_LEVELS } from "./logger.js";

/**
 * Create a standalone logger instance (not the singleton).
 * Useful for testing or when you need a separate logger.
 *
 * @param {Object} options
 * @param {HookSystem} options.hooks — Hook system to emit log events
 * @param {string} [options.minLevel="warn"] — Minimum log level to emit
 * @param {string} [options.target="stderr"] — Output target: stderr, stdout, none
 * @returns {Object} Logger with debug/info/warn/error methods
 */
export function createLogger({ hooks, minLevel = "warn", target = "stderr" }) {
  const minLevelNum = LOG_LEVELS[minLevel] ?? LOG_LEVELS.warn;

  // Register default handler if target is not "none"
  if (target !== "none") {
    const stream = target === "stdout" ? process.stdout : process.stderr;
    hooks.on("log", ({ level, message, metadata }) => {
      if (LOG_LEVELS[level] < minLevelNum) return;
      const ts = new Date().toISOString().slice(11, 19);
      const prefix = `[${level.toUpperCase()}] ${ts}`;
      const line = metadata
        ? `${prefix} ${message} ${JSON.stringify(metadata)}`
        : `${prefix} ${message}`;
      stream.write(line + "\n");
    });
  }

  const emit = (level, message, metadata) => {
    if (LOG_LEVELS[level] < minLevelNum) return;
    hooks.emit("log", { level, message, metadata });
  };

  return {
    debug: (message, metadata) => emit("debug", message, metadata),
    info: (message, metadata) => emit("info", message, metadata),
    warn: (message, metadata) => emit("warn", message, metadata),
    error: (message, metadata) => emit("error", message, metadata),
  };
}
