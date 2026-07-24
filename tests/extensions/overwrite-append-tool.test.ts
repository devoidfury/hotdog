import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fsSync from 'node:fs';
import path from 'node:path';
import { OverwriteTool } from '../../src/extensions/core-tools/overwrite.ts';
import { AppendTool } from '../../src/extensions/core-tools/append.ts';
import { ToolContext } from '../../src/core/extensions/tool-context.ts';
import { resultStr, tmpDir, toolCtx, cleanupDir } from '../helpers.ts';

let dir: string;

beforeAll(() => {
  dir = tmpDir();
});

afterAll(() => {
  cleanupDir(dir);
});

// ── OverwriteTool: Tool Definition ──────────────────────────────────────────

describe('OverwriteTool.toToolDef', () => {
  it('returns a simple tool definition', () => {
    const def = new OverwriteTool().toToolDef();
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('overwrite');
    expect(def.function.description).toContain('replacing all existing content');
  });

  it('requires only path and content', () => {
    const def = new OverwriteTool().toToolDef();
    expect(def.function.parameters.required).toEqual(['path', 'content']);
  });
});

// ── OverwriteTool: callDisplay ──────────────────────────────────────────────

describe('OverwriteTool.callDisplay', () => {
  const tool = new OverwriteTool();

  it('displays path and line count', () => {
    const display = tool.callDisplay({ path: 'foo.txt', content: 'hello\nworld' });
    expect(display).toContain('foo.txt');
    expect(display).toContain('overwrite');
    expect(display).toContain('2 lines');
  });

  it('handles invalid input gracefully', () => {
    expect(tool.callDisplay('not json')).toBe('not json');
    expect(tool.callDisplay({})).toBe('');
    expect(tool.callDisplay(null)).toBe('');
  });

  it('handles empty content', () => {
    expect(tool.callDisplay({ path: 'foo.txt', content: '' })).toContain('overwrite');
  });
});

// ── OverwriteTool: execute ──────────────────────────────────────────────────

describe('OverwriteTool.execute', () => {
  it('creates new file', async () => {
    const tool = new OverwriteTool();
    const filePath = path.join(dir, 'new.txt');
    await tool.execute(
      { path: 'new.txt', content: 'hello world' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('hello world');
  });

  it('overwrites existing file', async () => {
    const filePath = path.join(dir, 'existing.txt');
    fsSync.writeFileSync(filePath, 'old content');

    const tool = new OverwriteTool();
    await tool.execute(
      { path: 'existing.txt', content: 'new content' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('new content');
  });

  it('creates parent directories', async () => {
    const tool = new OverwriteTool();
    const filePath = path.join(dir, 'a', 'b', 'c', 'deep.txt');
    await tool.execute(
      { path: 'a/b/c/deep.txt', content: 'deep content' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('deep content');
  });

  it('returns structured JSON result', async () => {
    const tool = new OverwriteTool();
    const result = await tool.execute(
      { path: 'test.txt', content: 'hello' },
      toolCtx({ workspaceRoot: dir })
    );
    const parsed = JSON.parse(resultStr(result));
    expect(parsed.path).toBe('test.txt');
    expect(parsed.filesize_after).toBe(5);
  });

  it('handles multi-line content', async () => {
    const tool = new OverwriteTool();
    const content = 'line1\nline2\nline3';
    await tool.execute(
      { path: 'multi.txt', content },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'multi.txt'), 'utf-8')).toBe(content);
  });

  it('handles empty content', async () => {
    const tool = new OverwriteTool();
    await tool.execute(
      { path: 'empty.txt', content: '' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'empty.txt'), 'utf-8')).toBe('');
  });
});

// ── OverwriteTool: error cases ──────────────────────────────────────────────

describe('OverwriteTool.execute — error cases', () => {
  it('returns error on invalid JSON input', async () => {
    const tool = new OverwriteTool();
    const result = await tool.execute('not json', toolCtx({ workspaceRoot: dir }));
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('returns error on missing path', async () => {
    const tool = new OverwriteTool();
    const result = await tool.execute(
      { content: 'hello' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('returns error on missing content', async () => {
    const tool = new OverwriteTool();
    const result = await tool.execute(
      { path: 'file.txt' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('rejects path outside cwd boundary', async () => {
    const tool = new OverwriteTool();
    const result = await tool.execute(
      { path: '/etc/evil.txt', content: 'hack' },
      toolCtx({ cwdBoundary: dir })
    );
    expect(resultStr(result)).toContain('outside cwd boundary');
  });

  it('handles input as string JSON', async () => {
    const tool = new OverwriteTool();
    await tool.execute(
      '{"path":"string.txt","content":"from json"}',
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'string.txt'), 'utf-8')).toBe('from json');
  });
});

// ── AppendTool: Tool Definition ─────────────────────────────────────────────

describe('AppendTool.toToolDef', () => {
  it('returns a simple tool definition', () => {
    const def = new AppendTool().toToolDef();
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('append');
    expect(def.function.description).toContain('Appends content');
  });

  it('requires only path and content', () => {
    const def = new AppendTool().toToolDef();
    expect(def.function.parameters.required).toEqual(['path', 'content']);
  });
});

// ── AppendTool: callDisplay ─────────────────────────────────────────────────

describe('AppendTool.callDisplay', () => {
  const tool = new AppendTool();

  it('displays path and line count', () => {
    const display = tool.callDisplay({ path: 'foo.txt', content: 'hello\nworld' });
    expect(display).toContain('foo.txt');
    expect(display).toContain('append');
    expect(display).toContain('2 lines');
  });

  it('handles invalid input gracefully', () => {
    expect(tool.callDisplay('not json')).toBe('not json');
    expect(tool.callDisplay({})).toBe('');
    expect(tool.callDisplay(null)).toBe('');
  });
});

// ── AppendTool: execute ─────────────────────────────────────────────────────

describe('AppendTool.execute', () => {
  it('creates new file if it does not exist', async () => {
    const tool = new AppendTool();
    const filePath = path.join(dir, 'append-new.txt');
    await tool.execute(
      { path: 'append-new.txt', content: 'hello world' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('hello world');
  });

  it('appends to existing file', async () => {
    const filePath = path.join(dir, 'append-existing.txt');
    fsSync.writeFileSync(filePath, 'original content');

    const tool = new AppendTool();
    await tool.execute(
      { path: 'append-existing.txt', content: ' appended content' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('original content appended content');
  });

  it('appends multiple times', async () => {
    const filePath = path.join(dir, 'append-multi.txt');
    const tool = new AppendTool();

    await tool.execute({ path: 'append-multi.txt', content: 'line1' }, toolCtx({ workspaceRoot: dir }));
    await tool.execute({ path: 'append-multi.txt', content: '\nline2' }, toolCtx({ workspaceRoot: dir }));
    await tool.execute({ path: 'append-multi.txt', content: '\nline3' }, toolCtx({ workspaceRoot: dir }));

    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('line1\nline2\nline3');
  });

  it('creates parent directories', async () => {
    const tool = new AppendTool();
    const filePath = path.join(dir, 'append-deep', 'a', 'b', 'c', 'deep.txt');
    await tool.execute(
      { path: 'append-deep/a/b/c/deep.txt', content: 'deep content' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('deep content');
  });

  it('returns structured JSON result', async () => {
    const tool = new AppendTool();
    const result = await tool.execute(
      { path: 'append-test.txt', content: 'hello' },
      toolCtx({ workspaceRoot: dir })
    );
    const parsed = JSON.parse(resultStr(result));
    expect(parsed.path).toBe('append-test.txt');
    expect(parsed.bytes_appended).toBe(5);
  });

  it('handles empty content', async () => {
    const filePath = path.join(dir, 'append-empty.txt');
    fsSync.writeFileSync(filePath, 'existing');

    const tool = new AppendTool();
    await tool.execute(
      { path: 'append-empty.txt', content: '' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(filePath, 'utf-8')).toBe('existing');
  });
});

// ── AppendTool: error cases ─────────────────────────────────────────────────

describe('AppendTool.execute — error cases', () => {
  it('returns error on invalid JSON input', async () => {
    const tool = new AppendTool();
    const result = await tool.execute('not json', toolCtx({ workspaceRoot: dir }));
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('returns error on missing path', async () => {
    const tool = new AppendTool();
    const result = await tool.execute(
      { content: 'hello' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('returns error on missing content', async () => {
    const tool = new AppendTool();
    const result = await tool.execute(
      { path: 'file.txt' },
      toolCtx({ workspaceRoot: dir })
    );
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('rejects path outside cwd boundary', async () => {
    const tool = new AppendTool();
    const result = await tool.execute(
      { path: '/etc/evil.txt', content: 'hack' },
      toolCtx({ cwdBoundary: dir })
    );
    expect(resultStr(result)).toContain('outside cwd boundary');
  });

  it('handles input as string JSON', async () => {
    const tool = new AppendTool();
    await tool.execute(
      '{"path":"append-string.txt","content":"from json"}',
      toolCtx({ workspaceRoot: dir })
    );
    expect(fsSync.readFileSync(path.join(dir, 'append-string.txt'), 'utf-8')).toBe('from json');
  });
});
