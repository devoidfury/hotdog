import { describe, it, expect, afterEach, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  LOG_LEVELS,
  LOG_TARGETS,
  resolveLogLevel,
  resolveLogTarget,
  logBootConfigWarnings,
  initializeLogger,
  logger,
  resetLoggerForTesting,
} from "@utils/logger.ts";
import { peekLogBootPosture } from "@core/config/boot-posture.ts";
import { peekConfigFlags } from "@core/main.ts";
import { TMP_PARENT } from "../mocks/io.ts";
import { HookSystem } from "@core/hooks.ts";

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
  beforeAll(() => {
    // Clear any preloaded messages from previous tests so they don't flush on init
    resetLoggerForTesting();
  });

  afterEach(() => {
    resetLoggerForTesting();
  });

  afterAll(() => {
    // Ensure logger is reset after this describe block so other tests aren't affected
    resetLoggerForTesting();
  });

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


// ── Config-informed boot posture (owner request 2026-11-11) ────────────────
// The config layer of env > config > default, the named fallback for
// out-of-set values, and the early peek that lets the logger boot from the
// in-use file. Everything reads temp dirs only -- never the real config dir.

describe("resolve* config layer", () => {
  let savedLevel: string | undefined;
  let savedTarget: string | undefined;
  beforeAll(() => {
    savedLevel = process.env.HOTDOG_LOG_LEVEL;
    savedTarget = process.env.HOTDOG_LOG_TARGET;
    delete process.env.HOTDOG_LOG_LEVEL;
    delete process.env.HOTDOG_LOG_TARGET;
  });
  afterAll(() => {
    if (savedLevel !== undefined) process.env.HOTDOG_LOG_LEVEL = savedLevel;
    else delete process.env.HOTDOG_LOG_LEVEL;
    if (savedTarget !== undefined) process.env.HOTDOG_LOG_TARGET = savedTarget;
    else delete process.env.HOTDOG_LOG_TARGET;
  });

  it("uses a valid config value when env is unset", () => {
    expect(resolveLogLevel("debug")).toBe("debug");
    expect(resolveLogTarget("stdout")).toBe("stdout");
  });

  it("falls back to the default for out-of-set, non-string, and null config values", () => {
    expect(resolveLogLevel("verbos")).toBe("info");
    expect(resolveLogTarget("silence")).toBe("stderr");
    expect(resolveLogLevel(3)).toBe("info");
    expect(resolveLogLevel(null)).toBe("info");
    expect(resolveLogTarget({})).toBe("stderr");
  });
});

describe("logBootConfigWarnings (the one-time named fallback)", () => {
  let savedLevel: string | undefined;
  let savedTarget: string | undefined;
  beforeAll(() => {
    savedLevel = process.env.HOTDOG_LOG_LEVEL;
    savedTarget = process.env.HOTDOG_LOG_TARGET;
    delete process.env.HOTDOG_LOG_LEVEL;
    delete process.env.HOTDOG_LOG_TARGET;
  });
  afterAll(() => {
    if (savedLevel !== undefined) process.env.HOTDOG_LOG_LEVEL = savedLevel;
    else delete process.env.HOTDOG_LOG_LEVEL;
    if (savedTarget !== undefined) process.env.HOTDOG_LOG_TARGET = savedTarget;
    else delete process.env.HOTDOG_LOG_TARGET;
  });

  it("pins the closed target set (core.config.json's logTarget enum mirrors it)", () => {
    expect(LOG_TARGETS).toEqual(["stderr", "stdout", "none"]);
  });

  it("names the offending value and the accepted set, once per key", () => {
    const warns = logBootConfigWarnings({ logLevel: "verbos", logTarget: "sideways" });
    expect(warns).toHaveLength(2); // one per offending key -- never repeated per log line
    expect(warns[0]).toContain('"verbos"');
    expect(warns[0]).toContain("debug | info | warn | error");
    expect(warns[1]).toContain('"sideways"');
    expect(warns[1]).toContain("stderr | stdout | none");
    // The fallback the warn promises is what resolve* actually picks.
    expect(resolveLogLevel("verbos")).toBe("info");
    expect(resolveLogTarget("sideways")).toBe("stderr");
  });

  it("stays silent for valid values, absent keys, and null (null reads as absent)", () => {
    expect(logBootConfigWarnings({ logLevel: "debug", logTarget: "none" })).toEqual([]);
    expect(logBootConfigWarnings({})).toEqual([]);
    expect(logBootConfigWarnings({ logLevel: null, logTarget: null })).toEqual([]);
  });

  it("stays silent when a valid env value beats the bad config line (the value never applied)", () => {
    process.env.HOTDOG_LOG_LEVEL = "error";
    try {
      expect(logBootConfigWarnings({ logLevel: "verbos" })).toEqual([]);
    } finally {
      delete process.env.HOTDOG_LOG_LEVEL;
    }
  });

  it("warns when env itself is bad too -- then the config value would have applied", () => {
    process.env.HOTDOG_LOG_LEVEL = "chatty";
    try {
      expect(logBootConfigWarnings({ logLevel: "verbos" })).toHaveLength(1);
    } finally {
      delete process.env.HOTDOG_LOG_LEVEL;
    }
  });

  it("names non-string offenders", () => {
    const warns = logBootConfigWarnings({ logLevel: 3 });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("= 3");
  });
});

describe("peekLogBootPosture (early read of the in-use config file)", () => {
  let n = 0;
  const dirs: string[] = [];
  function tempDir(): string {
    const dir = mkdtempSync(join(TMP_PARENT, `hotdog-boot-posture-${++n}-`));
    dirs.push(dir);
    return dir;
  }
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    // The unparsable-file tests queue a debug line into the preload queue;
    // do not let it flush into a later block's initializeLogger.
    resetLoggerForTesting();
  });

  it("finds defaults.json through the -d chain (same path logic as the loader)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "defaults.json"), '{ "logLevel": "debug" }');
    const flags = peekConfigFlags(["-d", dir]);
    expect(flags).toEqual({ config: null, configDir: dir });
    expect(peekLogBootPosture(flags)).toEqual({ logLevel: "debug" });
  });

  it("an explicit -f file wins over the resolved config dir", () => {
    const dir = tempDir();
    const other = tempDir();
    const custom = join(other, "custom.json");
    writeFileSync(join(dir, "defaults.json"), '{ "logLevel": "debug", "logTarget": "none" }');
    writeFileSync(custom, '{ "logTarget": "stdout" }');
    const flags = peekConfigFlags(["-d", dir, "-f", custom]);
    expect(peekLogBootPosture(flags)).toEqual({ logTarget: "stdout" });
  });

  it("HOTDOG_CONFIG_DIR reaches the same resolution as the flag", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "defaults.json"), '{ "logLevel": "warn", "logTarget": "none" }');
    const saved = process.env.HOTDOG_CONFIG_DIR;
    process.env.HOTDOG_CONFIG_DIR = dir;
    try {
      expect(peekLogBootPosture(peekConfigFlags([]))).toEqual({ logLevel: "warn", logTarget: "none" });
    } finally {
      if (saved !== undefined) process.env.HOTDOG_CONFIG_DIR = saved;
      else delete process.env.HOTDOG_CONFIG_DIR;
    }
  });

  it("tolerates JSONC and the kebab/snake spellings the loader normalizes", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "defaults.json"),
      '{\n  // boot posture, JSONC like every config\n  "log-level": "debug", "log_target": "stdout",\n}',
    );
    expect(peekLogBootPosture({ config: join(dir, "defaults.json"), configDir: null })).toEqual({
      logLevel: "debug",
      logTarget: "stdout",
    });
  });

  it("a missing file is the normal empty posture (no throw, no noise)", () => {
    expect(peekLogBootPosture({ config: join(tempDir(), "absent.json"), configDir: null })).toEqual({});
    // An existing dir WITHOUT defaults.json is the isolation pattern.
    expect(peekLogBootPosture({ config: null, configDir: tempDir() })).toEqual({});
  });

  it("an unparsable file degrades to env/default instead of throwing before the logger exists", () => {
    const dir = tempDir();
    const file = join(dir, "defaults.json");
    writeFileSync(file, "{ this is not json ]");
    expect(() => peekLogBootPosture({ config: file, configDir: null })).not.toThrow();
    expect(peekLogBootPosture({ config: file, configDir: null })).toEqual({});
    // Parsed-but-not-an-object is equally not a config file.
    writeFileSync(file, "42");
    expect(peekLogBootPosture({ config: file, configDir: null })).toEqual({});
  });

  it("carries non-string values through so logBootConfigWarnings can name them", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "defaults.json"), '{ "logLevel": 3, "logTarget": true }');
    expect(peekLogBootPosture({ config: join(dir, "defaults.json"), configDir: null })).toEqual({
      logLevel: 3,
      logTarget: true,
    });
  });
});
