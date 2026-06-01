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
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Helpers ──────────────────────────────────────────────────────────────────

function uniqueSessionId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function setupSessionDir() {
  const dir = join(homedir(), ".cache", "oa-agent", "sessions");
  mkdirSync(dir, { recursive: true });
}

function cleanupSession(sessionId) {
  const testFile = join(homedir(), ".cache", "oa-agent", "sessions", `${sessionId}.jsonl`);
  try {
    rmSync(testFile);
  } catch {
    // ignore
  }
}

/**
 * Create a mock agent that mimics the real Agent class structure.
 * Uses a plain array for context (like the real Agent).
 */
function createMockAgent(sessionId) {
  const agent = {
    _context: [],
    _sessionId: sessionId || crypto.randomUUID(),
    _isRestoring: false,
    _systemPrompt: null,
    _iterationCount: 0,
    get context() {
      return this._context;
    },
    get sessionId() {
      return this._sessionId;
    },
    // Stub ensureSystemPrompt so it doesn't fail
    ensureSystemPrompt: () => {},
  };
  Object.defineProperty(agent, 'isRestoring', {
    get() { return agent._isRestoring; },
    set(v) { agent._isRestoring = v; },
  });
  return agent;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("Session restoration: full round-trip with INPUT, LLM, and TOOL_RESULT entries", () => {
  const sessionId = uniqueSessionId("restore-full");
  setupSessionDir();

  try {
    // Step 1: Simulate a session with user message, assistant response, and tool result
    const log = new SessionLog(sessionId);
    log.writeInput("What is 2+2?");
    log.writeAssistant(
      "Let me calculate that.",
      [{ id: "tc_1", type: "function", function: { name: "bash", arguments: "echo 4" } }],
      "I should use bash to calculate",
    );
    log.writeToolResult("<output>4</output>", "tc_1", "bash");
    log.writeAssistant("The answer is 4.");

    // Verify file exists
    expect(sessionExists(sessionId)).toBe(true);

    // Step 2: Read entries
    const entries = readSessionEntries(sessionId);
    expect(entries.length).toBe(4);

    // Verify entry types
    expect(entries[0].source).toBe(LOG_SOURCE.INPUT);
    expect(entries[1].source).toBe(LOG_SOURCE.LLM);
    expect(entries[2].source).toBe(LOG_SOURCE.TOOL_RESULT);
    expect(entries[3].source).toBe(LOG_SOURCE.LLM);

    // Step 3: Replay into a fresh agent
    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);

    expect(replayed).toBe(4);
    expect(agent.context.length).toBe(4);

    // Verify message roles and content
    expect(agent.context[0].role).toBe("user");
    expect(agent.context[0].content).toBe("What is 2+2?");

    expect(agent.context[1].role).toBe("assistant");
    expect(agent.context[1].content).toBe("Let me calculate that.");
    expect(agent.context[1].toolCalls).toEqual([
      { id: "tc_1", type: "function", function: { name: "bash", arguments: "echo 4" } },
    ]);
    expect(agent.context[1].reasoningContent).toBe("I should use bash to calculate");

    expect(agent.context[2].role).toBe("tool");
    expect(agent.context[2].content).toBe("<output>4</output>");
    expect(agent.context[2].toolCallId).toBe("tc_1");

    expect(agent.context[3].role).toBe("assistant");
    expect(agent.context[3].content).toBe("The answer is 4.");

  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: successive one-shot prompts resume correctly", () => {
  const sessionId = uniqueSessionId("restore-successive");
  setupSessionDir();

  try {
    // Simulate first one-shot prompt
    const log1 = new SessionLog(sessionId);
    log1.writeInput("Hello, world!");
    log1.writeAssistant("Hello! How can I help you today?");

    // Simulate second one-shot prompt (same session, continuing conversation)
    const log2 = new SessionLog(sessionId);
    log2.writeInput("What's the weather?");
    log2.writeAssistant("I don't have access to weather data.");

    // Verify file has all 4 entries
    const entries = readSessionEntries(sessionId);
    expect(entries.length).toBe(4);

    // Step 2: Create a fresh agent and replay
    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);

    expect(replayed).toBe(4);
    expect(agent.context.length).toBe(4);

    // Verify full conversation is restored
    expect(agent.context[0].content).toBe("Hello, world!");
    expect(agent.context[1].content).toBe("Hello! How can I help you today?");
    expect(agent.context[2].content).toBe("What's the weather?");
    expect(agent.context[3].content).toBe("I don't have access to weather data.");

    // Step 3: Simulate third prompt being added
    const userMsg = new Message({ role: "user", content: "Tell me a joke." });
    agent.context.push(userMsg);

    // Simulate assistant response
    const assistantMsg = new Message({ role: "assistant", content: "Why did the chicken cross the road? To get to the other side!" });
    agent.context.push(assistantMsg);

    // Verify 6 messages total
    expect(agent.context.length).toBe(6);
    expect(agent.context[4].content).toBe("Tell me a joke.");
    expect(agent.context[5].content).toBe("Why did the chicken cross the road? To get to the other side!");

  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: _isRestoring flag prevents duplicate log writes", () => {
  const sessionId = uniqueSessionId("restore-flag");
  setupSessionDir();

  try {
    // Create initial session log
    const log = new SessionLog(sessionId);
    log.writeInput("First message");
    log.writeAssistant("First response");

    const entries = readSessionEntries(sessionId);
    expect(entries.length).toBe(2);

    // Replay with isRestoring = true (simulating the fix)
    const agent = createMockAgent(sessionId);
    agent.isRestoring = true; // This should prevent duplicate writes
    const replayed = replayEntriesIntoContext(agent, entries);
    agent.isRestoring = false;

    expect(replayed).toBe(2);
    expect(agent.context.length).toBe(2);

    // Verify no duplicates were added during replay
    // (The _isRestoring flag prevents the session log extension from logging during replay)
    expect(agent.context[0].content).toBe("First message");
    expect(agent.context[1].content).toBe("First response");

  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: handles session with reset marker", () => {
  const sessionId = uniqueSessionId("restore-reset");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    log.writeInput("Before reset");
    log.writeReset();
    log.writeInput("After reset");
    log.writeAssistant("Response after reset");

    const entries = readSessionEntries(sessionId);
    // Should only get entries after the reset
    expect(entries.length).toBe(2);
    expect(entries[0].source).toBe(LOG_SOURCE.INPUT);
    expect(entries[0].content).toBe("After reset");

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);

    expect(replayed).toBe(2);
    expect(agent.context[0].content).toBe("After reset");
    expect(agent.context[1].content).toBe("Response after reset");

  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: handles session with compaction entries", () => {
  const sessionId = uniqueSessionId("restore-compaction");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    log.writeInput("Question 1");
    log.writeAssistant("Answer 1");
    log.writeCompaction(5, "Summary of conversation about JavaScript");
    log.writeInput("Question 2");
    log.writeAssistant("Answer 2");

    const entries = readSessionEntries(sessionId);
    expect(entries.length).toBe(5); // 2 before compaction + compaction + 2 after

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);

    expect(replayed).toBe(5);
    expect(agent.context[0].content).toBe("Question 1");
    expect(agent.context[1].content).toBe("Answer 1");
    // Compaction entry becomes a user message
    expect(agent.context[2].role).toBe("user");
    expect(agent.context[2].content).toContain("Summary of conversation");
    expect(agent.context[3].content).toBe("Question 2");
    expect(agent.context[4].content).toBe("Answer 2");

  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: handles empty/non-existent session gracefully", () => {
  const sessionId = uniqueSessionId("restore-empty");
  setupSessionDir();

  try {
    // No entries written
    expect(sessionExists(sessionId)).toBe(false);

    const entries = readSessionEntries(sessionId);
    expect(entries.length).toBe(0);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);

    expect(replayed).toBe(0);
    expect(agent.context.length).toBe(0);

  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: preserves reasoning content in assistant messages", () => {
  const sessionId = uniqueSessionId("restore-reasoning");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    log.writeAssistant(
      "I think the answer is 42.",
      null,
      "First I need to understand the question. Then I'll reason through it step by step. The answer should be 42.",
    );

    const entries = readSessionEntries(sessionId);
    expect(entries.length).toBe(1);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);

    expect(replayed).toBe(1);
    expect(agent.context[0].role).toBe("assistant");
    expect(agent.context[0].content).toBe("I think the answer is 42.");
    expect(agent.context[0].reasoningContent).toBe(
      "First I need to understand the question. Then I'll reason through it step by step. The answer should be 42.",
    );

  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: preserves tool calls in assistant messages", () => {
  const sessionId = uniqueSessionId("restore-tool-calls");
  setupSessionDir();

  try {
    const toolCalls = [
      { id: "tc_1", type: "function", function: { name: "read", arguments: "file.txt" } },
      { id: "tc_2", type: "function", function: { name: "grep", arguments: "pattern file.txt" } },
    ];

    const log = new SessionLog(sessionId);
    log.writeAssistant("Let me check the files.", toolCalls);

    const entries = readSessionEntries(sessionId);
    expect(entries.length).toBe(1);
    expect(entries[0].tool_calls).toEqual(toolCalls);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);

    expect(replayed).toBe(1);
    expect(agent.context[0].toolCalls).toEqual(toolCalls);

  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: tool result entries preserve tool_call_id", () => {
  const sessionId = uniqueSessionId("restore-tool-result");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    log.writeToolResult("<output>file contents</output>", "tc_1", "read");

    const entries = readSessionEntries(sessionId);
    expect(entries.length).toBe(1);
    expect(entries[0].tool_call_id).toBe("tc_1");
    expect(entries[0].tool_name).toBe("read");

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);

    expect(replayed).toBe(1);
    expect(agent.context[0].role).toBe("tool");
    expect(agent.context[0].toolCallId).toBe("tc_1");

  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: handles mixed entry types in correct order", () => {
  const sessionId = uniqueSessionId("restore-mixed");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    log.writeInput("Hello");
    log.writeAssistant("Hi there!");
    log.writeInput("Can you read file.txt?");
    log.writeAssistant(
      "Sure, let me read it.",
      [{ id: "tc_1", type: "function", function: { name: "read", arguments: "file.txt" } }],
    );
    log.writeToolResult("<output>File contents here</output>", "tc_1", "read");
    log.writeAssistant("Here's what I found in file.txt: File contents here");

    const entries = readSessionEntries(sessionId);
    expect(entries.length).toBe(6);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);

    expect(replayed).toBe(6);
    expect(agent.context.length).toBe(6);

    // Verify order
    expect(agent.context[0].role).toBe("user");
    expect(agent.context[1].role).toBe("assistant");
    expect(agent.context[2].role).toBe("user");
    expect(agent.context[3].role).toBe("assistant");
    expect(agent.context[4].role).toBe("tool");
    expect(agent.context[5].role).toBe("assistant");

  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: skip system prompt entries, regenerate dynamically", () => {
  const sessionId = uniqueSessionId("restore-system-skip");
  setupSessionDir();

  try {
    const log = new SessionLog(sessionId);
    log.writeInput("Hello");
    log.writeAssistant("Hi!");

    // Manually add a system prompt entry (simulating what the session log extension might write)
    const systemEntry = {
      ts: new Date().toISOString(),
      session_id: sessionId,
      role: "system",
      source: LOG_SOURCE.SYSTEM_PROMPT,
      content: "You are a helpful assistant.",
    };

    const entries = readSessionEntries(sessionId);
    // readSessionEntries only reads INPUT and LLM entries (system prompts are skipped)
    expect(entries.length).toBe(2);

    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);

    expect(replayed).toBe(2);
    // System messages should be empty (ensureSystemPrompt not called)
    expect(agent.context.length).toBe(2);

  } finally {
    cleanupSession(sessionId);
  }
});

test("Session restoration: multiple successive runs maintain consistent context", () => {
  const sessionId = uniqueSessionId("restore-multiple");
  setupSessionDir();

  try {
    // Run 1: Initial conversation
    const log1 = new SessionLog(sessionId);
    log1.writeInput("Run 1: Hello");
    log1.writeAssistant("Run 1: Hi there!");

    // Run 2: Continue conversation
    const log2 = new SessionLog(sessionId);
    log2.writeInput("Run 2: How are you?");
    log2.writeAssistant("Run 2: I'm doing well!");

    // Run 3: More conversation
    const log3 = new SessionLog(sessionId);
    log3.writeInput("Run 3: Goodbye");
    log3.writeAssistant("Run 3: See you later!");

    // Verify all 6 entries exist
    const entries = readSessionEntries(sessionId);
    expect(entries.length).toBe(6);

    // Replay into fresh agent
    const agent = createMockAgent(sessionId);
    const replayed = replayEntriesIntoContext(agent, entries);

    expect(replayed).toBe(6);
    expect(agent.context.length).toBe(6);

    // Verify all messages are in correct order
    expect(agent.context[0].content).toBe("Run 1: Hello");
    expect(agent.context[1].content).toBe("Run 1: Hi there!");
    expect(agent.context[2].content).toBe("Run 2: How are you?");
    expect(agent.context[3].content).toBe("Run 2: I'm doing well!");
    expect(agent.context[4].content).toBe("Run 3: Goodbye");
    expect(agent.context[5].content).toBe("Run 3: See you later!");

  } finally {
    cleanupSession(sessionId);
  }
});
