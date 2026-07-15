// Tests for the session-log extension create() function — hooks and readEntries.
// This complements session-log.test.ts which tests the SessionLog class.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { create, readSessionEntries, LOG_SOURCE } from "../../src/extensions/session-log/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { createMockCore } from "../helpers.ts";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CACHE_DIR = join(homedir(), ".cache", "hotdog", "sessions");

function setupTestDir(sessionId: string) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function cleanupTestFile(sessionId: string) {
  try { rmSync(join(CACHE_DIR, `${sessionId}.jsonl`)); } catch {}
}

describe("session-log extension create()", () => {
  beforeEach(() => {
    setupTestDir("test-session");
  });

  it("returns extension with hooks", async () => {
    const ext = await create(createMockCore() as any) as any;
    expect(ext.hooks).toBeDefined();
    expect(ext.hooks[HOOKS.CONTEXT_MESSAGE]).toBeDefined();
    expect(ext.hooks[HOOKS.OUTPUT_EVENT]).toBeDefined();
    expect(ext.hooks[HOOKS.SESSION_RESTORE_ACTIVE]).toBeDefined();
  });

  it("CONTEXT_MESSAGE hook logs assistant messages with LLM source", async () => {
    const sessionId = `test-assistant-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;

      await hook({
        message: { sessionId, role: "assistant", content: "Hello!" },
        agent: { sessionId },
      });

      const content = readFileSync(join(CACHE_DIR, `${sessionId}.jsonl`), "utf-8");
      const entry = JSON.parse(content.trim());
      expect(entry.source).toBe(LOG_SOURCE.LLM);
      expect(entry.content).toBe("Hello!");
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("CONTEXT_MESSAGE hook logs system messages as INPUT source", async () => {
    const sessionId = `test-system-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;

      await hook({
        message: { sessionId, role: "system", content: "System message" },
        agent: { sessionId },
      });

      const content = readFileSync(join(CACHE_DIR, `${sessionId}.jsonl`), "utf-8");
      const entry = JSON.parse(content.trim());
      expect(entry.source).toBe(LOG_SOURCE.INPUT);
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("CONTEXT_MESSAGE hook skips logging during restoration", async () => {
    const sessionId = `test-restoring-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const restoreHook = ext.hooks[HOOKS.SESSION_RESTORE_ACTIVE] as (ctx: any) => void;
      const messageHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;

      // Activate restoration mode
      restoreHook({ isRestoring: true });

      await messageHook({
        message: { sessionId, role: "user", content: "Should be skipped" },
        agent: { sessionId },
      });

      // File should not exist since message was skipped
      const entries = await readSessionEntries(sessionId);
      expect(entries).toEqual([]);
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("readEntries() returns entries for the last session", async () => {
    const sessionId = `test-readentries-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;

      await hook({
        message: { sessionId, role: "user", content: "Message 1" },
        agent: { sessionId },
      });
      await hook({
        message: { sessionId, role: "assistant", content: "Response 1" },
        agent: { sessionId },
      });

      const entries = await ext.readEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].content).toBe("Message 1");
      expect(entries[1].content).toBe("Response 1");
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("readEntries() returns empty array when no session ID tracked", async () => {
    const ext = await create(createMockCore() as any) as any;
    const entries = await ext.readEntries();
    expect(entries).toEqual([]);
  });

  it("readEntries() returns empty array when log file does not exist", async () => {
    const ext = await create(createMockCore() as any) as any;
    const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;

    // Trigger hook to set lastSessionId but don't write any entries
    const sessionId = `test-no-file-${Date.now()}`;
    cleanupTestFile(sessionId);

    // We need to set lastSessionId indirectly - use a unique session that doesn't have a file
    await hook({
      message: { sessionId, role: "user", content: "test" },
      agent: { sessionId },
    });

    // Now delete the file
    cleanupTestFile(sessionId);

    const entries = await ext.readEntries();
    expect(entries).toEqual([]);
  });

  it("getLogPath() returns path for last session", async () => {
    const sessionId = `test-logpath-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;

      await hook({
        message: { sessionId, role: "user", content: "test" },
        agent: { sessionId },
      });

      const logPath = ext.getLogPath();
      expect(logPath).toContain(sessionId);
      expect(logPath).toContain(".jsonl");
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("getLogPath() returns null when no session ID tracked", async () => {
    const ext = await create(createMockCore() as any) as any;
    expect(ext.getLogPath()).toBeNull();
  });

  it("OUTPUT_EVENT hook logs compaction results", async () => {
    const sessionId = `test-compaction-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.OUTPUT_EVENT] as (ctx: any) => Promise<void>;

      await hook({
        type: "compaction_result",
        data: { summary: "Summarized", messagesCompacted: 10 },
        agent: { sessionId },
      });

      const content = readFileSync(join(CACHE_DIR, `${sessionId}.jsonl`), "utf-8");
      const entry = JSON.parse(content.trim());
      expect(entry.source).toBe(LOG_SOURCE.COMPACTION);
      expect(entry.summary).toBe("Summarized");
      expect(entry.messages_compacted).toBe(10);
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("OUTPUT_EVENT hook ignores non-compaction events", async () => {
    const sessionId = `test-noncompaction-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.OUTPUT_EVENT] as (ctx: any) => Promise<void>;

      await hook({
        type: "some_other_event",
        data: {},
        agent: { sessionId },
      });

      const entries = await readSessionEntries(sessionId);
      expect(entries).toEqual([]);
    } finally {
      cleanupTestFile(sessionId);
    }
  });
});
