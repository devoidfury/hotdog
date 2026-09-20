// Tests for the session-log extension create() function — hooks and readEntries.
// This complements session-log.test.ts which tests the core session log read/replay functions.
//
// Session files are written to an isolated temp dir (HOTDOG_SESSIONS_DIR),
// so tests never touch the real ~/.cache/hotdog/sessions directory.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { create } from "@extensions/session-log/index.ts";
import { readSessionEntries, LOG_SOURCE } from "@core/session/session-log.ts";
import { HOOKS } from "@core/hooks.ts";
import { createMockCore } from "../helpers.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

const SESSIONS_DIR = mkdtempSync(join(os.tmpdir(), "hotdog-sessions-ext-"));

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = SESSIONS_DIR;
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  try { rmSync(SESSIONS_DIR, { recursive: true, force: true }); } catch {}
});

/** Each test gets a unique session id; the file is removed afterwards. */
function cleanupTestFile(sessionId: string) {
  try { rmSync(join(SESSIONS_DIR, `${sessionId}.jsonl`)); } catch {}
}

describe("session-log extension create()", () => {
  it("CONTEXT_MESSAGE hook logs messages with the correct source per role", async () => {
    const sessionId = `test-roles-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;

      await hook({
        message: { sessionId, role: "assistant", content: "Hello!" },
        agent: { sessionId },
      });
      await hook({
        message: { sessionId, role: "system", content: "System message" },
        agent: { sessionId },
      });
      await hook({
        message: { sessionId, role: "tool", content: "Tool output", toolCallId: "call_1" },
        agent: { sessionId },
      });

      const entries = await readSessionEntries(sessionId);
      expect(entries).toHaveLength(3);
      expect(entries[0]!.source).toBe(LOG_SOURCE.LLM);
      expect(entries[0]!.content).toBe("Hello!");
      expect(entries[1]!.source).toBe(LOG_SOURCE.INPUT);
      expect(entries[2]!.source).toBe(LOG_SOURCE.TOOL_RESULT);
      expect(entries[2]!.tool_call_id).toBe("call_1");
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("CONTEXT_MESSAGE hook records harness provenance as origin", async () => {
    const sessionId = `test-harness-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;

      await hook({
        message: { sessionId, role: "user", content: "[Task t1 completed]\ndone", source: "harness" },
        agent: { sessionId },
      });
      await hook({
        message: { sessionId, role: "user", content: "plain input" },
        agent: { sessionId },
      });
      await hook({
        message: { sessionId, role: "assistant", content: "assistant reply", source: "model" },
        agent: { sessionId },
      });
      await hook({
        message: { sessionId, role: "harness", content: "turn guard", source: "harness" },
        agent: { sessionId },
      });

      const entries = await readSessionEntries(sessionId);
      expect(entries).toHaveLength(4);
      // Harness-sourced message carries origin; plain input does not;
      // LLM output is tagged "model"; harness-role messages log as INPUT
      // channel with their role recorded for replay.
      expect(entries[0]!.origin).toBe("harness");
      expect(entries[1]!).not.toHaveProperty("origin");
      expect(entries[2]!.origin).toBe("model");
      expect(entries[3]!.source).toBe("input");
      expect(entries[3]!.role).toBe("harness");
      expect(entries[3]!.origin).toBe("harness");
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("CONTEXT_MESSAGE hook persists raw parts for harness messages with untrusted content", async () => {
    const sessionId = `test-harness-parts-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;

      const parts = [
        { type: "text", text: "[Task t1 completed]\n" },
        { type: "untrusted", text: "model output with <raw> markers" },
      ];
      await hook({
        message: { sessionId, role: "harness", content: parts, source: "harness", getTextContent: () => "[Task t1 completed]\nmodel output with <raw> markers" },
        agent: { sessionId },
      });

      const entries = await readSessionEntries(sessionId);
      expect(entries).toHaveLength(1);
      // Structure survives on disk raw, for replay to re-mangle at the wire.
      expect(entries[0]!.content).toEqual(parts);
      expect(entries[0]!.origin).toBe("harness");
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("CONTEXT_MESSAGE hook fills tool_name from the stored tool-result part", async () => {
    const sessionId = `test-tool-name-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;

      const part = {
        type: "tool-result",
        tool: "bash",
        status: "success",
        meta: [["exit_code", "0"]],
        error: null,
        hint: null,
        output: "done",
      };
      await hook({
        message: { sessionId, role: "tool", content: [part], toolCallId: "call_9", source: "tool" },
        agent: { sessionId },
      });
      // Legacy string tool messages (and non-tool messages) keep no name.
      await hook({
        message: { sessionId, role: "tool", content: "old rendered text", toolCallId: "call_10", source: "tool" },
        agent: { sessionId },
      });
      await hook({
        message: { sessionId, role: "user", content: "hi" },
        agent: { sessionId },
      });

      const entries = await readSessionEntries(sessionId);
      expect(entries[0]!.tool_name).toBe("bash");
      // stripNulls drops the key entirely when there is no part to read from.
      expect(entries[1]!.tool_name).toBeUndefined();
      expect(entries[2]!.tool_name).toBeUndefined();
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

  it("OUTPUT_EVENT compaction entry records summary, count, and harness origin", async () => {
    const sessionId = `test-compaction-origin-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.OUTPUT_EVENT] as (ctx: any) => Promise<void>;

      await hook({
        type: "compaction_result",
        data: { summary: "Summarized", messagesCompacted: 10 },
        agent: { sessionId },
      });

      const entries = await readSessionEntries(sessionId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.source).toBe(LOG_SOURCE.COMPACTION);
      expect(entries[0]!.origin).toBe("harness");
      // Content is the harness structure exactly as it enters the context:
      // real wrapper tag parts around the RAW model-generated summary.
      // Never escaped on disk -- the wire serializer mangles the part.
      const tag = "previous-context-summary";
      expect(entries[0]!.content).toEqual([
        { type: "text", text: `<${tag}>` },
        { type: "untrusted", text: "Summarized" },
        { type: "text", text: `</${tag}>` },
      ]);
      expect(entries[0]!.summary).toBe("Summarized");
      expect(entries[0]!.messages_compacted).toBe(10);
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

  it("readEntries() returns empty array when no session ID tracked or log file is missing", async () => {
    const ext = await create(createMockCore() as any) as any;
    expect(await ext.readEntries()).toEqual([]);

    // Trigger the hook to track a session, then delete its log file.
    const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
    const sessionId = `test-no-file-${Date.now()}`;
    await hook({
      message: { sessionId, role: "user", content: "test" },
      agent: { sessionId },
    });
    cleanupTestFile(sessionId);

    expect(await ext.readEntries()).toEqual([]);
  });

  it("getLogPath() tracks the last session or returns null", async () => {
    const ext = await create(createMockCore() as any) as any;
    expect(ext.getLogPath()).toBeNull();

    const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
    const sessionId = `test-logpath-${Date.now()}`;
    try {
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

  it("CONTEXT_MESSAGE hook rejects traversal session ids without writing or throwing", async () => {
    const ext = await create(createMockCore() as any) as any;
    const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
    const badId = "../evil-" + Date.now();
    const outsideFile = join(SESSIONS_DIR, "..", `${badId.slice(3)}.jsonl`);

    try {
      // Must swallow (warn) rather than throw: a hook failure would break the agent loop.
      await expect(hook({ message: { sessionId: badId, role: "user", content: "x" }, agent: { sessionId: badId } })).resolves.toBeUndefined();
      expect(() => readFileSync(outsideFile)).toThrow();
      expect(ext.getLogPath()).toBeNull(); // nothing tracked for a rejected id
    } finally {
      try { rmSync(outsideFile, { force: true }); } catch {}
    }
  });

  it("OUTPUT_EVENT compaction hook rejects traversal session ids without writing", async () => {
    const ext = await create(createMockCore() as any) as any;
    const hook = ext.hooks[HOOKS.OUTPUT_EVENT] as (ctx: any) => Promise<void>;
    const badId = "../evil-compact-" + Date.now();
    const outsideFile = join(SESSIONS_DIR, "..", `${badId.slice(3)}.jsonl`);

    try {
      await expect(hook({
        type: "compaction_result",
        data: { summary: "s", messagesCompacted: 1 },
        agent: { sessionId: badId },
      })).resolves.toBeUndefined();
      expect(() => readFileSync(outsideFile)).toThrow();
    } finally {
      try { rmSync(outsideFile, { force: true }); } catch {}
    }
  });
});

