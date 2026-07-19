// Tests for websocket/protocol.ts — C2S/S2C message type constants
// and type interfaces for client↔server WebSocket communication.

import { describe, it, expect } from "bun:test";
import { C2S, S2C } from "../../src/extensions/websocket/protocol.ts";
import type { C2SMessage, S2CMessage } from "../../src/extensions/websocket/protocol.ts";

// ── C2S Constants ────────────────────────────────────────────────────────────

describe("C2S constants", () => {
  it("has all expected message types with correct values", () => {
    const expected = {
      AUTH: "auth",
      CREATE_SESSION: "createSession",
      DELETE_SESSION: "deleteSession",
      RENAME_SESSION: "renameSession",
      LIST_SESSIONS: "listSessions",
      SWITCH_SESSION: "switchSession",
      SEND: "send",
      CANCEL: "cancel",
      QUESTION_ANSWER: "questionAnswer",
      COMMAND: "command",
    };
    expect(C2S).toEqual(expected);
  });

  it("all values are unique camelCase strings", () => {
    const values = Object.values(C2S);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^[a-z][a-zA-Z]*$/);
    }
  });
});

// ── S2C Constants ────────────────────────────────────────────────────────────

describe("S2C constants", () => {
  it("has all expected message types with correct values", () => {
    const expected = {
      SESSION_CREATED: "sessionCreated",
      SESSION_DELETED: "sessionDeleted",
      SESSIONS: "sessions",
      AUTH_REQUIRED: "authRequired",
      AUTH_ERROR: "authError",
      USER_MESSAGE: "userMessage",
      ASSISTANT_MESSAGE: "assistantMessage",
      THINKING: "thinking",
      TOOL_CALL: "toolCall",
      TOOL_RESULT: "toolResult",
      COMPACTING: "compacting",
      COMMAND_RESULT: "commandResult",
      QUESTION: "question",
      STREAMING_CHUNK: "streamingChunk",
      STREAMING_REASONING_CHUNK: "streamingReasoningChunk",
      TASK_PROGRESS: "taskProgress",
      TOKEN_USAGE: "tokenUsage",
      COMPACTION_RESULT: "compactionResult",
      SESSION_STATE: "sessionState",
      ERROR: "error",
    };
    expect(S2C).toEqual(expected);
  });

  it("all values are unique camelCase strings", () => {
    const values = Object.values(S2C);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^[a-z][a-zA-Z]*$/);
    }
  });
});

// ── No overlap between C2S and S2C ──────────────────────────────────────────

describe("C2S vs S2C", () => {
  it("C2S and S2C values do not overlap", () => {
    const c2sValues = new Set(Object.values(C2S));
    const s2cValues = new Set(Object.values(S2C));
    for (const value of c2sValues) {
      expect(s2cValues.has(value as any)).toBe(false);
    }
  });
});

// ── C2SMessage interface ────────────────────────────────────────────────────

describe("C2SMessage", () => {
  it("accepts auth, send, and command messages", () => {
    const authMsg: C2SMessage = { type: C2S.AUTH, token: "abc123" };
    expect(authMsg.type).toBe("auth");
    expect(authMsg.token).toBe("abc123");

    const sendMsg: C2SMessage = { type: C2S.SEND, content: "hello" };
    expect(sendMsg.type).toBe("send");

    const cmdMsg: C2SMessage = { type: C2S.COMMAND, sessionId: "sess-1", command: "/help" };
    expect(cmdMsg.type).toBe("command");
  });

  it("accepts additional properties via index signature", () => {
    const msg: C2SMessage = {
      type: C2S.CREATE_SESSION,
      profile: "default",
      model: "gpt-4",
      customField: true,
    };
    expect(msg.type).toBe("createSession");
    expect(msg.customField).toBe(true);
  });
});

// ── S2CMessage interface ────────────────────────────────────────────────────

describe("S2CMessage", () => {
  it("accepts session, content, and error messages", () => {
    const created: S2CMessage = { type: S2C.SESSION_CREATED, sessionId: "sess-1" };
    expect(created.type).toBe("sessionCreated");

    const authReq: S2CMessage = { type: S2C.AUTH_REQUIRED };
    expect(authReq.type).toBe("authRequired");
    expect(authReq.sessionId).toBeUndefined();

    const userMsg: S2CMessage = { type: S2C.USER_MESSAGE, sessionId: "sess-1", content: "Hello" };
    expect(userMsg.content).toBe("Hello");

    const chunk: S2CMessage = { type: S2C.STREAMING_CHUNK, sessionId: "sess-1", delta: "chunk" };
    expect(chunk.delta).toBe("chunk");
  });

  it("accepts additional properties via index signature", () => {
    const msg: S2CMessage = {
      type: S2C.ERROR,
      sessionId: "sess-1",
      code: 500,
      details: "something went wrong",
    };
    expect(msg.code).toBe(500);
  });
});
