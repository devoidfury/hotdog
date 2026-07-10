import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HOOKS } from "../../src/core/hooks.ts";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createMockCore } from "../helpers.js";

describe("Session Review CLI - listSessions", () => {
  const sessionsDir = join(homedir(), ".cache", "hotdog", "sessions");
  const TEST_SESSION_ID = `test-review-list-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(join(sessionsDir, `${TEST_SESSION_ID}.jsonl`));
    } catch {}
  });

  it("lists sessions in JSON format and finds test session", async () => {
    const { SessionLog } = await import(
      "../../src/extensions/session-log/session-log.js"
    );

    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("hello");
    await log.writeAssistant("world");

    const core = createMockCore();
    const { create } = await import(
      "../../src/extensions/ui-session-review-cli/index.js"
    );
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("review");
    const cli = { sessionId: null, wantsJson: true, toolIndex: false, colors: false, theme: "dark" };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => { capturedOutput += msg + "\n"; };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(capturedOutput.trim());
      expect(Array.isArray(parsed)).toBe(true);
      const found = parsed.find((s) => s.id === TEST_SESSION_ID);
      expect(found).toBeDefined();
      expect(found.entry_count).toBe(2);
    } finally {
      console.log = originalLog;
    }
  });

  it("lists sessions in text format", async () => {
    const { SessionLog } = await import(
      "../../src/extensions/session-log/session-log.js"
    );

    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("hello");
    await log.writeAssistant("world");

    const core = createMockCore();
    const { create } = await import(
      "../../src/extensions/ui-session-review-cli/index.js"
    );
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("review");
    const cli = { sessionId: null, wantsJson: false, toolIndex: false, colors: false, theme: "dark" };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => { capturedOutput += msg + "\n"; };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      expect(capturedOutput).toContain("=== Sessions ===");
      expect(capturedOutput).toContain(TEST_SESSION_ID);
    } finally {
      console.log = originalLog;
    }
  });

  it("filters out sessions with only 1 entry", async () => {
    const singleEntryId = `test-single-entry-${Date.now()}`;
    const { SessionLog } = await import(
      "../../src/extensions/session-log/session-log.js"
    );

    // Create a session with only 1 entry
    const log = new SessionLog(singleEntryId);
    await log.writeInput("hello");

    // Also create a session with 2 entries
    const log2 = new SessionLog(TEST_SESSION_ID);
    await log2.writeInput("hello");
    await log2.writeAssistant("world");

    const core = createMockCore();
    const { create } = await import(
      "../../src/extensions/ui-session-review-cli/index.js"
    );
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("review");
    const cli = {
      sessionId: null,
      wantsJson: true,
      toolIndex: false,
      colors: false,
      theme: "dark",
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(capturedOutput.trim());
      expect(Array.isArray(parsed)).toBe(true);
      // The single-entry session should not be in the list
      const singleEntry = parsed.find((s) => s.id === singleEntryId);
      expect(singleEntry).toBeUndefined();
      // But the 2-entry session should be
      const found = parsed.find((s) => s.id === TEST_SESSION_ID);
      expect(found).toBeDefined();
    } finally {
      console.log = originalLog;
      try {
        rmSync(join(sessionsDir, `${singleEntryId}.jsonl`));
      } catch {}
    }
  });
});

describe("Session Review CLI - reviewSession", () => {
  const sessionsDir = join(homedir(), ".cache", "hotdog", "sessions");
  const TEST_SESSION_ID = `test-review-session-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(join(sessionsDir, `${TEST_SESSION_ID}.jsonl`));
    } catch {}
  });

  it("returns exit code 1 for non-existent session with JSON", async () => {
    const core = createMockCore();
    const { create } = await import(
      "../../src/extensions/ui-session-review-cli/index.js"
    );
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

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(1);
      expect(capturedOutput.trim()).toBe("{}");
    } finally {
      console.log = originalLog;
    }
  });

  it("returns exit code 1 for non-existent session with text", async () => {
    const core = createMockCore();
    const { create } = await import(
      "../../src/extensions/ui-session-review-cli/index.js"
    );
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("review");
    const cli = {
      sessionId: "non-existent-session-xyz",
      wantsJson: false,
      toolIndex: false,
      colors: false,
      theme: "dark",
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(1);
      expect(capturedOutput).toContain("not found or empty");
    } finally {
      console.log = originalLog;
    }
  });

  it("reviews session with JSON output", async () => {
    const { SessionLog } = await import(
      "../../src/extensions/session-log/session-log.js"
    );

    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("hello");
    await log.writeAssistant("world");

    const core = createMockCore();
    const { create } = await import(
      "../../src/extensions/ui-session-review-cli/index.js"
    );
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

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(capturedOutput.trim());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
    } finally {
      console.log = originalLog;
    }
  });

  it("reviews session with text output showing different source types", async () => {
    const { SessionLog } = await import(
      "../../src/extensions/session-log/session-log.js"
    );

    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeSystemPrompt("You are a test agent");
    await log.writeInput("hello");
    await log.writeAssistant("thinking...");
    await log.writeAssistant(
      "running",
      [{ id: "tc_1", type: "function", function: { name: "bash", arguments: "ls" } }],
    );
    await log.writeToolResult("<output>done</output>", "tc_1", "bash");

    const core = createMockCore();
    const { create } = await import(
      "../../src/extensions/ui-session-review-cli/index.js"
    );
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("review");
    const cli = {
      sessionId: TEST_SESSION_ID,
      wantsJson: false,
      toolIndex: false,
      colors: false,
      theme: "dark",
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      expect(capturedOutput).toContain("=== Session:");
      expect(capturedOutput).toContain("[SYSTEM]");
      expect(capturedOutput).toContain("[USER]");
      expect(capturedOutput).toContain("[ASSISTANT]");
      expect(capturedOutput).toContain("[TOOL: bash]");
    } finally {
      console.log = originalLog;
    }
  });

  it("reviews session with --tool-index flag (JSON)", async () => {
    const { SessionLog } = await import(
      "../../src/extensions/session-log/session-log.js"
    );

    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("run bash");
    await log.writeAssistant(
      "running",
      [{ id: "tc_1", type: "function", function: { name: "bash", arguments: "ls" } }],
    );
    await log.writeToolResult("<output>done</output>", "tc_1", "bash");
    await log.writeAssistant(
      "running again",
      [{ id: "tc_2", type: "function", function: { name: "read", arguments: '{"path": "test.txt"}' } }],
    );
    await log.writeToolResult("<output>content</output>", "tc_2", "read");
    await log.writeAssistant("done");

    const core = createMockCore();
    const { create } = await import(
      "../../src/extensions/ui-session-review-cli/index.js"
    );
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

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(capturedOutput.trim());
      expect(parsed).toHaveProperty("bash");
      expect(parsed).toHaveProperty("read");
    } finally {
      console.log = originalLog;
    }
  });

  it("reviews session with --tool-index flag (text)", async () => {
    const { SessionLog } = await import(
      "../../src/extensions/session-log/session-log.js"
    );

    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("run bash");
    await log.writeAssistant(
      "running",
      [{ id: "tc_1", type: "function", function: { name: "bash", arguments: "ls" } }],
    );
    await log.writeToolResult("<output>done</output>", "tc_1", "bash");

    const core = createMockCore();
    const { create } = await import(
      "../../src/extensions/ui-session-review-cli/index.js"
    );
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("review");
    const cli = {
      sessionId: TEST_SESSION_ID,
      wantsJson: false,
      toolIndex: true,
      colors: false,
      theme: "dark",
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      expect(capturedOutput).toContain("=== Tool Usage ===");
      expect(capturedOutput).toContain("bash: 1x");
    } finally {
      console.log = originalLog;
    }
  });

  it("tool-index shows 'No tools used' when no tools", async () => {
    const { SessionLog } = await import(
      "../../src/extensions/session-log/session-log.js"
    );

    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("hello");
    await log.writeAssistant("world");

    const core = createMockCore();
    const { create } = await import(
      "../../src/extensions/ui-session-review-cli/index.js"
    );
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("review");
    const cli = {
      sessionId: TEST_SESSION_ID,
      wantsJson: false,
      toolIndex: true,
      colors: false,
      theme: "dark",
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      expect(capturedOutput).toContain("No tools used");
    } finally {
      console.log = originalLog;
    }
  });

  it("tool-index JSON output for session with no tools", async () => {
    const { SessionLog } = await import(
      "../../src/extensions/session-log/session-log.js"
    );

    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("hello");
    await log.writeAssistant("world");

    const core = createMockCore();
    const { create } = await import(
      "../../src/extensions/ui-session-review-cli/index.js"
    );
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

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(capturedOutput.trim());
      expect(Object.keys(parsed).length).toBe(0);
    } finally {
      console.log = originalLog;
    }
  });
});

describe("Session Review CLI - toolIndex without sessionId", () => {
  const sessionsDir = join(homedir(), ".cache", "hotdog", "sessions");
  const TEST_SESSION_ID = `test-review-toolindex-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(join(sessionsDir, `${TEST_SESSION_ID}.jsonl`));
    } catch {}
  });

  it("toolIndex without sessionId uses most recent session", async () => {
    const { SessionLog } = await import(
      "../../src/extensions/session-log/session-log.js"
    );

    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("run bash");
    await log.writeAssistant(
      "running",
      [{ id: "tc_1", type: "function", function: { name: "bash", arguments: "ls" } }],
    );
    await log.writeToolResult("<output>done</output>", "tc_1", "bash");

    const core = createMockCore();
    const { create } = await import(
      "../../src/extensions/ui-session-review-cli/index.js"
    );
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("review");
    const cli = {
      sessionId: null,
      wantsJson: true,
      toolIndex: true,
      colors: false,
      theme: "dark",
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(capturedOutput.trim());
      expect(parsed).toHaveProperty("bash");
    } finally {
      console.log = originalLog;
    }
  });
});

describe("Session Review CLI - registers review tool", () => {
  it("registers review tool via TOOLS_REGISTER hook", async () => {
    const core = createMockCore();
    const { create } = await import(
      "../../src/extensions/ui-session-review-cli/index.js"
    );
    const ext = create(core);

    expect(ext).not.toBeNull();
    expect(ext.hooks[HOOKS.TOOLS_REGISTER]).toBeDefined();

    await ext.hooks[HOOKS.TOOLS_REGISTER](core.toolRegistry);

    expect(core.toolRegistry.has("review")).toBe(true);
  });
});
