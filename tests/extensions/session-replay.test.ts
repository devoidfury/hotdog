// Tests for session restoration and replay — replayEntriesIntoContext, readSessionEntries, sessionExists.
// Merged from session-replay.test.ts + session-restoration.test.ts to reduce duplication.

import { test, expect } from "bun:test";
import {
  replayEntriesIntoContext,
  readSessionEntries,
  sessionExists,
  LOG_SOURCE,
  SessionLog,
  disabledSessionLog,
} from "../../src/extensions/session-log/session-log.ts";
import { Message } from "../../src/core/context/message.ts";
import { MessageLog } from "../../src/core/context/message-log.ts";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Helpers ──────────────────────────────────────────────────────────────────

function uniqueSessionId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function setupSessionDir() {
  const dir = join(homedir(), ".cache", "hotdog", "sessions");
  mkdirSync(dir, { recursive: true });
}

function cleanupSession(sessionId) {
  const testFile = join(homedir(), ".cache", "hotdog", "sessions", `${sessionId}.jsonl`);
  try { rmSync(testFile); } catch { /* ignore */ }
}

function createMockAgent(sessionId) {
  const log = new MessageLog();
  let _isRestoring = false;
  const agent = {
    _log: log,
    _sessionId: sessionId || crypto.randomUUID(),
    _systemPrompt: null,
    _iterationCount: 0,
    get log() { return log; },
    get sessionId() { return this._sessionId; },
    get isRestoring() { return _isRestoring; },
    set isRestoring(v: boolean) { _isRestoring = v; },
    ensureSystemPrompt: () => {},
    addMessage(msg) { log.push(msg); },
  };
  return agent;
}

// ── replayEntriesIntoContext behavior ───────────────────────────────────────

test("replayEntriesIntoContext replays user and assistant messages", () => {
  const agent = createMockAgent();
  const entries = [
    { role: "user", source: LOG_SOURCE.INPUT, content: "Hello" },
    { role: "assistant", source: LOG_SOURCE.LLM, content: "Hi there" },
    { role: "user", source: LOG_SOURCE.INPUT, content: "How are you?" },
    { role: "assistant", source: LOG_SOURCE.LLM, content: "I'm fine" },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(4);
  expect(agent.log.length).toBe(4);
  expect(agent.log.at(0).content).toBe("Hello");
  expect(agent.log.at(1).content).toBe("Hi there");
  expect(agent.log.at(2).content).toBe("How are you?");
  expect(agent.log.at(3).content).toBe("I'm fine");
});

test("replayEntriesIntoContext skips system prompt entries", () => {
  const agent = createMockAgent();
  const entries = [
    { role: "system", source: LOG_SOURCE.SYSTEM_PROMPT, content: "You are a helpful assistant" },
    { role: "user", source: LOG_SOURCE.INPUT, content: "Hello" },
    { role: "assistant", source: LOG_SOURCE.LLM, content: "Hi" },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(2);
  expect(agent.log.length).toBe(2);
  expect(agent.log.at(0).content).toBe("Hello");
  expect(agent.log.at(1).content).toBe("Hi");
});

test("replayEntriesIntoContext skips reset entries", () => {
  const agent = createMockAgent();
  const entries = [
    { role: "user", source: LOG_SOURCE.INPUT, content: "Before reset" },
    { role: "user", source: LOG_SOURCE.RESET, content: "" },
    { role: "assistant", source: LOG_SOURCE.LLM, content: "After reset" },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(2);
  expect(agent.log.length).toBe(2);
  expect(agent.log.at(0).content).toBe("Before reset");
  expect(agent.log.at(1).content).toBe("After reset");
});

test("replayEntriesIntoContext handles tool calls in assistant messages", () => {
  const agent = createMockAgent();
  const toolCalls = [{ id: "tc_1", type: "function", function: { name: "bash", arguments: "ls" } }];
  const entries = [{
    role: "assistant",
    source: LOG_SOURCE.LLM,
    content: "Let me check",
    tool_calls: toolCalls,
    reasoning_content: "I should list files",
  }];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(1);
  expect(agent.log.at(0).reasoningContent).toBe("I should list files");
  expect(agent.log.at(0).toolCalls).toEqual(toolCalls);
});

test("replayEntriesIntoContext handles tool result entries", () => {
  const agent = createMockAgent();
  const entries = [{
    role: "tool",
    source: LOG_SOURCE.TOOL_RESULT,
    content: "<output>done</output>",
    tool_call_id: "tc_1",
    tool_name: "bash",
  }];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(1);
  expect(agent.log.at(0).role).toBe("tool");
  expect(agent.log.at(0).content).toBe("<output>done</output>");
  expect(agent.log.at(0).toolCallId).toBe("tc_1");
});

test("replayEntriesIntoContext handles compaction entries as user messages", () => {
  const agent = createMockAgent();
  const entries = [{
    role: "user",
    source: LOG_SOURCE.COMPACTION,
    content: "<system-notice>[Compacted 5 messages]\n\nUser asked about JS, assistant explained closures.</system-notice>",
  }];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(1);
  expect(agent.log.at(0).role).toBe("user");
  expect(agent.log.at(0).content).toContain("[Compacted 5 messages]");
});

test("replayEntriesIntoContext handles PROMPT source as user messages", () => {
  const agent = createMockAgent();
  const entries = [{ role: "user", source: LOG_SOURCE.PROMPT, content: "Prompt template rendered content" }];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(1);
  expect(agent.log.at(0).role).toBe("user");
  expect(agent.log.at(0).content).toBe("Prompt template rendered content");
});

test("replayEntriesIntoContext handles mixed entry types", () => {
  const agent = createMockAgent();
  const entries = [
    { role: "user", source: LOG_SOURCE.INPUT, content: "Hello" },
    { role: "assistant", source: LOG_SOURCE.LLM, content: "Hi there" },
    { role: "tool", source: LOG_SOURCE.TOOL_RESULT, content: "result", tool_call_id: "tc_1" },
    { role: "user", source: LOG_SOURCE.INPUT, content: "Next" },
    {
      role: "assistant", source: LOG_SOURCE.LLM, content: "Done",
      tool_calls: [{ id: "tc_2", type: "function", function: { name: "read", arguments: "file.txt" } }],
    },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(5);
  expect(agent.log.length).toBe(5);
  expect(agent.log.at(0).role).toBe("user");
  expect(agent.log.at(1).role).toBe("assistant");
  expect(agent.log.at(2).role).toBe("tool");
  expect(agent.log.at(3).role).toBe("user");
  expect(agent.log.at(4).role).toBe("assistant");
  expect(agent.log.at(4).toolCalls).toEqual([
    { id: "tc_2", type: "function", function: { name: "read", arguments: "file.txt" } },
  ]);
});

test("replayEntriesIntoContext returns 0 for empty entries", () => {
  const agent = createMockAgent();
  expect(replayEntriesIntoContext(agent, [])).toBe(0);
  expect(agent.log.length).toBe(0);
});

test("replayEntriesIntoContext handles null/undefined entries", () => {
  const agent = createMockAgent();
  expect(replayEntriesIntoContext(agent, null)).toBe(0);
  expect(replayEntriesIntoContext(agent, undefined)).toBe(0);
});

test("replayEntriesIntoContext handles assistant without reasoning or tool_calls", () => {
  const agent = createMockAgent();
  const entries = [{ role: "assistant", source: LOG_SOURCE.LLM, content: "Simple response" }];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(1);
  expect(agent.log.at(0).content).toBe("Simple response");
  expect(agent.log.at(0).reasoningContent).toBe(null);
  expect(agent.log.at(0).toolCalls).toBe(null);
});

test("replayEntriesIntoContext handles tool result without tool_call_id", () => {
  const agent = createMockAgent();
  const entries = [{ role: "tool", source: LOG_SOURCE.TOOL_RESULT, content: "no id" }];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(1);
  expect(agent.log.at(0).toolCallId).toBe(null);
});

test("replayEntriesIntoContext skips unknown source types", () => {
  const agent = createMockAgent();
  const entries = [
    { role: "user", source: LOG_SOURCE.INPUT, content: "Hello" },
    { role: "unknown", source: "unknown_source", content: "skip me" },
    { role: "assistant", source: LOG_SOURCE.LLM, content: "World" },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(2);
  expect(agent.log.length).toBe(2);
});

// ── Full session restoration round-trips ───────────────────────────────────

test("Session restoration: full round-trip with INPUT, LLM, and TOOL_RESULT entries", async () => {
  const sessionId = uniqueSessionId("restore-full");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    await log.writeInput("What is 2+2?");
    await log.writeAssistant(
      "Let me calculate that.",
      [{ id: "tc_1", type: "function", function: { name: "bash", arguments: "echo 4" } }],
      "I should use bash to calculate",
    );
    await log.writeToolResult("<output>4</output>", "tc_1", "bash");
    await log.writeAssistant("The answer is 4.");

    expect(await sessionExists(sessionId)).toBe(true);

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(4);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(4);
    expect(agent.log.length).toBe(4);

    expect(agent.log.at(0).content).toBe("What is 2+2?");
    expect(agent.log.at(1).content).toBe("Let me calculate that.");
    expect(agent.log.at(1).toolCalls).toEqual([
      { id: "tc_1", type: "function", function: { name: "bash", arguments: "echo 4" } },
    ]);
    expect(agent.log.at(1).reasoningContent).toBe("I should use bash to calculate");
    expect(agent.log.at(2).content).toBe("<output>4</output>");
    expect(agent.log.at(2).toolCallId).toBe("tc_1");
    expect(agent.log.at(3).content).toBe("The answer is 4.");
  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: successive one-shot prompts resume correctly", async () => {
  const sessionId = uniqueSessionId("restore-successive");
  setupSessionDir();

  try {
    const log1 = new SessionLog(sessionId);
    await log1.writeInput("Hello, world!");
    await log1.writeAssistant("Hello! How can I help you today?");

    const log2 = new SessionLog(sessionId);
    await log2.writeInput("What's the weather?");
    await log2.writeAssistant("I don't have access to weather data.");

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(4);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(4);

    expect(agent.log.at(0).content).toBe("Hello, world!");
    expect(agent.log.at(1).content).toBe("Hello! How can I help you today?");
    expect(agent.log.at(2).content).toBe("What's the weather?");
    expect(agent.log.at(3).content).toBe("I don't have access to weather data.");

    // Simulate third prompt being added
    agent.addMessage(new Message({ role: "user", content: "Tell me a joke." }));
    agent.addMessage(new Message({
      role: "assistant",
      content: "Why did the chicken cross the road? To get to the other side!",
    }));
    expect(agent.log.length).toBe(6);
  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: _isRestoring flag prevents duplicate log writes", async () => {
  const sessionId = uniqueSessionId("restore-flag");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    await log.writeInput("First message");
    await log.writeAssistant("First response");

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(2);

    const agent = createMockAgent(sessionId);
    agent.isRestoring = true;
    const replayed = replayEntriesIntoContext(agent, entries);
    agent.isRestoring = false;

    expect(replayed).toBe(2);
    expect(agent.log.length).toBe(2);
  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: handles session with reset marker", async () => {
  const sessionId = uniqueSessionId("restore-reset");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    await log.writeInput("Before reset");
    await log.writeReset();
    await log.writeInput("After reset");
    await log.writeAssistant("Response after reset");

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(2);
    expect(entries[0].source).toBe(LOG_SOURCE.INPUT);
    expect(entries[0].content).toBe("After reset");

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(2);
    expect(agent.log.at(0).content).toBe("After reset");
    expect(agent.log.at(1).content).toBe("Response after reset");
  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: handles session with compaction entries", async () => {
  const sessionId = uniqueSessionId("restore-compaction");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    await log.writeInput("Question 1");
    await log.writeAssistant("Answer 1");
    await log.writeCompaction(5, "Summary of conversation about JavaScript");
    await log.writeInput("Question 2");
    await log.writeAssistant("Answer 2");

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(5);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(5);
    expect(agent.log.at(0).content).toBe("Question 1");
    expect(agent.log.at(1).content).toBe("Answer 1");
    expect(agent.log.at(2).role).toBe("user");
    expect(agent.log.at(2).content).toContain("Summary of conversation");
    expect(agent.log.at(3).content).toBe("Question 2");
    expect(agent.log.at(4).content).toBe("Answer 2");
  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: handles empty/non-existent session gracefully", async () => {
  const sessionId = uniqueSessionId("restore-empty");
  setupSessionDir();

  try {
    expect(await sessionExists(sessionId)).toBe(false);

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(0);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(0);
    expect(agent.log.length).toBe(0);
  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: preserves reasoning content in assistant messages", async () => {
  const sessionId = uniqueSessionId("restore-reasoning");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    await log.writeAssistant(
      "I think the answer is 42.",
      null,
      "First I need to understand the question. Then I'll reason through it step by step. The answer should be 42.",
    );

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(1);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(1);
    expect(agent.log.at(0).reasoningContent).toBe(
      "First I need to understand the question. Then I'll reason through it step by step. The answer should be 42.",
    );
  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: preserves tool calls in assistant messages", async () => {
  const sessionId = uniqueSessionId("restore-tool-calls");
  setupSessionDir();

  try {
    const toolCalls = [
      { id: "tc_1", type: "function", function: { name: "read", arguments: "file.txt" } },
      { id: "tc_2", type: "function", function: { name: "grep", arguments: "pattern file.txt" } },
    ];

    const log = new SessionLog(sessionId);
    await log.writeAssistant("Let me check the files.", toolCalls);

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(1);
    expect(entries[0].tool_calls).toEqual(toolCalls);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(1);
    expect(agent.log.at(0).toolCalls).toEqual(toolCalls);
  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: tool result entries preserve tool_call_id", async () => {
  const sessionId = uniqueSessionId("restore-tool-result");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    await log.writeToolResult("<output>file contents</output>", "tc_1", "read");

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(1);
    expect(entries[0].tool_call_id).toBe("tc_1");
    expect(entries[0].tool_name).toBe("read");

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(1);
    expect(agent.log.at(0).toolCallId).toBe("tc_1");
  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: handles mixed entry types in correct order", async () => {
  const sessionId = uniqueSessionId("restore-mixed");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    await log.writeInput("Hello");
    await log.writeAssistant("Hi there!");
    await log.writeInput("Can you read file.txt?");
    await log.writeAssistant("Sure, let me read it.", [
      { id: "tc_1", type: "function", function: { name: "read", arguments: "file.txt" } },
    ]);
    await log.writeToolResult("<output>File contents here</output>", "tc_1", "read");
    await log.writeAssistant("Here's what I found in file.txt: File contents here");

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(6);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(6);

    expect(agent.log.at(0).role).toBe("user");
    expect(agent.log.at(1).role).toBe("assistant");
    expect(agent.log.at(2).role).toBe("user");
    expect(agent.log.at(3).role).toBe("assistant");
    expect(agent.log.at(4).role).toBe("tool");
    expect(agent.log.at(5).role).toBe("assistant");
  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: skip system prompt entries, regenerate dynamically", async () => {
  const sessionId = uniqueSessionId("restore-system-skip");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    await log.writeInput("Hello");
    await log.writeAssistant("Hi!");

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(2);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(2);
    expect(agent.log.length).toBe(2);
  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: multiple successive runs maintain consistent context", async () => {
  const sessionId = uniqueSessionId("restore-multiple");
  setupSessionDir();

  try {
    const log1 = new SessionLog(sessionId);
    await log1.writeInput("Run 1: Hello");
    await log1.writeAssistant("Run 1: Hi there!");

    const log2 = new SessionLog(sessionId);
    await log2.writeInput("Run 2: How are you?");
    await log2.writeAssistant("Run 2: I'm doing well!");

    const log3 = new SessionLog(sessionId);
    await log3.writeInput("Run 3: Goodbye");
    await log3.writeAssistant("Run 3: See you later!");

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(6);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(6);

    expect(agent.log.at(0).content).toBe("Run 1: Hello");
    expect(agent.log.at(1).content).toBe("Run 1: Hi there!");
    expect(agent.log.at(2).content).toBe("Run 2: How are you?");
    expect(agent.log.at(3).content).toBe("Run 2: I'm doing well!");
    expect(agent.log.at(4).content).toBe("Run 3: Goodbye");
    expect(agent.log.at(5).content).toBe("Run 3: See you later!");
  } finally {
    cleanupSession(sessionId);
  }
});

test("replayEntriesIntoContext round-trip with readSessionEntries", async () => {
  const sessionId = uniqueSessionId("restore-roundtrip");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    await log.writeInput("Hello");
    await log.writeAssistant("Hi there");
    await log.writeToolResult("<output>done</output>", "tc_1", "bash");
    await log.writeInput("Next question");
    await log.writeAssistant("Answer", [
      { id: "tc_2", type: "function", function: { name: "read", arguments: "file.txt" } },
    ], "Reasoning");

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(5);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(5);

    expect(agent.log.at(0).content).toBe("Hello");
    expect(agent.log.at(1).content).toBe("Hi there");
    expect(agent.log.at(2).role).toBe("tool");
    expect(agent.log.at(3).content).toBe("Next question");
    expect(agent.log.at(4).toolCalls).toEqual([
      { id: "tc_2", type: "function", function: { name: "read", arguments: "file.txt" } },
    ]);
  } finally {
    cleanupSession(sessionId);
  }
});

test("replayEntriesIntoContext round-trip with reset", async () => {
  const sessionId = uniqueSessionId("restore-reset-roundtrip");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    await log.writeInput("before reset");
    await log.writeReset();
    await log.writeInput("after reset");
    await log.writeAssistant("response");

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(2);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(2);
    expect(agent.log.at(0).content).toBe("after reset");
    expect(agent.log.at(1).content).toBe("response");
  } finally {
    cleanupSession(sessionId);
  }
});

test("replayEntriesIntoContext with only reset entries returns 0", async () => {
  const sessionId = uniqueSessionId("restore-only-reset");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    await log.writeInput("before");
    await log.writeReset();

    const entries = await readSessionEntries(sessionId);
    expect(entries.length).toBe(0);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(0);
    expect(agent.log.length).toBe(0);
  } finally {
    cleanupSession(sessionId);
  }
});
