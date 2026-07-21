import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectInfoTool } from '../../src/extensions/core-tools/project-info.ts';
import { resultStr } from '../helpers.ts';

describe('ProjectInfoTool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-test-pinfo-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has correct tool name', () => {
    expect(ProjectInfoTool.TOOL_NAME).toBe('project_info');
  });

  it('generates tool definition', () => {
    const tool = new ProjectInfoTool();
    const def = tool.toToolDef();
    expect(def.function.name).toBe('project_info');
    // No required fields
    expect(def.function.parameters.required).toEqual([]);
  });

  it('returns directory not found for non-existent path', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: '/nonexistent/path/xyz' }), null!);
    expect(resultStr(result)).toContain('Directory not found');
  });

  it('returns info for current directory', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }), null!);
    expect(resultStr(result)).toContain('=== Project Info ===');
  });

  it('generates call display with path', () => {
    const tool = new ProjectInfoTool();
    const display = tool.callDisplay(JSON.stringify({ path: '/project' }));
    expect(display).toContain('path=/project');
  });

  it('generates call display with max_depth', () => {
    const tool = new ProjectInfoTool();
    const display = tool.callDisplay(JSON.stringify({ path: '/project', max_depth: 3 }));
    expect(display).toContain('depth=3');
  });

  it('generates call display with max_files', () => {
    const tool = new ProjectInfoTool();
    const display = tool.callDisplay(JSON.stringify({ path: '/project', max_files: 50 }));
    expect(display).toContain('files=50');
  });

  it('handles object input', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute({ path: tmpDir }, null!);
    expect(resultStr(result)).toContain('=== Project Info ===');
  });

  it('handles non-git directory (falls back to partial info)', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }), null!);
    // Should return partial info since tmpDir is not a git repo
    expect(resultStr(result)).toContain('=== Project Info ===');
  });
});

// Test the extensionToLanguage mapping through the tool's output
describe('ProjectInfoTool language detection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-test-lang-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects JavaScript files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test.js'), '');
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }), null!);
    expect(resultStr(result)).toContain('JavaScript');
  });

  it('detects TypeScript files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), '');
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }), null!);
    expect(resultStr(result)).toContain('TypeScript');
  });

  it('detects Markdown files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '');
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }), null!);
    expect(resultStr(result)).toContain('Markdown');
  });
});

// Test git-related methods
describe('ProjectInfoTool > git methods', () => {
  it('_getGitBranch returns null in non-git directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-test-git-'));
    try {
      const tool = new ProjectInfoTool();
      const branch = await (tool as any)._getGitBranch(tmpDir);
      expect(branch).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('_getLastCommitTime returns null in non-git directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-test-git-'));
    try {
      const tool = new ProjectInfoTool();
      const time = await (tool as any)._getLastCommitTime(tmpDir);
      expect(time).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('_getGitStatus returns empty array in non-git directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-test-git-'));
    try {
      const tool = new ProjectInfoTool();
      const status = await (tool as any)._getGitStatus(tmpDir);
      expect(status).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('_getGitBranch returns branch name in git repo', async () => {
    const tool = new ProjectInfoTool();
    const branch = await (tool as any)._getGitBranch(process.cwd());
    expect(typeof branch).toBe('string');
    expect(branch.length).toBeGreaterThan(0);
  });

  it('_getLastCommitTime returns time in git repo', async () => {
    const tool = new ProjectInfoTool();
    const time = await (tool as any)._getLastCommitTime(process.cwd());
    expect(typeof time).toBe('string');
    expect(time.length).toBeGreaterThan(0);
  });

  it('_getGitStatus returns status entries in git repo', async () => {
    const tool = new ProjectInfoTool();
    const status = await (tool as any)._getGitStatus(process.cwd());
    expect(Array.isArray(status)).toBe(true);
  });
});

// Test _walkDir method
describe('ProjectInfoTool > _walkDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-test-walk-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('walks directory and collects files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file1.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'file2.js'), '');
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
    fs.writeFileSync(path.join(tmpDir, 'subdir', 'file3.ts'), '');

    const tool = new ProjectInfoTool();
    const results: string[] = [];
    await (tool as any)._walkDir(tmpDir, 0, 10, results, 100);

    expect(results.length).toBe(3);
  });

  it('respects maxDepth limit', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file1.ts'), '');
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
    fs.writeFileSync(path.join(tmpDir, 'subdir', 'file2.ts'), '');

    const tool = new ProjectInfoTool();
    const results: string[] = [];
    await (tool as any)._walkDir(tmpDir, 0, 0, results, 100);

    // maxDepth=0 means only top-level files
    expect(results.length).toBe(1);
  });

  it('respects maxFiles limit', async () => {
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.ts`), '');
    }

    const tool = new ProjectInfoTool();
    const results: string[] = [];
    await (tool as any)._walkDir(tmpDir, 0, 10, results, 3);

    expect(results.length).toBe(3);
  });

  it('skips hidden files', async () => {
    fs.writeFileSync(path.join(tmpDir, '.hidden'), '');
    fs.writeFileSync(path.join(tmpDir, 'visible.ts'), '');

    const tool = new ProjectInfoTool();
    const results: string[] = [];
    await (tool as any)._walkDir(tmpDir, 0, 10, results, 100);

    expect(results.length).toBe(1);
    expect(results[0]).toContain('visible.ts');
  });

  it('handles unreadable directories gracefully', async () => {
    const unreadableDir = path.join(tmpDir, 'unreadable');
    fs.mkdirSync(unreadableDir);
    fs.chmodSync(unreadableDir, 0o000);

    const tool = new ProjectInfoTool();
    const results: string[] = [];
    // Should not throw even with unreadable dir
    await (tool as any)._walkDir(tmpDir, 0, 10, results, 100);

    // Restore permissions for cleanup
    fs.chmodSync(unreadableDir, 0o755);
  });
});

// Test _getDirSizes method
describe('ProjectInfoTool > _getDirSizes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-test-sizes-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns directory sizes', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file1.ts'), 'a'.repeat(1000));
    fs.writeFileSync(path.join(tmpDir, 'file2.ts'), 'b'.repeat(2000));

    const tool = new ProjectInfoTool();
    const sizes = await (tool as any)._getDirSizes(1, tmpDir);

    expect(Array.isArray(sizes)).toBe(true);
  });
});

// Test execute with various inputs
describe('ProjectInfoTool > execute edge cases', () => {
  it('handles object input with path', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute({ path: '/workspace' }, null!);
    expect(resultStr(result)).toContain('=== Project Info ===');
  });

  it('handles empty object input', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute({}, null!);
    expect(resultStr(result)).toContain('=== Project Info ===');
  });

  it('handles max_depth parameter', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: '/workspace', max_depth: 2 }), null!);
    expect(resultStr(result)).toContain('=== Project Info ===');
  });

  it('handles max_files parameter', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: '/workspace', max_files: 10 }), null!);
    expect(resultStr(result)).toContain('=== Project Info ===');
  });
});
