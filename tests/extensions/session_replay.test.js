import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  replayEntriesIntoContext,
  readSessionEntries,
  sessionExists,
  LOG_SOURCE,
  SessionLog,
  disabledSessionLog,
} from "../../src/extensions/session-log/session_log.js";
import { Message } from "../../src/core/context/message.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_SESSION_ID = "test-session-replay";

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
  const testFile = join(
    homedir(),
    ".cache",
    "oa-agent",
    "sessions",
    `${TEST_SESSION_ID}.jsonl`,
  );
  try {
    rmSync(testFile);
  } catch {
    // ignore
  }
}

/**
 * Create a minimal mock agent with an array context (as the real Agent does).
 */
function createMockAgent() {
  return {
    context: [],
    sessionLog: disabledSessionLog(),
    // Stub ensureSystemPrompt so it doesn't fail
    ensureSystemPrompt: () => {},
  };
}

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
  expect(agent.context.length).toBe(4);

  expect(agent.context[0].role).toBe("user");
  expect(agent.context[0].content).toBe("Hello");
  expect(agent.context[1].role).toBe("assistant");
  expect(agent.context[1].content).toBe("Hi there");
  expect(agent.context[2].role).toBe("user");
  expect(agent.context[2].content).toBe("How are you?");
  expect(agent.context[3].role).toBe("assistant");
  expect(agent.context[3].content).toBe("I'm fine");
});

test("replayEntriesIntoContext skips system prompt entries", () => {
  const agent = createMockAgent();
  const entries = [
    {
      role: "system",
      source: LOG_SOURCE.SYSTEM_PROMPT,
      content: "You are a helpful assistant",
    },
    { role: "user", source: LOG_SOURCE.INPUT, content: "Hello" },
    {
      role: "system",
      source: LOG_SOURCE.SYSTEM_PROMPT,
      content: "More system prompt",
    },
    { role: "assistant", source: LOG_SOURCE.LLM, content: "Hi" },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);

  expect(replayed).toBe(2);
  expect(agent.context.length).toBe(2);
  expect(agent.context[0].content).toBe("Hello");
  expect(agent.context[1].content).toBe("Hi");
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
  expect(agent.context.length).toBe(2);
  expect(agent.context[0].content).toBe("Before reset");
  expect(agent.context[1].content).toBe("After reset");
});

test("replayEntriesIntoContext handles tool calls in assistant messages", () => {
  const agent = createMockAgent();
  const toolCalls = [
    {
      id: "tc_1",
      type: "function",
      function: { name: "bash", arguments: "ls" },
    },
  ];
  const entries = [
    {
      role: "assistant",
      source: LOG_SOURCE.LLM,
      content: "Let me check",
      tool_calls: toolCalls,
      reasoning_content: "I should list files",
    },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);

  expect(replayed).toBe(1);
  expect(agent.context[0].role).toBe("assistant");
  expect(agent.context[0].content).toBe("Let me check");
  expect(agent.context[0].reasoningContent).toBe("I should list files");
  expect(agent.context[0].toolCalls).toEqual(toolCalls);
});

test("replayEntriesIntoContext handles tool result entries", () => {
  const agent = createMockAgent();
  const entries = [
    {
      role: "tool",
      source: LOG_SOURCE.TOOL_RESULT,
      content: "<output>done</output>",
      tool_call_id: "tc_1",
      tool_name: "bash",
    },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);

  expect(replayed).toBe(1);
  expect(agent.context[0].role).toBe("tool");
  expect(agent.context[0].content).toBe("<output>done</output>");
  expect(agent.context[0].toolCallId).toBe("tc_1");
});

test("replayEntriesIntoContext handles compaction entries as user messages", () => {
  const agent = createMockAgent();
  const entries = [
    {
      role: "system",
      source: LOG_SOURCE.COMPACTION,
      content:
        "[Compacted 5 messages]\n\nUser asked about JS, assistant explained closures.",
    },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);

  expect(replayed).toBe(1);
  expect(agent.context[0].role).toBe("user");
  expect(agent.context[0].content).toBe(
    "[Compacted 5 messages]\n\nUser asked about JS, assistant explained closures.",
  );
});

test("replayEntriesIntoContext handles PROMPT source as user messages", () => {
  const agent = createMockAgent();
  const entries = [
    {
      role: "user",
      source: LOG_SOURCE.PROMPT,
      content: "Prompt template rendered content",
    },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);

  expect(replayed).toBe(1);
  expect(agent.context[0].role).toBe("user");
  expect(agent.context[0].content).toBe("Prompt template rendered content");
});

test("replayEntriesIntoContext handles mixed entry types", () => {
  const agent = createMockAgent();
  const entries = [
    { role: "user", source: LOG_SOURCE.INPUT, content: "Hello" },
    { role: "assistant", source: LOG_SOURCE.LLM, content: "Hi there" },
    {
      role: "tool",
      source: LOG_SOURCE.TOOL_RESULT,
      content: "result",
      tool_call_id: "tc_1",
    },
    { role: "user", source: LOG_SOURCE.INPUT, content: "Next" },
    {
      role: "assistant",
      source: LOG_SOURCE.LLM,
      content: "Done",
      tool_calls: [
        {
          id: "tc_2",
          type: "function",
          function: { name: "read", arguments: "file.txt" },
        },
      ],
    },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);

  expect(replayed).toBe(5);
  expect(agent.context.length).toBe(5);

  expect(agent.context[0].role).toBe("user");
  expect(agent.context[1].role).toBe("assistant");
  expect(agent.context[2].role).toBe("tool");
  expect(agent.context[3].role).toBe("user");
  expect(agent.context[4].role).toBe("assistant");
  expect(agent.context[4].toolCalls).toEqual([
    {
      id: "tc_2",
      type: "function",
      function: { name: "read", arguments: "file.txt" },
    },
  ]);
});

test("replayEntriesIntoContext returns 0 for empty entries", () => {
  const agent = createMockAgent();
  const replayed = replayEntriesIntoContext(agent, []);
  expect(replayed).toBe(0);
  expect(agent.context.length).toBe(0);
});

test("replayEntriesIntoContext handles null/undefined entries", () => {
  const agent = createMockAgent();
  const replayed = replayEntriesIntoContext(agent, null);
  expect(replayed).toBe(0);

  const replayed2 = replayEntriesIntoContext(agent, undefined);
  expect(replayed2).toBe(0);
});

test("replayEntriesIntoContext handles assistant without reasoning or tool_calls", () => {
  const agent = createMockAgent();
  const entries = [
    { role: "assistant", source: LOG_SOURCE.LLM, content: "Simple response" },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);

  expect(replayed).toBe(1);
  expect(agent.context[0].role).toBe("assistant");
  expect(agent.context[0].content).toBe("Simple response");
  expect(agent.context[0].reasoningContent).toBe(null);
  expect(agent.context[0].toolCalls).toBe(null);
});

test("replayEntriesIntoContext handles tool result without tool_call_id", () => {
  const agent = createMockAgent();
  const entries = [
    { role: "tool", source: LOG_SOURCE.TOOL_RESULT, content: "no id" },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);

  expect(replayed).toBe(1);
  expect(agent.context[0].role).toBe("tool");
  expect(agent.context[0].toolCallId).toBe(null);
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
  expect(agent.context.length).toBe(2);
});

// Integration test: round-trip with readSessionEntries
test("replayEntriesIntoContext round-trip with readSessionEntries", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writeInput("Hello");
    log.writeAssistant("Hi there");
    log.writeToolResult("<output>done</output>", "tc_1", "bash");
    log.writeInput("Next question");
    log.writeAssistant(
      "Answer",
      [
        {
          id: "tc_2",
          type: "function",
          function: { name: "read", arguments: "file.txt" },
        },
      ],
      "Reasoning",
    );

    const entries = readSessionEntries(TEST_SESSION_ID);
    expect(entries.length).toBe(5);

    const agent = createMockAgent();
    const replayed = replayEntriesIntoContext(agent, entries);

    expect(replayed).toBe(5);
    expect(agent.context.length).toBe(5);

    expect(agent.context[0].content).toBe("Hello");
    expect(agent.context[1].content).toBe("Hi there");
    expect(agent.context[2].role).toBe("tool");
    expect(agent.context[3].content).toBe("Next question");
    expect(agent.context[4].toolCalls).toEqual([
      {
        id: "tc_2",
        type: "function",
        function: { name: "read", arguments: "file.txt" },
      },
    ]);
  } finally {
    teardown();
  }
});

test("replayEntriesIntoContext round-trip with reset", () => {
  const uniqueId = "test-replay-reset-" + Date.now();
  const dir = join(homedir(), ".cache", "oa-agent", "sessions");
  mkdirSync(dir, { recursive: true });
  const testFile = join(dir, `${uniqueId}.jsonl`);

  try {
    const log = new SessionLog(uniqueId);
    log.writeInput("before reset");
    log.writeReset();
    log.writeInput("after reset");
    log.writeAssistant("response");

    const entries = readSessionEntries(uniqueId);
    expect(entries.length).toBe(2);

    const agent = createMockAgent();
    const replayed = replayEntriesIntoContext(agent, entries);

    expect(replayed).toBe(2);
    expect(agent.context[0].content).toBe("after reset");
    expect(agent.context[1].content).toBe("response");
  } finally {
    try {
      rmSync(testFile);
    } catch {}
  }
});

test("replayEntriesIntoContext with only reset entries returns 0", () => {
  const uniqueId = "test-replay-only-reset-" + Date.now();
  const dir = join(homedir(), ".cache", "oa-agent", "sessions");
  mkdirSync(dir, { recursive: true });
  const testFile = join(dir, `${uniqueId}.jsonl`);

  try {
    const log = new SessionLog(uniqueId);
    log.writeInput("before");
    log.writeReset();

    const entries = readSessionEntries(uniqueId);
    expect(entries.length).toBe(0);

    const agent = createMockAgent();
    const replayed = replayEntriesIntoContext(agent, entries);

    expect(replayed).toBe(0);
    expect(agent.context.length).toBe(0);
  } finally {
    try {
      rmSync(testFile);
    } catch {}
  }
});

test("replayEntriesIntoContext preserves system prompt count at 0 before ensureSystemPrompt", () => {
  const agent = createMockAgent();
  const entries = [
    { role: "user", source: LOG_SOURCE.INPUT, content: "Hello" },
    { role: "assistant", source: LOG_SOURCE.LLM, content: "Hi" },
  ];

  replayEntriesIntoContext(agent, entries);

  // Context is a plain array — no system messages
  expect(agent.context.length).toBe(2);
});

// ── Session Restoration Tests ────────────────────────────────────────────────

test("sessionExists + readSessionEntries + replayEntriesIntoContext integration", () => {
  const uniqueId = "test-restoration-" + Date.now();
  const dir = join(homedir(), ".cache", "oa-agent", "sessions");
  mkdirSync(dir, { recursive: true });
  const testFile = join(dir, `${uniqueId}.jsonl`);

  try {
    const log = new SessionLog(uniqueId);
    log.writeInput("Hello");
    log.writeAssistant("Hi there!");
    log.writeToolResult("<output>done</output>", "tc_1", "bash");
    log.writeInput("Goodbye");
    log.writeAssistant("See you later!");

    expect(sessionExists(uniqueId)).toBe(true);

    const entries = readSessionEntries(uniqueId);
    expect(entries.length).toBe(5);

    const agent = createMockAgent();
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(5);
    expect(agent.context.length).toBe(5);

    expect(agent.context[0].content).toBe("Hello");
    expect(agent.context[1].content).toBe("Hi there!");
    expect(agent.context[2].role).toBe("tool");
    expect(agent.context[3].content).toBe("Goodbye");
    expect(agent.context[4].content).toBe("See you later!");
  } finally {
    try {
      rmSync(testFile);
    } catch {}
  }
});

test("sessionExists returns false for non-existent session", () => {
  expect(sessionExists("this-session-does-not-exist-xyz-12345")).toBe(false);
});

test("replayEntriesIntoContext with empty entries list", () => {
  const agent = createMockAgent();
  const replayed = replayEntriesIntoContext(agent, []);
  expect(replayed).toBe(0);
  expect(agent.context.length).toBe(0);
});

test("readSessionEntries returns empty array for non-existent session", () => {
  const entries = readSessionEntries("non-existent-session-abc-12345");
  expect(entries).toEqual([]);
});

test("session restoration with reset — only replays after last reset", () => {
  const uniqueId = "test-restoration-reset-" + Date.now();
  const dir = join(homedir(), ".cache", "oa-agent", "sessions");
  mkdirSync(dir, { recursive: true });
  const testFile = join(dir, `${uniqueId}.jsonl`);

  try {
    const log = new SessionLog(uniqueId);
    log.writeInput("before reset 1");
    log.writeAssistant("response 1");
    log.writeReset();
    log.writeInput("after reset");
    log.writeAssistant("response after");

    const entries = readSessionEntries(uniqueId);
    expect(entries.length).toBe(2);
    expect(entries[0].content).toBe("after reset");
    expect(entries[1].content).toBe("response after");

    const agent = createMockAgent();
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(2);
    expect(agent.context[0].content).toBe("after reset");
  } finally {
    try {
      rmSync(testFile);
    } catch {}
  }
});

test("session restoration with compaction entries", () => {
  const uniqueId = "test-restoration-compaction-" + Date.now();
  const dir = join(homedir(), ".cache", "oa-agent", "sessions");
  mkdirSync(dir, { recursive: true });
  const testFile = join(dir, `${uniqueId}.jsonl`);

  try {
    const log = new SessionLog(uniqueId);
    log.writeInput("first question");
    log.writeAssistant("first answer");
    log.writeCompaction(10, "Summarized conversation about JS");
    log.writeInput("second question");
    log.writeAssistant("second answer");

    const entries = readSessionEntries(uniqueId);
    expect(entries.length).toBe(5);

    const agent = createMockAgent();
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(5);

    // Compaction entry should be replayed as user message
    expect(agent.context[2].role).toBe("user");
    expect(agent.context[2].content).toContain("[Compacted 10 messages]");
  } finally {
    try {
      rmSync(testFile);
    } catch {}
  }
});
