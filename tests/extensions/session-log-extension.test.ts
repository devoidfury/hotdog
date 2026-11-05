// Tests for the session-log extension create() function — hooks and readEntries.
// This complements session-log.test.ts which tests the core session log read/replay functions.
//
// Session files are written to an isolated temp dir (HOTDOG_SESSIONS_DIR),
// so tests never touch the real ~/.cache/hotdog/sessions directory.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { create } from "@extensions/session-log/index.ts";
import { countSessionLogEntries, readSessionEntries, LOG_SOURCE } from "@core/session/session-log.ts";
import { seedRecordCount, getRecordCount, dropRecordCount } from "@extensions/session-log/record-count.ts";
import { Message, type ImageAttachment } from "@core/context/message.ts";
import { HOOKS } from "@core/hooks.ts";
import { createMockCore, TMP_PARENT } from "../helpers.ts";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SESSIONS_DIR = mkdtempSync(join(TMP_PARENT, "hotdog-sessions-ext-"));

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

      // Activate restoration mode for this session (payload shape matches
      // the core setter: agent + isRestoring; suppression is per-session).
      restoreHook({ agent: { sessionId }, isRestoring: true });

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

  it("noLog: true disables logging entirely", async () => {
    const sessionId = `test-nolog-${Date.now()}`;
    const logFile = join(SESSIONS_DIR, `${sessionId}.jsonl`);
    try {
      const ext = await create(
        createMockCore({ resolved: { noLog: true } }) as any,
      ) as any;

      // Calling the message hook with the instance built from a noLog
      // config must not create a session file.
      const hook = ext.hooks?.[HOOKS.CONTEXT_MESSAGE];
      if (hook) {
        await hook({
          message: { sessionId, role: "user", content: "Should never be logged" },
          agent: { sessionId },
        });
      }

      expect(() => readFileSync(logFile)).toThrow();
      expect(await readSessionEntries(sessionId)).toEqual([]);
    } finally {
      cleanupTestFile(sessionId);
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


describe("CONTEXT_REWOUND checkpointing", () => {
  it("writes a reset entry then re-appends the kept messages; replay sees only the kept set", async () => {
    const sessionId = `test-rewind-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const msgHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
      const rewindHook = ext.hooks[HOOKS.CONTEXT_REWOUND] as (ctx: any) => Promise<void>;

      // Four entries before the rewind.
      for (const m of [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
      ]) {
        await msgHook({ message: m, agent: { sessionId } });
      }

      // Rewind keeps turn 1; the system-role message must not resurface as user input.
      await rewindHook({
        agent: { sessionId },
        newContext: [
          { role: "system", content: "sys prompt" },
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
        ],
      });

      // Replay (readSessionEntries) slices from the last reset.
      const entries = await readSessionEntries(sessionId);
      expect(entries).toHaveLength(2);
      expect(entries[0]!.source).toBe(LOG_SOURCE.INPUT);
      expect(entries[0]!.content).toBe("u1");
      expect(entries[1]!.source).toBe(LOG_SOURCE.LLM);
      expect(entries[1]!.content).toBe("a1");

      // Raw log stays append-only: 4 original + 1 reset + 2 re-appended, with the
      // undone history still present above the marker.
      const raw = readFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(raw).toHaveLength(7);
      expect(raw[4]!.source).toBe("reset");
      expect(raw.map((e) => e.content)).toContain("u2");
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("rewind to empty (clear) checkpoints a bare reset — replay yields nothing", async () => {
    const sessionId = `test-clear-checkpoint-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const msgHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
      const rewindHook = ext.hooks[HOOKS.CONTEXT_REWOUND] as (ctx: any) => Promise<void>;

      await msgHook({ message: { role: "user", content: "u1" }, agent: { sessionId } });
      await rewindHook({ agent: { sessionId }, newContext: [] });

      expect(await readSessionEntries(sessionId)).toHaveLength(0);
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("suppresses checkpointing while a session restore is active", async () => {
    const sessionId = `test-rewind-restore-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const restoreHook = ext.hooks[HOOKS.SESSION_RESTORE_ACTIVE] as (ctx: any) => void;
      const rewindHook = ext.hooks[HOOKS.CONTEXT_REWOUND] as (ctx: any) => Promise<void>;

      restoreHook({ agent: { sessionId }, isRestoring: true });
      await rewindHook({ agent: { sessionId }, newContext: [{ role: "user", content: "u1" }] });
      restoreHook({ agent: { sessionId }, isRestoring: false });

      // Nothing was written at all.
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(SESSIONS_DIR, `${sessionId}.jsonl`))).toBe(false);
    } finally {
      cleanupTestFile(sessionId);
    }
  });
});

describe("write ordering serialization", () => {
  it("floating hook writes land on disk in dispatch order", async () => {
    // addMessage fire-and-forgets notifyHooks, so a /fork's copy loop dispatches
    // many CONTEXT_MESSAGE hooks without awaiting them, then the fork's first
    // prompt enqueues behind them. File order must equal dispatch order, or a
    // resumed fork restores its context scrambled.
    const sessionId = `test-order-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const msgHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;

      const floats: Promise<void>[] = [];
      for (let i = 1; i <= 12; i++) {
        floats.push(msgHook({ message: { role: i % 2 ? "user" : "assistant", content: `m${i}` }, agent: { sessionId } }));
      }
      await Promise.all(floats);

      const raw = readFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(raw.map((e) => e.content)).toEqual(
        Array.from({ length: 12 }, (_, i) => `m${i + 1}`),
      );
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("checkpoint enqueues atomically: a message dispatched mid-rewind lands after the kept history", async () => {
    // rewindHook (floating) then msgHook in the same tick. Without the atomic
    // sync-enqueue, the interleaved message replays between the reset marker
    // and the kept history -- deterministically wrong order, not a timing fluke.
    const sessionId = `test-order-atomic-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const msgHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
      const rewindHook = ext.hooks[HOOKS.CONTEXT_REWOUND] as (ctx: any) => Promise<void>;

      const floats = [
        rewindHook({
          agent: { sessionId },
          newContext: [
            { role: "user", content: "k1" },
            { role: "assistant", content: "k2" },
          ],
        }),
        msgHook({ message: { role: "user", content: "x" }, agent: { sessionId } }),
      ];
      await Promise.all(floats);

      const raw = readFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      // The reset entry carries empty content.
      expect(raw.map((e) => e.content)).toEqual(["", "k1", "k2", "x"]);

      // Replay slices from the reset and sees kept history first, then x.
      const entries = await readSessionEntries(sessionId);
      expect(entries.map((e) => e.content)).toEqual(["k1", "k2", "x"]);
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("SESSION_CREATE hook writes a session_start entry with model and profile", async () => {
    const sessionId = `test-session-start-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.SESSION_CREATE] as (ctx: any) => Promise<void>;

      await hook({
        sessionId,
        config: { model: "prov/my-model", profileName: "coder" },
      });

      const entries = await readSessionEntries(sessionId);
      const startEntry = entries.find((e) => e.source === LOG_SOURCE.SESSION_START);
      expect(startEntry).toBeDefined();
      expect(startEntry!.model).toBe("prov/my-model");
      expect(startEntry!.profile).toBe("coder");
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("PROFILE_SWITCH hook writes a profile_switch entry with from/to profiles", async () => {
    const sessionId = `test-profile-switch-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.PROFILE_SWITCH] as (ctx: any) => Promise<void>;

      await hook({
        agent: { sessionId },
        fromProfile: "default",
        toProfile: "auditor",
      });

      const entries = await readSessionEntries(sessionId);
      const switchEntry = entries.find((e) => e.source === LOG_SOURCE.PROFILE_SWITCH);
      expect(switchEntry).toBeDefined();
      expect(switchEntry!.from_profile).toBe("default");
      expect(switchEntry!.profile).toBe("auditor");
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("PROFILE_SWITCH hook rejects traversal session ids without writing", async () => {
    const ext = await create(createMockCore() as any) as any;
    const hook = ext.hooks[HOOKS.PROFILE_SWITCH] as (ctx: any) => Promise<void>;
    const badId = "../evil-profile-" + Date.now();
    const outsideFile = join(SESSIONS_DIR, "..", `${badId.slice(3)}.jsonl`);

    try {
      await expect(hook({
        agent: { sessionId: badId },
        fromProfile: "default",
        toProfile: "auditor",
      })).resolves.toBeUndefined();
      expect(() => readFileSync(outsideFile)).toThrow();
    } finally {
      try { rmSync(outsideFile, { force: true }); } catch {}
    }
  });

  it("readEntries() drains pending writes before reading", async () => {
    const sessionId = `test-order-drain-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const msgHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;

      // Dispatch without awaiting, then read through the extension immediately.
      const floats: Promise<void>[] = [];
      for (let i = 1; i <= 4; i++) {
        floats.push(msgHook({ message: { role: "user", content: `d${i}` }, agent: { sessionId } }));
      }

      const entries = await ext.readEntries();
      expect(entries.map((e: any) => e.content)).toEqual(["d1", "d2", "d3", "d4"]);
      await Promise.all(floats);
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("OUTPUT_EVENT token_usage writes a token_usage log entry with all token fields", async () => {
    const sessionId = `test-token-usage-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.OUTPUT_EVENT] as (ctx: any) => Promise<void>;

      await hook({
        type: "token_usage",
        data: {
          sessionPromptTokens: 100,
          sessionCachedTokens: 50,
          sessionCompletionTokens: 200,
          sessionTotalTokens: 350,
          turns: 3,
          promptTokens: 100,
          cachedTokens: 50,
          completionTokens: 200,
          totalTokens: 350,
          contextWindow: 128000,
        },
        agent: { sessionId },
      });

      const entries = await readSessionEntries(sessionId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.source).toBe(LOG_SOURCE.TOKEN_USAGE);
      expect(entries[0]!.sessionPromptTokens).toBe(100);
      expect(entries[0]!.sessionCachedTokens).toBe(50);
      expect(entries[0]!.sessionCompletionTokens).toBe(200);
      expect(entries[0]!.sessionTotalTokens).toBe(350);
      expect(entries[0]!.turns).toBe(3);
      expect(entries[0]!.promptTokens).toBe(100);
      expect(entries[0]!.cachedTokens).toBe(50);
      expect(entries[0]!.completionTokens).toBe(200);
      expect(entries[0]!.totalTokens).toBe(350);
      expect(entries[0]!.contextWindow).toBe(128000);
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("OUTPUT_EVENT token_usage persists durationMs beside the usage numbers", async () => {
    const sessionId = `test-token-duration-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.OUTPUT_EVENT] as (ctx: any) => Promise<void>;
      await hook({
        type: "token_usage",
        data: { promptTokens: 10, cachedTokens: 0, completionTokens: 5, totalTokens: 15, contextWindow: 128000, durationMs: 4213 },
        agent: { sessionId },
      });
      const entries = await readSessionEntries(sessionId);
      expect(entries[0]!.durationMs).toBe(4213);
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("token_usage omits durationMs when the event carries none or a non-number", async () => {
    const withGap = `test-token-dur-absent-${Date.now()}`;
    const withNaN = `test-token-dur-nan-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.OUTPUT_EVENT] as (ctx: any) => Promise<void>;
      await hook({
        type: "token_usage",
        data: { promptTokens: 1, cachedTokens: 0, completionTokens: 1, totalTokens: 2, contextWindow: 1000 },
        agent: { sessionId: withGap },
      });
      await hook({
        type: "token_usage",
        data: { promptTokens: 1, cachedTokens: 0, completionTokens: 1, totalTokens: 2, contextWindow: 1000, durationMs: "42" },
        agent: { sessionId: withNaN },
      });
      // Absent/non-finite: the field is NOT written, so old-shape records keep
      // their pre-duration shape and nothing is fabricated onto the log.
      const [e1] = await readSessionEntries(withGap);
      expect("durationMs" in (e1 ?? {})).toBe(false);
      const [e2] = await readSessionEntries(withNaN);
      expect("durationMs" in (e2 ?? {})).toBe(false);
    } finally {
      cleanupTestFile(withGap);
      cleanupTestFile(withNaN);
    }
  });

  it("token_usage lands AFTER the llm row it summarizes (live dispatch order)", async () => {
    // The live agent runs addMessage(assistant) then emitOutput("token_usage");
    // both enter the per-path write queue in that synchronous order, so the
    // persisted usage row must sit directly behind its llm row -- replayed
    // bubbles render at that position.
    const sessionId = `test-usage-order-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const msgHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
      const outHook = ext.hooks[HOOKS.OUTPUT_EVENT] as (ctx: any) => Promise<void>;

      const p1 = msgHook({ message: { role: "assistant", content: "answer" }, agent: { sessionId } });
      const p2 = outHook({
        type: "token_usage",
        data: { promptTokens: 90, cachedTokens: 10, completionTokens: 20, totalTokens: 110, contextWindow: 200000 },
        agent: { sessionId },
      });
      await Promise.all([p1, p2]);

      const entries = await readSessionEntries(sessionId);
      expect(entries.map((e) => e.source)).toEqual([LOG_SOURCE.LLM, LOG_SOURCE.TOKEN_USAGE]);
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("OUTPUT_EVENT token_usage rejects traversal session ids without writing", async () => {
    const ext = await create(createMockCore() as any) as any;
    const hook = ext.hooks[HOOKS.OUTPUT_EVENT] as (ctx: any) => Promise<void>;
    const badId = "../evil-token-" + Date.now();
    const outsideFile = join(SESSIONS_DIR, "..", `${badId.slice(3)}.jsonl`);

    try {
      await expect(hook({
        type: "token_usage",
        data: { promptTokens: 10, cachedTokens: 5, completionTokens: 20, totalTokens: 35, contextWindow: 128000 },
        agent: { sessionId: badId },
      })).resolves.toBeUndefined();
      expect(() => readFileSync(outsideFile)).toThrow();
    } finally {
      try { rmSync(outsideFile, { force: true }); } catch {}
    }
  });
});

describe("system prompt recording", () => {
  // The prompt is built by run() before the first message reaches the
  // context, so the turn-1 record must land above the first input row;
  // dedupe is per session and content-based (model rebuilds re-record).

  it("CONTEXT_MESSAGE records the built prompt above the first message", async () => {
    const sessionId = `test-prompt-first-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
      const agent = { sessionId, context: { getSystemPrompt: () => "You are terse." } };

      await hook({ message: { sessionId, role: "user", content: "hello" }, agent });

      const entries = await readSessionEntries(sessionId);
      expect(entries).toHaveLength(2);
      expect(entries[0]!.source).toBe(LOG_SOURCE.SYSTEM_PROMPT);
      expect(entries[0]!.content).toBe("You are terse.");
      expect(entries[0]!.v).toBe(2);
      expect(entries[1]!.source).toBe(LOG_SOURCE.INPUT);
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("records once: unchanged prompt does not repeat, changed prompt re-records", async () => {
    const sessionId = `test-prompt-dedupe-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
      let prompt = "prompt v1";
      const agent = { sessionId, context: { getSystemPrompt: () => prompt } };

      await hook({ message: { sessionId, role: "user", content: "one" }, agent });
      await hook({ message: { sessionId, role: "assistant", content: "uno" }, agent });
      // Model switch rebuilds the prompt; next message carries the new text.
      prompt = "prompt v2";
      await hook({ message: { sessionId, role: "user", content: "two" }, agent });
      await hook({ message: { sessionId, role: "assistant", content: "dos" }, agent });

      const entries = await readSessionEntries(sessionId);
      const prompts = entries.filter((e) => e.source === LOG_SOURCE.SYSTEM_PROMPT);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]!.content).toBe("prompt v1");
      expect(prompts[1]!.content).toBe("prompt v2");
      // Each prompt sits directly above the message it precedes.
      expect(entries[1]!.content).toBe("one");
      expect(entries.indexOf(prompts[1]!)).toBe(3);
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("TURN_START records a changed prompt even with no message event (continuation)", async () => {
    const sessionId = `test-prompt-turn-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const contextHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
      const turnHook = ext.hooks[HOOKS.TURN_START] as (ctx: any) => Promise<void>;
      const agent = { sessionId, context: { getSystemPrompt: () => "prompt A" } };

      await contextHook({ message: { sessionId, role: "user", content: "go" }, agent });
      // Mid-run model switch: rebuilt prompt, no new user message -- only
      // TURN_START fires (here at iteration 2: no turn_started record).
      const agent2 = { sessionId, context: { getSystemPrompt: () => "prompt B" } };
      await turnHook({ turnIndex: 2, agent: agent2 });

      const entries = await readSessionEntries(sessionId);
      const prompts = entries.filter((e) => e.source === LOG_SOURCE.SYSTEM_PROMPT);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]!.content).toBe("prompt B");
      expect(entries.some((e) => e.source === LOG_SOURCE.TURN_STARTED)).toBe(false);
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("rewind clears the dedupe so the next turn re-records below the reset", async () => {
    const sessionId = `test-prompt-rewind-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const contextHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
      const rewindHook = ext.hooks[HOOKS.CONTEXT_REWOUND] as (ctx: any) => Promise<void>;
      const turnHook = ext.hooks[HOOKS.TURN_START] as (ctx: any) => Promise<void>;
      const agent = { sessionId, context: { getSystemPrompt: () => "same prompt" } };

      await contextHook({ message: { sessionId, role: "user", content: "one" }, agent });
      await rewindHook({ agent, newContext: [{ sessionId, role: "user", content: "one" }] });
      // Same prompt text, but the reset sliced it out of the replay window.
      await turnHook({ turnIndex: 1, agent });

      const entries = await readSessionEntries(sessionId, { full: true });
      const resetIdx = entries.findIndex((e) => e.source === LOG_SOURCE.RESET);
      expect(resetIdx).toBeGreaterThan(0);
      const promptsAfterReset = entries
        .slice(resetIdx)
        .filter((e) => e.source === LOG_SOURCE.SYSTEM_PROMPT);
      expect(promptsAfterReset).toHaveLength(1);
      expect(promptsAfterReset[0]!.content).toBe("same prompt");
      // Epoch view: resume sees the prompt inside its own window (re-recorded
      // after the re-appended kept history).
      const epoch = await readSessionEntries(sessionId);
      expect(epoch.some((e) => e.source === LOG_SOURCE.SYSTEM_PROMPT)).toBe(true);
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("agents without a built prompt write nothing", async () => {
    const sessionId = `test-prompt-absent-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const contextHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;

      // Plain agent (no context) and empty prompt: message logs, prompt rows do not.
      await contextHook({ message: { sessionId, role: "user", content: "hi" }, agent: { sessionId } });
      await contextHook({
        message: { sessionId, role: "user", content: "hi again" },
        agent: { sessionId, context: { getSystemPrompt: () => null } },
      });

      const entries = await readSessionEntries(sessionId);
      expect(entries.every((e) => e.source !== LOG_SOURCE.SYSTEM_PROMPT)).toBe(true);
      expect(entries).toHaveLength(2);
    } finally {
      cleanupTestFile(sessionId);
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle closure (H-4 / M-6): SESSION_END reclaims the per-session maps,
// and restore-time suppression is keyed per session, never per instance.
// ---------------------------------------------------------------------------

describe("session-log SESSION_END reclaim", () => {
  it("reclaims the prompt dedupe: the prompt re-records after delete-then-resume", async () => {
    const sessionId = `test-reclaim-prompt-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const msgHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
      const endHook = ext.hooks[HOOKS.SESSION_END] as (ctx: any) => void;
      const agent = { sessionId, context: { getSystemPrompt: () => "PROMPT BODY" } };

      await msgHook({ message: { sessionId, role: "user", content: "u1" }, agent });
      await msgHook({ message: { sessionId, role: "user", content: "u2" }, agent });
      let entries = await readSessionEntries(sessionId);
      // Audit dedupe: the unchanged prompt records exactly once per session.
      expect(entries.filter((e) => e.source === LOG_SOURCE.SYSTEM_PROMPT)).toHaveLength(1);

      endHook({ sessionId });

      // Same instance, same id (the resume-after-delete case): the dedupe
      // entry is gone, so the prompt is re-recorded below the resumed rows.
      await msgHook({ message: { sessionId, role: "user", content: "u3" }, agent });
      entries = await readSessionEntries(sessionId);
      expect(entries.filter((e) => e.source === LOG_SOURCE.SYSTEM_PROMPT)).toHaveLength(2);
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("late writes after reclaim land: the write queue re-chains on demand", async () => {
    const sessionId = `test-reclaim-queue-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const msgHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
      const endHook = ext.hooks[HOOKS.SESSION_END] as (ctx: any) => void;
      const agent = { sessionId };

      await msgHook({ message: { sessionId, role: "user", content: "before" }, agent });
      endHook({ sessionId });
      // A floating write dispatched after the reclaim must still hit the log:
      // queuedAppend re-creates the chain entry when the map has none.
      await msgHook({ message: { sessionId, role: "assistant", content: "after" }, agent });

      const entries = await readSessionEntries(sessionId);
      expect(entries).toHaveLength(2);
      expect(entries[1]!.content).toBe("after");
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("reclaims the open turn: a later rewind does not re-emit the marker", async () => {
    const sessionId = `test-reclaim-openturn-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const turnStart = ext.hooks[HOOKS.TURN_START] as (ctx: any) => Promise<void>;
      const rewindHook = ext.hooks[HOOKS.CONTEXT_REWOUND] as (ctx: any) => Promise<void>;
      const endHook = ext.hooks[HOOKS.SESSION_END] as (ctx: any) => void;
      const agent = { sessionId };

      await turnStart({ turnIndex: 1, kind: "input", agent });
      endHook({ sessionId });
      await rewindHook({ agent, newContext: [{ sessionId, role: "user", content: "kept" }] });

      // RAW file read: readSessionEntries replays from the last reset, which
      // would hide the marker above it. The stale open turn (pre-reclaim)
      // would re-emit a SECOND marker below the reset.
      const raw = readFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const markers = raw.filter((e) => e.source === LOG_SOURCE.TURN_STARTED);
      expect(markers).toHaveLength(1);
      expect(raw[raw.length - 1]!.content).toBe("kept");
    } finally {
      cleanupTestFile(sessionId);
    }
  });

  it("reclaims barrier failures of the dead session only", async () => {
    const sid1 = `test-reclaim-barrier-${Date.now()}`;
    const sid2 = `test-reclaim-barrier2-${Date.now()}`;
    // A directory named <session>.jsonl makes every append (and fsync open)
    // fail: the barrier records failures for both sessions.
    mkdirSync(join(SESSIONS_DIR, `${sid1}.jsonl`));
    mkdirSync(join(SESSIONS_DIR, `${sid2}.jsonl`));
    try {
      const ext = await create(createMockCore() as any) as any;
      const before = ext.hooks[HOOKS.TOOL_BEFORE_EXECUTE] as (ctx: any) => Promise<void>;
      const gate = ext.hooks[HOOKS.TOOL_CALL] as (ctx: any) => any;
      const endHook = ext.hooks[HOOKS.SESSION_END] as (ctx: any) => void;

      await before({ toolCallId: "bf-1", toolName: "bash", input: "{}", agent: { sessionId: sid1 } });
      await before({ toolCallId: "bf-2", toolName: "bash", input: "{}", agent: { sessionId: sid2 } });
      // Sanity: both failures are recorded and block their calls.
      expect(gate({ toolCallId: "bf-1" })?.action).toBe("block");
      // Re-record (the gate consumes the entry on block).
      await before({ toolCallId: "bf-1", toolName: "bash", input: "{}", agent: { sessionId: sid1 } });

      endHook({ sessionId: sid1 });

      // The dead session's pending failure is gone (its call can never be
      // answered again); the other session's barrier is untouched.
      expect(gate({ toolCallId: "bf-1" })).toBeUndefined();
      expect(gate({ toolCallId: "bf-2" })?.action).toBe("block");
    } finally {
      for (const sid of [sid1, sid2]) {
        try { rmSync(join(SESSIONS_DIR, `${sid}.jsonl`), { recursive: true, force: true }); } catch {}
      }
    }
  });

  it("reclaims a stuck restoring flag so later messages log without the end dispatch", async () => {
    const sessionId = `test-reclaim-restore-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const restoreHook = ext.hooks[HOOKS.SESSION_RESTORE_ACTIVE] as (ctx: any) => void;
      const msgHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
      const endHook = ext.hooks[HOOKS.SESSION_END] as (ctx: any) => void;
      const agent = { sessionId };

      restoreHook({ agent, isRestoring: true });
      await msgHook({ message: { sessionId, role: "user", content: "skipped" }, agent });
      endHook({ sessionId });
      // Even a missing isRestoring:false cannot strand the flag past the end.
      await msgHook({ message: { sessionId, role: "user", content: "logged" }, agent });

      const entries = await readSessionEntries(sessionId);
      expect(entries.filter((e) => e.role === "user")).toHaveLength(1);
    } finally {
      cleanupTestFile(sessionId);
    }
  });
});

describe("session-log per-session restore suppression (M-6)", () => {
  it("session B logs CONTEXT_MESSAGE while session A replays", async () => {
    const idA = `test-restore-A-${Date.now()}`;
    const idB = `test-restore-B-${Date.now()}`;
    try {
      // ONE extension instance serves both sessions.
      const ext = await create(createMockCore() as any) as any;
      const restoreHook = ext.hooks[HOOKS.SESSION_RESTORE_ACTIVE] as (ctx: any) => void;
      const msgHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
      const agentA = { sessionId: idA };
      const agentB = { sessionId: idB };

      restoreHook({ agent: agentA, isRestoring: true });

      // B's live traffic must keep logging while A replays.
      await msgHook({ message: { sessionId: idB, role: "user", content: "B live" }, agent: agentB });
      // A's replayed entries stay suppressed, exactly as before.
      await msgHook({ message: { sessionId: idA, role: "user", content: "A replayed" }, agent: agentA });

      expect(await readSessionEntries(idB)).toHaveLength(1);
      expect(await readSessionEntries(idA)).toHaveLength(0);

      restoreHook({ agent: agentA, isRestoring: false });
      await msgHook({ message: { sessionId: idA, role: "user", content: "A live" }, agent: agentA });
      expect(await readSessionEntries(idA)).toHaveLength(1);
    } finally {
      cleanupTestFile(idA);
      cleanupTestFile(idB);
    }
  });

  it("the restoring set clears when the replay throws (core's try/finally contract)", async () => {
    const sessionId = `test-restore-throw-${Date.now()}`;
    try {
      const ext = await create(createMockCore() as any) as any;
      const restoreHook = ext.hooks[HOOKS.SESSION_RESTORE_ACTIVE] as (ctx: any) => void;
      const msgHook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
      const agent = { sessionId };

      // Mirrors core/session-log.ts restoreSessionIntoAgent: true, try,
      // finally false -- the clear must land even when the replay throws.
      const withRestore = async (body: () => Promise<void>) => {
        restoreHook({ agent, isRestoring: true });
        try {
          await body();
        } finally {
          restoreHook({ agent, isRestoring: false });
        }
      };

      let threw = false;
      try {
        await withRestore(async () => {
          await msgHook({ message: { sessionId, role: "user", content: "replayed" }, agent });
          expect(await readSessionEntries(sessionId)).toHaveLength(0); // suppressed
          throw new Error("replay blew up");
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      // The finally dispatched the clear: the session is live again.
      await msgHook({ message: { sessionId, role: "user", content: "live" }, agent });
      const entries = await readSessionEntries(sessionId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.content).toBe("live");
    } finally {
      cleanupTestFile(sessionId);
    }
  });
});

// Image persistence (the vanished-image bug): the executor stores a tool's
// images on Message.images, never in content parts, so the writer carries them
// as the TOOL_RESULT entry's sidecar array. Owner ruling: user-input images
// persist too -- the INPUT entry's sidecar is CONTEXT-VISIBLE on resume
// (replayEntriesIntoContext reads entry.images for INPUT), exactly like the
// live session. TOOL_RESULT stays display-only. Content, the search corpus,
// the durability facts and the sidebar record count must all stay as they were.
describe("session-log extension tool-result image sidecar", () => {
  const IMG: ImageAttachment = { type: "image_url", mimeType: "image/png", data: "aGVsbG8=" };
  const PART = {
    type: "tool-result",
    tool: "read",
    status: "success",
    meta: [],
    error: null,
    hint: null,
    output: "Image: photo.png",
  };

  /** The executor's tool-message shape (tool-executor #writeToolResult). */
  const toolMessage = (images?: unknown) =>
    new Message({
      role: "tool",
      content: [PART],
      toolCallId: "call_img",
      source: "tool",
      ...(images !== undefined ? { images: images as ImageAttachment[] } : {}),
    });

  /** Write one message through the real hook; return the landed JSONL line and its parse. */
  async function writeOne(sessionId: string, message: Message) {
    const ext = await create(createMockCore() as any) as any;
    const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
    await hook({ message, agent: { sessionId } });
    const line = readFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), "utf-8").trim().split("\n").at(-1)!;
    return { line, entry: JSON.parse(line) as Record<string, unknown> };
  }

  it("persists tool-result images as a sidecar array with content untouched", async () => {
    const idImg = `test-img-sidecar-${Date.now()}`;
    const idPlain = `test-img-none-${Date.now()}`;
    try {
      const withImg = await writeOne(idImg, toolMessage([IMG]));
      const plain = await writeOne(idPlain, toolMessage());

      expect(withImg.entry.images).toEqual([IMG]);
      // The sidecar rides beside content, never inside it: same parts, and no
      // base64 anywhere in the content surface (the search corpus reads that).
      expect(withImg.entry.content).toEqual(plain.entry.content);
      expect(JSON.stringify(withImg.entry.content)).not.toContain("aGVsbG8=");
      // INPUT-entry shape: the array sits right after content.
      expect(Object.keys(withImg.entry)).toEqual([
        "ts", "session_id", "role", "source", "v", "content", "images", "tool_call_id", "tool_name", "origin",
      ]);

      // Imageless entries keep the pre-sidecar bytes: no key, no null-noise,
      // and every other field identical to the image-carrying write.
      expect("images" in plain.entry).toBe(false);
      const stripVolatile = (e: Record<string, unknown>) => {
        const { ts: _ts, session_id: _sid, ...rest } = e;
        return rest;
      };
      const { images: _images, ...withoutSidecar } = withImg.entry;
      expect(stripVolatile(withoutSidecar)).toEqual(stripVolatile(plain.entry));
    } finally {
      cleanupTestFile(idImg);
      cleanupTestFile(idPlain);
    }
  });

  it("omits the sidecar for empty or malformed images, and for sources outside the gate", async () => {
    const idEmpty = `test-img-empty-${Date.now()}`;
    const idJunk = `test-img-junk-${Date.now()}`;
    const idLlm = `test-img-llm-${Date.now()}`;
    try {
      expect("images" in (await writeOne(idEmpty, toolMessage([]))).entry).toBe(false);
      expect("images" in (await writeOne(idJunk, toolMessage("not-an-array"))).entry).toBe(false);
      // The gate is the explicit INPUT+TOOL_RESULT source list, not "any
      // message with images": an assistant (LLM-source) message carrying an
      // images array -- no real producer does, but the gate must not care --
      // never gains the sidecar.
      const llm = new Message({ role: "assistant", content: "sure", images: [IMG], source: "model" });
      expect("images" in (await writeOne(idLlm, llm)).entry).toBe(false);
    } finally {
      cleanupTestFile(idEmpty);
      cleanupTestFile(idJunk);
      cleanupTestFile(idLlm);
    }
  });

  it("an image-carrying TOOL_RESULT entry is exactly one counted record", async () => {
    const sessionId = `test-img-count-${Date.now()}`;
    try {
      await seedRecordCount(sessionId); // no log yet: base 0
      const ext = await create(createMockCore() as any) as any;
      const hooks = ext.hooks as Record<string, (p: unknown) => Promise<void>>;
      await hooks[HOOKS.SESSION_CREATE]!({ sessionId, config: {} });
      await hooks[HOOKS.CONTEXT_MESSAGE]!({ message: toolMessage([IMG, IMG]), agent: { sessionId } });

      const entries = await readSessionEntries(sessionId, { full: true });
      // One line for the result, one counted record: the sidecar never splits
      // or adds a record, and the live writer tally matches the cold sum.
      expect(entries).toHaveLength(2);
      expect(countSessionLogEntries(entries)).toBe(2);
      expect(getRecordCount(sessionId)).toBe(2);
    } finally {
      cleanupTestFile(sessionId);
      dropRecordCount(sessionId);
    }
  });
});

// User-input image persistence (owner ruling): INPUT entries carry the
// message's images as a sidecar array, CONTEXT-VISIBLE on resume (see
// replayEntriesIntoContext INPUT case). The gate stays the explicit
// INPUT+TOOL_RESULT source list; content bytes, the record count and the
// byte-identity of imageless writes must all stay exactly as they were.
describe("session-log extension user-input image sidecar", () => {
  const IMG: ImageAttachment = { type: "image_url", mimeType: "image/png", data: "aGVsbG8gdXNlciBwaWM=" };
  const IMG2: ImageAttachment = { type: "image_url", mimeType: "image/jpeg", data: "anBlZyBwaWMgdG9v" };

  /** Plain CLI / chat turn: role user, provenance user. */
  const userMessage = (images?: unknown) =>
    new Message({
      role: "user",
      content: "look at this",
      source: "user",
      ...(images !== undefined ? { images: images as ImageAttachment[] } : {}),
    });

  /** Webui upload shape (Agent.run with source harness, handlers-send
   * content parts + images on the enqueue opts). */
  const uploadMessage = (images: unknown) =>
    new Message({
      role: "harness",
      content: [
        { type: "untrusted", text: "what is in this photo?" },
        { type: "file-include", path: "notes.txt", content: "file body" },
      ],
      source: "harness",
      images: images as ImageAttachment[],
    });

  /** Write one message through the real hook; return the landed JSONL line and its parse. */
  async function writeOne(sessionId: string, message: Message) {
    const ext = await create(createMockCore() as any) as any;
    const hook = ext.hooks[HOOKS.CONTEXT_MESSAGE] as (ctx: any) => Promise<void>;
    await hook({ message, agent: { sessionId } });
    const line = readFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), "utf-8").trim().split("\n").at(-1)!;
    return { line, entry: JSON.parse(line) as Record<string, unknown> };
  }

  it("persists user-input images as a sidecar array with content bytes untouched", async () => {
    const idImg = `test-input-img-${Date.now()}`;
    const idPlain = `test-input-plain-${Date.now()}`;
    try {
      const withImg = await writeOne(idImg, userMessage([IMG, IMG2]));
      const plain = await writeOne(idPlain, userMessage());

      expect(withImg.entry.source).toBe(LOG_SOURCE.INPUT);
      expect(withImg.entry.images).toEqual([IMG, IMG2]);
      // Sidecar only: the content field holds the exact plain text of the
      // imageless write, and no base64 rides inside it.
      expect(withImg.entry.content).toBe(plain.entry.content);
      expect(JSON.stringify(withImg.entry.content)).not.toContain("aGVsbG8gdXNlciBwaWM=");
      // The sidecar sits right after content, same slot as TOOL_RESULT.
      expect(Object.keys(withImg.entry)).toEqual([
        "ts", "session_id", "role", "source", "v", "content", "images", "origin",
      ]);

      // Structured uploads (webui shape): harness-provenance parts keep their
      // exact structure in content -- the untrusted/file-include rules are
      // untouched -- while the image rides the sidecar.
      const idUpload = `test-upload-img-${Date.now()}`;
      try {
        const up = await writeOne(idUpload, uploadMessage([IMG]));
        expect(up.entry.source).toBe(LOG_SOURCE.INPUT);
        expect(up.entry.origin).toBe("harness");
        expect(up.entry.images).toEqual([IMG]);
        expect(up.entry.content).toEqual([
          { type: "untrusted", text: "what is in this photo?" },
          { type: "file-include", path: "notes.txt", content: "file body" },
        ]);
        expect(JSON.stringify(up.entry.content)).not.toContain("aGVsbG8gdXNlciBwaWM=");
      } finally {
        cleanupTestFile(idUpload);
      }
    } finally {
      cleanupTestFile(idImg);
      cleanupTestFile(idPlain);
    }
  });

  it("imageless INPUT writes emit no images key (byte-identity with pre-sidecar logs)", async () => {
    const idImg = `test-input-bi-img-${Date.now()}`;
    const idPlain = `test-input-bi-plain-${Date.now()}`;
    try {
      const withImg = await writeOne(idImg, userMessage([IMG]));
      const plain = await writeOne(idPlain, userMessage());
      expect("images" in plain.entry).toBe(false);
      // Every other field identical to the image-carrying write: the gate
      // adds nothing (not even null-noise) when the message carries none.
      const stripVolatile = (e: Record<string, unknown>) => {
        const { ts: _ts, session_id: _sid, ...rest } = e;
        return rest;
      };
      const { images: _images, ...withoutSidecar } = withImg.entry;
      expect(stripVolatile(withoutSidecar)).toEqual(stripVolatile(plain.entry));
    } finally {
      cleanupTestFile(idImg);
      cleanupTestFile(idPlain);
    }
  });

  it("an image-heavy INPUT turn is exactly one counted record (live/cold parity)", async () => {
    const sessionId = `test-input-img-count-${Date.now()}`;
    try {
      await seedRecordCount(sessionId); // no log yet: base 0
      const ext = await create(createMockCore() as any) as any;
      const hooks = ext.hooks as Record<string, (p: unknown) => Promise<void>>;
      await hooks[HOOKS.SESSION_CREATE]!({ sessionId, config: {} });
      await hooks[HOOKS.CONTEXT_MESSAGE]!({ message: uploadMessage([IMG, IMG2]), agent: { sessionId } });

      const entries = await readSessionEntries(sessionId, { full: true });
      // session_start + one input record: the sidecar never splits or adds a
      // record, and the live writer tally matches the cold sum.
      expect(entries).toHaveLength(2);
      expect(countSessionLogEntries(entries)).toBe(2);
      expect(getRecordCount(sessionId)).toBe(2);
    } finally {
      cleanupTestFile(sessionId);
      dropRecordCount(sessionId);
    }
  });
});
