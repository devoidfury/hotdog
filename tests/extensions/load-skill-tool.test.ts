import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LoadSkillTool } from '../../src/extensions/skills/load-skill.ts';
import { SkillsLoader } from '../../src/extensions/skills/loader.ts';
import { getDisplay } from '../helpers.ts';

describe('LoadSkillTool', () => {
  let tmpDir: string;
  let loader: SkillsLoader;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-test-skill-'));
    loader = new SkillsLoader(tmpDir);
    await loader.loadSkills();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has correct tool name', () => {
    expect(LoadSkillTool.TOOL_NAME).toBe('load_skill');
  });

  it('generates tool definition', () => {
    const tool = new LoadSkillTool({ loader });
    const def = tool.toToolDef();
    expect(def.function.name).toBe('load_skill');
    expect(def.function.parameters.required).toEqual(['name']);
  });

  it('loads skill from SKILL.md in subdirectory', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\ndescription: Test skill\n---\n# Skill Instructions\n\nDo stuff.');

    await loader.loadSkills();
    const tool = new LoadSkillTool({ loader });
    const result = await tool.execute(JSON.stringify({ name: 'my-skill' }));
    expect(getDisplay(result)).toContain('Skill Instructions');
    expect(getDisplay(result)).toContain('Do stuff.');
  });

  it('returns error for non-existent skill', async () => {
    const tool = new LoadSkillTool({ loader });
    const result = await tool.execute(JSON.stringify({ name: 'non-existent' }));
    expect(getDisplay(result)).toContain('Skill not found');
  });

  it('generates call display', () => {
    const tool = new LoadSkillTool({ loader });
    const display = tool.callDisplay(JSON.stringify({ name: 'my-skill' }));
    expect(display).toBe('load_skill: my-skill');
  });

  it('handles object input', async () => {
    const skillDir = path.join(tmpDir, 'object-input');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\ndescription: Object\n---\n# Object Input Skill');

    await loader.loadSkills();
    const tool = new LoadSkillTool({ loader });
    const result = await tool.execute({ name: 'object-input' });
    expect(getDisplay(result)).toContain('Object Input Skill');
  });

  it('returns error when loader not available', async () => {
    const tool = new LoadSkillTool();
    const result = await tool.execute(JSON.stringify({ name: 'any' }));
    expect(getDisplay(result)).toContain('Skills loader not available');
  });

  it('returns error for malformed JSON string input', async () => {
    const tool = new LoadSkillTool({ loader });
    const result = await tool.execute('{ name: "not-json" }');
    expect(getDisplay(result)).toContain('Error parsing arguments');
  });

  it('returns error for null input', async () => {
    const tool = new LoadSkillTool({ loader });
    const result = await tool.execute(null);
    expect(getDisplay(result)).toContain('Error parsing arguments');
  });

  it('returns error for empty string input', async () => {
    const tool = new LoadSkillTool({ loader });
    const result = await tool.execute('   ');
    expect(getDisplay(result)).toContain('Error parsing arguments');
  });

  it('returns error when name is missing', async () => {
    const tool = new LoadSkillTool({ loader });
    const result = await tool.execute(JSON.stringify({}));
    expect(getDisplay(result)).toContain('name is required');
  });

  it('returns error when name is empty string', async () => {
    const tool = new LoadSkillTool({ loader });
    const result = await tool.execute(JSON.stringify({ name: '' }));
    expect(getDisplay(result)).toContain('name is required');
  });
});
