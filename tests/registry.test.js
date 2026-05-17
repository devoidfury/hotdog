import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  toolDef,
  param,
  parseToolArgs,
  toolResult,
  truncateOutput,
  generateDiff,
  validateCwdBoundary,
  writeFileWithParents,
  resolvePath,
  fileSize,
  checkWritable,
  checkReadable,
  getRequiredStr,
  runCommand,
  ToolRegistry,
  ToolContext,
  ToolResult,
} from '../src/tools/registry.js';

describe('toolDef', () => {
  it('creates a tool definition', () => {
    const def = toolDef('test', 'A test tool', { properties: { x: { type: 'string' } } });
    expect(def).toEqual({
      type: 'function',
      function: {
        name: 'test',
        description: 'A test tool',
        parameters: {
          type: 'object',
          properties: { x: { type: 'string' } },
          required: [],
        },
      },
    });
  });

  it('includes required fields', () => {
    const def = toolDef('test', 'desc', { required: ['x', 'y'] });
    expect(def.function.parameters.required).toEqual(['x', 'y']);
  });

  it('handles missing parameters', () => {
    const def = toolDef('test', 'desc');
    expect(def.function.parameters.properties).toEqual({});
    expect(def.function.parameters.required).toEqual([]);
  });
});

describe('param', () => {
  it('creates a parameter with description', () => {
    expect(param('string', 'A path')).toEqual({ type: 'string', description: 'A path' });
  });

  it('creates a parameter without description', () => {
    expect(param('integer')).toEqual({ type: 'integer', description: '' });
  });
});

describe('parseToolArgs', () => {
  it('parses valid JSON string', () => {
    expect(parseToolArgs('{"x": 1}')).toEqual({ x: 1 });
  });

  it('returns raw string on parse failure', () => {
    expect(parseToolArgs('not json')).toEqual({ input: 'not json' });
  });

  it('returns object as-is', () => {
    const obj = { x: 1 };
    expect(parseToolArgs(obj)).toBe(obj);
  });
});

describe('toolResult', () => {
  it('returns string as-is', () => {
    expect(toolResult('result')).toBe('result');
  });

  it('stringifies objects', () => {
    expect(toolResult({ key: 'val' })).toBe('{"key":"val"}');
  });

  it('converts numbers to string', () => {
    expect(toolResult(42)).toBe('42');
  });

  it('converts null to string', () => {
    expect(toolResult(null)).toBe('null');
  });
});

describe('truncateOutput', () => {
  it('returns empty string for null', () => {
    expect(truncateOutput(null, 10)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(truncateOutput(undefined, 10)).toBe('');
  });

  it('returns text under limit', () => {
    const text = 'line1\nline2\nline3';
    expect(truncateOutput(text, 10)).toBe(text);
  });

  it('truncates text over limit', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line${i + 1}`).join('\n');
    const result = truncateOutput(lines, 3);
    expect(result).toContain('line3');
    expect(result).toContain('[truncated, 2 more lines]');
  });

  it('handles single line', () => {
    expect(truncateOutput('single', 1)).toBe('single');
  });

  it('handles zero max lines', () => {
    const result = truncateOutput('line1\nline2', 0);
    expect(result).toBe('\n--- [truncated, 2 more lines] ---');
  });
});

describe('generateDiff', () => {
  it('returns empty for identical text', () => {
    expect(generateDiff('hello', 'hello')).toBe('');
  });

  it('shows changed lines', () => {
    const oldText = 'line1\nold\nline3';
    const newText = 'line1\nnew\nline3';
    const diff = generateDiff(oldText, newText);
    expect(diff).toContain('- old');
    expect(diff).toContain('+ new');
  });

  it('shows added lines', () => {
    const diff = generateDiff('a', 'a\nb');
    expect(diff).toContain('+ b');
  });

  it('shows removed lines', () => {
    const diff = generateDiff('a\nb', 'a');
    expect(diff).toContain('- b');
  });

  it('limits comparison phase', () => {
    const oldLines = Array.from({ length: 50 }, (_, i) => `old${i}`).join('\n');
    const newLines = Array.from({ length: 50 }, (_, i) => `new${i}`).join('\n');
    const diff = generateDiff(oldLines, newLines, 5);
    // maxLines limits comparison phase; remaining lines still added
    const diffLines = diff.split('\n');
    expect(diffLines.length).toBeGreaterThan(10);
  });
});

describe('validateCwdBoundary', () => {
  it('returns true when no boundary', () => {
    expect(validateCwdBoundary('/any/path', null)).toBe(true);
  });

  it('returns true for path within boundary', () => {
    expect(validateCwdBoundary('/home/user/project/file.txt', '/home/user/project')).toBe(true);
  });

  it('returns true for boundary itself', () => {
    expect(validateCwdBoundary('/home/user/project', '/home/user/project')).toBe(true);
  });

  it('returns false for path outside boundary', () => {
    expect(validateCwdBoundary('/home/other/file.txt', '/home/user/project')).toBe(false);
  });
});

describe('ToolRegistry', () => {
  it('registers and retrieves tools', () => {
    const reg = new ToolRegistry();
    reg.register('bash', { name: 'bash' });
    expect(reg.get('bash')).toEqual({ name: 'bash' });
  });

  it('checks tool existence', () => {
    const reg = new ToolRegistry();
    reg.register('bash', {});
    expect(reg.has('bash')).toBe(true);
    expect(reg.has('write')).toBe(false);
  });

  it('lists all tools', () => {
    const reg = new ToolRegistry();
    reg.register('bash', {});
    reg.register('write', {});
    const all = reg.getAll();
    expect(all).toHaveLength(2);
    expect(all.map(([name]) => name)).toContain('bash');
  });

  it('filters by whitelist', () => {
    const reg = new ToolRegistry();
    reg.register('bash', {});
    reg.register('write', {});
    reg.register('read', {});
    const filtered = reg.filter(['bash', 'write'], null);
    expect(filtered.getAll()).toHaveLength(2);
  });

  it('filters by blacklist', () => {
    const reg = new ToolRegistry();
    reg.register('bash', {});
    reg.register('write', {});
    reg.register('read', {});
    const filtered = reg.filter(null, ['bash']);
    expect(filtered.getAll()).toHaveLength(2);
  });

  it('filters by both whitelist and blacklist', () => {
    const reg = new ToolRegistry();
    reg.register('bash', {});
    reg.register('write', {});
    reg.register('read', {});
    // whitelist wins: only bash and write allowed, but bash is blacklisted
    const filtered = reg.filter(['bash', 'write'], ['bash']);
    expect(filtered.getAll()).toHaveLength(1);
    expect(filtered.has('bash')).toBe(false);
    expect(filtered.has('write')).toBe(true);
  });
});

describe('ToolContext', () => {
  it('creates context with defaults', () => {
    const ctx = new ToolContext();
    expect(ctx.skills).toEqual([]);
    expect(ctx.allSkills).toEqual([]);
    expect(ctx.skillDirectories).toEqual([]);
    expect(ctx.modelRegistry).toEqual({});
    expect(ctx.cwdBoundary).toBeNull();
  });

  it('accepts custom options', () => {
    const ctx = new ToolContext({
      skills: ['skill1'],
      cwdBoundary: '/project',
    });
    expect(ctx.skills).toEqual(['skill1']);
    expect(ctx.cwdBoundary).toBe('/project');
  });

  it('handles cancelled callback', () => {
    let cancelled = false;
    const ctx = new ToolContext({
      isCancelled: () => cancelled,
    });
    expect(ctx.isCancelled()).toBe(false);
    cancelled = true;
    expect(ctx.isCancelled()).toBe(true);
  });

  it('has new fields: workspaceRoot, currentFile, modelNames, activeProvider', () => {
    const ctx = new ToolContext({
      workspaceRoot: '/project',
      currentFile: '/project/src/main.js',
      modelNames: ['qwen3.5-0.8b', 'qwen3.5-4b'],
      activeProvider: 'openai',
    });
    expect(ctx.workspaceRoot).toBe('/project');
    expect(ctx.currentFile).toBe('/project/src/main.js');
    expect(ctx.modelNames).toEqual(['qwen3.5-0.8b', 'qwen3.5-4b']);
    expect(ctx.activeProvider).toBe('openai');
  });

  it('defaults new fields to null/empty', () => {
    const ctx = new ToolContext();
    expect(ctx.workspaceRoot).toBeNull();
    expect(ctx.currentFile).toBeNull();
    expect(ctx.modelNames).toEqual([]);
    expect(ctx.activeProvider).toBeNull();
  });
});

describe('ToolResult', () => {
  it('creates success result with ok()', () => {
    const r = ToolResult.ok('hello');
    expect(r.success).toBe(true);
    expect(r.output).toBe('hello');
    expect(r.error).toBeNull();
    expect(r.isOk()).toBe(true);
    expect(r.isErr()).toBe(false);
  });

  it('creates error result with err()', () => {
    const r = ToolResult.err('not found');
    expect(r.success).toBe(false);
    expect(r.output).toBe('');
    expect(r.error).toBe('not found');
    expect(r.isOk()).toBe(false);
    expect(r.isErr()).toBe(true);
  });

  it('chains withEntry to add metadata', () => {
    const r = ToolResult.ok('out').withEntry('key', 'val');
    expect(r.metadata).toBeInstanceOf(Map);
    expect(r.metadata.get('key')).toBe('val');
  });

  it('chains withEntries to add multiple metadata', () => {
    const r = ToolResult.ok('out').withEntries({ a: '1', b: '2' });
    expect(r.metadata.get('a')).toBe('1');
    expect(r.metadata.get('b')).toBe('2');
  });

  it('chains withOutputTag', () => {
    const r = ToolResult.ok('data').withOutputTag('result');
    expect(r.outputTag).toBe('result');
  });

  it('toDisplay returns output', () => {
    expect(ToolResult.ok('hello world').toDisplay()).toBe('hello world');
  });

  it('toDisplay appends error for failures', () => {
    const r = ToolResult.err('command failed');
    expect(r.toDisplay()).toBe('Error: command failed');
  });

  it('toDisplay combines output + error', () => {
    const r = ToolResult.ok('partial output').withEntry('x', '1');
    r.success = false;
    r.error = 'partial failure';
    expect(r.toDisplay()).toBe('partial output\nError: partial failure');
  });

  it('toApiContent success no metadata', () => {
    const r = ToolResult.ok('hello world');
    const content = r.toApiContent('bash');
    expect(content).toBe('<tool name="bash" status="success">\n  <output>hello world</output>\n</tool>');
  });

  it('toApiContent failure with error', () => {
    const r = ToolResult.err('command not found');
    const content = r.toApiContent('bash');
    expect(content).toContain('<tool name="bash" status="failure">');
    expect(content).toContain('<error>command not found</error>');
    expect(content).toContain('<output></output>');
  });

  it('toApiContent with metadata', () => {
    const r = ToolResult.ok('output').withEntry('key1', 'val1').withEntry('key2', 'val2');
    const content = r.toApiContent('read_file');
    expect(content).toContain('<tool name="read_file" status="success">');
    expect(content).toContain('<output>output</output>');
    expect(content).toContain('<key1>val1</key1>');
    expect(content).toContain('<key2>val2</key2>');
  });

  it('toApiContent no error when success', () => {
    const content = ToolResult.ok('ok').toApiContent('bash');
    expect(content).not.toContain('<error>');
  });

  it('toApiContent custom output tag', () => {
    const content = ToolResult.ok('hello world').withOutputTag('result').toApiContent('bash');
    expect(content).toBe('<tool name="bash" status="success">\n  <result>hello world</result>\n</tool>');
  });

  it('toApiContent short metadata as attributes', () => {
    const r = ToolResult.ok('output')
      .withEntry('truncated', 'true')
      .withEntry('page', '1')
      .withEntry('total_pages', '3')
      .withEntry('duration_ms', '42')
      .withEntry('diff', '--- a/file\n+++ b/file');
    const content = r.toApiContent('edit');
    expect(content).toContain('name="edit"');
    expect(content).toContain('status="success"');
    expect(content).toContain('duration_ms="42"');
    expect(content).toContain('page="1"');
    expect(content).toContain('total_pages="3"');
    expect(content).toContain('truncated="true"');
    expect(content).toContain('<diff>--- a/file\n+++ b/file</diff>');
    expect(content).toContain('<output>output</output>');
  });

  it('toApiContent escapes XML special chars', () => {
    const r = ToolResult.ok('a < b & c > d');
    const content = r.toApiContent('bash');
    expect(content).toContain('a &lt; b &amp; c &gt; d');
  });

  it('toolResult passes through ToolResult via toDisplay()', () => {
    const r = ToolResult.ok('hello').withEntry('x', '1');
    expect(toolResult(r)).toBe('hello');

    const err = ToolResult.err('boom');
    expect(toolResult(err)).toBe('Error: boom');
  });
});

describe('writeFileWithParents', () => {
  const tmpDir = '/tmp/oa-test-writefile';

  it('writes file and creates parent dirs', () => {
    const filePath = path.join(tmpDir, 'a', 'b', 'c', 'test.txt');
    writeFileWithParents(filePath, 'content');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('content');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('overwrites existing file', () => {
    const filePath = path.join(tmpDir, 'test.txt');
    writeFileWithParents(filePath, 'v1');
    writeFileWithParents(filePath, 'v2');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('v2');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('resolvePath', () => {
  it('resolves existing path', () => {
    const resolved = resolvePath('/workspace/oa-js/src/tools/registry.js');
    expect(resolved).toBe('/workspace/oa-js/src/tools/registry.js');
  });

  it('throws for non-existent path', () => {
    expect(() => resolvePath('/nonexistent/path/file.txt')).toThrow('Path not found');
  });

  it('throws when path escapes boundary', () => {
    expect(() => resolvePath('/etc/passwd', '/workspace/oa-js')).toThrow('outside the allowed directory');
  });

  it('allows path within boundary', () => {
    const resolved = resolvePath('/workspace/oa-js/src/tools/registry.js', '/workspace/oa-js');
    expect(resolved).toBe('/workspace/oa-js/src/tools/registry.js');
  });

  it('allows path outside cwd when no boundary is set', () => {
    // When cwdBoundary is null, paths outside the current directory should be allowed
    const resolved = resolvePath('/etc/hostname');
    expect(resolved).toBe('/etc/hostname');
  });
});

describe('fileSize', () => {
  it('returns file size in bytes', () => {
    const size = fileSize('/workspace/oa-js/src/tools/registry.js');
    expect(typeof size).toBe('number');
    expect(size).toBeGreaterThan(0);
  });
});

describe('checkWritable', () => {
  const tmpDir = '/tmp/oa-test-writable';

  it('returns true for writable file', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'data');
    expect(checkWritable(filePath)).toBe(true);
    fs.unlinkSync(filePath);
  });

  it('returns true for new file in writable dir', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, 'new-file.txt');
    expect(checkWritable(filePath)).toBe(true);
  });

  it('throws for unwritable directory', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Create a read-only directory
    const roDir = path.join(tmpDir, 'readonly');
    fs.mkdirSync(roDir, { recursive: true });
    fs.chmodSync(roDir, 0o555);
    const filePath = path.join(roDir, 'test.txt');
    expect(() => checkWritable(filePath)).toThrow('not writable');
    fs.chmodSync(roDir, 0o755);
    fs.rmSync(roDir, { recursive: true, force: true });
  });

  it('throws for unwritable existing file', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, 'readonly-file.txt');
    fs.writeFileSync(filePath, 'data');
    fs.chmodSync(filePath, 0o444);
    expect(() => checkWritable(filePath)).toThrow('not writable');
    fs.chmodSync(filePath, 0o644);
    fs.unlinkSync(filePath);
  });
});

describe('checkReadable', () => {
  const tmpDir = '/tmp/oa-test-readable';

  it('returns true for readable file', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'data');
    expect(checkReadable(filePath)).toBe(true);
  });

  it('throws for non-existent path', () => {
    expect(() => checkReadable('/nonexistent/path/file.txt')).toThrow('does not exist');
  });

  it('throws for unreadable file', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, 'no-read.txt');
    fs.writeFileSync(filePath, 'data');
    fs.chmodSync(filePath, 0o000);
    expect(() => checkReadable(filePath)).toThrow('not readable');
    fs.chmodSync(filePath, 0o644);
    fs.unlinkSync(filePath);
  });
});

describe('getRequiredStr', () => {
  it('returns string value', () => {
    expect(getRequiredStr({ name: 'Alice' }, 'name')).toBe('Alice');
  });

  it('throws for missing key', () => {
    expect(() => getRequiredStr({ name: 'Alice' }, 'age')).toThrow('Missing required argument: age');
  });

  it('throws for non-string value', () => {
    expect(() => getRequiredStr({ count: 42 }, 'count')).toThrow('Missing required argument: count');
  });

  it('throws for null input', () => {
    expect(() => getRequiredStr(null, 'key')).toThrow('Missing required argument: key');
  });
});

describe('runCommand', () => {
  it('returns stdout for successful command', () => {
    const output = runCommand('echo', ['hello world']);
    expect(output).toBe('hello world');
  });

  it('throws on non-zero exit', () => {
    expect(() => runCommand('sh', ['-c', 'exit 1'])).toThrow('exit code 1');
  });

  it('includes stderr in error message', () => {
    try {
      runCommand('sh', ['-c', 'echo error >&2; exit 2']);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.message).toContain('exit code 2');
      expect(e.message).toContain('error');
    }
  });

  it('supports cwd option', () => {
    const output = runCommand('pwd', [], '/tmp');
    expect(output).toBe('/tmp');
  });
});
