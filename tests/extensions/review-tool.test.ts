import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { ReviewTool } from '../../src/extensions/ui-session-review-cli/review.ts';
import { resultStr } from '../helpers.ts';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

// Isolated temp dir so tests never touch the user's real session files.
const TEST_SESSIONS_DIR = mkdtempSync(join(os.tmpdir(), 'hotdog-sessions-review-tool-'));

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = TEST_SESSIONS_DIR;
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  try { rmSync(TEST_SESSIONS_DIR, { recursive: true, force: true }); } catch {}
});

describe('ReviewTool', () => {
  function writeReviewSession(id: string, entries: Record<string, unknown>[]): string {
    const sessionFile = join(TEST_SESSIONS_DIR, `${id}.jsonl`);
    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return sessionFile;
  }

  const rctxEntries = [0, 1, 2, 3, 4].map((i) => ({
    ts: Date.now(),
    source: i === 0 ? 'input' : 'llm',
    content: `msg ${i}`,
  }));

  it('has correct tool name', () => {
    const tool = new ReviewTool();
    const def = tool.toToolDef();
    expect(def.function.name).toBe('review');
  });

  it('generates tool definition with operations', () => {
    const tool = new ReviewTool();
    const def = tool.toToolDef();
    const properties = def.function.parameters.properties as Record<string, unknown>;
    expect(properties).toHaveProperty('operation');
    expect((properties.operation as Record<string, unknown>).enum).toEqual(['list', 'get', 'read_context', 'tool_index']);
    expect(properties).toHaveProperty('message_start');
    expect(properties).toHaveProperty('message_end');
    expect(def.function.parameters.required).toEqual(['operation']);
  });

  it('defaults to list operation with empty or null input', async () => {
    const tool = new ReviewTool();
    for (const input of ['', null]) {
      const parsed = JSON.parse(resultStr(await tool.execute(input)));
      expect(Array.isArray(parsed)).toBe(true);
    }
  });

  it('returns error for get without session_id', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute(JSON.stringify({ operation: 'get' }));
    expect(resultStr(result)).toContain('session_id is required');
  });

  it('returns error for tool_index without session_id', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute(JSON.stringify({ operation: 'tool_index' }));
    expect(resultStr(result)).toContain('session_id is required');
  });

  it('returns error for unknown operation', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute(JSON.stringify({ operation: 'unknown' }));
    expect(resultStr(result)).toContain('Unknown operation');
  });

  it('limits list to max 100', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute(JSON.stringify({ operation: 'list', limit: 9999 }));
    const parsed = JSON.parse(resultStr(result));
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('generates call display for list', () => {
    const tool = new ReviewTool();
    expect(tool.callDisplay(JSON.stringify({ operation: 'list' }))).toContain('list');
  });

  it('generates call display for get', () => {
    const tool = new ReviewTool();
    expect(tool.callDisplay(JSON.stringify({ operation: 'get', session_id: 'abc123' }))).toContain('abc123');
  });

  it('generates call display for tool_index', () => {
    const tool = new ReviewTool();
    expect(tool.callDisplay(JSON.stringify({ operation: 'tool_index', session_id: 'xyz' }))).toContain('xyz');
  });

  it('generates call display with unknown operation', () => {
    const tool = new ReviewTool();
    expect(tool.callDisplay(JSON.stringify({ operation: 'unknown' }))).toContain('unknown');
  });

  it('handles invalid JSON gracefully (defaults to list)', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute('not json');
    const parsed = JSON.parse(resultStr(result));
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('list tolerates files that vanish during the readdir/stat window', async () => {
    const REAL_ID = 'test-review-vanish-real';
    const ghostLink = join(TEST_SESSIONS_DIR, 'test-review-vanish-ghost.jsonl');
    const realFile = join(TEST_SESSIONS_DIR, `${REAL_ID}.jsonl`);
    writeFileSync(realFile,
      JSON.stringify({ ts: Date.now(), source: 'input', content: 'hello' }) + '\n' +
      JSON.stringify({ ts: Date.now(), source: 'llm', content: 'world' }) + '\n',
    );
    // Broken symlink: readdir() lists it but stat() throws ENOENT -- the
    // same state a session hit by concurrent cleanup would be in.
    symlinkSync('/nonexistent/hotdog-ghost-target', ghostLink);

    try {
      const tool = new ReviewTool();
      const result = await tool.execute(JSON.stringify({ operation: 'list', limit: 10 }));
      const parsed = JSON.parse(resultStr(result));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.find((s: Record<string, unknown>) => s.id === REAL_ID)).toBeDefined();
      expect(parsed.find((s: Record<string, unknown>) => s.id === 'test-review-vanish-ghost')).toBeUndefined();
    } finally {
      try { unlinkSync(ghostLink); } catch {}
      try { rmSync(realFile); } catch {}
    }
  });

  it('handles empty string input', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute('');
    const parsed = JSON.parse(resultStr(result));
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('handles truncated content in tool_index', async () => {
    // Create a test session with tool calls that have long arguments
    const TEST_SESSION_ID = `test-review-truncate-${Date.now()}`;
    const sessionsDir = TEST_SESSIONS_DIR;
    mkdirSync(sessionsDir, { recursive: true });

    // Create a session file with tool_calls
    const sessionFile = join(sessionsDir, `${TEST_SESSION_ID}.jsonl`);
    const longArgs = 'a'.repeat(600);
    writeFileSync(sessionFile, JSON.stringify({
      ts: Date.now(),
      source: 'llm',
      role: 'assistant',
      content: 'calling tool',
      tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'bash', arguments: longArgs } },
        { id: 'tc_2', type: 'function', function: { name: 'read', arguments: '{"path": "test.txt"}' } },
      ],
    }) + '\n');

    try {
      const tool = new ReviewTool();
      const result = await tool.execute(JSON.stringify({
        operation: 'tool_index',
        session_id: TEST_SESSION_ID,
      }));
      const parsed = JSON.parse(resultStr(result));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
      // First tool should have truncated arguments (500 chars max)
      expect(parsed[0].tool_name).toBe('bash');
      expect(parsed[0].arguments.length).toBe(501); // 500 + '…'
      // Second tool should not be truncated
      expect(parsed[1].tool_name).toBe('read');
      expect(parsed[1].arguments).toBe('{"path": "test.txt"}');
    } finally {
      try { rmSync(sessionFile); } catch {}
    }
  });

  it('get operation returns user input and stop responses with indexes', async () => {
    const TEST_SESSION_ID = `test-review-get-${Date.now()}`;
    const sessionFile = join(TEST_SESSIONS_DIR, `${TEST_SESSION_ID}.jsonl`);
    const entries = [
      { ts: Date.now(), source: 'input', role: 'user', content: 'hello' },
      {
        ts: Date.now(), source: 'llm', content: 'calling a tool',
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      },
      { ts: Date.now(), source: 'tool_result', content: 'tool output', tool_call_id: 'tc_1', tool_name: 'bash' },
      { ts: Date.now(), source: 'llm', content: 'final answer', reasoning_content: 'thought about it' },
    ];
    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    try {
      const tool = new ReviewTool();
      const result = await tool.execute(JSON.stringify({
        operation: 'get',
        session_id: TEST_SESSION_ID,
      }));
      const parsed = JSON.parse(resultStr(result));
      expect(Array.isArray(parsed)).toBe(true);
      // Only user input (idx 0) and the stop response (idx 3) survive.
      expect(parsed.length).toBe(2);
      expect(parsed[0].index).toBe(0);
      expect(parsed[0].content).toBe('hello');
      expect(parsed[1].index).toBe(3);
      expect(parsed[1].content).toBe('final answer');
      // Full internal fields are preserved, not a curated subset.
      expect(parsed[0].source).toBe('input');
      expect(parsed[0].ts).toBeDefined();
      expect(parsed[1].source).toBe('llm');
      expect(parsed[1].reasoning_content).toBe('thought about it');
    } finally {
      try { rmSync(sessionFile); } catch {}
    }
  });

  it('get operation returns empty array for non-existent session', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute(JSON.stringify({
      operation: 'get',
      session_id: 'non-existent-session-xyz',
    }));
    const parsed = JSON.parse(resultStr(result));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(0);
  });

  it('read_context returns the exact entry range with indexes', async () => {
    const TEST_SESSION_ID = `test-review-rctx-${Date.now()}`;
    const sessionFile = writeReviewSession(TEST_SESSION_ID, rctxEntries);
    try {
      const tool = new ReviewTool();
      const result = await tool.execute(JSON.stringify({
        operation: 'read_context',
        session_id: TEST_SESSION_ID,
        message_start: 1,
        message_end: 3,
      }));
      const parsed = JSON.parse(resultStr(result));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
      expect(parsed[0].index).toBe(1);
      expect(parsed[1].index).toBe(2);
      expect(parsed[0].content).toBe('msg 1');
      expect(parsed[1].content).toBe('msg 2');
      // Full internal fields preserved.
      expect(parsed[0].ts).toBeDefined();
      expect(parsed[0].source).toBe('llm');
    } finally {
      try { rmSync(sessionFile); } catch {}
    }
  });

  it('read_context allows end equal to total entry count (half-open)', async () => {
    const TEST_SESSION_ID = `test-review-rctx-bound-${Date.now()}`;
    const sessionFile = writeReviewSession(TEST_SESSION_ID, rctxEntries);
    try {
      const tool = new ReviewTool();
      const result = await tool.execute(JSON.stringify({
        operation: 'read_context',
        session_id: TEST_SESSION_ID,
        message_start: 3,
        message_end: 5,
      }));
      const parsed = JSON.parse(resultStr(result));
      expect(parsed.length).toBe(2);
      expect(parsed[0].index).toBe(3);
      expect(parsed[1].index).toBe(4);
    } finally {
      try { rmSync(sessionFile); } catch {}
    }
  });

  it('returns error for read_context without session_id', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute(JSON.stringify({
      operation: 'read_context',
      message_start: 0,
      message_end: 1,
    }));
    expect(resultStr(result)).toContain('session_id is required');
  });

  it('returns error for read_context with missing or non-integer range', async () => {
    const TEST_SESSION_ID = 'test-review-rctx-badargs';
    const tool = new ReviewTool();
    for (const args of [
      { operation: 'read_context', session_id: TEST_SESSION_ID },
      { operation: 'read_context', session_id: TEST_SESSION_ID, message_start: 0 },
      { operation: 'read_context', session_id: TEST_SESSION_ID, message_start: 0, message_end: '1' },
      { operation: 'read_context', session_id: TEST_SESSION_ID, message_start: 1.5, message_end: 3 },
    ]) {
      const result = await tool.execute(JSON.stringify(args));
      expect(resultStr(result)).toContain('requires integer');
    }
  });

  it('returns error for read_context with inverted or negative range', async () => {
    const TEST_SESSION_ID = 'test-review-rctx-inverted';
    const tool = new ReviewTool();
    for (const [start, end] of [[3, 1], [-1, 2]]) {
      const result = await tool.execute(JSON.stringify({
        operation: 'read_context',
        session_id: TEST_SESSION_ID,
        message_start: start,
        message_end: end,
      }));
      expect(resultStr(result)).toContain('invalid range');
    }
  });

  it('returns error for read_context beyond session length', async () => {
    const TEST_SESSION_ID = `test-review-rctx-oob-${Date.now()}`;
    const sessionFile = writeReviewSession(TEST_SESSION_ID, rctxEntries);
    try {
      const tool = new ReviewTool();
      const result = await tool.execute(JSON.stringify({
        operation: 'read_context',
        session_id: TEST_SESSION_ID,
        message_start: 0,
        message_end: 999,
      }));
      expect(resultStr(result)).toContain('out of bounds');
      expect(resultStr(result)).toContain('5 entries');
    } finally {
      try { rmSync(sessionFile); } catch {}
    }
  });

  it('generates call display for read_context', () => {
    const tool = new ReviewTool();
    const display = tool.callDisplay(JSON.stringify({
      operation: 'read_context',
      session_id: 'xyz',
      message_start: 1,
      message_end: 4,
    }));
    expect(display).toContain('xyz');
    expect(display).toContain('1-4');
  });

  it('tool_index returns empty array for session with no tool calls', async () => {
    const TEST_SESSION_ID = `test-review-no-tools-${Date.now()}`;
    const sessionsDir = TEST_SESSIONS_DIR;
    mkdirSync(sessionsDir, { recursive: true });

    const sessionFile = join(sessionsDir, `${TEST_SESSION_ID}.jsonl`);
    writeFileSync(sessionFile, JSON.stringify({
      ts: Date.now(),
      source: 'input',
      role: 'user',
      content: 'hello',
    }) + '\n');

    try {
      const tool = new ReviewTool();
      const result = await tool.execute(JSON.stringify({
        operation: 'tool_index',
        session_id: TEST_SESSION_ID,
      }));
      const parsed = JSON.parse(resultStr(result));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(0);
    } finally {
      try { rmSync(sessionFile); } catch {}
    }
  });

  it('list operation returns session summaries', async () => {
    const TEST_SESSION_ID = `test-review-list-${Date.now()}`;
    const sessionsDir = TEST_SESSIONS_DIR;
    mkdirSync(sessionsDir, { recursive: true });

    // Create a session with 2+ entries (sessions with 1 entry are filtered)
    const sessionFile = join(sessionsDir, `${TEST_SESSION_ID}.jsonl`);
    writeFileSync(sessionFile,
      JSON.stringify({ ts: Date.now(), source: 'input', content: 'hello' }) + '\n' +
      JSON.stringify({ ts: Date.now(), source: 'llm', content: 'world' }) + '\n',
    );

    try {
      const tool = new ReviewTool();
      const result = await tool.execute(JSON.stringify({
        operation: 'list',
        limit: 10,
      }));
      const parsed = JSON.parse(resultStr(result));
      expect(Array.isArray(parsed)).toBe(true);
      const found = parsed.find((s: Record<string, unknown>) => s.id === TEST_SESSION_ID);
      expect(found).toBeDefined();
      expect(found.entry_count).toBe(2);
    } finally {
      try { rmSync(sessionFile); } catch {}
    }
  });

  it('list respects limit parameter', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute(JSON.stringify({
      operation: 'list',
      limit: 1,
    }));
    const parsed = JSON.parse(resultStr(result));
    expect(Array.isArray(parsed)).toBe(true);
    // limit is enforced at max 100, min 1
  });

  it('tool_index handles entries without tool_calls', async () => {
    const TEST_SESSION_ID = `test-review-no-tc-${Date.now()}`;
    const sessionsDir = TEST_SESSIONS_DIR;
    mkdirSync(sessionsDir, { recursive: true });

    const sessionFile = join(sessionsDir, `${TEST_SESSION_ID}.jsonl`);
    writeFileSync(sessionFile,
      JSON.stringify({ ts: Date.now(), source: 'input', content: 'hello' }) + '\n' +
      JSON.stringify({ ts: Date.now(), source: 'llm', content: 'world' }) + '\n',
    );

    try {
      const tool = new ReviewTool();
      const result = await tool.execute(JSON.stringify({
        operation: 'tool_index',
        session_id: TEST_SESSION_ID,
      }));
      const parsed = JSON.parse(resultStr(result));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(0);
    } finally {
      try { rmSync(sessionFile); } catch {}
    }
  });
});
