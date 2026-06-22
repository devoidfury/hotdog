import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LoadSkillTool } from '../../src/extensions/skills/load-skill.js';
import { ToolContext } from '../../src/core/extensions/tool-context.js';
import { SkillsLoader } from '../../src/extensions/skills/loader.js';
import { getDisplay } from '../helpers.js';

describe('LoadSkillTool', () => {
  let tmpDir;
  let loader;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-test-skill-'));
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

  it('notifies context on skill activation', async () => {
    const skillDir = path.join(tmpDir, 'activated-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\ndescription: Activated\n---\n# Content');

    await loader.loadSkills();
    let activated = false;
    const ctx = new ToolContext();
    ctx.set('onActivateSkill', (name) => { activated = true; expect(name).toBe('activated-skill'); });

    const tool = new LoadSkillTool({ loader });
    await tool.execute(JSON.stringify({ name: 'activated-skill' }), ctx);
    expect(activated).toBe(true);
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
});
