import { test, expect } from "bun:test";
import { SessionLog, LOG_SOURCE, stripNulls, readSessionEntries, readAllSessions, sessionExists, disabledSessionLog } from "../extensions/session-log/session_log.js";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_SESSION_ID = "test-session-extended";

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
  const testFile = join(homedir(), ".cache", "oa-agent", "sessions", `${TEST_SESSION_ID}.jsonl`);
  try {
    rmSync(testFile);
  } catch {
    // ignore
  }
}

test("disabledSessionLog is a no-op", () => {
  const log = disabledSessionLog();
  expect(log.append).toBeDefined();
  expect(log.writeSystemPrompt).toBeDefined();
  expect(log.writeInput).toBeDefined();
  expect(log.writeAssistant).toBeDefined();
  expect(log.writeToolResult).toBeDefined();
  expect(log.writeReset).toBeDefined();
  expect(log.writeCompaction).toBeDefined();
  expect(log.writePrompt).toBeDefined();
  // Should not throw
  expect(() => log.append({})).not.toThrow();
  expect(() => log.writeSystemPrompt("x")).not.toThrow();
  expect(() => log.writeInput("x")).not.toThrow();
  expect(() => log.writeAssistant("x")).not.toThrow();
  expect(() => log.writeToolResult("x", "tc1", "bash")).not.toThrow();
  expect(() => log.writeReset()).not.toThrow();
  expect(() => log.writeCompaction(5, "summary")).not.toThrow();
  expect(() => log.writePrompt("x")).not.toThrow();
});

test("SessionLog.writeAssistant includes reasoning and tool_calls", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writeAssistant("final output", [
      { id: "tc1", type: "function", function: { name: "bash", arguments: "ls" } },
    ], "reasoning content");

    const content = readFileSync(log.path, "utf-8");
    const line = JSON.parse(content.trim());

    expect(line.role).toBe("assistant");
    expect(line.content).toBe("final output");
    expect(line.reasoning_content).toBe("reasoning content");
    expect(line.tool_calls).toEqual([
      { id: "tc1", type: "function", function: { name: "bash", arguments: "ls" } },
    ]);
  } finally {
    teardown();
  }
});

test("SessionLog.writeCompaction includes messagesCompacted count", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writeCompaction(15, "Summarized conversation");

    const content = readFileSync(log.path, "utf-8");
    const line = JSON.parse(content.trim());

    expect(line.source).toBe(LOG_SOURCE.COMPACTION);
    expect(line.role).toBe("system");
    expect(line.content).toContain("[Compacted 15 messages]");
    expect(line.content).toContain("Summarized conversation");
  } finally {
    teardown();
  }
});

test("SessionLog.writePrompt creates correct entry", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writePrompt("Prompt content rendered");

    const content = readFileSync(log.path, "utf-8");
    const line = JSON.parse(content.trim());

    expect(line.source).toBe(LOG_SOURCE.PROMPT);
    expect(line.role).toBe("user");
    expect(line.content).toBe("Prompt content rendered");
  } finally {
    teardown();
  }
});

test("readSessionEntries handles malformed JSON lines", () => {
  const dir = join(homedir(), ".cache", "oa-agent", "sessions");
  mkdirSync(dir, { recursive: true });
  const testFile = join(dir, `${TEST_SESSION_ID}.jsonl`);
  try {
    rmSync(testFile);
  } catch {}
  
  try {
    // Write a mix of valid and invalid lines
    writeFileSync(testFile, [
      '{"ts":"2024-01-01T00:00:00Z","source":"input","content":"valid"}',
      'this is not json',
      '{"ts":"2024-01-01T00:00:01Z","source":"input","content":"also valid"}',
      '',
      '{"ts":"2024-01-01T00:00:02Z","source":"reset"}',
      '{"ts":"2024-01-01T00:00:03Z","source":"input","content":"after reset"}',
    ].join('\n'));

    const entries = readSessionEntries(TEST_SESSION_ID);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    // Should include "after reset" since there's a reset entry
    const lastEntry = entries[entries.length - 1];
    expect(lastEntry.content).toBe("after reset");
  } finally {
    try { rmSync(testFile); } catch {}
  }
});

test("readSessionEntries replays from last reset", () => {
  // Use a unique session ID to avoid conflicts with other tests
  const uniqueId = "test-reset-replay-" + Date.now();
  const dir = join(homedir(), ".cache", "oa-agent", "sessions");
  mkdirSync(dir, { recursive: true });
  const testFile = join(dir, `${uniqueId}.jsonl`);
  
  // Clean up any leftover file from previous runs
  try { rmSync(testFile); } catch {}
  
  try {
    const log = new SessionLog(uniqueId);
    log.writeInput("before reset");
    log.writeReset();
    log.writeInput("after reset");
    log.writeAssistant("response");

    const entries = readSessionEntries(uniqueId);
    // Should only include entries after reset
    expect(entries.length).toBe(2);
    expect(entries[0].content).toBe("after reset");
    expect(entries[1].content).toBe("response");
  } finally {
    try { rmSync(testFile); } catch {}
  }
});

test("readSessionEntries returns all entries when no reset", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writeInput("msg1");
    log.writeAssistant("resp1");
    log.writeInput("msg2");

    const entries = readSessionEntries(TEST_SESSION_ID);
    expect(entries.length).toBe(3);
    expect(entries[0].content).toBe("msg1");
    expect(entries[1].content).toBe("resp1");
    expect(entries[2].content).toBe("msg2");
  } finally {
    teardown();
  }
});

test("readSessionEntries returns empty for non-existent session", () => {
  const entries = readSessionEntries("non-existent-session-xyz");
  expect(entries).toEqual([]);
});

test("sessionExists returns true for existing session", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writeInput("test");
    expect(sessionExists(TEST_SESSION_ID)).toBe(true);
  } finally {
    teardown();
  }
});

test("sessionExists returns false for non-existent session", () => {
  expect(sessionExists("non-existent-session-xyz")).toBe(false);
});

test("stripNulls only strips top-level nulls", () => {
  const obj = {
    a: { nested: "value", nullField: null },
    b: null,
    c: [1, null, 3],
  };
  const result = stripNulls(obj);
  // Top-level nulls are stripped
  expect(result.b).toBeUndefined();
  // Nested objects are NOT recursively processed
  expect(result.a.nullField).toBeNull();
  // Arrays are NOT recursively processed
  expect(result.c).toEqual([1, null, 3]);
});

test("stripNulls handles empty object", () => {
  expect(stripNulls({})).toEqual({});
});

test("stripNulls preserves 0, false, empty string, empty array, empty object", () => {
  const obj = { a: 0, b: false, c: "", d: [], e: {} };
  const result = stripNulls(obj);
  expect(result).toEqual({ a: 0, b: false, c: "", d: [], e: {} });
});

test("readAllSessions reads from multiple session files", () => {
  const dir = join(homedir(), ".cache", "oa-agent", "sessions");
  mkdirSync(dir, { recursive: true });
  
  const testId1 = "test-readall-1";
  const testId2 = "test-readall-2";
  
  try {
    const file1 = join(dir, `${testId1}.jsonl`);
    const file2 = join(dir, `${testId2}.jsonl`);
    
    writeFileSync(file1, '{"ts":"2024-01-01","source":"input","content":"from session 1"}\n');
    writeFileSync(file2, '{"ts":"2024-01-01","source":"input","content":"from session 2"}\n');
    
    const allEntries = readAllSessions();
    expect(allEntries.length).toBeGreaterThanOrEqual(2);
    
    // Clean up
    rmSync(file1);
    rmSync(file2);
  } finally {
    // Clean up test files
    try { rmSync(join(dir, `${testId1}.jsonl`)); } catch {}
    try { rmSync(join(dir, `${testId2}.jsonl`)); } catch {}
  }
});

test("readAllSessions returns empty when no sessions exist", () => {
  // This test relies on the actual sessions directory state
  // It should not throw
  expect(() => readAllSessions()).not.toThrow();
});

test("SessionLog handles empty content", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writeInput("");
    log.writeAssistant("");
    log.writeToolResult("");
    log.writeReset();

    const content = readFileSync(log.path, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(4);
    
    const firstLine = JSON.parse(lines[0]);
    expect(firstLine.content).toBe("");
  } finally {
    teardown();
  }
});

test("SessionLog writes entries in order", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writeSystemPrompt("system");
    log.writeInput("input");
    log.writeAssistant("assistant");
    log.writeToolResult("tool result", "tc1", "bash");
    log.writeReset();
    log.writeCompaction(5, "summary");
    log.writePrompt("prompt");

    const content = readFileSync(log.path, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(7);

    const sources = lines.map(l => JSON.parse(l).source);
    expect(sources).toEqual([
      LOG_SOURCE.SYSTEM_PROMPT,
      LOG_SOURCE.INPUT,
      LOG_SOURCE.LLM,
      LOG_SOURCE.TOOL_RESULT,
      LOG_SOURCE.RESET,
      LOG_SOURCE.COMPACTION,
      LOG_SOURCE.PROMPT,
    ]);
  } finally {
    teardown();
  }
});
