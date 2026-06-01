import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LoadSkillTool } from '../src/tools/load_skill.js';

function getResultStr(result) {
  if (result?.toDisplay) {
    return result.toDisplay();
  }
  return String(result);
}

describe('LoadSkillTool', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-test-skill-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has correct tool name', () => {
    expect(LoadSkillTool.TOOL_NAME).toBe('load_skill');
  });

  it('generates tool definition', () => {
    const tool = new LoadSkillTool({ skillsPath: tmpDir });
    const def = tool.toToolDef();
    expect(def.function.name).toBe('load_skill');
    expect(def.function.parameters.required).toEqual(['name']);
  });

  it('loads skill from SKILL.md in subdirectory', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Skill Instructions\n\nDo stuff.');

    const tool = new LoadSkillTool({ skillsPath: tmpDir });
    const result = await tool.execute(JSON.stringify({ name: 'my-skill' }));
    expect(getResultStr(result)).toContain('Skill Instructions');
    expect(getResultStr(result)).toContain('Do stuff.');
  });

  it('loads skill from direct .md file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'direct-skill.md'), '# Direct Skill');

    const tool = new LoadSkillTool({ skillsPath: tmpDir });
    const result = await tool.execute(JSON.stringify({ name: 'direct-skill' }));
    expect(getResultStr(result)).toContain('Direct Skill');
  });

  it('returns error for non-existent skill', async () => {
    const tool = new LoadSkillTool({ skillsPath: tmpDir });
    const result = await tool.execute(JSON.stringify({ name: 'non-existent' }));
    expect(getResultStr(result)).toContain('Skill not found');
  });

  it('notifies context on skill activation', async () => {
    const skillDir = path.join(tmpDir, 'activated-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Content');

    let activated = false;
    const ctx = {
      onActivateSkill: (name) => { activated = true; expect(name).toBe('activated-skill'); },
    };

    const tool = new LoadSkillTool({ skillsPath: tmpDir });
    await tool.execute(JSON.stringify({ name: 'activated-skill' }), ctx);
    expect(activated).toBe(true);
  });

  it('notifies context when loading direct .md file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'direct-activated.md'), '# Content');

    let activated = false;
    const ctx = {
      onActivateSkill: (name) => { activated = true; expect(name).toBe('direct-activated'); },
    };

    const tool = new LoadSkillTool({ skillsPath: tmpDir });
    await tool.execute(JSON.stringify({ name: 'direct-activated' }), ctx);
    expect(activated).toBe(true);
  });

  it('generates call display', () => {
    const tool = new LoadSkillTool({ skillsPath: tmpDir });
    const display = tool.callDisplay(JSON.stringify({ name: 'my-skill' }));
    expect(display).toBe('load_skill: my-skill');
  });

  it('handles object input', async () => {
    const skillDir = path.join(tmpDir, 'object-input');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Object Input Skill');

    const tool = new LoadSkillTool({ skillsPath: tmpDir });
    const result = await tool.execute({ name: 'object-input' });
    expect(getResultStr(result)).toContain('Object Input Skill');
  });
});
