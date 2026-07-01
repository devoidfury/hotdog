// Tests for session-log extension create() function and LOG_SOURCE.

import { describe, it, expect } from "bun:test";
import {
  LOG_SOURCE,
  disabledSessionLog,
  readSessionEntries,
} from "../../src/extensions/session-log/index.js";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_SESSION_ID = "test-session-ext";

function setupTestDir() {
  const dir = join(homedir(), ".cache", "oa-agent", "sessions");
  mkdirSync(dir, { recursive: true });
  const testFile = join(dir, `${TEST_SESSION_ID}.jsonl`);
  try {
    rmSync(testFile);
  } catch {
    // doesn't exist yet
  }
}

function teardown() {
  const testFile = join(homedir(), ".cache", "oa-agent", "sessions", `${TEST_SESSION_ID}.jsonl`);
  try {
    rmSync(testFile);
  } catch {
    // ignore
  }
}

describe("LOG_SOURCE constants", () => {
  it("has all expected source types", () => {
    expect(LOG_SOURCE.SYSTEM_PROMPT).toBe("system_prompt");
    expect(LOG_SOURCE.INPUT).toBe("input");
    expect(LOG_SOURCE.LLM).toBe("llm");
    expect(LOG_SOURCE.TOOL_RESULT).toBe("tool_result");
    expect(LOG_SOURCE.RESET).toBe("reset");
    expect(LOG_SOURCE.COMPACTION).toBe("compaction");
    expect(LOG_SOURCE.PROMPT).toBe("prompt");
  });
});

describe("disabledSessionLog", () => {
  it("returns a no-op object with all expected methods", () => {
    const log = disabledSessionLog();
    expect(log.sessionId).toBeNull();
    expect(log.logPath).toBeNull();
    expect(typeof log.writeInput).toBe("function");
    expect(typeof log.writeSystemPrompt).toBe("function");
    expect(typeof log.writeAssistant).toBe("function");
    expect(typeof log.writeToolResult).toBe("function");
    expect(typeof log.writeReset).toBe("function");
    expect(typeof log.readEntries).toBe("function");
    expect(typeof log.getLogPath).toBe("function");
  });

  it("readEntries returns empty array", () => {
    const log = disabledSessionLog();
    expect(log.readEntries()).toEqual([]);
  });

  it("getLogPath returns null", () => {
    const log = disabledSessionLog();
    expect(log.getLogPath()).toBeNull();
  });

  it("write methods are no-ops", () => {
    const log = disabledSessionLog();
    expect(() => log.writeInput("test")).not.toThrow();
    expect(() => log.writeSystemPrompt("test")).not.toThrow();
    expect(() => log.writeAssistant("test")).not.toThrow();
    expect(() => log.writeToolResult("test", "tc1", "bash")).not.toThrow();
    expect(() => log.writeReset()).not.toThrow();
  });
});

describe("session-log extension create()", () => {
  it("returns hooks for CONTEXT_MESSAGE and OUTPUT_EVENT", async () => {
    const { create } = await import("../../src/extensions/session-log/index.js");
    const core = { hooks: {} };
    const ext = await create(core);
    expect(ext.hooks).toBeDefined();
    expect(ext.hooks["context:message"]).toBeDefined();
    expect(ext.hooks["output:event"]).toBeDefined();
    expect(ext.hooks["session:restoreActive"]).toBeDefined();
  });

  it("CONTEXT_MESSAGE hook logs user messages with INPUT source", async () => {
    setupTestDir();
    try {
      const { create } = await import("../../src/extensions/session-log/index.js");
      const core = { hooks: {} };
      const ext = await create(core);

      await ext.hooks["context:message"]({
        message: { role: "user", content: "Hello", sessionId: TEST_SESSION_ID },
        agent: { sessionId: TEST_SESSION_ID },
      });

      const entries = await readSessionEntries(TEST_SESSION_ID);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const lastEntry = entries[entries.length - 1];
      expect(lastEntry.source).toBe("input");
      expect(lastEntry.content).toBe("Hello");
    } finally {
      teardown();
    }
  });

  it("CONTEXT_MESSAGE hook logs assistant messages with LLM source", async () => {
    setupTestDir();
    try {
      const { create } = await import("../../src/extensions/session-log/index.js");
      const core = { hooks: {} };
      const ext = await create(core);

      await ext.hooks["context:message"]({
        message: { role: "assistant", content: "I can help", sessionId: TEST_SESSION_ID },
        agent: { sessionId: TEST_SESSION_ID },
      });

      const entries = await readSessionEntries(TEST_SESSION_ID);
      const lastEntry = entries[entries.length - 1];
      expect(lastEntry.source).toBe("llm");
    } finally {
      teardown();
    }
  });

  it("CONTEXT_MESSAGE hook logs tool messages with TOOL_RESULT source", async () => {
    setupTestDir();
    try {
      const { create } = await import("../../src/extensions/session-log/index.js");
      const core = { hooks: {} };
      const ext = await create(core);

      await ext.hooks["context:message"]({
        message: { role: "tool", content: "ls output", toolCallId: "tc1", sessionId: TEST_SESSION_ID },
        agent: { sessionId: TEST_SESSION_ID },
      });

      const entries = await readSessionEntries(TEST_SESSION_ID);
      const lastEntry = entries[entries.length - 1];
      expect(lastEntry.source).toBe("tool_result");
    } finally {
      teardown();
    }
  });

  it("CONTEXT_MESSAGE hook uses agent sessionId for log file path", async () => {
    setupTestDir();
    try {
      const { create } = await import("../../src/extensions/session-log/index.js");
      const core = { hooks: {} };
      const ext = await create(core);

      // The hook uses agent.sessionId for the log file path,
      // and message.sessionId for the log entry's session_id field.
      // Both should be consistent for correct logging.
      await ext.hooks["context:message"]({
        message: { role: "user", content: "Hello", sessionId: TEST_SESSION_ID },
        agent: { sessionId: TEST_SESSION_ID },
      });

      // Verify the log was written to the correct file (based on agent.sessionId)
      const entries = await readSessionEntries(TEST_SESSION_ID);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[entries.length - 1].content).toBe("Hello");
    } finally {
      teardown();
    }
  });

  it("OUTPUT_EVENT hook logs compaction results", async () => {
    setupTestDir();
    try {
      const { create } = await import("../../src/extensions/session-log/index.js");
      const core = { hooks: {} };
      const ext = await create(core);

      await ext.hooks["output:event"]({
        type: "compaction_result",
        data: { summary: "Conversation summary", messagesCompacted: 10 },
        agent: { sessionId: TEST_SESSION_ID },
      });

      const entries = await readSessionEntries(TEST_SESSION_ID);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const lastEntry = entries[entries.length - 1];
      expect(lastEntry.source).toBe("compaction");
      expect(lastEntry.summary).toBe("Conversation summary");
      expect(lastEntry.messages_compacted).toBe(10);
    } finally {
      teardown();
    }
  });

  it("OUTPUT_EVENT hook ignores non-compaction events", async () => {
    setupTestDir();
    try {
      const { create } = await import("../../src/extensions/session-log/index.js");
      const core = { hooks: {} };
      const ext = await create(core);

      // Write a message first so we know the entry count
      await ext.hooks["context:message"]({
        message: { role: "user", content: "test", sessionId: TEST_SESSION_ID },
        agent: { sessionId: TEST_SESSION_ID },
      });

      const beforeCount = await readSessionEntries(TEST_SESSION_ID).then(e => e.length);

      await ext.hooks["output:event"]({
        type: "token_usage",
        data: { prompt_tokens: 10 },
        agent: { sessionId: TEST_SESSION_ID },
      });

      const afterCount = await readSessionEntries(TEST_SESSION_ID).then(e => e.length);
      expect(afterCount).toBe(beforeCount);
    } finally {
      teardown();
    }
  });

  it("getLogPath returns the path for the last session", async () => {
    setupTestDir();
    try {
      const { create } = await import("../../src/extensions/session-log/index.js");
      const core = { hooks: {} };
      const ext = await create(core);

      expect(ext.getLogPath()).toBeNull();

      await ext.hooks["context:message"]({
        message: { role: "user", content: "Hello" },
        agent: { sessionId: TEST_SESSION_ID },
      });

      const logPath = ext.getLogPath();
      expect(logPath).toContain(TEST_SESSION_ID);
      expect(logPath).toMatch(/\.jsonl$/);
    } finally {
      teardown();
    }
  });

  it("SESSION_RESTORE_ACTIVE hook tracks restoring state", async () => {
    setupTestDir();
    try {
      const { create } = await import("../../src/extensions/session-log/index.js");
      const core = { hooks: {} };
      const ext = await create(core);

      // Enable restoring mode
      ext.hooks["session:restoreActive"]({ isRestoring: true });

      const beforeCount = await readSessionEntries(TEST_SESSION_ID).then(e => e.length);

      // Messages during restoration should not be logged
      await ext.hooks["context:message"]({
        message: { role: "user", content: "restored message", sessionId: TEST_SESSION_ID },
        agent: { sessionId: TEST_SESSION_ID },
      });

      const afterCount = await readSessionEntries(TEST_SESSION_ID).then(e => e.length);
      expect(afterCount).toBe(beforeCount);

      // Disable restoring mode
      ext.hooks["session:restoreActive"]({ isRestoring: false });

      // Now messages should be logged again
      await ext.hooks["context:message"]({
        message: { role: "user", content: "after restore", sessionId: TEST_SESSION_ID },
        agent: { sessionId: TEST_SESSION_ID },
      });

      const finalCount = await readSessionEntries(TEST_SESSION_ID).then(e => e.length);
      expect(finalCount).toBe(beforeCount + 1);
    } finally {
      teardown();
    }
  });
});
