// Tests for session-log extension create() function and LOG_SOURCE.

import { describe, it, expect } from "bun:test";
import {
  LOG_SOURCE,
  disabledSessionLog,
  readSessionEntries,
} from "../../src/extensions/session-log/index.js";
import { setupSessionTestDir, cleanupSessionTest } from "../helpers.js";

const TEST_SESSION_ID = "test-session-ext";

function setupTestDir() {
  setupSessionTestDir(TEST_SESSION_ID);
}

function teardown() {
  cleanupSessionTest(TEST_SESSION_ID);
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
  it("returns a no-op object with correct properties", () => {
    const log = disabledSessionLog();
    expect(log.sessionId).toBeNull();
    expect(log.logPath).toBeNull();
    expect(log.readEntries()).toEqual([]);
    expect(log.getLogPath()).toBeNull();
  });
});

describe("session-log extension create()", () => {
  let ext, core;

  async function createExt() {
    const { create } = await import("../../src/extensions/session-log/index.js");
    core = { hooks: {} };
    return create(core);
  }

  it("returns hooks for CONTEXT_MESSAGE and OUTPUT_EVENT", async () => {
    ext = await createExt();
    expect(ext.hooks).toBeDefined();
    expect(ext.hooks["context:message"]).toBeDefined();
    expect(ext.hooks["output:event"]).toBeDefined();
    expect(ext.hooks["session:restoreActive"]).toBeDefined();
  });

  // Parameterized CONTEXT_MESSAGE hook tests for different message roles
  const messageScenarios = [
    { role: "user", content: "Hello", expectedSource: "input" },
    { role: "assistant", content: "I can help", expectedSource: "llm" },
    { role: "tool", content: "ls output", toolCallId: "tc1", expectedSource: "tool_result" },
  ];

  for (const scenario of messageScenarios) {
    it(`CONTEXT_MESSAGE hook logs ${scenario.role} messages with ${scenario.expectedSource} source`, async () => {
      setupTestDir();
      try {
        ext = await createExt();

        await ext.hooks["context:message"]({
          message: { role: scenario.role, content: scenario.content, sessionId: TEST_SESSION_ID, ...scenario },
          agent: { sessionId: TEST_SESSION_ID },
        });

        const entries = await readSessionEntries(TEST_SESSION_ID);
        expect(entries.length).toBeGreaterThanOrEqual(1);
        const lastEntry = entries[entries.length - 1];
        expect(lastEntry.source).toBe(scenario.expectedSource);
        expect(lastEntry.content).toBe(scenario.content);
      } finally {
        teardown();
      }
    });
  }

  it("OUTPUT_EVENT hook logs compaction results", async () => {
    setupTestDir();
    try {
      ext = await createExt();

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
      ext = await createExt();

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
      ext = await createExt();

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
      ext = await createExt();

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