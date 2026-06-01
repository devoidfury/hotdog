import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WriteTool } from '../../src/extensions/core-tools/write.js';
import { ToolContext, ToolResult } from '../../src/core/tool-registry.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oa-write-test-'));
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

describe('WriteTool.toToolDef', () => {
  it('returns a tool definition with all modes documented', () => {
    const def = new WriteTool().toToolDef();
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('write');
    expect(def.function.description).toContain('overwrite');
    expect(def.function.description).toContain('insert_before');
    expect(def.function.description).toContain('replace_all');
    expect(def.function.description).toContain('regex_replace');
    expect(def.function.description).toContain('replace_range');
    expect(def.function.description).toContain('replace_range_literal');
    expect(def.function.description).toContain('replace_range_regex');
  });

  it('requires mode, path, and content', () => {
    const def = new WriteTool().toToolDef();
    expect(def.function.parameters.required).toEqual(['mode', 'path', 'content']);
  });
});

// ── callDisplay ─────────────────────────────────────────────────────────────

describe('WriteTool.callDisplay', () => {
  it('shows overwrite mode', () => {
    const display = new WriteTool().callDisplay({ mode: 'overwrite', path: 'foo.txt', content: 'hello' });
    expect(display).toBe('foo.txt overwrite (1 lines)');
  });

  it('shows insert_before mode', () => {
    const display = new WriteTool().callDisplay({ mode: 'insert_before', path: 'foo.txt', content: 'hello', start_at: 5 });
    expect(display).toBe('foo.txt insert_before line 5 (1 lines)');
  });

  it('shows replace_all mode', () => {
    const display = new WriteTool().callDisplay({ mode: 'replace_all', path: 'foo.txt', content: 'new', search: 'old' });
    expect(display).toBe('foo.txt replace_all /old/ (1 lines)');
  });

  it('shows regex_replace mode', () => {
    const display = new WriteTool().callDisplay({ mode: 'regex_replace', path: 'foo.txt', content: 'new', search_re: 'old\\d+' });
    expect(display).toContain('regex_replace');
    expect(display).toContain('old\\d+');
  });

  it('shows replace_range mode', () => {
    const display = new WriteTool().callDisplay({ mode: 'replace_range', path: 'foo.txt', content: 'new', start_at: 1, end_at: 3 });
    // 3 lines replaced (lines 1-3), content has 1 line
    expect(display).toBe('foo.txt replace_range lines 1–3 (3 → 1 lines)');
  });

  it('shows replace_range_literal mode', () => {
    const display = new WriteTool().callDisplay({ mode: 'replace_range_literal', path: 'foo.txt', content: 'new', search: 'old', start_at: 1, end_at: 3 });
    expect(display).toBe('foo.txt replace_range_literal lines 1–3 (3 → 1 lines)');
  });

  it('shows replace_range_regex mode without end_at', () => {
    const display = new WriteTool().callDisplay({ mode: 'replace_range_regex', path: 'foo.txt', content: 'new', search_re: 'old', start_at: 1 });
    expect(display).toContain('replace_range_regex');
    expect(display).toContain('1–EOF');
  });

  it('handles invalid input gracefully', () => {
    const tool = new WriteTool();
    expect(tool.callDisplay('not json')).toBe('not json');
    expect(tool.callDisplay({})).toBe('');
    expect(tool.callDisplay(null)).toBe('');
  });

  it('handles multi-line content', () => {
    const display = new WriteTool().callDisplay({ mode: 'overwrite', path: 'foo.txt', content: 'line1\nline2\nline3' });
    expect(display).toBe('foo.txt overwrite (3 lines)');
  });

  it('handles empty content — splits to one empty line', () => {
    const display = new WriteTool().callDisplay({ mode: 'overwrite', path: 'foo.txt', content: '' });
    // ''.split('\n') returns [''], which has length 1
    expect(display).toBe('foo.txt overwrite (1 lines)');
  });
});

// ── execute: overwrite ──────────────────────────────────────────────────────

describe('WriteTool.execute — overwrite', () => {
  it('creates new file with overwrite mode', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const filePath = path.join(dir, 'new.txt');
    const result = await tool.execute(
      { mode: 'overwrite', path: 'new.txt', content: 'hello world' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('new.txt');
    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('hello world');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('overwrites existing file', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'existing.txt');
    fsSync.writeFileSync(filePath, 'old content');

    const tool = new WriteTool();
    await tool.execute(
      { mode: 'overwrite', path: 'existing.txt', content: 'new content' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('new content');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates parent directories for overwrite', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const filePath = path.join(dir, 'a', 'b', 'c', 'deep.txt');
    await tool.execute(
      { mode: 'overwrite', path: 'a/b/c/deep.txt', content: 'deep content' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('deep content');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns structured JSON result', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'overwrite', path: 'test.txt', content: 'hello' },
      toolCtx({ workspaceRoot: dir })
    );
    const parsed = JSON.parse(resultStr(result));
    expect(parsed.mode).toBe('overwrite');
    expect(parsed.path).toBe('test.txt');
    expect(parsed.filesize_before).toBe(0);
    expect(parsed.filesize_after).toBe(5);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles multi-line content', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const content = 'line1\nline2\nline3';
    await tool.execute(
      { mode: 'overwrite', path: 'multi.txt', content },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'multi.txt'), 'utf-8')).toBe(content);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles empty content', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'overwrite', path: 'empty.txt', content: '' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'empty.txt'), 'utf-8')).toBe('');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: insert_before ──────────────────────────────────────────────────

describe('WriteTool.execute — insert_before', () => {
  it('inserts at beginning of file', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'line2\nline3');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'insert_before', path: 'file.txt', content: 'line1', start_at: 1 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('line1\nline2\nline3');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('inserts in middle of file', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'line1\nline3');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'insert_before', path: 'file.txt', content: 'line2', start_at: 2 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('line1\nline2\nline3');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('inserts multi-line content', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'line3');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'insert_before', path: 'file.txt', content: 'line1\nline2', start_at: 1 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('line1\nline2\nline3');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('inserts at end of file', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'line1');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'insert_before', path: 'file.txt', content: 'line2', start_at: 2 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('line1\nline2');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('inserts beyond end of file', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'line1');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'insert_before', path: 'file.txt', content: 'line2', start_at: 100 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('line1\nline2');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('inserts into empty file', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), '');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'insert_before', path: 'file.txt', content: 'hello', start_at: 1 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('hello');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('errors on missing start_at', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'insert_before', path: 'file.txt', content: 'hello' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('insert_before requires path, start_at, and content');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('errors on invalid start_at (zero)', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'insert_before', path: 'file.txt', content: 'hello', start_at: 0 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('insert_before requires path, start_at, and content');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: replace_all ────────────────────────────────────────────────────

describe('WriteTool.execute — replace_all', () => {
  it('replaces all occurrences', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'foo bar foo baz foo');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'replace_all', path: 'file.txt', content: 'qux', search: 'foo' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('qux bar qux baz qux');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces nothing when search not found', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'hello world');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'replace_all', path: 'file.txt', content: 'new', search: 'xyz' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('hello world');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('errors on missing search', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'replace_all', path: 'file.txt', content: 'new' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('replace_all requires path, search, and content');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: regex_replace ──────────────────────────────────────────────────

describe('WriteTool.execute — regex_replace', () => {
  it('replaces all regex matches', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'foo1 bar foo2 baz foo3');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'regex_replace', path: 'file.txt', content: 'X', search_re: 'foo\\d+' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('X bar X baz X');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('errors on missing search_re', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'regex_replace', path: 'file.txt', content: 'new' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('regex_replace requires path, search_re, and content');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles invalid regex', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'hello');
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'regex_replace', path: 'file.txt', content: 'new', search_re: '[invalid' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Edit failed');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: replace_range ──────────────────────────────────────────────────

describe('WriteTool.execute — replace_range', () => {
  it('replaces a range of lines', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'line1\nline2\nline3\nline4');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'replace_range', path: 'file.txt', content: 'NEW', start_at: 2, end_at: 3 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('line1\nNEW\nline4');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces a single line', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'a\nb\nc');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'replace_range', path: 'file.txt', content: 'X', start_at: 2, end_at: 2 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('a\nX\nc');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces range with multi-line content', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'a\nb\nc');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'replace_range', path: 'file.txt', content: 'X\nY\nZ', start_at: 2, end_at: 2 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('a\nX\nY\nZ\nc');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('errors when end_at > file length', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'a\nb');
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'replace_range', path: 'file.txt', content: 'X', start_at: 1, end_at: 100 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Edit failed');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('errors when start_at > end_at', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'replace_range', path: 'file.txt', content: 'X', start_at: 5, end_at: 3 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('start_at must be <= end_at');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('errors on missing start_at', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'replace_range', path: 'file.txt', content: 'X', end_at: 3 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('replace_range requires path, start_at, end_at, and content');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: replace_range_literal ──────────────────────────────────────────

describe('WriteTool.execute — replace_range_literal', () => {
  it('replaces literal string in range', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'foo bar\nfoo baz\nend');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'replace_range_literal', path: 'file.txt', content: 'X', search: 'foo', start_at: 1, end_at: 2 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('X bar\nX baz\nend');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces literal string without end_at (defaults to EOF)', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'foo\nfoo\nfoo');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'replace_range_literal', path: 'file.txt', content: 'X', search: 'foo', start_at: 1 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('X\nX\nX');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('errors on missing search', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'replace_range_literal', path: 'file.txt', content: 'X', start_at: 1 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('replace_range_literal requires path, search, start_at, and content');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('errors on missing start_at', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'replace_range_literal', path: 'file.txt', content: 'X', search: 'foo' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('replace_range_literal requires path, search, start_at, and content');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: replace_range_regex ────────────────────────────────────────────

describe('WriteTool.execute — replace_range_regex', () => {
  it('replaces regex in range', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'foo1 bar\nfoo2 baz\nend');
    const tool = new WriteTool();
    await tool.execute(
      { mode: 'replace_range_regex', path: 'file.txt', content: 'X', search_re: 'foo\\d+', start_at: 1, end_at: 2 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'file.txt'), 'utf-8')).toBe('X bar\nX baz\nend');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('errors on missing search_re', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'replace_range_regex', path: 'file.txt', content: 'X', start_at: 1 },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('replace_range_regex requires path, search_re, start_at, and content');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: error cases ────────────────────────────────────────────────────

describe('WriteTool.execute — error cases', () => {
  it('returns error on invalid JSON input', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute('not json', toolCtx({ workspaceRoot: dir }));
    expect(resultStr(result)).toContain('Error parsing arguments');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns error on missing mode', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { path: 'file.txt', content: 'hello' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns error on missing path', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'overwrite', content: 'hello' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns error on missing content', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'overwrite', path: 'file.txt' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects path outside cwd boundary', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'overwrite', path: '/etc/evil.txt', content: 'hack' },
      toolCtx({ cwdBoundary: dir })
    );
    expect(resultStr(result)).toContain('outside cwd boundary');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles unknown mode', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      { mode: 'nonexistent', path: 'file.txt', content: 'hello' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Edit failed');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles input as string JSON', async () => {
    const dir = tmpDir();
    const tool = new WriteTool();
    const result = await tool.execute(
      '{"mode":"overwrite","path":"string.txt","content":"from json"}',
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'string.txt'), 'utf-8')).toBe('from json');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
