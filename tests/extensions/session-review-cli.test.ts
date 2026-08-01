import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { HOOKS } from "../../src/core/hooks.ts";
import { mkdirSync, rmSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createMockCore } from "../helpers.ts";
import { captureConsole, withSilentConsole } from "../test-helpers.ts";
import type { CoreContext } from "../../src/core/extensions/types.ts";

const SessionLog = (await import("../../src/extensions/session-log/session-log.ts")).SessionLog;
const { create: createSessionReview } = await import("../../src/extensions/ui-session-review-cli/index.ts");

// Use isolated temp directory to avoid scanning 100+ real session files
const TEST_SESSIONS_DIR = join(import.meta.dir, "..", ".test-sessions-review");

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = TEST_SESSIONS_DIR;
  mkdirSync(TEST_SESSIONS_DIR, { recursive: true });
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  try { rmSync(TEST_SESSIONS_DIR, { recursive: true, force: true }); } catch {}
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function sessionsDir() {
  return TEST_SESSIONS_DIR;
}

async function setupSession(id: string, entries: Array<{ type: "input" | "assistant" | "system", content: string }>) {
  const log = new SessionLog(id);
  for (const e of entries) {
    if (e.type === "system") await log.writeSystemPrompt(e.content);
    else if (e.type === "input") await log.writeInput(e.content);
    else await log.writeAssistant(e.content);
  }
}

async function runHandler(cli: Record<string, unknown>, coreConfig?: Record<string, unknown>) {
  const core = createMockCore(coreConfig) as unknown as CoreContext;
  const ext = createSessionReview(core);
  await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);
  const def = core.cliSubcommandRegistry.get("sessions");
  return def!.handler!(cli, core);
}

// ── listSessions ────────────────────────────────────────────────────────────

describe("Session Review CLI - listSessions", () => {
  const sessionsDirPath = sessionsDir();
  const TEST_SESSION_ID = `test-review-list-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(sessionsDirPath, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(join(sessionsDirPath, `${TEST_SESSION_ID}.jsonl`)); } catch {}
  });

  it("lists sessions in JSON format and finds test session", async () => {
    await setupSession(TEST_SESSION_ID, [
      { type: "input", content: "hello" },
      { type: "assistant", content: "world" },
    ]);

    const cli = { sessionId: null, wantsJson: true, toolIndex: false, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(output.trim());
    expect(Array.isArray(parsed)).toBe(true);
    const found = parsed.find((s: any) => s.id === TEST_SESSION_ID);
    expect(found).toBeDefined();
    expect(found.entry_count).toBe(2);
  });

  it("lists sessions in text format", async () => {
    await setupSession(TEST_SESSION_ID, [
      { type: "input", content: "hello" },
      { type: "assistant", content: "world" },
    ]);

    const cli = { sessionId: null, wantsJson: false, toolIndex: false, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(0);
    expect(output).toContain("=== Sessions ===");
    expect(output).toContain(TEST_SESSION_ID);
  });

  it("filters out sessions with only 1 entry", async () => {
    const singleEntryId = `test-single-entry-${Date.now()}`;
    await setupSession(singleEntryId, [{ type: "input", content: "hello" }]);
    await setupSession(TEST_SESSION_ID, [
      { type: "input", content: "hello" },
      { type: "assistant", content: "world" },
    ]);

    try {
      const cli = { sessionId: null, wantsJson: true, toolIndex: false, colors: false, theme: "dark", args: ["show"] };
      const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(output.trim());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.find((s: any) => s.id === singleEntryId)).toBeUndefined();
      expect(parsed.find((s: any) => s.id === TEST_SESSION_ID)).toBeDefined();
    } finally {
      try { rmSync(join(sessionsDirPath, `${singleEntryId}.jsonl`)); } catch {}
    }
  });
});

// ── reviewSession ───────────────────────────────────────────────────────────

describe("Session Review CLI - reviewSession", () => {
  const sessionsDirPath = sessionsDir();
  const TEST_SESSION_ID = `test-review-session-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(sessionsDirPath, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(join(sessionsDirPath, `${TEST_SESSION_ID}.jsonl`)); } catch {}
  });

  it("returns exit code 1 for non-existent session (JSON)", async () => {
    const cli = { sessionId: "non-existent-session-xyz", wantsJson: true, toolIndex: false, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(1);
    expect(output.trim()).toBe("{}");
  });

  it("returns exit code 1 for non-existent session (text)", async () => {
    const cli = { sessionId: "non-existent-session-xyz", wantsJson: false, toolIndex: false, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(1);
    expect(output).toContain("not found or empty");
  });

  it("reviews session with JSON output", async () => {
    await setupSession(TEST_SESSION_ID, [
      { type: "input", content: "hello" },
      { type: "assistant", content: "world" },
    ]);

    const cli = { sessionId: TEST_SESSION_ID, wantsJson: true, toolIndex: false, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(output.trim());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
  });

  it("reviews session with text output showing different source types", async () => {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeSystemPrompt("You are a test agent");
    await log.writeInput("hello");
    await log.writeAssistant("thinking...");
    await log.writeAssistant("running", [{ id: "tc_1", type: "function", function: { name: "bash", arguments: "ls" } }]);
    await log.writeToolResult("<output>done</output>", "tc_1", "bash");

    const cli = { sessionId: TEST_SESSION_ID, wantsJson: false, toolIndex: false, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(0);
    expect(output).toContain("=== Session:");
    expect(output).toContain("[SYSTEM]");
    expect(output).toContain("[USER]");
    expect(output).toContain("[ASSISTANT]");
    expect(output).toContain("[TOOL: bash]");
  });

  it("reviews session with --tool-index flag (JSON)", async () => {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("run bash");
    await log.writeAssistant("running", [{ id: "tc_1", type: "function", function: { name: "bash", arguments: "ls" } }]);
    await log.writeToolResult("<output>done</output>", "tc_1", "bash");
    await log.writeAssistant("running again", [{ id: "tc_2", type: "function", function: { name: "read", arguments: '{"path": "test.txt"}' } }]);
    await log.writeToolResult("<output>content</output>", "tc_2", "read");
    await log.writeAssistant("done");

    const cli = { sessionId: TEST_SESSION_ID, wantsJson: true, toolIndex: true, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(output.trim());
    expect(parsed).toHaveProperty("bash");
    expect(parsed).toHaveProperty("read");
  });

  it("reviews session with --tool-index flag (text)", async () => {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("run bash");
    await log.writeAssistant("running", [{ id: "tc_1", type: "function", function: { name: "bash", arguments: "ls" } }]);
    await log.writeToolResult("<output>done</output>", "tc_1", "bash");

    const cli = { sessionId: TEST_SESSION_ID, wantsJson: false, toolIndex: true, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(0);
    expect(output).toContain("=== Tool Usage ===");
    expect(output).toContain("bash: 1x");
  });

  it("tool-index shows 'No tools used' when no tools", async () => {
    await setupSession(TEST_SESSION_ID, [
      { type: "input", content: "hello" },
      { type: "assistant", content: "world" },
    ]);

    const cli = { sessionId: TEST_SESSION_ID, wantsJson: false, toolIndex: true, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(0);
    expect(output).toContain("No tools used");
  });

  it("tool-index JSON output for session with no tools", async () => {
    await setupSession(TEST_SESSION_ID, [
      { type: "input", content: "hello" },
      { type: "assistant", content: "world" },
    ]);

    const cli = { sessionId: TEST_SESSION_ID, wantsJson: true, toolIndex: true, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(output.trim());
    expect(Object.keys(parsed).length).toBe(0);
  });
});

// ── sessions delete ─────────────────────────────────────────────────────────

describe("Session Review CLI - sessions delete", () => {
  const sessionsDirPath = sessionsDir();
  const TEST_SESSION_ID = `test-review-delete-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(sessionsDirPath, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(join(sessionsDirPath, `${TEST_SESSION_ID}.jsonl`)); } catch {}
  });

  it("deletes an existing session with --yes", async () => {
    await setupSession(TEST_SESSION_ID, [
      { type: "input", content: "hello" },
      { type: "assistant", content: "world" },
    ]);

    const cli = { args: ["delete", TEST_SESSION_ID], yes: true, colors: false, theme: "dark" };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(0);
    expect(output).toContain(`Deleted session '${TEST_SESSION_ID}'.`);

    const files = readdirSync(sessionsDirPath).filter((f: string) => f.endsWith(".jsonl"));
    expect(files.find((f: string) => f.startsWith(TEST_SESSION_ID))).toBeUndefined();
  });

  it("returns exit code 1 for non-existent session", async () => {
    const cli = { args: ["delete", "non-existent-session"], yes: true, colors: false, theme: "dark" };
    let captured = "";
    const origErr = console.error;
    console.error = (msg: unknown) => { captured += String(msg) + "\n"; };
    try {
      const exitCode = await runHandler(cli);
      expect(exitCode).toBe(1);
      expect(captured).toContain("not found");
    } finally {
      console.error = origErr;
    }
  });

  it("returns exit code 1 when no session id provided", async () => {
    const cli = { args: ["delete"], yes: true, colors: false, theme: "dark" };
    let captured = "";
    const origErr = console.error;
    console.error = (msg: unknown) => { captured += String(msg) + "\n"; };
    try {
      const exitCode = await runHandler(cli);
      expect(exitCode).toBe(1);
      expect(captured).toContain("Usage:");
    } finally {
      console.error = origErr;
    }
  });
});

// ── sessions cleanup ────────────────────────────────────────────────────────

describe("Session Review CLI - sessions cleanup", () => {
  const sessionsDirPath = sessionsDir();
  const OLD_SESSION_ID = `test-cleanup-old-${Date.now()}`;
  const NEW_SESSION_ID = `test-cleanup-new-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(sessionsDirPath, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(join(sessionsDirPath, `${OLD_SESSION_ID}.jsonl`)); } catch {}
    try { rmSync(join(sessionsDirPath, `${NEW_SESSION_ID}.jsonl`)); } catch {}
  });

  it("removes old sessions with --yes", async () => {
    await setupSession(NEW_SESSION_ID, [
      { type: "input", content: "hello" },
      { type: "assistant", content: "world" },
    ]);
    await setupSession(OLD_SESSION_ID, [
      { type: "input", content: "old" },
      { type: "assistant", content: "data" },
    ]);

    // Make the old session file appear old
    const oldPath = join(sessionsDirPath, `${OLD_SESSION_ID}.jsonl`);
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(oldPath, oldDate, oldDate);

    const cli = { args: ["cleanup"], olderThan: 30, yes: true, colors: false, theme: "dark" };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(0);
    expect(output).toContain("Deleted 1 session");

    const files = readdirSync(sessionsDirPath).filter((f: string) =>
      f.endsWith(".jsonl") && (f.startsWith(OLD_SESSION_ID) || f.startsWith(NEW_SESSION_ID))
    );
    expect(files.length).toBe(1);
    expect(files[0]).toContain(NEW_SESSION_ID);
  });

  it("reports nothing to clean when all sessions are recent", async () => {
    await setupSession(NEW_SESSION_ID, [
      { type: "input", content: "hello" },
      { type: "assistant", content: "world" },
    ]);

    const cli = { args: ["cleanup"], olderThan: 30, yes: true, colors: false, theme: "dark" };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(0);
    expect(output).toContain("No sessions older than 30 days");
  });
});

// ── review tool registration ────────────────────────────────────────────────

describe("Session Review CLI - registers review tool", () => {
  it("registers review tool via TOOLS_REGISTER hook", async () => {
    const core = createMockCore() as unknown as CoreContext;
    const ext = createSessionReview(core);
    await ext.hooks![HOOKS.TOOLS_REGISTER]!({
      register: core.toolRegistry.register.bind(core.toolRegistry),
    } as any);

    expect(core.toolRegistry.has("review")).toBe(true);
  });
});

// ── edge cases ──────────────────────────────────────────────────────────────

describe("Session Review CLI - edge cases", () => {
  const sessionsDirPath = sessionsDir();
  const TEST_SESSION_ID = `test-review-edge-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(sessionsDirPath, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(join(sessionsDirPath, `${TEST_SESSION_ID}.jsonl`)); } catch {}
  });

  it("returns exit code 1 for unknown sessions action", async () => {
    const cli = { args: ["unknown-action"], colors: false, theme: "dark" };
    let captured = "";
    const origErr = console.error;
    console.error = (msg: unknown) => { captured += String(msg) + "\n"; };
    try {
      const exitCode = await runHandler(cli);
      expect(exitCode).toBe(1);
      expect(captured).toContain("Unknown sessions action");
    } finally {
      console.error = origErr;
    }
  });

  it("shows tool-index for most recent session without --session-id", async () => {
    await setupSession(TEST_SESSION_ID, [
      { type: "input", content: "hello" },
      { type: "assistant", content: "world" },
    ]);

    const cli = { sessionId: null, wantsJson: false, toolIndex: true, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(0);
    expect(output).toContain("=== Tool Usage ===");
    expect(output).toContain("No tools used");
  });

  it("shows tool-index JSON for most recent session without --session-id", async () => {
    await setupSession(TEST_SESSION_ID, [
      { type: "input", content: "hello" },
      { type: "assistant", content: "world" },
    ]);

    const cli = { sessionId: null, wantsJson: true, toolIndex: true, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(output.trim());
    expect(typeof parsed).toBe("object");
  });

  it("lists sessions as JSON when no sessions exist", async () => {
    // Clear all test sessions
    const files = readdirSync(sessionsDirPath).filter((f: string) => f.endsWith(".jsonl"));
    for (const f of files) {
      try { rmSync(join(sessionsDirPath, f)); } catch {}
    }

    const cli = { sessionId: null, wantsJson: true, toolIndex: false, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(1);
    expect(output.trim()).toBe("[]");
  });

  it("lists sessions as text when no sessions exist", async () => {
    // Clear all test sessions
    const files = readdirSync(sessionsDirPath).filter((f: string) => f.endsWith(".jsonl"));
    for (const f of files) {
      try { rmSync(join(sessionsDirPath, f)); } catch {}
    }

    const cli = { sessionId: null, wantsJson: false, toolIndex: false, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(1);
    expect(output).toContain("No log entries found");
  });

  it("cleanup handles missing sessions directory", async () => {
    const originalDir = process.env.HOTDOG_SESSIONS_DIR;
    try {
      process.env.HOTDOG_SESSIONS_DIR = "/nonexistent/path/for/testing";
      const cli = { args: ["cleanup"], olderThan: 30, yes: true, colors: false, theme: "dark" };
      const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
      expect(exitCode).toBe(0);
      expect(output).toContain("No sessions directory found");
    } finally {
      process.env.HOTDOG_SESSIONS_DIR = originalDir;
    }
  });

  it("cleanup respects custom --older-than value", async () => {
    const OLD_SESSION_ID = `test-cleanup-custom-${Date.now()}`;
    try {
      await setupSession(OLD_SESSION_ID, [
        { type: "input", content: "old" },
        { type: "assistant", content: "data" },
      ]);

      // Make the session file appear 5 days old
      const oldPath = join(sessionsDirPath, `${OLD_SESSION_ID}.jsonl`);
      const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      utimesSync(oldPath, oldDate, oldDate);

      // With olderThan=3, it should be deleted (5 > 3)
      const cli = { args: ["cleanup"], olderThan: 3, yes: true, colors: false, theme: "dark" };
      const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
      expect(exitCode).toBe(0);
      expect(output).toContain("Deleted 1 session");
    } finally {
      try { rmSync(join(sessionsDirPath, `${OLD_SESSION_ID}.jsonl`)); } catch {}
    }
  });

  it("delete prompts for confirmation when not in --yes mode (non-TTY)", async () => {
    const TEST_DELETE_ID = `test-review-delete-prompt-${Date.now()}`;
    await setupSession(TEST_DELETE_ID, [
      { type: "input", content: "hello" },
      { type: "assistant", content: "world" },
    ]);

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    try {
      // In non-TTY mode, confirm() returns false, so delete should be aborted
      const cli = { args: ["delete", TEST_DELETE_ID], yes: false, colors: false, theme: "dark" };
      const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
      expect(exitCode).toBe(0);
      expect(output).toContain("Aborted");

      // Session should still exist
      const files = readdirSync(sessionsDirPath).filter((f: string) =>
        f.startsWith(TEST_DELETE_ID)
      );
      expect(files.length).toBe(1);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
      try { rmSync(join(sessionsDirPath, `${TEST_DELETE_ID}.jsonl`)); } catch {}
    }
  });

  it("tool-index without --session-id shows 'No sessions found' when empty dir", async () => {
    // Clear all sessions
    const files = readdirSync(sessionsDirPath).filter((f: string) => f.endsWith(".jsonl"));
    for (const f of files) {
      try { rmSync(join(sessionsDirPath, f)); } catch {}
    }

    const cli = { sessionId: null, wantsJson: false, toolIndex: true, colors: false, theme: "dark", args: ["show"] };
    const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
    expect(exitCode).toBe(1);
    expect(output).toContain("No sessions found");
  });

  it("listSessions JSON output when sessions dir doesn't exist", async () => {
    const originalDir = process.env.HOTDOG_SESSIONS_DIR;
    try {
      process.env.HOTDOG_SESSIONS_DIR = "/nonexistent/path/for/testing/list";
      const cli = { sessionId: null, wantsJson: true, toolIndex: false, colors: false, theme: "dark", args: ["show"] };
      const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
      expect(exitCode).toBe(1);
      expect(output.trim()).toBe("[]");
    } finally {
      process.env.HOTDOG_SESSIONS_DIR = originalDir;
    }
  });

  it("listSessions returns empty when all sessions have only 1 entry (JSON)", async () => {
    const singleEntryId = `test-single-entry-only-${Date.now()}`;
    await setupSession(singleEntryId, [{ type: "input", content: "hello" }]);

    try {
      const cli = { sessionId: null, wantsJson: true, toolIndex: false, colors: false, theme: "dark", args: ["show"] };
      const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
      expect(exitCode).toBe(1);
      expect(output.trim()).toBe("[]");
    } finally {
      try { rmSync(join(sessionsDirPath, `${singleEntryId}.jsonl`)); } catch {}
    }
  });

  it("cleanup prompts for confirmation when not in --yes mode (non-TTY)", async () => {
    const OLD_SESSION_ID = `test-cleanup-confirm-${Date.now()}`;
    await setupSession(OLD_SESSION_ID, [
      { type: "input", content: "old" },
      { type: "assistant", content: "data" },
    ]);

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    try {
      // Make the session file appear old
      const oldPath = join(sessionsDirPath, `${OLD_SESSION_ID}.jsonl`);
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      utimesSync(oldPath, oldDate, oldDate);

      // In non-TTY mode, confirm() returns false, so cleanup should be aborted
      const cli = { args: ["cleanup"], olderThan: 30, yes: false, colors: false, theme: "dark" };
      const { output, result: exitCode } = await captureConsole(() => runHandler(cli));
      expect(exitCode).toBe(0);
      expect(output).toContain("Aborted");

      // Session should still exist
      const files = readdirSync(sessionsDirPath).filter((f: string) =>
        f.startsWith(OLD_SESSION_ID)
      );
      expect(files.length).toBe(1);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
      try { rmSync(join(sessionsDirPath, `${OLD_SESSION_ID}.jsonl`)); } catch {}
    }
  });
});
