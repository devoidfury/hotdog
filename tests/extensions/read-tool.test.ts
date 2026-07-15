import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ReadTool } from '../../src/extensions/core-tools/read.ts';
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
    const props = def.function.parameters.properties as Record<string, { type?: string }>;
    expect(props.limit!.type).toBe('integer');
    expect(props.offset!.type).toBe('integer');
    expect(props.type).toBeUndefined();
  });
});

// ── callDisplay ─────────────────────────────────────────────────────────────

describe('ReadTool.callDisplay', () => {
  it('shows path and pagination range', () => {
    const display = new ReadTool().callDisplay({ path: 'foo.txt', limit: 10, offset: 5 });
    expect(display).toContain('foo.txt');
    expect(display).toContain('5');
    expect(display).toContain('15');
  });

  it('handles invalid input gracefully', () => {
    expect(new ReadTool().callDisplay('not json')).toBe('not json');
    expect(new ReadTool().callDisplay({})).toContain('no path');
    expect(new ReadTool().callDisplay(null)).toContain('no path');
  });
});

// ── execute: read lines ─────────────────────────────────────────────────────

describe('ReadTool.execute — read lines', () => {
  it('reads entire file by default', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nline2\nline3');

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'file.txt' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toBe('line1\nline2\nline3');
  });

  it('respects limit', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5');

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'file.txt', limit: 2 },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toBe('line1\nline2');
  });

  it('respects offset', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nline2\nline3\nline4');

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'file.txt', offset: 2, limit: 2 },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toBe('line3\nline4');
  });

  it('handles offset beyond file length', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'line1\nline2');

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'file.txt', offset: 10 },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toContain('offset 10 is beyond end');
    expect(resultStr(result)).toContain('[empty]');
  });

  it('handles empty file', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, '');

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'file.txt' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toBe('');
  });

  it('handles single line file', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'only line');

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'file.txt' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toBe('only line');
  });
});

// ── execute: directory listing ──────────────────────────────────────────────

describe('ReadTool.execute — directory listing', () => {
  it('lists directory contents at depth 1', async () => {
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
  });
});

// ── execute: error cases ────────────────────────────────────────────────────

describe('ReadTool.execute — error cases', () => {
  it('returns error on file not found', async () => {
    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'nonexistent.txt' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toContain('File not found');
  });

  it('returns error on invalid JSON input', async () => {
    const tool = new ReadTool();
    const result = await tool.execute('not json', toolCtx({ workspaceRoot: dir }));
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('returns error on missing path', async () => {
    const tool = new ReadTool();
    const result = await tool.execute({ limit: 10 }, toolCtx({ workspaceRoot: dir }));
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('rejects path outside cwd boundary', async () => {
    const tool = new ReadTool();
    const result = await tool.execute(
      { path: '/etc/passwd' },
      toolCtx({ cwdBoundary: dir })
    );
    expect(resultStr(result)).toContain('outside cwd boundary');
  });

  it('handles input as string JSON', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello world');

    const tool = new ReadTool();
    const result = await tool.execute(
      JSON.stringify({ path: 'file.txt' }),
      toolCtx({ workspaceRoot: dir })
    );

    expect(resultStr(result)).toBe('hello world');
  });
});

// ── execute: image files ────────────────────────────────────────────────────

describe('ReadTool.execute — image files', () => {
  /**
   * Minimal valid PNG file (1x1 transparent pixel).
   */
  const MINIMAL_PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6260000000020001978304000000000049454e44ae426082',
    'hex',
  );

  /**
   * Minimal valid JPEG file (1x1 white pixel).
   */
  const MINIMAL_JPEG = Buffer.from(
    'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c28222e232837292c30313434341f27393d3c32363c3e3f3f3f3f3f3f3f3f3f3f3f3f3f3f3ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc4001f100002010303020403050504040000017d0102030405060708090a0bffc4001f000003010101010101010101010101000000000102030405060708090a0bffc4001f1000030101010101010101010100000000000102030405060708090a0bffd9',
    'hex',
  );

  it('reads PNG file and returns image', async () => {
    const filePath = path.join(dir, 'test.png');
    fsSync.writeFileSync(filePath, MINIMAL_PNG);

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'test.png' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('test.png');
    expect(result.output).toContain('image/png');
    expect(result.images).toEqual([
      {
        type: 'image_url',
        mimeType: 'image/png',
        data: MINIMAL_PNG.toString('base64'),
      },
    ]);
  });

  for (const ext of ['jpg', 'jpeg']) {
    it(`reads JPEG file (.${ext}) and returns image`, async () => {
      const filePath = path.join(dir, `test.${ext}`);
      fsSync.writeFileSync(filePath, MINIMAL_JPEG);

      const tool = new ReadTool();
      const result = await tool.execute(
        { path: `test.${ext}` },
        toolCtx({ workspaceRoot: dir })
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain(`test.${ext}`);
      expect(result.output).toContain('image/jpeg');
      expect(result.images).toEqual([
        {
          type: 'image_url',
          mimeType: 'image/jpeg',
          data: MINIMAL_JPEG.toString('base64'),
        },
      ]);
    });
  }

  it('reads WebP file and returns image', async () => {
    // Minimal WebP (RIFF container with VP8 bitstream)
    const webp = Buffer.from(
      '524946461a000000574542505650380a00000001000100000100407200000000405249464600000000',
      'hex',
    );
    const filePath = path.join(dir, 'test.webp');
    fsSync.writeFileSync(filePath, webp);

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'test.webp' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('test.webp');
    expect(result.output).toContain('image/webp');
    expect(result.images).toEqual([
      {
        type: 'image_url',
        mimeType: 'image/webp',
        data: webp.toString('base64'),
      },
    ]);
  });

  it('reads .base64 file and returns image with text content', async () => {
    const base64Content = 'SGVsbG8gV29ybGQh'; // "Hello World!" in base64
    const filePath = path.join(dir, 'data.base64');
    fsSync.writeFileSync(filePath, base64Content);

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'data.base64' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(result.success).toBe(true);
    expect(result.images).toEqual([
      {
        type: 'image_url',
        mimeType: 'application/octet-stream',
        data: base64Content,
      },
    ]);
  });

  it('handles uppercase extensions', async () => {
    const filePath = path.join(dir, 'test.PNG');
    fsSync.writeFileSync(filePath, MINIMAL_PNG);

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'test.PNG' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(result.success).toBe(true);
    expect(result.images).toBeDefined();
    expect((result.images![0] as { mimeType: string }).mimeType).toBe('image/png');
  });

  it('includes file size in metadata', async () => {
    const filePath = path.join(dir, 'test.png');
    fsSync.writeFileSync(filePath, MINIMAL_PNG);

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'test.png' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(result.metadata!.get('size')).toBe(String(MINIMAL_PNG.length));
    expect(result.metadata!.get('mime_type')).toBe('image/png');
  });

  it('reads image with absolute path', async () => {
    const filePath = path.join(dir, 'test.png');
    fsSync.writeFileSync(filePath, MINIMAL_PNG);

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: filePath },
      toolCtx({ workspaceRoot: dir })
    );

    expect(result.success).toBe(true);
    expect(result.images).toBeDefined();
    expect((result.images![0] as { mimeType: string }).mimeType).toBe('image/png');
  });

  it('rejects path outside cwd boundary for images', async () => {
    const filePath = path.join(dir, 'test.png');
    fsSync.writeFileSync(filePath, MINIMAL_PNG);

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: filePath },
      toolCtx({ cwdBoundary: '/tmp/restricted' })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('outside cwd boundary');
  });

  it('text files are not treated as images', async () => {
    const filePath = path.join(dir, 'file.txt');
    fsSync.writeFileSync(filePath, 'hello world');

    const tool = new ReadTool();
    const result = await tool.execute(
      { path: 'file.txt' },
      toolCtx({ workspaceRoot: dir })
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('hello world');
    expect(result.images).toBeNull();
  });
});
