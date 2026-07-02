// Tests for SessionLog — serialization, null stripping, images, and replay.
// Merged from session-log.test.js + session-log-extended.test.js + session-log-images.test.js
// to reduce duplication and consolidate related tests.

import { test, expect } from "bun:test";
import {
  SessionLog,
  LOG_SOURCE,
  readSessionEntries,
  readAllSessions,
  sessionExists,
  disabledSessionLog,
  createInputEntry,
  createPromptEntry,
  replayEntriesIntoContext,
} from "../../src/extensions/session-log/session-log.js";
import { Message } from "../../src/core/context/message.js";
import { MessageLog } from "../../src/core/context/message-log.js";
import { stripNulls } from "../../src/utils/objects.js";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_SESSION_ID = "test-session-log";

function setupTestDir() {
  const dir = join(homedir(), ".cache", "hotdog", "sessions");
  if (!dir.includes("hotdog")) throw new Error("bad path");
  mkdirSync(dir, { recursive: true });
  const testFile = join(dir, `${TEST_SESSION_ID}.jsonl`);
  try {
    rmSync(testFile);
  } catch {
    // doesn't exist yet
  }
}

function teardown() {
  const testFile = join(homedir(), ".cache", "hotdog", "sessions", `${TEST_SESSION_ID}.jsonl`);
  try {
    rmSync(testFile);
  } catch {
    // ignore
  }
}

function createMockAgent() {
  const log = new MessageLog();
  return {
    get log() { return log; },
    sessionLog: disabledSessionLog(),
    ensureSystemPrompt: () => {},
    addMessage(msg) { log.push(msg); },
  };
}

// ── stripNulls ───────────────────────────────────────────────────────────────

test("stripNulls removes null fields", () => {
  const obj = { a: 1, b: null, c: "hello", d: null };
  const result = stripNulls(obj);
  expect(Object.keys(result).sort()).toEqual(["a", "c"]);
  expect(result.a).toBe(1);
  expect(result.c).toBe("hello");
});

test("stripNulls preserves non-null values", () => {
  const obj = { a: 0, b: false, c: "", d: [], e: {} };
  const result = stripNulls(obj);
  expect(Object.keys(result).sort()).toEqual(["a", "b", "c", "d", "e"]);
});

test("stripNulls only strips top-level nulls", () => {
  const obj = {
    a: { nested: "value", nullField: null },
    b: null,
    c: [1, null, 3],
  };
  const result = stripNulls(obj);
  expect(result.b).toBeUndefined();
  expect(result.a.nullField).toBeNull(); // nested objects are NOT recursively processed
  expect(result.c).toEqual([1, null, 3]); // arrays are NOT recursively processed
});

test("stripNulls handles empty object", () => {
  expect(stripNulls({})).toEqual({});
});

test("stripNulls preserves falsy but non-null values", () => {
  const obj = { a: 0, b: false, c: "", d: [], e: {} };
  const result = stripNulls(obj);
  expect(result).toEqual({ a: 0, b: false, c: "", d: [], e: {} });
});

// ── disabledSessionLog ──────────────────────────────────────────────────────

test("disabledSessionLog is a no-op", () => {
  const log = disabledSessionLog();
  expect(() => log.append({})).not.toThrow();
  expect(() => log.writeSystemPrompt("x")).not.toThrow();
  expect(() => log.writeInput("x")).not.toThrow();
  expect(() => log.writeAssistant("x")).not.toThrow();
  expect(() => log.writeToolResult("x", "tc1", "bash")).not.toThrow();
  expect(() => log.writeReset()).not.toThrow();
  expect(() => log.writeCompaction(5, "summary")).not.toThrow();
  expect(() => log.writePrompt("x")).not.toThrow();
});

// ── SessionLog serialization ───────────────────────────────────────────────

test("SessionLog serializes without null fields", async () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("hello world");
    await log.writeReset();

    const content = readFileSync(log.path, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    const firstLine = JSON.parse(lines[0]);
    expect(firstLine).toEqual({
      ts: expect.any(String),
      session_id: TEST_SESSION_ID,
      role: "user",
      source: LOG_SOURCE.INPUT,
      content: "hello world",
    });
    expect(firstLine).not.toHaveProperty("reasoning_content");
    expect(firstLine).not.toHaveProperty("tool_calls");
    expect(firstLine).not.toHaveProperty("tool_call_id");
    expect(firstLine).not.toHaveProperty("tool_name");

    const resetLine = JSON.parse(lines[1]);
    expect(resetLine).toEqual({
      ts: expect.any(String),
      session_id: TEST_SESSION_ID,
      role: "user",
      source: LOG_SOURCE.RESET,
      content: "",
    });
    expect(resetLine).not.toHaveProperty("reasoning_content");
  } finally {
    teardown();
  }
});

test("SessionLog.writeAssistant includes reasoning and tool_calls", async () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeAssistant(
      "final output",
      [{ id: "tc1", type: "function", function: { name: "bash", arguments: "ls" } }],
      "reasoning content",
    );

    const content = readFileSync(log.path, "utf-8");
    const line = JSON.parse(content.trim());

    expect(line.role).toBe("assistant");
    expect(line.content).toBe("final output");
    expect(line.reasoning_content).toBe("reasoning content");
    expect(line.tool_calls).toEqual([
      { id: "tc1", type: "function", function: { name: "bash", arguments: "ls" } },
    ]);
    expect(line).not.toHaveProperty("tool_call_id");
    expect(line).not.toHaveProperty("tool_name");
  } finally {
    teardown();
  }
});

test("SessionLog.writeToolResult includes tool_call_id and tool_name", async () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeToolResult("<output>done</output>", "tc_1", "bash");

    const content = readFileSync(log.path, "utf-8");
    const line = JSON.parse(content.trim());

    expect(line.role).toBe("tool");
    expect(line.content).toBe("<output>done</output>");
    expect(line.tool_call_id).toBe("tc_1");
    expect(line.tool_name).toBe("bash");
    expect(line).not.toHaveProperty("reasoning_content");
    expect(line).not.toHaveProperty("tool_calls");
  } finally {
    teardown();
  }
});

test("SessionLog.writeCompaction includes messagesCompacted count", async () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeCompaction(15, "Summarized conversation");

    const content = readFileSync(log.path, "utf-8");
    const line = JSON.parse(content.trim());

    expect(line.source).toBe(LOG_SOURCE.COMPACTION);
    expect(line.role).toBe("user");
    expect(line.content).toContain("<system-notice>");
    expect(line.content).toContain("[Compacted 15 messages]");
    expect(line.content).toContain("Summarized conversation");
  } finally {
    teardown();
  }
});

test("SessionLog.writePrompt creates correct entry", async () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writePrompt("Prompt content rendered");

    const content = readFileSync(log.path, "utf-8");
    const line = JSON.parse(content.trim());

    expect(line.source).toBe(LOG_SOURCE.PROMPT);
    expect(line.role).toBe("user");
    expect(line.content).toBe("Prompt content rendered");
  } finally {
    teardown();
  }
});

test("SessionLog writes entries in order", async () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeSystemPrompt("system");
    await log.writeInput("input");
    await log.writeAssistant("assistant");
    await log.writeToolResult("tool result", "tc1", "bash");
    await log.writeReset();
    await log.writeCompaction(5, "summary");
    await log.writePrompt("prompt");

    const content = readFileSync(log.path, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(7);

    const sources = lines.map((l) => JSON.parse(l).source);
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

test("SessionLog handles empty content", async () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("");
    await log.writeAssistant("");
    await log.writeToolResult("");
    await log.writeReset();

    const content = readFileSync(log.path, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(4);

    const firstLine = JSON.parse(lines[0]);
    expect(firstLine.content).toBe("");
  } finally {
    teardown();
  }
});

// ── SessionLog images ──────────────────────────────────────────────────────

test("createInputEntry includes images when provided", () => {
  const entry = createInputEntry("session-1", "What is this?", [
    { type: "image_url", mimeType: "image/png", data: "abc123" },
  ]);
  expect(entry.source).toBe(LOG_SOURCE.INPUT);
  expect(entry.content).toBe("What is this?");
  expect(entry.images).toEqual([
    { type: "image_url", mimeType: "image/png", data: "abc123" },
  ]);
});

test("createInputEntry omits images when not provided", () => {
  const entry = createInputEntry("session-1", "Hello");
  expect(entry.images).toBeNull();
});

test("createPromptEntry includes images when provided", () => {
  const entry = createPromptEntry("session-1", "Analyze this", [
    { type: "image_url", mimeType: "image/jpeg", data: "imgdata" },
  ]);
  expect(entry.source).toBe(LOG_SOURCE.PROMPT);
  expect(entry.images).toEqual([
    { type: "image_url", mimeType: "image/jpeg", data: "imgdata" },
  ]);
});

test("SessionLog.writeInput stores images in log file", async () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("What is in this image?", [
      { type: "image_url", mimeType: "image/png", data: "base64data" },
    ]);

    const entries = await readSessionEntries(TEST_SESSION_ID);
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe("What is in this image?");
    expect(entries[0].images).toEqual([
      { type: "image_url", mimeType: "image/png", data: "base64data" },
    ]);
  } finally {
    teardown();
  }
});

test("SessionLog.writeInput without images stores null", async () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("Hello");

    const entries = await readSessionEntries(TEST_SESSION_ID);
    expect(entries.length).toBe(1);
    // stripNulls removes null images from the log
    expect(entries[0].images).toBeUndefined();
  } finally {
    teardown();
  }
});

test("SessionLog round-trip with images preserves image data", async () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("Analyze this image", [
      { type: "image_url", mimeType: "image/png", data: "testbase64data" },
    ]);
    await log.writeAssistant("I see a cat");
    await log.writeInput("What color is it?", [
      { type: "image_url", mimeType: "image/jpeg", data: "anotherimage" },
    ]);
    await log.writeAssistant("It is orange");

    const entries = await readSessionEntries(TEST_SESSION_ID);
    expect(entries.length).toBe(4);

    expect(entries[0].images).toEqual([
      { type: "image_url", mimeType: "image/png", data: "testbase64data" },
    ]);
    expect(entries[2].images).toEqual([
      { type: "image_url", mimeType: "image/jpeg", data: "anotherimage" },
    ]);

    const agent = createMockAgent();
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(4);

    expect(agent.log.at(0).images).toEqual([
      { type: "image_url", mimeType: "image/png", data: "testbase64data" },
    ]);
    expect(agent.log.at(2).images).toEqual([
      { type: "image_url", mimeType: "image/jpeg", data: "anotherimage" },
    ]);

    const json0 = agent.log.at(0).toJSON();
    expect(Array.isArray(json0.content)).toBe(true);
    expect(json0.content[0]).toEqual({ type: "text", text: "Analyze this image" });
    expect(json0.content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,testbase64data" },
    });
  } finally {
    teardown();
  }
});

// ── readSessionEntries ─────────────────────────────────────────────────────

test("readSessionEntries handles malformed JSON lines", async () => {
  const dir = join(homedir(), ".cache", "hotdog", "sessions");
  mkdirSync(dir, { recursive: true });
  const testFile = join(dir, `${TEST_SESSION_ID}.jsonl`);

  try {
    writeFileSync(
      testFile,
      [
        '{"ts":"2024-01-01T00:00:00Z","source":"input","content":"valid"}',
        "this is not json",
        '{"ts":"2024-01-01T00:00:01Z","source":"input","content":"also valid"}',
        "",
        '{"ts":"2024-01-01T00:00:02Z","source":"reset"}',
        '{"ts":"2024-01-01T00:00:03Z","source":"input","content":"after reset"}',
      ].join("\n"),
    );

    const entries = await readSessionEntries(TEST_SESSION_ID);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const lastEntry = entries[entries.length - 1];
    expect(lastEntry.content).toBe("after reset");
  } finally {
    try { rmSync(testFile); } catch {}
  }
});

test("readSessionEntries replays from last reset", async () => {
  const uniqueId = "test-reset-replay-" + Date.now();
  const dir = join(homedir(), ".cache", "hotdog", "sessions");
  mkdirSync(dir, { recursive: true });
  const testFile = join(dir, `${uniqueId}.jsonl`);

  try {
    const log = new SessionLog(uniqueId);
    await log.writeInput("before reset");
    await log.writeReset();
    await log.writeInput("after reset");
    await log.writeAssistant("response");

    const entries = await readSessionEntries(uniqueId);
    expect(entries.length).toBe(2);
    expect(entries[0].content).toBe("after reset");
    expect(entries[1].content).toBe("response");
  } finally {
    try { rmSync(testFile); } catch {}
  }
});

test("readSessionEntries returns all entries when no reset", async () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("msg1");
    await log.writeAssistant("resp1");
    await log.writeInput("msg2");

    const entries = await readSessionEntries(TEST_SESSION_ID);
    expect(entries.length).toBe(3);
    expect(entries[0].content).toBe("msg1");
    expect(entries[1].content).toBe("resp1");
    expect(entries[2].content).toBe("msg2");
  } finally {
    teardown();
  }
});

test("readSessionEntries returns empty for non-existent session", async () => {
  const entries = await readSessionEntries("non-existent-session-xyz");
  expect(entries).toEqual([]);
});

test("sessionExists returns true for existing session", async () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    await log.writeInput("test");
    expect(await sessionExists(TEST_SESSION_ID)).toBe(true);
  } finally {
    teardown();
  }
});

test("sessionExists returns false for non-existent session", async () => {
  expect(await sessionExists("non-existent-session-xyz")).toBe(false);
});

test("readAllSessions reads from multiple session files", async () => {
  const dir = join(homedir(), ".cache", "hotdog", "sessions");
  mkdirSync(dir, { recursive: true });

  const testId1 = "test-readall-1";
  const testId2 = "test-readall-2";

  try {
    const file1 = join(dir, `${testId1}.jsonl`);
    const file2 = join(dir, `${testId2}.jsonl`);

    writeFileSync(file1, '{"ts":"2024-01-01","source":"input","content":"from session 1"}\n');
    writeFileSync(file2, '{"ts":"2024-01-01","source":"input","content":"from session 2"}\n');

    const allEntries = await readAllSessions();
    expect(allEntries.length).toBeGreaterThanOrEqual(2);

    rmSync(file1);
    rmSync(file2);
  } finally {
    try { rmSync(join(dir, `${testId1}.jsonl`)); } catch {}
    try { rmSync(join(dir, `${testId2}.jsonl`)); } catch {}
  }
});

// ── replayEntriesIntoContext ──────────────────────────────────────────────

// Note: Basic replayEntriesIntoContext behavior tests are in session-replay.test.js
// which covers all entry types (user, assistant, tool, system, compaction, PROMPT),
// edge cases (empty, null, unknown sources), and full restoration round-trips.
// The tests below focus on image-specific replay behavior.

test("replayEntriesIntoContext preserves images in user messages", () => {
  const agent = createMockAgent();
  const entries = [
    { role: "user", source: LOG_SOURCE.INPUT, content: "What is this?", images: [{ type: "image_url", mimeType: "image/png", data: "abc" }] },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(1);
  expect(agent.log.at(0).images).toEqual([
    { type: "image_url", mimeType: "image/png", data: "abc" },
  ]);
});

test("replayEntriesIntoContext handles multiple images", () => {
  const agent = createMockAgent();
  const entries = [
    {
      role: "user",
      source: LOG_SOURCE.INPUT,
      content: "Compare these",
      images: [
        { type: "image_url", mimeType: "image/png", data: "img1" },
        { type: "image_url", mimeType: "image/jpeg", data: "img2" },
      ],
    },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(1);
  expect(agent.log.at(0).images.length).toBe(2);
  expect(agent.log.at(0).images[0].mimeType).toBe("image/png");
  expect(agent.log.at(0).images[1].mimeType).toBe("image/jpeg");
});

test("replayEntriesIntoContext handles PROMPT source with images", () => {
  const agent = createMockAgent();
  const entries = [
    { role: "user", source: LOG_SOURCE.PROMPT, content: "Template with image", images: [{ type: "image_url", mimeType: "image/webp", data: "webpimg" }] },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(1);
  expect(agent.log.at(0).role).toBe("user");
  expect(agent.log.at(0).images).toEqual([
    { type: "image_url", mimeType: "image/webp", data: "webpimg" },
  ]);
});

test("replayed message getTextContent returns text without images", () => {
  const agent = createMockAgent();
  const entries = [
    { role: "user", source: LOG_SOURCE.INPUT, content: "What is this?", images: [{ type: "image_url", mimeType: "image/png", data: "abc" }] },
  ];

  replayEntriesIntoContext(agent, entries);
  expect(agent.log.at(0).getTextContent()).toBe("What is this?");
});
