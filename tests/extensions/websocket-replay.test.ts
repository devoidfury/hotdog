// Unit tests for replay.ts. The attach/resume tests drive replayLogSlice
// through the live server; replaySessionHistory (the fork/in-memory path from
// SWITCH_SESSION) and the partial-stream flush need direct exercise: the
// message-shape mapping, tool name resolution from the preceding assistant
// turn, content flattening, and the dropped-connection catch.

import { describe, it, expect } from "bun:test";
import {
  replayPendingQuestion,
  replaySessionHistory,
} from "@extensions/websocket/replay.ts";
import { S2C } from "@extensions/websocket/protocol.ts";
import type { AgentLike } from "@core/session/index.ts";
import { Message, type ImageAttachment } from "@core/context/message.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import { createWsMockWs } from "../mocks/websocket.ts";

function received(ws: { messages: string[] }): Array<Record<string, unknown>> {
  return ws.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
}

/** A registry stub: `bash` renders a display header, `boom` throws (the
 *  display hook must not take replay down), anything else is unknown now. */
const fakeRegistry = {
  get: (name: string) => {
    if (name === "bash") return { callDisplay: (input: unknown) => `bash: ${input}` };
    if (name === "boom") {
      return {
        callDisplay: () => {
          throw new Error("display exploded");
        },
      };
    }
    return undefined;
  },
};

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
      { toolRegistry: fakeRegistry },
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
      display: 'bash: {"command":"ls"}',
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
    ], { toolRegistry: fakeRegistry });

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
    // Unknown tool: no live display, and the text was empty so no ASSISTANT_MESSAGE.
    expect(call.display).toBeUndefined();
    expect(out.some((m) => m.type === S2C.ASSISTANT_MESSAGE)).toBe(false);
  });

  it("omits display when the tool's callDisplay throws", () => {
    const out = replay([
      new Message({ role: "assistant", content: "x", toolCalls: [{ id: "c9", type: "function", function: { name: "boom", arguments: "{}" } }] }),
    ], { toolRegistry: fakeRegistry });
    const call = out.find((m) => m.type === S2C.TOOL_CALL)!;
    expect(call).toMatchObject({ name: "boom", args: "{}" });
    expect(call.display).toBeUndefined();
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
