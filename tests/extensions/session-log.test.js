import { test, expect } from "bun:test";
import { SessionLog, LOG_SOURCE, readSessionEntries } from "../../src/extensions/session-log/session-log.js";
import { stripNulls } from "../../src/utils/objects.js";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_SESSION_ID = "test-session-nulls";

function setupTestDir() {
  const dir = join(homedir(), ".cache", "oa-agent", "sessions");
  if (!dir.includes("oa-agent")) throw new Error("bad path");
  mkdirSync(dir, { recursive: true });
  // Clean up any previous test data
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

test("SessionLog serializes without null fields", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writeInput("hello world");
    log.writeReset();

    const content = readFileSync(log.path, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    // First line should NOT have null fields
    const firstLine = JSON.parse(lines[0]);
    expect(firstLine).toEqual({
      ts: expect.any(String),
      session_id: TEST_SESSION_ID,
      role: "user",
      source: LOG_SOURCE.INPUT,
      content: "hello world",
    });
    // Verify null fields are absent
    expect(firstLine).not.toHaveProperty("reasoning_content");
    expect(firstLine).not.toHaveProperty("tool_calls");
    expect(firstLine).not.toHaveProperty("tool_call_id");
    expect(firstLine).not.toHaveProperty("tool_name");

    // Reset line should also be clean
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

test("SessionLog with tool_calls includes them", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writeAssistant("thinking", [
      { id: "tc_1", type: "function", function: { name: "bash", arguments: "ls" } },
    ], "reasoning content");

    const content = readFileSync(log.path, "utf-8");
    const line = JSON.parse(content.trim());

    expect(line.role).toBe("assistant");
    expect(line.content).toBe("thinking");
    expect(line.reasoning_content).toBe("reasoning content");
    expect(line.tool_calls).toEqual([
      { id: "tc_1", type: "function", function: { name: "bash", arguments: "ls" } },
    ]);
    // tool_call_id and tool_name should be absent (they're null)
    expect(line).not.toHaveProperty("tool_call_id");
    expect(line).not.toHaveProperty("tool_name");
  } finally {
    teardown();
  }
});

test("SessionLog tool_result includes tool_call_id and tool_name", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writeToolResult("<output>done</output>", "tc_1", "bash");

    const content = readFileSync(log.path, "utf-8");
    const line = JSON.parse(content.trim());

    expect(line.role).toBe("tool");
    expect(line.content).toBe("<output>done</output>");
    expect(line.tool_call_id).toBe("tc_1");
    expect(line.tool_name).toBe("bash");
    // reasoning_content and tool_calls should be absent
    expect(line).not.toHaveProperty("reasoning_content");
    expect(line).not.toHaveProperty("tool_calls");
  } finally {
    teardown();
  }
});

test("readSessionEntries round-trip with stripped nulls", () => {
  setupTestDir();
  try {
    const log = new SessionLog(TEST_SESSION_ID);
    log.writeInput("test input");
    log.writeAssistant("response");
    log.writeReset();
    log.writeInput("after reset");

    const entries = readSessionEntries(TEST_SESSION_ID);

    // Should replay from reset, so only 1 entry
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[entries.length - 1].content).toBe("after reset");
  } finally {
    teardown();
  }
});
