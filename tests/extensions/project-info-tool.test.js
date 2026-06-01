import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectInfoTool } from '../../src/extensions/core-tools/project-info.js';
import { ToolResult } from '../../src/core/extensions/tool-utils.js';

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

describe('ProjectInfoTool', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-test-pinfo-'));
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
    const result = await tool.execute(JSON.stringify({ path: '/nonexistent/path/xyz' }));
    expect(resultStr(result)).toContain('Directory not found');
  });

  it('returns info for current directory', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }));
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

  it('generates call display with all params', () => {
    const tool = new ProjectInfoTool();
    const display = tool.callDisplay(JSON.stringify({ path: '/p', max_depth: 2, max_files: 100 }));
    expect(display).toContain('path=/p');
    expect(display).toContain('depth=2');
    expect(display).toContain('files=100');
  });

  it('handles object input', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute({ path: tmpDir });
    expect(resultStr(result)).toContain('=== Project Info ===');
  });

  it('handles non-git directory (falls back to partial info)', async () => {
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }));
    // Should return partial info since tmpDir is not a git repo
    expect(resultStr(result)).toContain('=== Project Info ===');
  });

  it('has correct TOOL_NAME', () => {
    expect(ProjectInfoTool.TOOL_NAME).toBe('project_info');
  });
});

// Test the extensionToLanguage mapping through the tool's output
// We can't test it directly since it's not exported, but we can verify
// the tool produces language breakdowns with correct mappings.
describe('ProjectInfoTool language detection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-test-lang-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects JavaScript files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test.js'), '');
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }));
    expect(resultStr(result)).toContain('JavaScript');
  });

  it('detects TypeScript files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), '');
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }));
    expect(resultStr(result)).toContain('TypeScript');
  });

  it('detects Markdown files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '');
    const tool = new ProjectInfoTool();
    const result = await tool.execute(JSON.stringify({ path: tmpDir }));
    expect(resultStr(result)).toContain('Markdown');
  });
});
