import { describe, it, expect } from 'bun:test';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EditTool } from '../../src/extensions/core-tools/edit.js';
import { ToolContext } from '../../src/core/extensions/tool-context.js';
import { resultStr, tmpDir, toolCtx } from '../helpers.js';

// ── Tool Definition ─────────────────────────────────────────────────────────

describe('EditTool.toToolDef', () => {
  it('returns a tool definition with correct name', () => {
    const def = new EditTool().toToolDef();
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('edit');
  });

  it('requires path, oldString, and newString', () => {
    const def = new EditTool().toToolDef();
    expect(def.function.parameters.required).toEqual(['path', 'oldString', 'newString']);
  });

  it('has replace_all as optional boolean', () => {
    const def = new EditTool().toToolDef();
    expect(def.function.parameters.properties.replace_all.type).toBe('boolean');
  });
});

// ── callDisplay ─────────────────────────────────────────────────────────────

describe('EditTool.callDisplay', () => {
  it('shows old and new string previews', () => {
    const display = new EditTool().callDisplay({
      path: 'foo.js',
      oldString: 'hello',
      newString: 'world',
    });
    expect(display).toContain('hello');
    expect(display).toContain('world');
    expect(display).toContain('foo.js');
  });

  it('truncates long strings', () => {
    const longStr = 'a'.repeat(50);
    const display = new EditTool().callDisplay({
      path: 'foo.js',
      oldString: longStr,
      newString: 'replaced',
    });
    expect(display).toContain('...');
    expect(display).toContain('foo.js:');
  });

  it('handles invalid input gracefully', () => {
    expect(new EditTool().callDisplay('not json')).toBe('not json');
    expect(new EditTool().callDisplay({})).toBe('');
    expect(new EditTool().callDisplay(null)).toBe('');
  });
});

// ── execute: exact match ────────────────────────────────────────────────────

describe('EditTool.execute — exact match', () => {
  it('replaces a single occurrence', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello world hello');

    const tool = new EditTool();
    const result = await tool.execute(
      { path: 'file.txt', oldString: 'world', newString: 'universe' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('hello universe hello');
    expect(resultStr(result)).toContain('Successfully edited');
    expect(resultStr(result)).toContain('found 1 match');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces all occurrences with replace_all', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'foo bar foo baz foo');

    const tool = new EditTool();
    await tool.execute(
      { path: 'file.txt', oldString: 'foo', newString: 'qux', replace_all: true },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('qux bar qux baz qux');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces only first by default', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'foo bar foo baz foo');

    const tool = new EditTool();
    await tool.execute(
      { path: 'file.txt', oldString: 'foo', newString: 'qux' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('qux bar foo baz foo');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces multi-line content', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nhello\nline3');

    const tool = new EditTool();
    await tool.execute(
      { path: 'file.txt', oldString: 'hello', newString: 'world' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('line1\nworld\nline3');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('creates parent directories for new file', async () => {
    const dir = tmpDir();
    const tool = new EditTool();
    const filePath = path.join(dir, 'a', 'b', 'new.txt');

    // Create initial file
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, 'old content');

    await tool.execute(
      { path: 'a/b/new.txt', oldString: 'old', newString: 'new' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('new content');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: line-trimmed fallback ──────────────────────────────────────────

describe('EditTool.execute — line-trimmed fallback', () => {
  it('matches with different indentation', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, '  hello world  \n  foo bar  ');

    const tool = new EditTool();
    await tool.execute(
      { path: 'file.txt', oldString: 'hello world', newString: 'universe' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('  universe  \n  foo bar  ');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('provides helpful error when text not found', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nline2\nline3');

    const tool = new EditTool();
    const result = await tool.execute(
      { path: 'file.txt', oldString: 'notfound', newString: 'replacement' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toContain('text not found in file');
    expect(resultStr(result)).toContain('Searched for');
    expect(resultStr(result)).toContain('File content');
    expect(resultStr(result)).toContain('Tip');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: error cases ────────────────────────────────────────────────────

describe('EditTool.execute — error cases', () => {
  it('rejects empty oldString', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello');

    const tool = new EditTool();
    const result = await tool.execute(
      { path: 'file.txt', oldString: '', newString: 'world' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toContain('oldString must not be empty');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects identical oldString and newString', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello');

    const tool = new EditTool();
    const result = await tool.execute(
      { path: 'file.txt', oldString: 'hello', newString: 'hello' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toContain('no changes to apply');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('returns error on invalid JSON input', async () => {
    const dir = tmpDir();
    const tool = new EditTool();
    const result = await tool.execute('not json', toolCtx({ workspaceRoot: dir }));
    expect(resultStr(result)).toContain('Error parsing arguments');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('returns error on missing path', async () => {
    const dir = tmpDir();
    const tool = new EditTool();
    const result = await tool.execute(
      { oldString: 'a', newString: 'b' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('returns error on missing oldString', async () => {
    const dir = tmpDir();
    const tool = new EditTool();
    const result = await tool.execute(
      { path: 'file.txt', newString: 'b' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('returns error on missing newString', async () => {
    const dir = tmpDir();
    const tool = new EditTool();
    const result = await tool.execute(
      { path: 'file.txt', oldString: 'a' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects path outside cwd boundary', async () => {
    const dir = tmpDir();
    const tool = new EditTool();
    const result = await tool.execute(
      { path: '/etc/evil.txt', oldString: 'a', newString: 'b' },
      toolCtx({ cwdBoundary: dir })
    );
    expect(resultStr(result)).toContain('outside cwd boundary');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects input that is too large', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello');

    const tool = new EditTool();
    const bigString = 'x'.repeat(16001); // DEFAULT_MAX_EDIT_INPUT_SIZE (16000) + 1
    const result = await tool.execute(
      { path: 'file.txt', oldString: bigString, newString: 'y' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Edit input too large');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('handles input as string JSON', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello world');

    const tool = new EditTool();
    await tool.execute(
      JSON.stringify({ path: 'file.txt', oldString: 'hello', newString: 'goodbye' }),
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('goodbye world');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });
});

// ── snake_case aliases ──────────────────────────────────────────────────────

describe('EditTool.execute — snake_case aliases', () => {
  it('accepts old_string and new_string', async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello world');

    const tool = new EditTool();
    await tool.execute(
      { path: 'file.txt', old_string: 'hello', new_string: 'goodbye' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('goodbye world');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });
});
