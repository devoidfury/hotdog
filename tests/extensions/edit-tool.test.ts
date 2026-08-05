import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EditTool } from '../../src/extensions/core-tools/edit.ts';
import { AssistantRetryableError } from '../../src/core/error.ts';
import { ToolContext } from '../../src/core/extensions/tool-context.ts';
import { resultStr, tmpDir, toolCtx, cleanupDir } from '../helpers.ts';

let dir: string;

beforeAll(() => {
  dir = tmpDir();
});

afterAll(() => {
  cleanupDir(dir);
});

// ── Tool Definition ─────────────────────────────────────────────────────────

describe('EditTool.toToolDef', () => {
  it('returns a tool definition with correct name', () => {
    const def = new EditTool({ maxEditInputSize: 16000 }).toToolDef();
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('edit');
  });

  it('requires path, oldString, and newString', () => {
    const def = new EditTool({ maxEditInputSize: 16000 }).toToolDef();
    expect(def.function.parameters.required).toEqual(['path', 'oldString', 'newString']);
  });

  it('has replace_all as optional boolean', () => {
    const def = new EditTool({ maxEditInputSize: 16000 }).toToolDef();
    const props = def.function.parameters.properties as Record<string, unknown>;
    expect((props.replace_all as Record<string, string>).type).toBe('boolean');
  });
});

// ── callDisplay ─────────────────────────────────────────────────────────────

describe('EditTool.callDisplay', () => {
  it('shows old and new string previews', () => {
    const display = new EditTool({ maxEditInputSize: 16000 }).callDisplay({
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
    const display = new EditTool({ maxEditInputSize: 16000 }).callDisplay({
      path: 'foo.js',
      oldString: longStr,
      newString: 'replaced',
    });
    expect(display).toContain('...');
    expect(display).toContain('foo.js:');
  });

  it('handles invalid input gracefully', () => {
    expect(new EditTool({ maxEditInputSize: 16000 }).callDisplay('not json')).toBe('not json');
    expect(new EditTool({ maxEditInputSize: 16000 }).callDisplay({})).toBe('');
    expect(new EditTool({ maxEditInputSize: 16000 }).callDisplay(null)).toBe('');
  });
});

// ── execute: exact match ────────────────────────────────────────────────────

describe('EditTool.execute — exact match', () => {
  it('replaces a single occurrence', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello world hello');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'file.txt', oldString: 'world', newString: 'universe' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('hello universe hello');
    expect(resultStr(result)).toContain('Successfully edited');
    expect(resultStr(result)).toContain('found 1 match');
  });

  it('replaces all occurrences with replace_all', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'foo bar foo baz foo');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      { path: 'file.txt', oldString: 'foo', newString: 'qux', replace_all: true },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('qux bar qux baz qux');
  });

  it('replaces only first by default', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'foo bar foo baz foo');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      { path: 'file.txt', oldString: 'foo', newString: 'qux' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('qux bar foo baz foo');
  });

  it('replaces multi-line content', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nhello\nline3');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      { path: 'file.txt', oldString: 'hello', newString: 'world' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('line1\nworld\nline3');
  });

  it('creates parent directories for new file', async () => {
    const tool = new EditTool({ maxEditInputSize: 16000 });
    const filePath = path.join(dir, 'a', 'b', 'new.txt');

    // Create initial file
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, 'old content');

    await tool.execute(
      { path: 'a/b/new.txt', oldString: 'old', newString: 'new' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('new content');
  });
});

// ── execute: line-trimmed fallback ──────────────────────────────────────────

describe('EditTool.execute — line-trimmed fallback', () => {
  it('matches with different indentation', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, '  hello world  \n  foo bar  ');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      { path: 'file.txt', oldString: 'hello world', newString: 'universe' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('  universe  \n  foo bar  ');
  });

  it('throws AssistantRetryableError with helpful message when text not found', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nline2\nline3');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await expect(
      tool.execute(
        { path: 'file.txt', oldString: 'notfound', newString: 'replacement' },
        toolCtx({ workspaceRoot: dir })
      )
    ).rejects.toThrow(/text not found in file/);
  });
});

// ── execute: error cases ────────────────────────────────────────────────────

describe('EditTool.execute — error cases', () => {
  it('rejects empty oldString', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'file.txt', oldString: '', newString: 'world' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toContain('oldString must not be empty');
  });

  it('rejects identical oldString and newString', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'file.txt', oldString: 'hello', newString: 'hello' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toContain('no changes to apply');
  });

  it('returns error on invalid JSON input', async () => {
    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute('not json', toolCtx({ workspaceRoot: dir }));
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('returns error on missing path', async () => {
    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { oldString: 'a', newString: 'b' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('returns error on missing oldString', async () => {
    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'file.txt', newString: 'b' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('returns error on missing newString', async () => {
    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: 'file.txt', oldString: 'a' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('rejects path outside cwd boundary', async () => {
    const tool = new EditTool({ maxEditInputSize: 16000 });
    const result = await tool.execute(
      { path: '/etc/evil.txt', oldString: 'a', newString: 'b' },
      toolCtx({ cwdBoundary: dir })
    );
    expect(resultStr(result)).toContain('Path escape rejected');
  });

  it('throws AssistantRetryableError when input is too large', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    const bigString = 'x'.repeat(16001); // DEFAULT_MAX_EDIT_INPUT_SIZE (16000) + 1
    await expect(
      tool.execute(
        { path: 'file.txt', oldString: bigString, newString: 'y' },
        toolCtx({ workspaceRoot: dir })
      )
    ).rejects.toThrow(/Edit input too large/);
  });

  it('handles input as string JSON', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello world');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      JSON.stringify({ path: 'file.txt', oldString: 'hello', newString: 'goodbye' }),
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('goodbye world');
  });
});

// ── snake_case aliases ──────────────────────────────────────────────────────

describe('EditTool.execute — snake_case aliases', () => {
  it('accepts old_string and new_string', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello world');

    const tool = new EditTool({ maxEditInputSize: 16000 });
    await tool.execute(
      { path: 'file.txt', old_string: 'hello', new_string: 'goodbye' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('goodbye world');
  });
});
