// Durable compaction: a restart must not re-inflate what the live session
// already compacted. Resume replays the full epoch, so every successful
// reduction must persist a checkpoint and replay must truncate there. (The
// writer used to gate on a non-empty `summary`, which every summary-less
// rescue strategy reports without, so rescue successes left no record.)
//
// Pins here:
//   * every successful reduction persists a CHECKPOINT marker (real summary,
//     or an honest mechanical harness line for trim/drop/baton pops);
//   * replay truncates at the LAST checkpoint marker: the marker message
//     leads the context and only entries logged after it replay (the writer
//     re-logs the live post-compaction context behind the marker);
//   * logs with no checkpoint marker replay byte-identically (markers
//     without the `checkpoint` field stay inline audit messages);
//   * durability facts (pending questions, openTurn) keep scanning the FULL
//     epoch; a marker before a RESET sits outside the epoch view.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import { LlmError } from "@core/error.ts";
import { Message, type ImageAttachment } from "@core/context/message.ts";
import { MessageLog } from "@core/context/message-log.ts";
import {
  replayEntriesIntoContext,
  readSessionEntries,
  epochEntries,
  epochStartIndex,
  countSessionLogEntries,
  LOG_SOURCE,
  type LogEntry,
} from "@core/session/session-log.ts";
import { create as createSessionLogExt } from "@extensions/session-log/index.ts";
import { create as createCompactionExtension } from "@extensions/compaction/index.ts";

const TAG = "previous-context-summary";

// ── replay-side pins (pure function) ─────────────────────────────────────────

function mkEntry(over: Partial<LogEntry> & { source: LogEntry["source"] }): LogEntry {
  return { ts: "2026-11-19T00:00:00Z", session_id: "s", content: "", ...over };
}

function input(text: string, extra?: Partial<LogEntry>): LogEntry {
  return mkEntry({ source: LOG_SOURCE.INPUT, content: text, ...extra });
}

function llm(text: string, extra?: Partial<LogEntry>): LogEntry {
  return mkEntry({ source: LOG_SOURCE.LLM, content: text, origin: "model", ...extra });
}

function marker(opts: { checkpoint?: boolean; summary?: string; compacted?: number } = {}): LogEntry {
  const summary = opts.summary ?? "everything before me is summarized here";
  return mkEntry({
    source: LOG_SOURCE.COMPACTION,
    v: 2,
    content: [
      { type: "text", text: `<${TAG}>` },
      { type: "untrusted", text: summary },
      { type: "text", text: `</${TAG}>` },
    ],
    summary,
    messages_compacted: opts.compacted ?? 5,
    origin: "harness",
    ...(opts.checkpoint === undefined ? {} : { checkpoint: opts.checkpoint }),
  });
}

function recorder() {
  const log = new MessageLog();
  return { agent: { addMessage: (m: Message) => log.push(m) }, log };
}

const msgText = (m: Message): string =>
  Array.isArray(m.content) ? m.content.map((p) => (p as { text?: string }).text ?? "").join("") : String(m.content ?? "");

describe("durable compaction replay truncation", () => {
  it("INCIDENT SHAPE: a fat log + one checkpoint resumes a small context", () => {
    const fat: LogEntry[] = [];
    for (let i = 0; i < 40; i++) fat.push(llm(`FAT-${i}-` + "x".repeat(800)));
    const entries: LogEntry[] = [
      ...fat,
      marker({ checkpoint: true }),
      llm("kept tail A"),
      llm("kept tail B"),
      input("post-compaction question"),
      llm("post-compaction answer"),
    ];
    const { agent, log } = recorder();
    const { replayed } = replayEntriesIntoContext(agent, entries);

    // Marker + 2 snapshot copies + 2 post-compaction messages -- the 40 fat
    // entries never reach the context.
    expect(replayed).toBe(5);
    const texts = log.getAll().map(msgText);
    expect(texts.some((t) => t.includes("FAT-"))).toBe(false);
    const weight = texts.reduce((n, t) => n + t.length, 0);
    // Bounded by the marker-onward content, nowhere near the fat prefix
    // (40 x ~810 chars).
    expect(weight).toBeLessThan(2000);
    // The marker leads the context as the harness summary message.
    expect(log.at(0)!.role).toBe("harness");
    expect(log.at(0)!.source).toBe("harness");
    expect(msgText(log.at(0)!)).toContain(TAG);
  });

  it("no checkpoint -> replay is byte-identical to today (backward compat)", () => {
    const pre = recorder();
    const entries: LogEntry[] = [
      input("u1"),
      llm("a1"),
      marker({ /* legacy marker: no checkpoint field */ }),
      input("u2"),
      llm("a2"),
    ];
    const { replayed } = replayEntriesIntoContext(pre.agent, entries);
    expect(replayed).toBe(5);
    expect(pre.log.getAll().map(msgText)).toEqual([
      "u1",
      "a1",
      `<${TAG}>everything before me is summarized here</${TAG}>`,
      "u2",
      "a2",
    ]);
    // checkpoint:false is likewise inert (never written by the writer;
    // defensive: only the literal true truncates).
    const pre2 = recorder();
    replayEntriesIntoContext(pre2.agent, [input("u1"), marker({ checkpoint: false }), input("u2")]);
    expect(pre2.log.length).toBe(3);
  });

  it("two checkpoints in one epoch -> the last wins", () => {
    const { agent, log } = recorder();
    const { replayed } = replayEntriesIntoContext(agent, [
      input("ancient"),
      marker({ checkpoint: true, summary: "first checkpoint" }),
      input("between"),
      input("newest"),
      marker({ checkpoint: true, summary: "second checkpoint" }),
      input("after"),
    ]);
    expect(replayed).toBe(2);
    expect(msgText(log.at(0)!)).toContain("second checkpoint");
    expect(msgText(log.at(1)!)).toBe("after");
  });

  it("a checkpoint inside a pre-RESET prefix never leaks into the epoch view", async () => {
    // Full-log shape: [fat, marker, snapshot, RESET, kept-after-reset...].
    // The epoch slice (what restore replays) starts at the RESET, so the
    // marker plays no role: replay is exactly the entries after the reset.
    const full: LogEntry[] = [
      input("before-compaction"),
      marker({ checkpoint: true }),
      input("kept copy"),
      mkEntry({ source: LOG_SOURCE.RESET }),
      input("after-reset"),
    ];
    const epoch = epochEntries(full);
    expect(epoch.map((e) => e.source)).toEqual([LOG_SOURCE.INPUT]);
    const { agent, log } = recorder();
    const { replayed } = replayEntriesIntoContext(agent, epoch);
    expect(replayed).toBe(1);
    expect(msgText(log.at(0)!)).toBe("after-reset");
    // A direct full-view replay (callers that skip the epoch slice) still
    // truncates at the marker and skips the RESET entry itself.
    const direct = recorder();
    replayEntriesIntoContext(direct.agent, full);
    expect(direct.log.getAll().map(msgText)).toEqual([
      `<${TAG}>everything before me is summarized here</${TAG}>`,
      "kept copy",
      "after-reset",
    ]);
  });

  it("durability facts survive truncation: question before the last marker stays pending, openTurn stays open", () => {
    const questions = [{ prompt: "Which endpoint?" }];
    const { agent, log } = recorder();
    const result = replayEntriesIntoContext(agent, [
      mkEntry({ source: LOG_SOURCE.TURN_STARTED, content: { kind: "input" } }),
      llm("assistant opening the question", {
        tool_calls: [{ id: "call_q", type: "function", function: { name: "question", arguments: "{}" } }],
      }),
      mkEntry({ source: LOG_SOURCE.QUESTION_ASKED, content: questions, tool_call_id: "call_q" }),
      marker({ checkpoint: true }),
      llm("kept reply after the rescue"),
    ]);
    // Audit posture (documented in resume-notes): pending questions and
    // openTurn come from the FULL epoch scan -- an unanswered question the
    // rescue truncated is STILL re-presented to the human, while the
    // replayed context carries only marker-onward messages.
    expect(result.pendingQuestions).toEqual([{ toolCallId: "call_q", questions }]);
    expect(result.openTurn).toBe(true);
    expect(result.replayed).toBe(2); // marker + kept reply, no held call
    expect(log.getAll().map(msgText)).toEqual([
      `<${TAG}>everything before me is summarized here</${TAG}>`,
      "kept reply after the rescue",
    ]);
  });

  it("images: truncated entries never return; tool_result stays un-inlined; surviving INPUT re-inlines", () => {
    const img = (n: number): ImageAttachment => ({
      type: "image_url",
      mimeType: "image/png",
      data: "A".repeat(n),
    });
    const { agent, log } = recorder();
    replayEntriesIntoContext(agent, [
      input("image gone with the prefix", { images: [img(400)] }),
      marker({ checkpoint: true }),
      input("surviving user image", { images: [img(600)] }),
      llm("opens a call", {
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
      }),
      mkEntry({
        source: LOG_SOURCE.TOOL_RESULT,
        content: "screenshot text",
        tool_call_id: "c1",
        images: [img(800)],
      }),
    ]);
    expect(log.length).toBe(4); // marker, input, llm+call, tool_result
    const [markerMsg, survivor, , toolMsg] = log.getAll();
    expect(markerMsg!.role).toBe("harness");
    expect(survivor!.images?.[0]!.data).toBe("A".repeat(600)); // doctrine: INPUT re-inlines
    expect(toolMsg!.images).toBeUndefined(); // doctrine: tool_result never re-inlines
    expect(log.getAll().some((m) => m.images?.some((a) => a.data === "A".repeat(400)))).toBe(false);
  });
});

// ── writer pins (session-log extension OUTPUT_EVENT compaction_result) ───────

let TMP: string;
beforeAll(() => {
  TMP = mkdtempSync(join(TMP_PARENT, "compaction-marker-"));
});
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function useSessionsDir(name: string): string {
  const dir = join(TMP, name);
  process.env.HOTDOG_SESSIONS_DIR = dir;
  return dir;
}

function mockCore(compaction: Record<string, unknown>): any {
  return {
    hooks: new HookSystem(),
    config: { compaction },
    modelRegistry: {
      "test-model": { name: "test-model", temperature: null, contextLimit: 1000 },
    },
    resolved: { contextLimit: 1000 },
  };
}

function contextAgent(sessionId: string, messages: Message[]) {
  const log = new MessageLog(messages);
  return {
    log,
    sessionId,
    model: "test-model",
    modelRegistry: { "test-model": { name: "test-model", temperature: null, contextLimit: 1000 } },
    cancelled: false,
    clearedCount: 0,
    get context() {
      return {
        getMessages: () => log.getAll(),
        getSystem: () => log.getSystem(),
        getNonSystem: () => log.getNonSystem(),
        getSystemPrompt: () => null,
        getTokenUsage: () => ({ promptTokens: 0, cachedTokens: 0 }),
      };
    },
    llmClient: { chatStreamCancellable: () => (async function* () {})() },
    buildMessages() {
      return [...log.getAll()];
    },
    addMessage(msg: Message) {
      log.push(msg);
    },
    replaceContext(next: Message[]) {
      log.replace(next);
    },
    async clearContext() {
      this.clearedCount++;
      log.replace([]);
    },
    async ensureSystemPrompt() {},
    enqueueCallback: () => {},
    enqueue(content: string) {
      log.push(new Message({ role: "user", content, source: "model" }));
    },
    sink: { emit: (_e: unknown) => {} },
  } as any;
}

const textOf = (m: Message): string =>
  typeof m.content === "string"
    ? m.content
    : (m.content as Array<Record<string, unknown>>)
        .map((p) => (typeof p?.text === "string" ? p.text : ""))
        .join("");

/** Mount session-log + compaction on one HookSystem; the compaction_result
 *  event reaches the writer through the real notifyHooks seam. */
async function mount(compaction: Record<string, unknown>) {
  const core = mockCore(compaction);
  const sl = (await createSessionLogExt(core)) as any;
  const slOut = sl.hooks[HOOKS.OUTPUT_EVENT] as (p: any) => Promise<void>;
  core.hooks.on(HOOKS.OUTPUT_EVENT, async (payload: any) => {
    await slOut(payload);
  });
  const comp = createCompactionExtension(core) as any;
  return { core, sl, comp };
}

async function logLiveMessage(sl: any, agent: any, message: Message): Promise<void> {
  await sl.hooks[HOOKS.CONTEXT_MESSAGE]({ message, agent });
}

describe("compaction marker writer", () => {
  it("real summary + readable context -> CHECKPOINT marker, then the re-logged live context", async () => {
    useSessionsDir("writer-summary");
    const sessionId = `cp-writer-${Date.now()}`;
    const ext = (await createSessionLogExt(mockCore({}))) as any;
    const out = ext.hooks[HOOKS.OUTPUT_EVENT] as (p: any) => Promise<void>;
    const kept = [
      new Message({ role: "user", content: "kept u", source: "user" }),
      new Message({ role: "assistant", content: "kept a", source: "model" }),
    ];
    const agent = contextAgent(sessionId, kept);
    await out({
      type: "compaction_result",
      data: { summary: "Real model summary", messagesCompacted: 7, strategy: "summarize" },
      agent,
    });
    const entries = await readSessionEntries(sessionId, { full: true });
    expect(entries.length).toBe(3);
    expect(entries[0]!.source).toBe(LOG_SOURCE.COMPACTION);
    expect(entries[0]!.checkpoint).toBe(true);
    expect(entries[0]!.summary).toBe("Real model summary");
    expect(entries[0]!.strategy).toBe("summarize");
    expect(entries[1]!.content).toBe("kept u");
    expect(entries[2]!.content).toBe("kept a");
    // The marker itself never counts toward the sidebar message count.
    expect(countSessionLogEntries(entries)).toBe(2);
    // Replay: marker leads, snapshot follows.
    const { agent: rec, log } = recorder();
    replayEntriesIntoContext(rec, entries);
    expect(log.length).toBe(3);
    expect(log.at(0)!.role).toBe("harness");
    expect(log.at(1)!.content).toBe("kept u");
  });

  it("summary-less reduction (trim) -> honest mechanical marker text, no invented summary", async () => {
    useSessionsDir("writer-mechanical");
    const sessionId = `cp-mech-${Date.now()}`;
    const ext = (await createSessionLogExt(mockCore({}))) as any;
    const out = ext.hooks[HOOKS.OUTPUT_EVENT] as (p: any) => Promise<void>;
    const agent = contextAgent(sessionId, [new Message({ role: "user", content: "u", source: "user" })]);
    await out({
      type: "compaction_result",
      data: { messagesCompacted: 12, strategy: "trim" },
      agent,
    });
    const entries = await readSessionEntries(sessionId, { full: true });
    const m = entries[0]!;
    expect(m.source).toBe(LOG_SOURCE.COMPACTION);
    expect(m.checkpoint).toBe(true);
    expect(m.messages_compacted).toBe(12);
    expect(m.summary).toMatch(/^12 messages evicted by compaction \(strategy 'trim'\) at \d{4}-\d{2}-\d{2}T/);
    expect(m.origin).toBe("harness");
    // The mechanical line is the harness summary body, wrapped like every
    // other compaction summary.
    expect(m.content).toEqual([
      { type: "text", text: `<${TAG}>` },
      { type: "untrusted", text: m.summary },
      { type: "text", text: `</${TAG}>` },
    ]);
  });

  it("notice-only append (no summary, evicts 0) writes NO marker", async () => {
    useSessionsDir("writer-notice");
    const sessionId = `cp-notice-${Date.now()}`;
    const ext = (await createSessionLogExt(mockCore({}))) as any;
    const out = ext.hooks[HOOKS.OUTPUT_EVENT] as (p: any) => Promise<void>;
    await out({
      type: "compaction_result",
      data: { messagesCompacted: 0, strategy: "pass-the-baton" },
      agent: { sessionId },
    });
    expect(await readSessionEntries(sessionId, { full: true })).toEqual([]);
  });

  it("duck-typed agent without a readable context -> pre-fix inline marker (never truncates replay)", async () => {
    useSessionsDir("writer-duck");
    const sessionId = `cp-duck-${Date.now()}`;
    const ext = (await createSessionLogExt(mockCore({}))) as any;
    const out = ext.hooks[HOOKS.OUTPUT_EVENT] as (p: any) => Promise<void>;
    await out({
      type: "compaction_result",
      data: { summary: "S", messagesCompacted: 3, strategy: "summarize" },
      agent: { sessionId }, // no context accessor
    });
    const entries = await readSessionEntries(sessionId, { full: true });
    expect(entries.length).toBe(1);
    expect(entries[0]!.checkpoint).toBeUndefined();
    // And replay keeps it inline (the legacy inert shape).
    const { agent: rec, log } = recorder();
    replayEntriesIntoContext(rec, [input("u1"), ...entries]);
    expect(log.length).toBe(2);
  });

  it("the live summary message is NOT duplicated into the snapshot (the marker IS it)", async () => {
    useSessionsDir("writer-dedupe");
    const sessionId = `cp-dedupe-${Date.now()}`;
    const ext = (await createSessionLogExt(mockCore({}))) as any;
    const out = ext.hooks[HOOKS.OUTPUT_EVENT] as (p: any) => Promise<void>;
    const summary = "the only summary";
    const summaryMsg = new Message({
      role: "harness",
      source: "harness",
      content: [
        { type: "text", text: `<${TAG}>` },
        { type: "untrusted", text: summary },
        { type: "text", text: `</${TAG}>` },
      ],
    });
    const agent = contextAgent(sessionId, [
      summaryMsg,
      new Message({ role: "user", content: "kept u", source: "user" }),
      new Message({ role: "assistant", content: "kept a", source: "model" }),
    ]);
    await out({
      type: "compaction_result",
      data: { summary, messagesCompacted: 9, strategy: "summarize" },
      agent,
    });
    const entries = await readSessionEntries(sessionId, { full: true });
    expect(entries.length).toBe(3); // marker + 2 kept, the live summary copy excluded
    expect(entries.filter((e) => e.source === LOG_SOURCE.COMPACTION).length).toBe(1);
    const { agent: rec, log } = recorder();
    replayEntriesIntoContext(rec, entries);
    expect(log.length).toBe(3);
    expect(log.getAll().filter((m) => msgText(m).includes(summary)).length).toBe(1);
  });

  it("suppressed during session restore (replay never re-checkpoints)", async () => {
    useSessionsDir("writer-restore");
    const sessionId = `cp-restore-${Date.now()}`;
    const ext = (await createSessionLogExt(mockCore({}))) as any;
    const restore = ext.hooks[HOOKS.SESSION_RESTORE_ACTIVE] as (p: any) => void;
    const out = ext.hooks[HOOKS.OUTPUT_EVENT] as (p: any) => Promise<void>;
    restore({ agent: { sessionId }, isRestoring: true });
    await out({
      type: "compaction_result",
      data: { summary: "S", messagesCompacted: 2 },
      agent: { sessionId },
    });
    expect(await readSessionEntries(sessionId, { full: true })).toEqual([]);
  });
});

// ── end-to-end pins (compaction extension + session-log extension) ───────────

describe("durable compaction end-to-end", () => {
  it("ROUND-TRIP: live /compact trim -> checkpoint marker in the log -> replay == live context", async () => {
    useSessionsDir("e2e-roundtrip");
    const sessionId = `cp-rt-${Date.now()}`;
    const { sl, comp } = await mount({
      enabled: true,
      reserveTokens: 0,
      keepRecentMessages: 2, // findFirstKeptIndex protects keepRecent*2 = 4
      strategy: "trim",
      userTurnGuardPrompt: "Continue.",
      batonNoticePrompt: "Pass the baton now.",
    });
    // 10 messages of 80 chars: 200 est. tokens; trim to 120 keeps the newest 6.
    const original: Message[] = [];
    for (let i = 0; i < 10; i++) {
      original.push(
        new Message({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `m${i}:` + "z".repeat(76),
          source: i % 2 === 0 ? "user" : "model",
        }),
      );
    }
    const agent = contextAgent(sessionId, original);
    agent.modelRegistry = { "test-model": { name: "test-model", temperature: null, contextLimit: 120 } };
    for (const m of original) await logLiveMessage(sl, agent, m);

    // Run the compact command through the real command seam.
    let handler: ((agent: any, cmdValue: string) => Promise<unknown>) | null = null;
    await comp.hooks[HOOKS.COMMANDS_REGISTER]({
      registry: { register: (_name: string, def: { handler: typeof handler }) => { handler = def.handler; } },
    });
    const display = (await handler!(agent, "")) as { content?: string };
    expect(String(display?.content)).toContain("trim");

    const live = agent.context.getMessages() as Message[];
    // 6 kept + the harness user-turn guard (the window ends on an assistant
    // turn; the guard rides the snapshot too -- replay parity).
    expect(live.length).toBe(7);
    // the trim actually trimmed

    const entries = await readSessionEntries(sessionId, { full: true });
    expect(entries.length).toBe(18); // 10 originals + marker + 7 re-logged (6 kept + guard)
    const m = entries[10]!;
    expect(m.source).toBe(LOG_SOURCE.COMPACTION);
    expect(m.checkpoint).toBe(true);
    expect(m.summary).toMatch(/^4 messages evicted by compaction \(strategy 'trim'\) at /);

    // Replay into a fresh agent equals the live post-compaction context,
    // modulo the leading marker (the mechanical summary stands in for the
    // absent live summary message).
    const { agent: rec, log } = recorder();
    replayEntriesIntoContext(rec, epochEntries(entries));
    expect(log.getAll().map(textOf).slice(1)).toEqual(live.map(textOf));

    // A post-compaction message logged through the normal seam extends both
    // the live context and every later replay.
    const later = new Message({ role: "user", content: "after the rescue", source: "user" });
    agent.addMessage(later);
    await logLiveMessage(sl, agent, later);
    const entries2 = await readSessionEntries(sessionId, { full: true });
    const { agent: rec2, log: log2 } = recorder();
    replayEntriesIntoContext(rec2, epochEntries(entries2));
    expect(log2.getAll().map(textOf).slice(1)).toEqual(agent.context.getMessages().map(textOf));
  });

  it("overflow rescue: pop lands the marker AFTER the reduction is proven; Continue promotion still works", async () => {
    useSessionsDir("e2e-rescue");
    const sessionId = `cp-rescue-${Date.now()}`;
    const { sl, comp } = await mount({
      enabled: true,
      reserveTokens: 50,
      keepRecentMessages: 4,
      strategy: "summarize",
      userTurnGuardPrompt: "Continue.",
      batonNoticePrompt: "Pass the baton now.",
    });
    // 8 x 100 chars = 200 est. tokens against a 200/50 config: the plausibility
    // gate passes on the local measurement, and the baton pops to the budget
    // the AIM ladder computes.
    const original: Message[] = [];
    for (let i = 0; i < 8; i++) {
      original.push(
        new Message({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `r${i}:` + "y".repeat(97),
          source: i % 2 === 0 ? "user" : "model",
        }),
      );
    }
    const agent = contextAgent(sessionId, original);
    agent.modelRegistry = { "test-model": { name: "test-model", temperature: null, contextLimit: 200 } };
    // The handoff's clear is the real seam: replaceContext + CONTEXT_REWOUND
    // (the writer checkpoints the log with a RESET).
    agent.clearContext = async () => {
      agent.clearedCount++;
      agent.log.replace([]);
      await sl.hooks[HOOKS.CONTEXT_REWOUND]({ agent, newContext: [] });
    };
    for (const m of original) await logLiveMessage(sl, agent, m);

    const params: any = { messages: [...original], modelConfig: {}, toolDefs: [] };
    const result = await comp.hooks[HOOKS.PROVIDER_ERROR]({
      error: LlmError.Api('HTTP 400 (body: {"error":{"code":"context_length_exceeded"}})', 400),
      params,
      agent,
      retry: false,
    });
    expect(result).toEqual({ retry: true });

    const live = agent.context.getMessages() as Message[];
    expect(live.length).toBeLessThan(original.length);
    const entries = await readSessionEntries(sessionId, { full: true });
    const markerIdx = entries.findIndex((e) => e.source === LOG_SOURCE.COMPACTION);
    expect(markerIdx).toBe(8); // right after the 8 originals, before the snapshot
    expect(entries[markerIdx]!.checkpoint).toBe(true);
    expect(String(entries[markerIdx]!.summary)).toMatch(/^3 messages evicted by compaction \(strategy 'pass-the-baton'\) at /);

    // Replay equals the live rescued context, modulo the leading marker.
    const { agent: rec, log } = recorder();
    replayEntriesIntoContext(rec, epochEntries(entries));
    expect(log.getAll().map(textOf).slice(1)).toEqual(live.map(textOf));

    // Continue promotion (path B): narrated handoff after the pop clears the
    // context (RESET) -- the marker above the RESET leaves the epoch view.
    await comp.hooks[HOOKS.TURN_END]({
      reason: "completion",
      cancelled: false,
      stopped: true,
      toolResults: [],
      message: "Handoff: everything before step 3 is done.",
      claimTurn: () => true,
      agent,
    });
    expect(agent.clearedCount).toBe(1);
    // The real bus drains the plan message into the next turn's context;
    // mirror its logging here.
    const planMsg = agent.context.getMessages()[0]!;
    await logLiveMessage(sl, agent, planMsg);

    // The fresh session's first CONTEXT hook replays the stashed tail.
    await comp.hooks[HOOKS.CONTEXT]({ messages: agent.context.getMessages(), agent });
    const afterReplay = agent.context.getMessages() as Message[];
    expect(afterReplay.length).toBeGreaterThan(1);
    expect(textOf(afterReplay[0]!)).toContain("# Baton handoff");

    const full = await readSessionEntries(sessionId, { full: true });
    const resetIdx = full.findIndex((e) => e.source === LOG_SOURCE.RESET);
    expect(resetIdx).toBeGreaterThan(-1);
    const markerIdx2 = full.findIndex((e) => e.source === LOG_SOURCE.COMPACTION);
    expect(markerIdx2).toBeLessThan(resetIdx); // marker sits above the reset
    const epoch = epochEntries(full);
    expect(epochStartIndex(full)).toBe(resetIdx + 1);
    expect(epoch.some((e) => e.source === LOG_SOURCE.COMPACTION)).toBe(false);
    // Epoch replay: no marker, nothing truncated (only the logged plan is in
    // the epoch; the stashed tail rides replaceContext, the pre-existing
    // baton seam -- unchanged by this fix).
    const { agent: rec2, log: log2 } = recorder();
    const r2 = replayEntriesIntoContext(rec2, epoch);
    expect(r2.replayed).toBe(1);
    expect(textOf(log2.at(0)!)).toContain("# Baton handoff");
  });

  it("a rolled-back phantom compaction never checkpoints the log", async () => {
    useSessionsDir("e2e-rollback");
    const sessionId = `cp-rollback-${Date.now()}`;
    const { sl, comp } = await mount({
      enabled: true,
      // Budget = contextLimit 300 - 124 = 176 tokens: the fixture measures
      // exactly 176, so the first-entry plausibility gate (refuses only when
      // measured AND provider are strictly UNDER budget) lets the rescue
      // chain in, while the aim stays strictly below the rejected size.
      reserveTokens: 124,
      keepRecentMessages: 4,
      strategy: "summarize",
      userTurnGuardPrompt: "Continue.",
      batonNoticePrompt: "N".repeat(200), // notice heavier than the tiny pop
    });
    const original: Message[] = [];
    for (let i = 0; i < 7; i++) {
      original.push(new Message({ role: i % 2 === 0 ? "user" : "assistant", content: `r${i}:` + "y".repeat(97), source: "model" }));
    }
    original.push(new Message({ role: "user", content: "tiny", source: "user" })); // 10 tokens
    const agent = contextAgent(sessionId, original);
    agent.modelRegistry = { "test-model": { name: "test-model", temperature: null, contextLimit: 300 } };
    for (const m of original) await logLiveMessage(sl, agent, m);

    // Replace the rescue chain's first rung with a strategy that reports
    // success while growing the request (pop 10 tokens, append a 50-token
    // notice): the monotonicity law must roll it back -- and the parked
    // compaction_result must be DROPPED, not checkpointed.
    let strategyRan = 0;
    comp.registry.register({
      name: "pass-the-baton",
      canCompact: () => true,
      execute: async () => {
        strategyRan++;
        return {
          summary: null,
          messagesCompacted: 1,
          keepFrom: "tail",
          appendNotice: "N".repeat(200),
          metadata: { strategyName: "pass-the-baton" },
        };
      },
    } as never);

    const params: any = { messages: [...original], modelConfig: {}, toolDefs: [] };
    const result = await comp.hooks[HOOKS.PROVIDER_ERROR]({
      error: LlmError.Api('HTTP 400 (body: {"error":{"code":"context_length_exceeded"}})', 400),
      params,
      agent,
      retry: false,
    });
    // The rescue chain must ACTUALLY have entered and run the fake strategy:
    // without this pin the fixture could silently degrade back to a
    // first-entry-gate refusal where every assertion below passes trivially.
    expect(strategyRan).toBeGreaterThanOrEqual(1);
    expect(result).toBeUndefined(); // error surfaced, no retry
    // Context restored byte-identical to the rejection's bytes (the rollback).
    const after = agent.context.getMessages() as Message[];
    expect(after).toEqual(original);
    const entries = await readSessionEntries(sessionId, { full: true });
    expect(entries.some((e) => e.source === LOG_SOURCE.COMPACTION)).toBe(false);
    // And the popped tail's stash did not survive the rollback either.
    expect(existsSync(join(process.env.HOTDOG_SESSIONS_DIR!, `${sessionId}.baton.json`))).toBe(false);
  });

  it("image-downgrade-only rescue writes NO marker (covers=0 -> do not emit)", async () => {
    useSessionsDir("e2e-image-only");
    const sessionId = `cp-imgonly-${Date.now()}`;
    const { sl, comp } = await mount({
      enabled: true,
      reserveTokens: 6000,
      keepRecentMessages: 4,
      strategy: "summarize",
      userTurnGuardPrompt: "Continue.",
      batonNoticePrompt: "Pass the baton now.",
    });
    const img = (n: number): ImageAttachment => ({ type: "image_url", mimeType: "image/png", data: "A".repeat(n) });
    const original: Message[] = [];
    for (let i = 0; i < 4; i++) {
      original.push(
        new Message({
          role: "assistant",
          content: `shot ${i}`,
          toolCalls: [{ id: `c${i}`, type: "function", function: { name: "agent_browser", arguments: "{}" } }],
          source: "model",
        }),
      );
      original.push(
        new Message({
          role: "tool",
          content: `screenshot ${i} text`,
          toolCallId: `c${i}`,
          source: "tool",
          images: [img(16384)], // 4096 est. tokens each -> 16,384+ total
        }),
      );
    }
    const agent = contextAgent(sessionId, original);
    agent.modelRegistry = { "test-model": { name: "test-model", temperature: null, contextLimit: 20000 } };
    for (const m of original) await logLiveMessage(sl, agent, m);

    const params: any = { messages: [...original], modelConfig: {}, toolDefs: [] };
    const result = await comp.hooks[HOOKS.PROVIDER_ERROR]({
      error: LlmError.Api('HTTP 400 (body: {"error":{"code":"context_length_exceeded"}})', 400),
      params,
      agent,
      retry: false,
    });
    expect(result).toEqual({ retry: true });
    // Every message survived (downgrade-only): a marker here would truncate
    // replay for an eviction that covers no messages -> no marker emitted.
    const entries = await readSessionEntries(sessionId, { full: true });
    expect(entries.some((e) => e.source === LOG_SOURCE.COMPACTION)).toBe(false);
    // And no message was dropped from the live context.
    expect(agent.context.getMessages().length).toBe(original.length);
    // Replay without a marker stays full (all 8 messages).
    const { agent: rec, log } = recorder();
    replayEntriesIntoContext(rec, epochEntries(entries));
    expect(log.length).toBe(8);
  });
});
