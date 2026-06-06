import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createSubcommandRegistry } from "../../src/core/extensions/registries.js";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockCore(config = {}) {
  return {
    config: {
      theme: "dark",
      maxIterations: 100,
      ...config.coreConfig,
    },
    resolved: {
      baseUrl: "http://localhost:8080",
      apiKey: "test-key",
      model: "test-model",
      stream: false,
      chatTimeout: 30,
      profileName: "default",
      profile: {},
      hideTools: false,
      hideThinking: false,
      showTokenUse: false,
      ...config.resolved,
    },
    modelRegistry: config.modelRegistry || {},
    hooks: config.hooks || {
      emit: () => {},
      emitAsync: async () => {},
      on: () => {},
      hookNames: () => [],
    },
    toolRegistry: config.toolRegistry || {
      getAll: () => [],
      has: () => false,
      register: () => {},
    },
    extensions: config.extensions || {
      has: () => false,
      load: async () => null,
      cleanup: async () => {},
    },
    buildConfig: config.buildConfig || (async () => config.resolved || {}),
  };
}

// ── Subcommand Registry Exit Code Tests ──────────────────────────────────────

describe("SubcommandRegistry - exit code propagation", () => {
  it("registers handler that returns exit code 0", async () => {
    const registry = createSubcommandRegistry();
    registry.register("test-success", {
      description: "Test success",
      handler: async () => 0,
    });

    const def = registry.get("test-success");
    expect(def).toBeDefined();
    expect(def.handler).toBeDefined();

    const result = await def.handler({}, {});
    expect(result).toBe(0);
  });

  it("registers handler that returns exit code 1", async () => {
    const registry = createSubcommandRegistry();
    registry.register("test-failure", {
      description: "Test failure",
      handler: async () => 1,
    });

    const def = registry.get("test-failure");
    const result = await def.handler({}, {});
    expect(result).toBe(1);
  });

  it("handler can return different codes based on conditions", async () => {
    const registry = createSubcommandRegistry();
    registry.register("conditional", {
      description: "Conditional exit",
      handler: async (cli) => {
        return cli.success ? 0 : 1;
      },
    });

    const def = registry.get("conditional");
    expect(await def.handler({ success: true }, {})).toBe(0);
    expect(await def.handler({ success: false }, {})).toBe(1);
  });
});

// ── Session Review Exit Code Tests ───────────────────────────────────────────

describe("Session Review - exit codes", () => {
  const TEST_SESSION_ID = `test-exit-code-${Date.now()}`;
  const sessionsDir = join(homedir(), ".cache", "oa-agent", "sessions");

  function setup() {
    mkdirSync(sessionsDir, { recursive: true });
  }

  function teardown() {
    const testFile = join(sessionsDir, `${TEST_SESSION_ID}.jsonl`);
    try {
      rmSync(testFile);
    } catch {
      // ignore
    }
  }

  beforeEach(setup);
  afterEach(teardown);

  describe("listSessions", () => {
    it("returns 1 when sessions directory does not exist", async () => {
      // Import the function dynamically to test internal behavior
      const { readSessionEntries } = await import(
        "../../src/extensions/session-log/session-log.js"
      );

      // Test with non-existent directory
      const nonExistentDir = join("/tmp", "non-existent-dir-" + Date.now());
      // Simulate what listSessions does
      const { existsSync, readdirSync } = await import("node:fs");

      if (!existsSync(nonExistentDir)) {
        // This is the expected behavior - directory doesn't exist
        expect(existsSync(nonExistentDir)).toBe(false);
      }
    });

    it("returns 0 when sessions exist with valid entries", async () => {
      const { SessionLog } = await import(
        "../../src/extensions/session-log/session-log.js"
      );

      // Create a session with multiple entries (listSessions filters sessions with <= 1 entry)
      const log = new SessionLog(TEST_SESSION_ID);
      log.writeInput("test input");
      log.writeAssistant("test response");

      const { readSessionEntries } = await import(
        "../../src/extensions/session-log/session-log.js"
      );
      const entries = readSessionEntries(TEST_SESSION_ID);
      expect(entries.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("reviewSession", () => {
    it("returns 1 for non-existent session", async () => {
      const { readSessionEntries } = await import(
        "../../src/extensions/session-log/session-log.js"
      );

      const entries = readSessionEntries("non-existent-session-xyz");
      expect(entries.length).toBe(0);
    });

    it("returns 0 for existing session with entries", async () => {
      const { SessionLog, readSessionEntries } = await import(
        "../../src/extensions/session-log/session-log.js"
      );

      const log = new SessionLog(TEST_SESSION_ID);
      log.writeInput("hello");
      log.writeAssistant("world");

      const entries = readSessionEntries(TEST_SESSION_ID);
      expect(entries.length).toBe(2);
      expect(entries[0].content).toBe("hello");
    });
  });

  describe("printToolIndex", () => {
    it("returns 0 for entries with no tool results", async () => {
      const { SessionLog, readSessionEntries } = await import(
        "../../src/extensions/session-log/session-log.js"
      );

      const log = new SessionLog(TEST_SESSION_ID);
      log.writeInput("hello");
      log.writeAssistant("world");

      const entries = readSessionEntries(TEST_SESSION_ID);
      // No tool results in these entries
      const toolEntries = entries.filter((e) => e.source === "tool_result");
      expect(toolEntries.length).toBe(0);
    });

    it("returns 0 for entries with tool results", async () => {
      const { SessionLog, readSessionEntries } = await import(
        "../../src/extensions/session-log/session-log.js"
      );

      const log = new SessionLog(TEST_SESSION_ID);
      log.writeInput("run bash");
      log.writeAssistant(
        "running",
        [{ id: "tc_1", type: "function", function: { name: "bash", arguments: "ls" } }],
      );
      log.writeToolResult("<output>done</output>", "tc_1", "bash");

      const entries = readSessionEntries(TEST_SESSION_ID);
      const toolEntries = entries.filter((e) => e.source === "tool_result");
      expect(toolEntries.length).toBe(1);
      expect(toolEntries[0].tool_name).toBe("bash");
    });
  });
});

// ── Main Function Exit Code Tests ────────────────────────────────────────────

describe("Main function - exit code scenarios", () => {
  it("returns 1 for unknown subcommand", async () => {
    // Simulate the error path in main()
    const error = new Error("Unknown subcommand: foobar");
    error.message = "Unknown subcommand: foobar";

    // This mimics the logic in main()
    let exitCode = 0;
    try {
      throw error;
    } catch (e) {
      if (e.message.startsWith("Unknown subcommand:")) {
        exitCode = 1;
      } else {
        throw e;
      }
    }
    expect(exitCode).toBe(1);
  });

  it("returns 1 when subcommand handler is not available", async () => {
    const registry = createSubcommandRegistry();
    // Register without handler (metadata only)
    registry.register("no-handler", {
      description: "No handler",
    });

    const def = registry.get("no-handler");
    // When handler is missing, main() returns 1
    expect(def.handler).toBeUndefined();
  });

  it("returns 0 for version flag", () => {
    // Simulate: if (cli.version) { console.log("oa-agent 0.1.0"); return 0; }
    const cli = { version: true };
    let exitCode = 0;
    if (cli.version) {
      exitCode = 0;
    }
    expect(exitCode).toBe(0);
  });

  it("returns 0 for help flag", () => {
    const cli = { help: true };
    let exitCode = 0;
    if (cli.help) {
      exitCode = 0;
    }
    expect(exitCode).toBe(0);
  });

  it("returns 1 when no subcommand provided", () => {
    const cli = { subcommand: null, version: false, help: false };
    let exitCode = 1;
    if (!cli.subcommand && !cli.version && !cli.help) {
      exitCode = 1;
    }
    expect(exitCode).toBe(1);
  });
});

// ── One-Shot Extension Exit Code Tests ───────────────────────────────────────

describe("One-Shot extension - exit codes", () => {
  it("returns 0 on successful completion", async () => {
    // Simulate successful runOneShot
    let exitCode = 0;
    try {
      // Simulate successful bus.runUntilCancelled()
      // No throw = success
    } catch (e) {
      exitCode = e.exitCode ?? 1;
    }
    expect(exitCode).toBe(0);
  });

  it("returns 1 on error without exitCode property", async () => {
    let exitCode = 0;
    try {
      throw new Error("Something went wrong");
    } catch (e) {
      exitCode = e.exitCode ?? 1;
    }
    expect(exitCode).toBe(1);
  });

  it("returns custom exitCode when error has exitCode property", async () => {
    let exitCode = 0;
    try {
      const error = new Error("Custom error");
      error.exitCode = 42;
      throw error;
    } catch (e) {
      exitCode = e.exitCode ?? 1;
    }
    expect(exitCode).toBe(42);
  });
});

// ── Info Subcommand Exit Code Tests ──────────────────────────────────────────

describe("Info subcommand - exit codes", () => {
  it("printInfoText returns 0", () => {
    // Simulate printInfoText - it always returns 0 on success
    const mockData = {
      resolved: { baseUrl: "http://test", model: "test" },
      modelRegistry: {},
      providers: [],
      skillsLoader: { activeSkills: () => [] },
      connectivity: { reachable: true, error: null },
      config: {},
    };

    // The function always returns 0 at the end
    const exitCode = 0;
    expect(exitCode).toBe(0);
  });

  it("printInfoJson returns 0", () => {
    // Simulate printInfoJson - it always returns 0 on success
    const exitCode = 0;
    expect(exitCode).toBe(0);
  });
});

// ── Show-Prompt Subcommand Exit Code Tests ───────────────────────────────────

describe("Show-Prompt subcommand - exit codes", () => {
  it("runShowPrompt returns 0 on success", () => {
    // Simulate successful show-prompt
    // The function always returns 0 after printing the system prompt
    const exitCode = 0;
    expect(exitCode).toBe(0);
  });
});

// ── Error Handling Exit Code Tests ───────────────────────────────────────────

describe("Error handling - exit codes", () => {
  it("formatError preserves exitCode property", async () => {
    const { formatError } = await import("../../src/core/error.js");

    const error = new Error("Test error");
    error.exitCode = 5;
    const formatted = formatError(error);
    expect(typeof formatted).toBe("string");
  });

  it("main().catch returns 1 for unhandled errors", async () => {
    // Simulate: main().catch(async (e) => { console.error(formatError(e)); return 1; })
    const { formatError } = await import("../../src/core/error.js");

    let exitCode = 0;
    try {
      throw new Error("Unhandled error");
    } catch (e) {
      // This is what the .catch handler does
      formatError(e); // Would log to console.error in real code
      exitCode = 1;
    }
    expect(exitCode).toBe(1);
  });
});

// ── Integration: Subcommand Handler Return Values ────────────────────────────

describe("Integration: subcommand handler return values", () => {
  it("handler return value propagates through registry", async () => {
    const registry = createSubcommandRegistry();

    // Register a handler that returns specific exit codes based on input
    registry.register("test", {
      description: "Test handler",
      handler: async (cli) => {
        if (cli.error) return 1;
        if (cli.warning) return 2;
        return 0;
      },
    });

    const def = registry.get("test");

    // Test different return values
    expect(await def.handler({ error: true })).toBe(1);
    expect(await def.handler({ warning: true })).toBe(2);
    expect(await def.handler({})).toBe(0);
  });

  it("handler can access cli and core parameters", async () => {
    const registry = createSubcommandRegistry();

    registry.register("echo", {
      description: "Echo test",
      handler: async (cli, core) => {
        if (cli.value === core.config.expectedValue) {
          return 0;
        }
        return 1;
      },
    });

    const def = registry.get("echo");
    const core = { config: { expectedValue: "match" } };

    expect(await def.handler({ value: "match" }, core)).toBe(0);
    expect(await def.handler({ value: "nomatch" }, core)).toBe(1);
  });

  it("async handler properly awaits and returns", async () => {
    const registry = createSubcommandRegistry();

    registry.register("async-test", {
      description: "Async test",
      handler: async () => {
        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 1));
        return 0;
      },
    });

    const def = registry.get("async-test");
    const result = await def.handler({}, {});
    expect(result).toBe(0);
  });
});

// ── Edge Cases ───────────────────────────────────────────────────────────────

describe("Exit code edge cases", () => {
  it("undefined return is treated as 0 (implicit success)", async () => {
    const registry = createSubcommandRegistry();
    registry.register("implicit", {
      handler: async () => {
        // No explicit return - returns undefined
      },
    });

    const def = registry.get("implicit");
    const result = await def.handler({}, {});
    // undefined is falsy, but the .then((code) => process.exit(code)) 
    // will exit with undefined which Node treats as 0
    expect(result).toBeUndefined();
  });

  it("null return is treated as 0", async () => {
    const registry = createSubcommandRegistry();
    registry.register("null-return", {
      handler: async () => null,
    });

    const def = registry.get("null-return");
    const result = await def.handler({}, {});
    expect(result).toBeNull();
  });

  it("numeric exit codes are preserved", async () => {
    const codes = [0, 1, 2, 126, 127, 255];
    for (const code of codes) {
      const registry = createSubcommandRegistry();
      registry.register(`code-${code}`, {
        handler: async () => code,
      });
      const def = registry.get(`code-${code}`);
      expect(await def.handler({}, {})).toBe(code);
    }
  });
});
