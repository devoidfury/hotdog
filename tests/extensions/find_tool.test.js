import { describe, it, expect } from 'bun:test';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FindTool } from '../extensions/core-tools/find.js';
import { ToolContext, ToolResult } from '../extensions/core-tools/registry.js';
import { DEFAULT_FIND_MAX_RESULTS } from '../src/config.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function tmpDir() {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), 'oa-find-test-'));
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

function getResultStr(result) {
  if (result?.toDisplay) {
    return result.toDisplay();
  }
  return String(result);
}

// ── Tool Definition ─────────────────────────────────────────────────────────

describe('FindTool.toToolDef', () => {
  it('returns a tool definition with correct name', () => {
    const def = new FindTool().toToolDef();
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('find');
  });

  it('requires only pattern', () => {
    const def = new FindTool().toToolDef();
    expect(def.function.parameters.required).toEqual(['pattern']);
  });
});

// ── callDisplay ─────────────────────────────────────────────────────────────

describe('FindTool.callDisplay', () => {
  it('shows pattern and path with default max', () => {
    const display = new FindTool().callDisplay({ pattern: '*.js', path: 'src' });
    expect(display).toBe(`*.js in src (max ${DEFAULT_FIND_MAX_RESULTS})`);
  });

  it('shows file type filter', () => {
    const display = new FindTool().callDisplay({ pattern: '*.js', file_type: 'f', max_results: 100 });
    expect(display).toBe('*.js in . (f, max 100)');
  });

  it('handles invalid input gracefully', () => {
    expect(new FindTool().callDisplay('not json')).toBe(`* in . (max ${DEFAULT_FIND_MAX_RESULTS})`);
    expect(new FindTool().callDisplay({})).toBe(`* in . (max ${DEFAULT_FIND_MAX_RESULTS})`);
    expect(new FindTool().callDisplay(null)).toBe(`* in . (max ${DEFAULT_FIND_MAX_RESULTS})`);
  });
});

// ── execute: basic find ─────────────────────────────────────────────────────

describe('FindTool.execute — basic find', () => {
  it('finds files matching pattern', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'hello.txt'), 'hello');
    fsSync.writeFileSync(path.join(dir, 'world.txt'), 'world');
    fsSync.writeFileSync(path.join(dir, 'data.json'), '{"key": "value"}');

    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: '*.txt', path: dir },
      toolCtx()
    );

    expect(getResultStr(result)).toContain('hello.txt');
    expect(getResultStr(result)).toContain('world.txt');
    expect(getResultStr(result)).not.toContain('data.json');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('finds files recursively', async () => {
    const dir = tmpDir();
    fsSync.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fsSync.writeFileSync(path.join(dir, 'root.txt'), 'root');
    fsSync.writeFileSync(path.join(dir, 'sub', 'nested.txt'), 'nested');

    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: '**/*.txt', path: dir },
      toolCtx()
    );

    expect(getResultStr(result)).toContain('root.txt');
    expect(getResultStr(result)).toContain('nested.txt');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('returns "No files found" when nothing matches', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'hello.txt'), 'hello');

    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: '*.xyz', path: dir },
      toolCtx()
    );

    expect(getResultStr(result)).toContain('No files found');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: file type filter ───────────────────────────────────────────────

describe('FindTool.execute — file type filter', () => {
  it('finds only files with file_type f', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'file');
    fsSync.mkdirSync(path.join(dir, 'subdir'));

    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: '*', file_type: 'f', path: dir },
      toolCtx()
    );

    expect(getResultStr(result)).toContain('file.txt');
    expect(getResultStr(result)).not.toContain('subdir');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('finds only directories with file_type d', async () => {
    const dir = tmpDir();
    fsSync.writeFileSync(path.join(dir, 'file.txt'), 'file');
    fsSync.mkdirSync(path.join(dir, 'subdir'));

    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: '*', file_type: 'd', path: dir },
      toolCtx()
    );

    expect(getResultStr(result)).toContain('subdir');
    expect(getResultStr(result)).not.toContain('file.txt');
    fsSync.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: max_results ────────────────────────────────────────────────────

describe('FindTool.execute — max_results', () => {
  it('limits results to max_results', async () => {
    const dir = tmpDir();
    for (let i = 0; i < 10; i++) {
      fsSync.writeFileSync(path.join(dir, `file${i}.txt`), `content ${i}`);
    }

    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: '*.txt', path: dir, max_results: 3 },
      toolCtx()
    );

    // Should have at most 3 results
    const lines = getResultStr(result).split('\n').filter(l => l.includes('file'));
    expect(lines.length).toBeLessThanOrEqual(3);
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it('uses default max_results when not specified', async () => {
    const dir = tmpDir();
    for (let i = 0; i < 5; i++) {
      fsSync.writeFileSync(path.join(dir, `file${i}.txt`), `content ${i}`);
    }

    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: '*.txt', path: dir },
      toolCtx()
    );

    const lines = getResultStr(result).split('\n').filter(l => l.includes('file'));
    expect(lines.length).toBe(5);
    fsSync.rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute: error cases ────────────────────────────────────────────────────

describe('FindTool.execute — error cases', () => {
  it('returns error on invalid JSON input', async () => {
    const tool = new FindTool();
    const result = await tool.execute('not json', toolCtx());
    expect(getResultStr(result)).toContain('Error parsing arguments');
  });

  it('returns error on missing pattern', async () => {
    const tool = new FindTool();
    const result = await tool.execute({ path: '.' }, toolCtx());
    expect(getResultStr(result)).toContain('Error parsing arguments');
  });

  it('handles non-existent search path gracefully', async () => {
    const tool = new FindTool();
    const result = await tool.execute(
      { pattern: '*', path: '/nonexistent/path/that/does/not/exist' },
      toolCtx()
    );
    // Should not crash, may return "No files found" or error
    expect(getResultStr(result)).toBeDefined();
  });
});
