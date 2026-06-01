import { describe, it, expect } from 'bun:test';
import fsSync from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ReadTool } from '../extensions/core-tools/read.js';
import { ToolContext, ToolResult } from '../extensions/core-tools/registry.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function tmpDir() {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), 'oa-read-test-'));
}

function toolCtx(opts = {}) {
  return new ToolContext({
    cwdBoundary: opts.cwdBoundary || null,
    workspaceRoot: opts.workspaceRoot || null,
    ...opts,
  });
}

/**
 * Extract string output from a tool result (handles ToolResult or plain string).
 * For error results, includes the error message.
 */
function resultStr(result) {
  if (result instanceof ToolResult) {
    if (result.error) {
      return result.error;
    }
    return result.output;
  }
  return result;
}

// ── Tool Definition ─────────────────────────────────────────────────────────

describe('ReadTool.toToolDef', () => {
  it('returns a tool definition with correct name', () => {
    const def = new ReadTool().toToolDef();
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('read');
  });

  it('requires only path', () => {
    const def = new ReadTool().toToolDef();
    expect(def.function.parameters.required).toEqual(['path']);
  });

  it('has optional limit and offset', () => {
    const def = new ReadTool().toToolDef();
    const props = def.function.parameters.properties;
    expect(props.limit.type).toBe('integer');
    expect(props.offset.type).toBe('integer');
    expect(props.type).toBeUndefined();
  });
});

// ── callDisplay ─────────────────────────────────────────────────────────────

describe('ReadTool.callDisplay', () => {
  it('shows path and pagination range', () => {
    const display = new ReadTool().callDisplay({ path: 'foo.txt', limit: 10, offset: 5 });
    expect(display).toBe('foo.txt (lines 5-15)');
  });

  it('handles invalid input gracefully', () => {
    expect(new ReadTool().callDisplay('not json')).toBe('not json');
    expect(new ReadTool().callDisplay({})).toBe('(no path)');
    expect(new ReadTool().callDisplay(null)).toBe('(no path)');
  });
});

// ── execute: read lines ─────────────────────────────────────────────────────

describe('ReadTool.execute — read lines', () => {
  it('reads entire file by default', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nline2\nline3');

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'file.txt' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toBe('line1\nline2\nline3');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('respects limit', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5');

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'file.txt', limit: 2 },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toBe('line1\nline2');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('respects offset', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nline2\nline3\nline4');

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'file.txt', offset: 2, limit: 2 },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toBe('line3\nline4');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles offset beyond file length', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nline2');

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'file.txt', offset: 10 },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toContain('offset 10 is beyond end');
    expect(resultStr(result)).toContain('[empty]');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles empty file', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, '');

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'file.txt' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toBe('');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles single line file', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'only line');

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'file.txt' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toBe('only line');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: directory listing ──────────────────────────────────────────────

describe('ReadTool.execute — directory listing', () => {
  it('lists directory contents at depth 1', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'a.txt'), 'a');
    fsSync.writeFileSync(path.join(dir, 'b.txt'), 'b');
    fsSync.mkdirSync(path.join(dir, 'subdir'));

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: '.' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toContain('is a directory');
    expect(resultStr(result)).toContain('a.txt');
    expect(resultStr(result)).toContain('b.txt');
    expect(resultStr(result)).toContain('subdir/');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: error cases ────────────────────────────────────────────────────

describe('ReadTool.execute — error cases', () => {
  it('returns error on file not found', async () => {
    const dir = tmpDir();
    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'nonexistent.txt' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toContain('File not found');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns error on invalid JSON input', async () => {
    const dir = tmpDir();
    const tool = new ReadTool();
    const result = await tool.execute('not json', toolCtx({ workspaceRoot: dir }));
    expect(resultStr(result)).toContain('Error parsing arguments');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns error on missing path', async () => {
    const dir = tmpDir();
    const tool = new ReadTool();
    const result = await tool.execute({ limit: 10 }, toolCtx({ workspaceRoot: dir }));
    expect(resultStr(result)).toContain('Error parsing arguments');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects path outside cwd boundary', async () => {
    const dir = tmpDir();
    const tool = new ReadTool();
    const result = await tool.execute(
      { path: '/etc/passwd' },
      toolCtx({ cwdBoundary: dir })
    );
    expect(resultStr(result)).toContain('outside cwd boundary');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles input as string JSON', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello world');

    const tool = new ReadTool();
    const result = await tool.execute(
      JSON.stringify({ path: 'file.txt' }),
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toBe('hello world');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
