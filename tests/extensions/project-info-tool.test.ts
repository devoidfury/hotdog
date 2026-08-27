import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectInfoTool } from '../../src/extensions/core-tools/project-info.ts';
import { resultStr, toolCtx } from '../helpers.ts';

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

  it('returns directory not found for non-existent path inside the workspace', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: path.join(tmpDir, 'no-such-dir') }), toolCtx({ workspaceRoots: [tmpDir] }));
    expect(resultStr(result)).toContain('Directory not found');
  });

  it('rejects paths that escape the workspace', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: '/etc' }), toolCtx({ workspaceRoots: [tmpDir] }));
    expect(resultStr(result)).toContain('Path escape rejected');
  });

  it('returns info for current directory', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }), toolCtx({ workspaceRoots: [tmpDir] }));
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
    const result = await tool.execute({ path: tmpDir }, toolCtx({ workspaceRoots: [tmpDir] }));
    expect(resultStr(result)).toContain('=== Project Info ===');
  });

  it('handles non-git directory (falls back to partial info)', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }), toolCtx({ workspaceRoots: [tmpDir] }));
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
    const result = await tool.execute(JSON.stringify({ path: tmpDir }), toolCtx({ workspaceRoots: [tmpDir] }));
    expect(resultStr(result)).toContain('JavaScript');
  });

  it('detects TypeScript files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), '');
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }), toolCtx({ workspaceRoots: [tmpDir] }));
    expect(resultStr(result)).toContain('TypeScript');
  });

  it('detects Markdown files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '');
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }), toolCtx({ workspaceRoots: [tmpDir] }));
    expect(resultStr(result)).toContain('Markdown');
  });
});

// Test git-related behavior through public API
describe('ProjectInfoTool > git behavior', () => {
  it('shows git repo info when run in a git repo', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: process.cwd() }), toolCtx({ workspaceRoots: [process.cwd()] }));
    const output = resultStr(result);
    expect(output).toContain('git');
    expect(output).toContain('last commit:');
  });

  it('shows partial info for non-git directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-test-git-'));
    try {
      const tool = new ProjectInfoTool();
      const result = await tool.execute(JSON.stringify({ path: tmpDir }), toolCtx({ workspaceRoots: [tmpDir] }));
      const output = resultStr(result);
      expect(output).toContain('not a git repo');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// Test directory walking behavior through public API (non-git mode)
describe('ProjectInfoTool > directory walking', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-test-walk-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists files in non-git directory', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file1.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'file2.js'), '');
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
    fs.writeFileSync(path.join(tmpDir, 'subdir', 'file3.ts'), '');

    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }), toolCtx({ workspaceRoots: [tmpDir] }));
    const output = resultStr(result);
    expect(output).toContain('file1.ts');
    expect(output).toContain('file2.js');
    expect(output).toContain('file3.ts');
  });

  it('respects max_files limit', async () => {
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.ts`), '');
    }

    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir, max_files: 3 }), toolCtx({ workspaceRoots: [tmpDir] }));
    const output = resultStr(result);
    // In non-git mode, max_files limits files collected (no "and X more" since total unknown)
    const fileLines = output.split('\n').filter(l => l.trim().endsWith('.ts'));
    expect(fileLines.length).toBe(3);
  });
});

// Test directory sizes through public API
describe('ProjectInfoTool > directory sizes', () => {
  it('shows directory sizes in git repo output', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: process.cwd() }), toolCtx({ workspaceRoots: [process.cwd()] }));
    const output = resultStr(result);
    expect(output).toContain('Directories');
  });
});

// Test execute with various inputs
describe('ProjectInfoTool > execute edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-test-pinfo-edge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles object input with path', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute({ path: tmpDir }, toolCtx({ workspaceRoots: [tmpDir] }));
    expect(resultStr(result)).toContain('=== Project Info ===');
  });

  it('handles empty object input', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute({}, toolCtx({ workspaceRoots: [tmpDir] }));
    expect(resultStr(result)).toContain('=== Project Info ===');
  });

  it('handles max_depth parameter', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir, max_depth: 2 }), toolCtx({ workspaceRoots: [tmpDir] }));
    expect(resultStr(result)).toContain('=== Project Info ===');
  });

  it('handles max_files parameter', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir, max_files: 10 }), toolCtx({ workspaceRoots: [tmpDir] }));
    expect(resultStr(result)).toContain('=== Project Info ===');
  });
});
