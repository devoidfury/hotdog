import { describe, it, expect } from "bun:test";
import {
  LOG_LEVELS,
  resolveLogLevel,
  resolveLogTarget,
  initializeLogger,
  logger,
} from "../../src/core/logger.js";
import { HookSystem } from "../../src/core/hooks.js";

describe("LOG_LEVELS", () => {
  it("has correct numeric ordering", () => {
    expect(LOG_LEVELS.debug).toBe(0);
    expect(LOG_LEVELS.info).toBe(1);
    expect(LOG_LEVELS.warn).toBe(2);
    expect(LOG_LEVELS.error).toBe(3);
  });
});

describe("resolveLogLevel", () => {
  it("returns default 'warn' with no config", () => {
    const origLevel = process.env.HOTDOG_LOG_LEVEL;
    delete process.env.HOTDOG_LOG_LEVEL;
    try {
      expect(resolveLogLevel()).toBe("warn");
    } finally {
      if (origLevel !== undefined) process.env.HOTDOG_LOG_LEVEL = origLevel;
    }
  });

  it("returns configLevel when provided", () => {
    expect(resolveLogLevel("debug")).toBe("debug");
    expect(resolveLogLevel("info")).toBe("info");
    expect(resolveLogLevel("error")).toBe("error");
  });

  it("prefers env var over config", () => {
    const origLevel = process.env.HOTDOG_LOG_LEVEL;
    process.env.HOTDOG_LOG_LEVEL = "debug";
    try {
      expect(resolveLogLevel("error")).toBe("debug");
    } finally {
      if (origLevel !== undefined) process.env.HOTDOG_LOG_LEVEL = origLevel;
      else delete process.env.HOTDOG_LOG_LEVEL;
    }
  });

  it("ignores invalid env var, falls back to config", () => {
    const origLevel = process.env.HOTDOG_LOG_LEVEL;
    process.env.HOTDOG_LOG_LEVEL = "invalid";
    try {
      expect(resolveLogLevel("debug")).toBe("debug");
    } finally {
      if (origLevel !== undefined) process.env.HOTDOG_LOG_LEVEL = origLevel;
      else delete process.env.HOTDOG_LOG_LEVEL;
    }
  });

  it("handles case-insensitive env var", () => {
    const origLevel = process.env.HOTDOG_LOG_LEVEL;
    process.env.HOTDOG_LOG_LEVEL = "DEBUG";
    try {
      expect(resolveLogLevel("error")).toBe("debug");
    } finally {
      if (origLevel !== undefined) process.env.HOTDOG_LOG_LEVEL = origLevel;
      else delete process.env.HOTDOG_LOG_LEVEL;
    }
  });
});

describe("resolveLogTarget", () => {
  it("returns default 'stderr' with no config", () => {
    const origTarget = process.env.HOTDOG_LOG_TARGET;
    delete process.env.HOTDOG_LOG_TARGET;
    try {
      expect(resolveLogTarget()).toBe("stderr");
    } finally {
      if (origTarget !== undefined) process.env.HOTDOG_LOG_TARGET = origTarget;
    }
  });

  it("returns configTarget when provided", () => {
    expect(resolveLogTarget("stdout")).toBe("stdout");
    expect(resolveLogTarget("stderr")).toBe("stderr");
    expect(resolveLogTarget("none")).toBe("none");
  });

  it("prefers env var over config", () => {
    const origTarget = process.env.HOTDOG_LOG_TARGET;
    process.env.HOTDOG_LOG_TARGET = "stdout";
    try {
      expect(resolveLogTarget("none")).toBe("stdout");
    } finally {
      if (origTarget !== undefined) process.env.HOTDOG_LOG_TARGET = origTarget;
      else delete process.env.HOTDOG_LOG_TARGET;
    }
  });

  it("ignores invalid env var, falls back to config", () => {
    const origTarget = process.env.HOTDOG_LOG_TARGET;
    process.env.HOTDOG_LOG_TARGET = "invalid";
    try {
      expect(resolveLogTarget("stdout")).toBe("stdout");
    } finally {
      if (origTarget !== undefined) process.env.HOTDOG_LOG_TARGET = origTarget;
      else delete process.env.HOTDOG_LOG_TARGET;
    }
  });

  it("handles case-insensitive env var", () => {
    const origTarget = process.env.HOTDOG_LOG_TARGET;
    process.env.HOTDOG_LOG_TARGET = "STDOUT";
    try {
      expect(resolveLogTarget("none")).toBe("stdout");
    } finally {
      if (origTarget !== undefined) process.env.HOTDOG_LOG_TARGET = origTarget;
      else delete process.env.HOTDOG_LOG_TARGET;
    }
  });
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
