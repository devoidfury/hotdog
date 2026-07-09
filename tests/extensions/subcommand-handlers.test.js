import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HOOKS } from "../../src/core/hooks.js";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createMockCore } from "../helpers.js";

// ── Session Review Extension Tests ───────────────────────────────────────────

describe("Session Review Extension - exit codes", () => {
  const TEST_SESSION_ID = `test-subcmd-review-${Date.now()}`;
  const sessionsDir = join(homedir(), ".cache", "hotdog", "sessions");

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

  it("registers review subcommand via CLI_SUBCOMMANDS_REGISTER hook", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-session-review-cli/index.js");
    const ext = create(core);

    expect(ext).not.toBeNull();
    expect(ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER]).toBeDefined();

    // Trigger the hook to register the subcommand
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    expect(core.cliSubcommandRegistry.has("review")).toBe(true);
    const def = core.cliSubcommandRegistry.get("review");
    expect(def.handler).toBeDefined();
  });

  it("review subcommand returns exit code 0 for existing session", async () => {
    const { SessionLog } = await import(
      "../../src/extensions/session-log/session-log.js"
    );

    // Create a test session
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("hello");
    await log.writeAssistant("world");

    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-session-review-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("review");
    const cli = {
      sessionId: TEST_SESSION_ID,
      wantsJson: true,
      toolIndex: false,
      colors: false,
      theme: "dark",
    };

    // Suppress console output during handler execution
    const originalLog = console.log;
    console.log = () => {};
    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
    } finally {
      console.log = originalLog;
    }
  });

  it("review subcommand returns exit code 1 for non-existent session", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-session-review-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("review");
    const cli = {
      sessionId: "non-existent-session-xyz",
      wantsJson: true,
      toolIndex: false,
      colors: false,
      theme: "dark",
    };

    // Suppress console output during handler execution
    const originalLog = console.log;
    console.log = () => {};
    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(1);
    } finally {
      console.log = originalLog;
    }
  });

  it("review subcommand with --tool-index returns 0", async () => {
    const { SessionLog } = await import(
      "../../src/extensions/session-log/session-log.js"
    );

    // Create a test session with tool usage
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("run bash");
    await log.writeAssistant(
      "running",
      [{ id: "tc_1", type: "function", function: { name: "bash", arguments: "ls" } }],
    );
    await log.writeToolResult("<output>done</output>", "tc_1", "bash");

    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-session-review-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("review");
    const cli = {
      sessionId: TEST_SESSION_ID,
      wantsJson: true,
      toolIndex: true,
      colors: false,
      theme: "dark",
    };

    // Suppress console output during handler execution
    const originalLog = console.log;
    console.log = () => {};
    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
    } finally {
      console.log = originalLog;
    }
  });

  it("review subcommand lists sessions (returns 0 when sessions exist)", async () => {
    const { SessionLog } = await import(
      "../../src/extensions/session-log/session-log.js"
    );

    // Clean up any leftover session file from previous test runs
    try {
      const { rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      rmSync(join(homedir(), ".cache", "hotdog", "sessions", `${TEST_SESSION_ID}.jsonl`));
    } catch {}

    // Create a test session with multiple entries
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("hello");
    await log.writeAssistant("world");
    await log.writeInput("how are you");
    await log.writeAssistant("good");

    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-session-review-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("review");
    const cli = {
      sessionId: null, // No session ID = list mode
      wantsJson: true,
      toolIndex: false,
      colors: false,
      theme: "dark",
    };

    // Capture console output to verify it's valid JSON
    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);

      // Verify output is valid JSON array
      const parsed = JSON.parse(capturedOutput.trim());
      expect(Array.isArray(parsed)).toBe(true);
      // Our test session should be in the list
      const foundSession = parsed.find(
        (s) => s.id === TEST_SESSION_ID,
      );
      expect(foundSession).toBeDefined();
      expect(foundSession.entry_count).toBe(4);
    } finally {
      console.log = originalLog;
    }
  });
});

// ── Info Show-Prompt Extension Tests ─────────────────────────────────────────

describe("Info Show-Prompt Extension - exit codes", () => {
  it("registers info and show-prompt subcommands", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);

    expect(ext).not.toBeNull();
    expect(ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER]).toBeDefined();

    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    expect(core.cliSubcommandRegistry.has("info")).toBe(true);
    expect(core.cliSubcommandRegistry.has("show-prompt")).toBe(true);
  });

  it("info subcommand returns exit code 0 for both JSON and text output", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("info");
    const originalLog = console.log;
    console.log = () => {};
    try {
      for (const wantsJson of [true, false]) {
        const exitCode = await def.handler({ wantsJson, colors: false, theme: "dark", config: null, skillsPath: null }, core);
        expect(exitCode).toBe(0);
      }
    } finally {
      console.log = originalLog;
    }
  });

  it("show-prompt subcommand returns exit code 0", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("show-prompt");
    const originalLog = console.log;
    console.log = () => {};
    try {
      const exitCode = await def.handler({ wantsJson: false, colors: false, theme: "dark", config: null }, core);
      expect(exitCode).toBe(0);
    } finally {
      console.log = originalLog;
    }
  });
});

// ── One-Shot Extension Tests ─────────────────────────────────────────────────
// CLI_ARGS_PARSED hook tests are in one-shot-cli.test.js

describe("One-Shot Extension - exit codes", () => {
  it("registers prompt subcommand via CLI_SUBCOMMANDS_REGISTER hook", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-one-shot/index.js");
    const ext = create(core);

    expect(ext).not.toBeNull();
    expect(ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER]).toBeDefined();

    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    expect(core.cliSubcommandRegistry.has("prompt")).toBe(true);
    const def = core.cliSubcommandRegistry.get("prompt");
    expect(def.handler).toBeDefined();
  });
});

// ── Subcommand Handler Return Type Tests ─────────────────────────────────────

describe("Subcommand handler return types", () => {
  it("all registered handlers return numeric exit codes", async () => {
    const core = createMockCore();

    // Load all extensions that register subcommands
    const { create: createReview } = await import("../../src/extensions/ui-session-review-cli/index.js");
    const { create: createInfo } = await import("../../src/extensions/ui-info-cli/index.js");
    const { create: createOneShot } = await import("../../src/extensions/ui-one-shot/index.js");

    const reviewExt = createReview(core);
    const infoExt = createInfo(core);
    const oneShotExt = createOneShot(core);

    // Register all subcommands
    await reviewExt.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);
    await infoExt.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);
    await oneShotExt.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    // Verify all subcommands are registered
    const subcommands = core.cliSubcommandRegistry.names();
    expect(subcommands).toContain("review");
    expect(subcommands).toContain("info");
    expect(subcommands).toContain("show-prompt");
    expect(subcommands).toContain("prompt");

    // Verify all have handlers
    for (const name of subcommands) {
      const def = core.cliSubcommandRegistry.get(name);
      expect(def.handler).toBeDefined();
      expect(typeof def.handler).toBe("function");
    }
  });
});

// ── Main Entry Point Integration Tests ───────────────────────────────────────

describe("Main entry point - exit code flow", () => {
  it("process.exit is called with return value from main()", async () => {
    // This test verifies the pattern:
    // main().catch(...).then((code) => process.exit(code))
    //
    // We can't actually test process.exit without killing the test process,
    // but we can verify the promise chain behavior.

    const mockMain = async () => {
      return 0;
    };

    let capturedCode = null;
    const originalExit = process.exit;
    process.exit = (code) => {
      capturedCode = code;
      throw new Error("process.exit called with: " + code);
    };

    try {
      await mockMain()
        .catch((e) => {
          return 1;
        })
        .then((code) => process.exit(code));
    } catch (e) {
      if (e.message.startsWith("process.exit called with:")) {
        expect(capturedCode).toBe(0);
      } else {
        throw e;
      }
    } finally {
      process.exit = originalExit;
    }
  });

  it("error in main() returns exit code 1", async () => {
    const mockMain = async () => {
      throw new Error("Test error");
    };

    let capturedCode = null;
    const originalExit = process.exit;
    process.exit = (code) => {
      capturedCode = code;
      throw new Error("process.exit called with: " + code);
    };

    try {
      await mockMain()
        .catch((e) => {
          return 1;
        })
        .then((code) => process.exit(code));
    } catch (e) {
      if (e.message.startsWith("process.exit called with:")) {
        expect(capturedCode).toBe(1);
      } else {
        throw e;
      }
    } finally {
      process.exit = originalExit;
    }
  });

  it("error with custom exitCode preserves the code", async () => {
    const mockMain = async () => {
      const err = new Error("Custom error");
      err.exitCode = 42;
      throw err;
    };

    // Simulate the runOneShot pattern
    let exitCode = 0;
    try {
      await mockMain();
    } catch (e) {
      exitCode = e.exitCode ?? 1;
    }
    expect(exitCode).toBe(42);
  });
});
