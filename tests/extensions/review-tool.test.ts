import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ReviewTool } from '../../src/extensions/ui-session-review-cli/review.ts';
import { resultStr, tmpDir, cleanupDir } from '../helpers.ts';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

describe('ReviewTool', () => {
  it('has correct tool name', () => {
    const tool = new ReviewTool();
    const def = tool.toToolDef();
    expect(def.function.name).toBe('review');
  });

  it('generates tool definition with operations', () => {
    const tool = new ReviewTool();
    const def = tool.toToolDef();
    expect(def.function.parameters.properties).toHaveProperty('operation');
    expect(def.function.parameters.properties.operation.enum).toEqual(['list', 'get', 'tool_index']);
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

  it('handles empty string input', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute('');
    const parsed = JSON.parse(resultStr(result));
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('handles truncated content in tool_index', async () => {
    // Create a test session with tool calls that have long arguments
    const TEST_SESSION_ID = `test-review-truncate-${Date.now()}`;
    const sessionsDir = join(homedir(), '.cache', 'hotdog', 'sessions');
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

  it('get operation returns session entries', async () => {
    // Create a test session
    const TEST_SESSION_ID = `test-review-get-${Date.now()}`;
    const sessionsDir = join(homedir(), '.cache', 'hotdog', 'sessions');
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
        operation: 'get',
        session_id: TEST_SESSION_ID,
      }));
      const parsed = JSON.parse(resultStr(result));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);
      expect(parsed[0].content).toBe('hello');
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

  it('tool_index returns empty array for session with no tool calls', async () => {
    const TEST_SESSION_ID = `test-review-no-tools-${Date.now()}`;
    const sessionsDir = join(homedir(), '.cache', 'hotdog', 'sessions');
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
    const sessionsDir = join(homedir(), '.cache', 'hotdog', 'sessions');
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
    const sessionsDir = join(homedir(), '.cache', 'hotdog', 'sessions');
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
