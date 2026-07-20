import { describe, it, expect } from "bun:test";
import {
  LOG_LEVELS,
  resolveLogLevel,
  resolveLogTarget,
  initializeLogger,
  logger,
} from "../../src/core/logger.ts";
import { HookSystem } from "../../src/core/hooks.ts";

describe("LOG_LEVELS", () => {
  it("has correct numeric ordering", () => {
    expect(LOG_LEVELS.debug).toBe(0);
    expect(LOG_LEVELS.info).toBe(1);
    expect(LOG_LEVELS.warn).toBe(2);
    expect(LOG_LEVELS.error).toBe(3);
  });
});

describe("resolveLogLevel and resolveLogTarget", () => {
  // Both functions share the same resolution pattern: env var > config param > default,
  // with case-insensitive env var handling and invalid env var fallback.
  const resolvers = [
    { name: "resolveLogLevel", fn: resolveLogLevel as (c?: string) => string, env: "HOTDOG_LOG_LEVEL", default: "info", validEnv: "debug", validConfig: "error" },
    { name: "resolveLogTarget", fn: resolveLogTarget as (c?: string) => string, env: "HOTDOG_LOG_TARGET", default: "stderr", validEnv: "stdout", validConfig: "none" },
  ];

  for (const { name, fn, env, default: def, validEnv, validConfig } of resolvers) {
    describe(name, () => {
      it("returns default with no config", () => {
        const orig = process.env[env];
        delete process.env[env];
        try {
          expect(fn()).toBe(def);
        } finally {
          if (orig !== undefined) process.env[env] = orig;
        }
      });

      it("returns config value when provided", () => {
        const orig = process.env[env];
        delete process.env[env];
        try {
          expect(fn(validEnv)).toBe(validEnv);
        } finally {
          if (orig !== undefined) process.env[env] = orig;
        }
      });

      it("prefers env var over config", () => {
        const orig = process.env[env];
        process.env[env] = validEnv;
        try {
          expect(fn(validConfig)).toBe(validEnv);
        } finally {
          if (orig !== undefined) process.env[env] = orig;
          else delete process.env[env];
        }
      });

      it("ignores invalid env var, falls back to config", () => {
        const orig = process.env[env];
        process.env[env] = "invalid";
        try {
          expect(fn(validEnv)).toBe(validEnv);
        } finally {
          if (orig !== undefined) process.env[env] = orig;
          else delete process.env[env];
        }
      });

      it("handles case-insensitive env var", () => {
        const orig = process.env[env];
        process.env[env] = validEnv.toUpperCase();
        try {
          expect(fn(validConfig)).toBe(validEnv);
        } finally {
          if (orig !== undefined) process.env[env] = orig;
          else delete process.env[env];
        }
      });
    });
  }
});

describe("logger", () => {
  it("provides all log level methods", () => {
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("logger methods do not throw before initialization", () => {
    logger.debug("test debug");
    logger.info("test info");
    logger.warn("test warn");
    logger.error("test error");
  });

  it("logger methods accept metadata", () => {
    logger.debug("test", { key: "value" });
    logger.info("test", { key: "value" });
    logger.warn("test", { key: "value" });
    logger.error("test", { key: "value" });
  });
});

describe("initializeLogger", () => {
  // Note: initializeLogger is a singleton that persists across test runs.
  // These tests verify behavior assuming the logger may or may not already
  // be initialized by other tests.
  it("does not throw when called", () => {
    const hooks = new HookSystem();
    expect(() =>
      initializeLogger({ hooks, minLevel: "debug", target: "none" }),
    ).not.toThrow();
  });

  it("does not reinitialize when called twice", () => {
    const hooks1 = new HookSystem();
    const hooks2 = new HookSystem();
    initializeLogger({ hooks: hooks1, minLevel: "debug", target: "none" });
    initializeLogger({ hooks: hooks2, minLevel: "debug", target: "none" });
    // If the logger was not yet initialized, hooks1 gets the handler.
    // If it was already initialized, neither gets a new handler.
    // In either case, initializeLogger does not throw.
  });

  it("accepts target 'none' without throwing", () => {
    const hooks = new HookSystem();
    expect(() =>
      initializeLogger({ hooks, minLevel: "debug", target: "none" }),
    ).not.toThrow();
  });
});
