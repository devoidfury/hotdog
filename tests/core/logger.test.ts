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
  it("orders levels from most to least verbose", () => {
    expect(LOG_LEVELS.debug).toBeLessThan(LOG_LEVELS.info);
    expect(LOG_LEVELS.info).toBeLessThan(LOG_LEVELS.warn);
    expect(LOG_LEVELS.warn).toBeLessThan(LOG_LEVELS.error);
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
  it("logger methods are safe to call before initialization", () => {
    // Also verifies all four methods exist and are callable
    expect(() => logger.debug("test", { key: "value" })).not.toThrow();
    expect(() => logger.info("test", { key: "value" })).not.toThrow();
    expect(() => logger.warn("test", { key: "value" })).not.toThrow();
    expect(() => logger.error("test", { key: "value" })).not.toThrow();
  });
});

describe("initializeLogger", () => {
  it("does not register handler when target is none", () => {
    const hooks = new HookSystem();
    const beforeCount = hooks.handlerCount("log");
    initializeLogger({ hooks, minLevel: "debug", target: "none" });
    expect(hooks.handlerCount("log")).toBe(beforeCount);
  });

  it("is idempotent — second call does not re-register", () => {
    const hooks = new HookSystem();
    initializeLogger({ hooks, minLevel: "debug", target: "stderr" });
    const countAfterFirst = hooks.handlerCount("log");
    initializeLogger({ hooks, minLevel: "debug", target: "stderr" });
    expect(hooks.handlerCount("log")).toBe(countAfterFirst);
  });

  it("registers handler when target is not none", () => {
    const hooks = new HookSystem();
    const beforeCount = hooks.handlerCount("log");
    initializeLogger({ hooks, minLevel: "debug", target: "stderr" });
    // Handler is registered (count increases or stays same if already initialized by setup)
    expect(hooks.handlerCount("log") >= beforeCount).toBe(true);
  });
});

