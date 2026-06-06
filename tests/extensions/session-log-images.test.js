import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  replayEntriesIntoContext,
  readSessionEntries,
  LOG_SOURCE,
  SessionLog,
  createInputEntry,
  createPromptEntry,
} from "../../src/extensions/session-log/session-log.js";
import { Message } from "../../src/core/context/message.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_SESSION_ID = "test-session-images";

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

function createMockAgent() {
  return {
    context: [],
    sessionLog: { append() {}, writeSystemPrompt() {}, writeInput() {}, writeAssistant() {}, writeToolResult() {}, writeReset() {}, writeCompaction() {}, writePrompt() {} },
    ensureSystemPrompt: () => {},
  };
}

// ── Entry creation tests ─────────────────────────────────────────────────────

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

// ── SessionLog writeInput with images ────────────────────────────────────────

test("SessionLog.writeInput stores images in log file", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writeInput("What is in this image?", [
      { type: "image_url", mimeType: "image/png", data: "base64data" },
    ]);

    const entries = readSessionEntries(TEST_SESSION_ID);
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe("What is in this image?");
    expect(entries[0].images).toEqual([
      { type: "image_url", mimeType: "image/png", data: "base64data" },
    ]);
  } finally {
    teardown();
  }
});

test("SessionLog.writeInput without images stores null", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writeInput("Hello");

    const entries = readSessionEntries(TEST_SESSION_ID);
    expect(entries.length).toBe(1);
    // stripNulls removes null images from the log
    expect(entries[0].images).toBeUndefined();
  } finally {
    teardown();
  }
});

// ── Replay with images ───────────────────────────────────────────────────────

test("replayEntriesIntoContext preserves images in user messages", () => {
  const agent = createMockAgent();
  const entries = [
    {
      role: "user",
      source: LOG_SOURCE.INPUT,
      content: "What is this?",
      images: [{ type: "image_url", mimeType: "image/png", data: "abc" }],
    },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(1);
  expect(agent.context[0].images).toEqual([
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
  expect(agent.context[0].images.length).toBe(2);
  expect(agent.context[0].images[0].mimeType).toBe("image/png");
  expect(agent.context[0].images[1].mimeType).toBe("image/jpeg");
});

test("replayEntriesIntoContext handles entries without images", () => {
  const agent = createMockAgent();
  const entries = [
    { role: "user", source: LOG_SOURCE.INPUT, content: "Hello" },
    { role: "assistant", source: LOG_SOURCE.LLM, content: "Hi" },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(2);
  expect(agent.context[0].images).toBeNull();
  expect(agent.context[1].images).toBeNull();
});

test("replayEntriesIntoContext handles mixed entries with and without images", () => {
  const agent = createMockAgent();
  const entries = [
    {
      role: "user",
      source: LOG_SOURCE.INPUT,
      content: "Text only",
    },
    {
      role: "assistant",
      source: LOG_SOURCE.LLM,
      content: "Response",
    },
    {
      role: "user",
      source: LOG_SOURCE.INPUT,
      content: "With image",
      images: [{ type: "image_url", mimeType: "image/png", data: "xyz" }],
    },
    {
      role: "assistant",
      source: LOG_SOURCE.LLM,
      content: "Got it",
    },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(4);
  expect(agent.context[0].images).toBeNull();
  expect(agent.context[1].images).toBeNull();
  expect(agent.context[2].images).toEqual([
    { type: "image_url", mimeType: "image/png", data: "xyz" },
  ]);
  expect(agent.context[3].images).toBeNull();
});

// ── Round-trip test ──────────────────────────────────────────────────────────

test("SessionLog round-trip with images preserves image data", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writeInput("Analyze this image", [
      { type: "image_url", mimeType: "image/png", data: "testbase64data" },
    ]);
    log.writeAssistant("I see a cat");
    log.writeInput("What color is it?", [
      { type: "image_url", mimeType: "image/jpeg", data: "anotherimage" },
    ]);
    log.writeAssistant("It is orange");

    const entries = readSessionEntries(TEST_SESSION_ID);
    expect(entries.length).toBe(4);

    // Verify images are preserved in entries
    expect(entries[0].images).toEqual([
      { type: "image_url", mimeType: "image/png", data: "testbase64data" },
    ]);
    expect(entries[2].images).toEqual([
      { type: "image_url", mimeType: "image/jpeg", data: "anotherimage" },
    ]);

    // Replay into context
    const agent = createMockAgent();
    const replayed = replayEntriesIntoContext(agent, entries);
    expect(replayed).toBe(4);

    // Verify Message objects have images
    expect(agent.context[0].images).toEqual([
      { type: "image_url", mimeType: "image/png", data: "testbase64data" },
    ]);
    expect(agent.context[2].images).toEqual([
      { type: "image_url", mimeType: "image/jpeg", data: "anotherimage" },
    ]);

    // Verify toJSON produces correct OpenAI format
    const json0 = agent.context[0].toJSON();
    expect(Array.isArray(json0.content)).toBe(true);
    expect(json0.content[0]).toEqual({
      type: "text",
      text: "Analyze this image",
    });
    expect(json0.content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,testbase64data" },
    });
  } finally {
    teardown();
  }
});

// ── PROMPT source with images ────────────────────────────────────────────────

test("replayEntriesIntoContext handles PROMPT source with images", () => {
  const agent = createMockAgent();
  const entries = [
    {
      role: "user",
      source: LOG_SOURCE.PROMPT,
      content: "Template with image",
      images: [{ type: "image_url", mimeType: "image/webp", data: "webpimg" }],
    },
  ];

  const replayed = replayEntriesIntoContext(agent, entries);
  expect(replayed).toBe(1);
  expect(agent.context[0].role).toBe("user");
  expect(agent.context[0].images).toEqual([
    { type: "image_url", mimeType: "image/webp", data: "webpimg" },
  ]);
});

// ── getTextContent for logging ───────────────────────────────────────────────

test("replayed message getTextContent returns text without images", () => {
  const agent = createMockAgent();
  const entries = [
    {
      role: "user",
      source: LOG_SOURCE.INPUT,
      content: "What is this?",
      images: [{ type: "image_url", mimeType: "image/png", data: "abc" }],
    },
  ];

  replayEntriesIntoContext(agent, entries);
  expect(agent.context[0].getTextContent()).toBe("What is this?");
});
