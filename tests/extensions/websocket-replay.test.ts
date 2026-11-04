// Unit tests for replay.ts. The attach/resume tests drive replayLogSlice
// through the live server; replaySessionHistory (the fork/in-memory path from
// SWITCH_SESSION) and the partial-stream flush need direct exercise: the
// message-shape mapping, tool name resolution from the preceding assistant
// turn, content flattening, and the dropped-connection catch. replayLogSlice
// gets direct exercise here for the token_usage case (attach/switch/reconnect
// all flow through it).

import { describe, it, expect } from "bun:test";
import {
  replayLogSlice,
  replayPendingQuestion,
  replaySessionHistory,
} from "@extensions/websocket/replay.ts";
import { LOG_SOURCE, type LogEntry } from "@core/session/session-log.ts";
import { S2C } from "@extensions/websocket/protocol.ts";
import type { AgentLike } from "@core/session/index.ts";
import { Message, type ImageAttachment } from "@core/context/message.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import { createWsMockWs } from "../mocks/websocket.ts";

function received(ws: { messages: string[] }): Array<Record<string, unknown>> {
  return ws.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
}

function fakeAgent(
  messages: unknown[],
  extras: Record<string, unknown> = {},
): AgentLike {
  return { getMessages: () => messages, ...extras } as unknown as AgentLike;
}

function replay(messages: unknown[], extras: Record<string, unknown> = {}) {
  const ws = createWsMockWs();
  replaySessionHistory("s1", fakeAgent(messages, extras), ws);
  return received(ws);
}

describe("replaySessionHistory", () => {
  it("maps a full user/assistant/tool conversation to S2C messages", () => {
    const out = replay(
      [
        new Message({ role: "user", content: "run ls" }),
        new Message({
          role: "assistant",
          content: "listing done",
          reasoningContent: "hmm, a listing",
          toolCalls: [
            { type: "function", id: "c1", function: { name: "bash", arguments: '{"command":"ls"}' } },
          ],
        }),
        new Message({ role: "tool", content: "file1\nfile2", toolCallId: "c1" }),
      ],
    );

    expect(out.map((m) => m.type)).toEqual([
      S2C.USER_MESSAGE,
      S2C.THINKING,
      S2C.TOOL_CALL,
      S2C.ASSISTANT_MESSAGE,
      S2C.TOOL_RESULT,
    ]);
    expect(out[0]).toMatchObject({ sessionId: "s1", content: "run ls" });
    expect(out[1]).toMatchObject({ content: "hmm, a listing" });
    expect(out[2]).toMatchObject({
      name: "bash",
      args: '{"command":"ls"}',
      toolCallId: "c1",
    });
    expect(out[3]).toMatchObject({ content: "listing done" });
    expect(out[4]).toMatchObject({
      name: "bash", // resolved from the preceding assistant turn's call id
      output: "file1\nfile2",
      toolCallId: "c1",
    });
  });

  it("moves file-include parts into files[] and keeps the remaining text", () => {
    const out = replay([
      new Message({
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "file-include", path: "notes.md", content: "FILE DATA" },
        ],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe(S2C.USER_MESSAGE);
    expect(out[0]!.content).toBe("look at this");
    expect(out[0]!.files).toEqual([{ path: "notes.md", content: "FILE DATA" }]);
    expect(out[0]!.images).toBeUndefined();
  });

  it("carries user and tool images through wireImages", () => {
    const img: ImageAttachment = { type: "image_url", mimeType: "image/png", data: "aGVsbG8=" };
    const wire = { mimeType: "image/png", data: "aGVsbG8=" };
    const out = replay([
      new Message({ role: "user", content: "pic", images: [img] }),
      new Message({ role: "assistant", content: "seen", toolCalls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] }),
      new Message({ role: "tool", content: "ok", toolCallId: "c1", images: [img] }),
    ]);

    expect(out[0]!.images).toEqual([wire]);
    const toolResult = out.find((m) => m.type === S2C.TOOL_RESULT)!;
    expect(toolResult.images).toEqual([wire]);
  });

  it("defaults missing call names and arguments, omits toolCallId when empty", () => {
    const out = replay([
      new Message({
        role: "assistant",
        content: null,
        // Legacy-shaped call: no type, no arguments; the defaults must fill in.
        toolCalls: [{ id: "", function: { name: "mystery" } }] as never,
      }),
    ]);
    const call = out.find((m) => m.type === S2C.TOOL_CALL)!;
    expect(call).toMatchObject({ name: "mystery", args: "{}" });
    expect(call.toolCallId).toBeUndefined();
    // The text was empty, so no ASSISTANT_MESSAGE.
    expect(out.some((m) => m.type === S2C.ASSISTANT_MESSAGE)).toBe(false);
  });


  it("carries a hint-driven argsSummary from the registry's metadata", () => {
    const registry = {
      get: () => undefined,
      getMetadata: (name: string) =>
        name === "bash"
          ? { argDisplay: { command: { preview: "first-line", syntax: "shell" } } }
          : undefined,
    };
    const out = replay(
      [
        new Message({
          role: "assistant",
          content: "x",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "git status\n&& git diff" }) },
            },
          ],
        }),
      ],
      { toolRegistry: registry },
    );
    const call = out.find((m) => m.type === S2C.TOOL_CALL)!;
    expect(call.argsSummary).toBe("git status… (2 lines, 22 chars)");
  });

  it("flattens tool-result parts (output, hint, meta) and flags orphaned results", () => {
    const out = replay([
      new Message({
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c2", function: { name: "mystery" } }] as never,
      }),
      new Message({
        role: "tool",
        toolCallId: "c2",
        content: [
          {
            type: "tool-result",
            tool: "mystery",
            status: "error",
            output: "out",
            error: null,
            hint: "try again",
            meta: [["exit", "1"]],
          },
        ],
      }),
      new Message({ role: "tool", content: "orphaned" }),
    ]);
    const matched = out.filter((m) => m.type === S2C.TOOL_RESULT)[0]!;
    expect(matched).toMatchObject({ name: "mystery", output: "out\nHINT: try again\nMETA: {\"exit\":\"1\"}", toolCallId: "c2" });
    const orphan = out.filter((m) => m.type === S2C.TOOL_RESULT)[1]!;
    expect(orphan).toMatchObject({ name: "unknown", output: "orphaned" });
    expect(orphan.toolCallId).toBeUndefined();
  });

  it("falls back to msg.content when getTextContent is absent, and skips empty turns", () => {
    const out = replay([
      { role: "assistant", content: "legacy text" },
      { role: "assistant", content: "", toolCalls: [] },
      new Message({ role: "system", content: "not a conversation role" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: S2C.ASSISTANT_MESSAGE, content: "legacy text" });
  });

  it("flushes in-flight streaming partials after the message log", () => {
    const out = replay(
      [new Message({ role: "user", content: "go" })],
      { currentStreamingReasoning: "half a thought", currentStreamingContent: "half a reply" },
    );
    expect(out.map((m) => m.type)).toEqual([
      S2C.USER_MESSAGE,
      S2C.STREAMING_REASONING_CHUNK,
      S2C.STREAMING_CHUNK,
    ]);
    expect(out[1]!.content).toBe("half a thought");
    expect(out[2]!.content).toBe("half a reply");
  });

  it("swallows a dropped connection mid-replay", () => {
    let sends = 0;
    const ws = {
      readyState: 1,
      send: (_data: string) => {
        sends++;
        if (sends >= 2) throw new Error("socket closed");
      },
    } as unknown as Parameters<typeof replaySessionHistory>[2];
    expect(() =>
      replaySessionHistory(
        "s1",
        fakeAgent([
          new Message({ role: "user", content: "one" }),
          new Message({ role: "user", content: "two" }),
        ]),
        ws,
      ),
    ).not.toThrow();
    expect(sends).toBe(2);
  });
});

describe("replayLogSlice token_usage", () => {
  const entry = (over: Record<string, unknown>) =>
    ({
      ts: "2026-10-20T00:00:00.000Z",
      session_id: "s",
      source: LOG_SOURCE.INPUT,
      content: "",
      ...over,
    }) as unknown as LogEntry;

  function slice(entries: LogEntry[], startIdx = 0): string[] {
    const ws = createWsMockWs();
    replayLogSlice(ws, "s1", entries, startIdx);
    return ws.messages;
  }

  it("replays each token_usage record as S2C.TOKEN_USAGE at its log position", () => {
    const raw = slice([
      entry({ source: LOG_SOURCE.INPUT, content: "go" }),
      entry({
        source: LOG_SOURCE.TOKEN_USAGE,
        sessionPromptTokens: 150000,
        sessionCachedTokens: 148000,
        sessionCompletionTokens: 3000,
        sessionTotalTokens: 153000,
        turns: 2,
        promptTokens: 150000,
        cachedTokens: 148000,
        completionTokens: 3000,
        totalTokens: 153000,
        contextWindow: 200000,
      }),
      entry({ source: LOG_SOURCE.LLM, content: "done" }),
      entry({
        source: LOG_SOURCE.TOKEN_USAGE,
        sessionPromptTokens: 153000,
        sessionCachedTokens: 150000,
        sessionCompletionTokens: 3200,
        sessionTotalTokens: 156200,
        turns: 3,
        promptTokens: 152000,
        cachedTokens: 150000,
        completionTokens: 200,
        totalTokens: 152200,
        contextWindow: 200000,
      }),
    ]);
    const msgs = raw.map((m) => JSON.parse(m) as Record<string, unknown>);
    // One bubble per record, interleaved where the log puts them.
    expect(msgs.map((m) => m.type)).toEqual([
      S2C.USER_MESSAGE,
      S2C.TOKEN_USAGE,
      S2C.ASSISTANT_MESSAGE,
      S2C.TOKEN_USAGE,
    ]);
    // Byte-identical to what the live websocket-channel mapper sends for the
    // same record: same fields, same order, no turns/sessionCachedTokens --
    // including the additive ctxUsed/ctxTotal gauge pair for the footer.
    expect(raw[1]).toBe(
      JSON.stringify({
        type: S2C.TOKEN_USAGE,
        sessionId: "s1",
        sessionPromptTokens: 150000,
        sessionCompletionTokens: 3000,
        sessionTotalTokens: 153000,
        promptTokens: 150000,
        completionTokens: 3000,
        totalTokens: 153000,
        cachedTokens: 148000,
        contextWindow: 200000,
        ctxUsed: 153000,
        ctxTotal: 200000,
      }),
    );
  });

  it("omits contextWindow for legacy records that predate the field", () => {
    const raw = slice([
      entry({
        source: LOG_SOURCE.TOKEN_USAGE,
        sessionPromptTokens: 900,
        sessionCompletionTokens: 60,
        sessionTotalTokens: 960,
        promptTokens: 900,
        completionTokens: 60,
        totalTokens: 960,
        cachedTokens: 0,
      }),
    ]);
    const msg = JSON.parse(raw[0]!) as Record<string, unknown>;
    expect(msg.type).toBe(S2C.TOKEN_USAGE);
    expect("contextWindow" in msg).toBe(false);
    // No attested window: the ctxTotal gauge field rides along as little as
    // the denominator does; used is still attested and sent.
    expect("ctxTotal" in msg).toBe(false);
    expect(msg.ctxUsed).toBe(960);
    expect(msg.totalTokens).toBe(960);
  });

  it("attests no ctxUsed when the record's totalTokens is zero", () => {
    const raw = slice([
      entry({
        source: LOG_SOURCE.TOKEN_USAGE,
        totalTokens: 0,
        contextWindow: 200000,
      }),
    ]);
    const msg = JSON.parse(raw[0]!) as Record<string, unknown>;
    expect("ctxUsed" in msg).toBe(false);
    expect("ctxTotal" in msg).toBe(false); // no gauge without a used-number
  });
});

describe("replayPendingQuestion", () => {
  const questions = [{ key: "q1", prompt: "pick one", options: ["a", "b"] }];

  function bridgeWith(pending: Record<string, unknown> | null): WebSocketQuestionBridge {
    return {
      peek: (sessionId: string) => (pending ? pending[sessionId] ?? null : null),
    } as unknown as WebSocketQuestionBridge;
  }

  it("re-sends the pending questions as a QUESTION message", () => {
    const ws = createWsMockWs();
    replayPendingQuestion(bridgeWith({ s1: questions }), "s1", ws);
    expect(received(ws)).toEqual([
      { type: S2C.QUESTION, sessionId: "s1", questions },
    ]);
  });

  it("sends nothing when no question is pending", () => {
    const ws = createWsMockWs();
    replayPendingQuestion(bridgeWith({ other: questions }), "s1", ws);
    replayPendingQuestion(bridgeWith(null), "s1", ws);
    expect(ws.messages).toHaveLength(0);
  });
});

describe("replayLogSlice footer meta (assistant ts + turn duration)", () => {
  const T0 = Date.parse("2026-10-20T00:00:00.000Z");
  const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

  function entryAt(offsetMs: number | undefined, over: Record<string, unknown>): LogEntry {
    return {
      ...(offsetMs !== undefined ? { ts: iso(offsetMs) } : {}),
      session_id: "s",
      source: LOG_SOURCE.INPUT,
      content: "",
      ...over,
    } as unknown as LogEntry;
  }

  function sliceMeta(entries: LogEntry[], startIdx = 0): Array<Record<string, unknown>> {
    const ws = createWsMockWs();
    replayLogSlice(ws, "s1", entries, startIdx);
    return ws.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
  }

  it("assistant frames carry the entry ts and the bracketing turn's duration", () => {
    const out = sliceMeta([
      entryAt(0, { source: LOG_SOURCE.TURN_STARTED, content: { kind: "input" } }),
      entryAt(10, { source: LOG_SOURCE.INPUT, content: "go" }),
      entryAt(981200, { source: LOG_SOURCE.LLM, content: "done" }),
      entryAt(981250, { source: LOG_SOURCE.TURN_END, content: { status: "completed" } }),
    ]);
    const assistant = out.find((m) => m.type === S2C.ASSISTANT_MESSAGE)!;
    expect(assistant.ts).toBe(T0 + 981200);
    expect(assistant.durationMs).toBe(981250);
  });

  it("deltas resolve the duration from markers below the slice start", () => {
    const full = [
      entryAt(0, { source: LOG_SOURCE.TURN_STARTED, content: { kind: "input" } }),
      entryAt(10, { source: LOG_SOURCE.INPUT, content: "go" }),
      entryAt(5000, { source: LOG_SOURCE.LLM, content: "mid-turn" }),
      entryAt(20000, { source: LOG_SOURCE.LLM, content: "final" }),
      entryAt(20500, { source: LOG_SOURCE.TURN_END, content: { status: "completed" } }),
    ];
    const out = sliceMeta(full, 3);
    expect(out).toHaveLength(1); // only the tail LLM entry replays
    expect(out[0]!.content).toBe("final");
    expect(out[0]!.ts).toBe(T0 + 20000);
    expect(out[0]!.durationMs).toBe(20500); // full turn span, marker or not
  });

  it("an open turn keeps the ts but drops the duration", () => {
    const out = sliceMeta([
      entryAt(0, { source: LOG_SOURCE.TURN_STARTED, content: { kind: "input" } }),
      entryAt(5000, { source: LOG_SOURCE.LLM, content: "crash cut" }),
    ]);
    const assistant = out.find((m) => m.type === S2C.ASSISTANT_MESSAGE)!;
    expect(assistant.ts).toBe(T0 + 5000);
    expect("durationMs" in assistant).toBe(false);
  });

  it("a re-emitted turn_started (crash + resume) re-brackets: the later marker owns the turn", () => {
    const out = sliceMeta([
      entryAt(0, { source: LOG_SOURCE.TURN_STARTED, content: { kind: "input" } }),
      entryAt(5000, { source: LOG_SOURCE.LLM, content: "before the crash" }),
      entryAt(10000, { source: LOG_SOURCE.TURN_STARTED, content: { kind: "resume" } }),
      entryAt(15000, { source: LOG_SOURCE.LLM, content: "after resume" }),
      entryAt(16000, { source: LOG_SOURCE.TURN_END, content: { status: "completed" } }),
    ]);
    const assistants = out.filter((m) => m.type === S2C.ASSISTANT_MESSAGE);
    expect(assistants).toHaveLength(2);
    // The never-closed first bracket invents nothing: ts survives, duration does not.
    expect(assistants[0]!.ts).toBe(T0 + 5000);
    expect("durationMs" in assistants[0]!).toBe(false);
    expect(assistants[1]!.durationMs).toBe(6000); // second marker owns the span
  });

  it("legacy entries without ts or markers ride neither field (and no bogus ts)", () => {
    const out = sliceMeta([
      { session_id: "s", source: LOG_SOURCE.LLM, content: "ancient" } as unknown as LogEntry,
      entryAt(undefined, { source: LOG_SOURCE.LLM, content: "no ts" }),
    ]);
    for (const m of out) {
      expect(m.type).toBe(S2C.ASSISTANT_MESSAGE);
      expect("ts" in m).toBe(false);
      expect("durationMs" in m).toBe(false);
    }
  });

  it("a malformed ts is dropped, not sent as garbage", () => {
    const out = sliceMeta([entryAt(undefined, { ts: "not-a-date", source: LOG_SOURCE.LLM, content: "x" })]);
    expect("ts" in out[0]!).toBe(false);
  });

  it("fork (in-memory) replay has no timestamps to send", () => {
    const out = replay([new Message({ role: "assistant", content: "forked" })]);
    expect(out[0]!.type).toBe(S2C.ASSISTANT_MESSAGE);
    expect("ts" in out[0]!).toBe(false);
    expect("durationMs" in out[0]!).toBe(false);
    expect("ctx" in out[0]!).toBe(false);
  });
});

describe("replayLogSlice footer meta (assistant ctx usage)", () => {
  function entry(over: Record<string, unknown>): LogEntry {
    return {
      session_id: "s",
      source: LOG_SOURCE.INPUT,
      content: "",
      ...over,
    } as unknown as LogEntry;
  }

  function sliceMeta(entries: LogEntry[], startIdx = 0): Array<Record<string, unknown>> {
    const ws = createWsMockWs();
    replayLogSlice(ws, "s1", entries, startIdx);
    return ws.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
  }

  it("the assistant frame carries the ctx usage of the record written for that response", () => {
    const out = sliceMeta([
      entry({ source: LOG_SOURCE.INPUT, content: "go" }),
      entry({ source: LOG_SOURCE.LLM, ts: "2026-10-20T00:00:05.000Z", content: "done" }),
      entry({
        source: LOG_SOURCE.TOKEN_USAGE,
        totalTokens: 125824,
        contextWindow: 262144,
        cachedTokens: 98304,
        promptTokens: 26112,
        completionTokens: 1408,
      }),
    ]);
    const assistant = out.find((m) => m.type === S2C.ASSISTANT_MESSAGE)!;
    // The gauge pair (used/total) plus the breakdown the record attests,
    // derived by ctxByIndex -- the same numbers the sidebar gauge shows.
    expect(assistant.ctx).toEqual({
      used: 125824,
      total: 262144,
      cached: 98304,
      prompt: 26112,
      completion: 1408,
    });
  });

  it("logs predating usage records send no ctx field (pinned omission)", () => {
    const out = sliceMeta([
      entry({ source: LOG_SOURCE.LLM, ts: "2026-10-20T00:00:05.000Z", content: "old log" }),
    ]);
    expect(out).toHaveLength(1);
    expect("ctx" in out[0]!).toBe(false);
  });

  it("a record attributes to its own llm entry only", () => {
    const out = sliceMeta([
      entry({ source: LOG_SOURCE.LLM, content: "first" }),
      entry({ source: LOG_SOURCE.TOKEN_USAGE, totalTokens: 960 }),
      entry({ source: LOG_SOURCE.LLM, content: "second" }),
    ]);
    const assistants = out.filter((m) => m.type === S2C.ASSISTANT_MESSAGE);
    expect(assistants).toHaveLength(2);
    expect(assistants[0]!.ctx).toEqual({ used: 960 });
    // No record followed the second response: it borrows nothing.
    expect("ctx" in assistants[1]!).toBe(false);
  });

  it("ctx rides a delta slice whose record lands after the cursor", () => {
    const full = [
      entry({ source: LOG_SOURCE.INPUT, content: "go" }),
      entry({ source: LOG_SOURCE.LLM, content: "answer" }),
      entry({ source: LOG_SOURCE.TOKEN_USAGE, totalTokens: 1200, contextWindow: 8000 }),
    ];
    const out = sliceMeta(full, 1);
    expect(out).toHaveLength(2); // the llm frame and the usage frame
    expect(out[0]!.type).toBe(S2C.ASSISTANT_MESSAGE);
    expect(out[0]!.ctx).toEqual({ used: 1200, total: 8000 });
    expect(out[1]!.type).toBe(S2C.TOKEN_USAGE); // the event stays on the wire
  });

  it("a record with zero totalTokens attests no ctx", () => {
    const out = sliceMeta([
      entry({ source: LOG_SOURCE.LLM, content: "answer" }),
      entry({ source: LOG_SOURCE.TOKEN_USAGE, totalTokens: 0 }),
    ]);
    const assistant = out.find((m) => m.type === S2C.ASSISTANT_MESSAGE)!;
    expect("ctx" in assistant).toBe(false);
  });
});

describe("replayLogSlice footer meta (assistant per-call duration)", () => {
  const T0 = Date.parse("2026-10-20T00:00:00.000Z");
  const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
  function entryAt(offsetMs: number, over: Record<string, unknown>): LogEntry {
    return { ts: iso(offsetMs), session_id: "s", source: LOG_SOURCE.INPUT, content: "", ...over } as unknown as LogEntry;
  }
  function sliceMeta(entries: LogEntry[]): Array<Record<string, unknown>> {
    const ws = createWsMockWs();
    replayLogSlice(ws, "s1", entries, 0);
    return ws.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
  }

  it("recorded durationMs on the usage record wins over the log gap", () => {
    // The gap (input@0 -> llm@9000) would derive 9000, but the record's own
    // durationMs is the truth: callMs = 4200, flagged NOT derived.
    const out = sliceMeta([
      entryAt(0, { source: LOG_SOURCE.INPUT, content: "go" }),
      entryAt(9000, { source: LOG_SOURCE.LLM, content: "done" }),
      entryAt(9010, { source: LOG_SOURCE.TOKEN_USAGE, totalTokens: 500, durationMs: 4200 }),
    ]);
    const assistant = out.find((m) => m.type === S2C.ASSISTANT_MESSAGE)!;
    expect(assistant.callMs).toBe(4200);
    expect("callDerived" in assistant).toBe(false);
  });

  it("falls back to the derived log gap, flagged derived, when the record has no duration", () => {
    const out = sliceMeta([
      entryAt(0, { source: LOG_SOURCE.INPUT, content: "go" }),
      entryAt(4200, { source: LOG_SOURCE.LLM, content: "done" }),
      entryAt(4210, { source: LOG_SOURCE.TOKEN_USAGE, totalTokens: 500 }),
    ]);
    const assistant = out.find((m) => m.type === S2C.ASSISTANT_MESSAGE)!;
    expect(assistant.callMs).toBe(4200);
    expect(assistant.callDerived).toBe(true);
  });

  it("old logs with no derivable gap omit callMs entirely (pinned omission)", () => {
    // No trigger entry precedes the llm: nothing to measure from, so the
    // field is omitted, never borrowed.
    const out = sliceMeta([
      entryAt(5000, { source: LOG_SOURCE.LLM, content: "old" }),
      entryAt(14000, { source: LOG_SOURCE.TURN_END, content: { status: "completed" } }),
    ]);
    const assistant = out.find((m) => m.type === S2C.ASSISTANT_MESSAGE)!;
    expect("callMs" in assistant).toBe(false);
    expect("callDerived" in assistant).toBe(false);
  });

  it("a restart never bridges: no callMs across the resume_attempt record", () => {
    const out = sliceMeta([
      entryAt(0, { source: LOG_SOURCE.TOOL_RESULT, content: "prior", tool_call_id: "c1" }),
      entryAt(200000, { source: LOG_SOURCE.RESUME_ATTEMPT, content: { origin: "auto" } }),
      entryAt(205000, { source: LOG_SOURCE.LLM, content: "after resume" }),
    ]);
    const assistant = out.find((m) => m.type === S2C.ASSISTANT_MESSAGE)!;
    expect("callMs" in assistant).toBe(false);
  });

  it("callMs and the turn durationMs are independent segments", () => {
    // Turn bracket present (durationMs), but the call gap is separate:
    // tool_result@1000 -> llm@3000 derives 2000 inside a longer turn.
    const out = sliceMeta([
      entryAt(0, { source: LOG_SOURCE.TURN_STARTED, content: { kind: "input" } }),
      entryAt(10, { source: LOG_SOURCE.INPUT, content: "go" }),
      entryAt(1000, { source: LOG_SOURCE.LLM, content: "call1", tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{}" } }] }),
      entryAt(1500, { source: LOG_SOURCE.TOOL_RESULT, content: "out", tool_call_id: "c1" }),
      entryAt(3500, { source: LOG_SOURCE.LLM, content: "final" }),
      entryAt(4000, { source: LOG_SOURCE.TURN_END, content: { status: "completed" } }),
    ]);
    const assistants = out.filter((m) => m.type === S2C.ASSISTANT_MESSAGE);
    // First call: input@10 -> llm@1000 = 990, derived (no usage record).
    expect(assistants[0]!.callMs).toBe(990);
    expect(assistants[0]!.callDerived).toBe(true);
    expect(assistants[0]!.durationMs).toBe(4000); // same turn total on both
    // Second call: tool_result@1500 -> llm@3500 = 2000, derived.
    expect(assistants[1]!.callMs).toBe(2000);
    expect(assistants[1]!.durationMs).toBe(4000);
  });
});
