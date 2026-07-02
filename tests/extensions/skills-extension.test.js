import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { create } from '../../src/extensions/skills/index.js';
import { HOOKS } from '../../src/core/hooks.js';
import { ToolContext } from '../../src/core/extensions/tool-context.js';
import { createConfigRegistry } from '../../src/core/extensions/config-registry.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Skills Extension', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-test-skill-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSkill(name, description, content) {
    const skillDir = path.join(tmpDir, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\ndescription: ${description}\n---\n${content}`,
    );
  }

  it('creates extension with loader', async () => {
    const ext = await create({
      config: { skills: { skillsPath: tmpDir } },
    });

    expect(ext).toBeDefined();
    expect(ext.loader).toBeDefined();
  });

  it('getAllSkills returns all loaded skills', async () => {
    writeSkill('greet', 'Greet skill', '# Greet');
    writeSkill('farewell', 'Farewell skill', '# Farewell');

    const ext = await create({
      config: { skills: { skillsPath: tmpDir } },
    });

    const skills = ext.getAllSkills();
    expect(skills.length).toBe(2);
  });

  it('getActiveSkills returns active skills', async () => {
    writeSkill('greet', 'Greet skill', '# Greet');

    const ext = await create({
      config: { skills: { skillsPath: tmpDir } },
    });

    expect(ext.getActiveSkills()).toHaveLength(0);

    ext.loader.activateSkill('greet');
    const active = ext.getActiveSkills();
    expect(active.length).toBe(1);
    expect(active[0].name).toBe('greet');
  });

  it('getCombinedToolPatterns returns tool patterns from active skills', async () => {
    const skillDir = path.join(tmpDir, 'toolskill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\ndescription: Tool skill\ninclude-tools:\n  - "read*"\n  - "write*"\n---\n# Content',
    );

    const ext = await create({
      config: { skills: { skillsPath: tmpDir } },
    });

    ext.loader.activateSkill('toolskill');
    const patterns = ext.getCombinedToolPatterns();
    expect(patterns.has('read*')).toBe(true);
    expect(patterns.has('write*')).toBe(true);
  });

  it('getCombinedToolPatterns returns empty set when no skills active', async () => {
    const ext = await create({
      config: { skills: { skillsPath: tmpDir } },
    });

    const patterns = ext.getCombinedToolPatterns();
    expect(patterns.size).toBe(0);
  });

  it('isToolAllowed returns true when no active skill patterns', async () => {
    const ext = await create({
      config: { skills: { skillsPath: tmpDir } },
    });

    expect(ext.isToolAllowed('anything')).toBe(true);
  });

  it('isToolAllowed matches tool against active skill patterns', async () => {
    const skillDir = path.join(tmpDir, 'toolskill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\ndescription: Tool skill\ninclude-tools:\n  - "read*"\n---\n# Content',
    );

    const ext = await create({
      config: { skills: { skillsPath: tmpDir } },
    });

    ext.loader.activateSkill('toolskill');
    expect(ext.isToolAllowed('read_file')).toBe(true);
    expect(ext.isToolAllowed('write_file')).toBe(false);
  });

  it('extension.json defines --preload-skills CLI flag', async () => {
    // CLI flags are defined declaratively in extension.json cli:flags,
    // not via imperative hooks. Verify the extension.json has the flag.
    const extensionData = (await import('../../src/extensions/skills/extension.json')).default;
    expect(extensionData['cli:flags']).toBeDefined();
    expect(extensionData['cli:flags'].length).toBe(1);
    expect(extensionData['cli:flags'][0].long).toBe('--preload-skills');
    expect(extensionData['cli:flags'][0].type).toBe('array');
  });

  it('AGENT_TOOL_CONTEXT sets skillsLoader on toolCtx', async () => {
    const ext = await create({
      config: { skills: { skillsPath: tmpDir } },
    });

    const toolCtx = new ToolContext();
    await ext.hooks[HOOKS.AGENT_TOOL_CONTEXT]({ toolCtx });

    expect(toolCtx.get('skillsLoader')).toBeDefined();
    expect(toolCtx.get('skillsLoader')).toBe(ext.loader);
  });

  it('COMMANDS_REGISTER registers the skill command', async () => {
    writeSkill('greet', 'Greet skill', '# Greet');

    const ext = await create({
      config: { skills: { skillsPath: tmpDir } },
    });

    const registrations = [];
    const registry = { register: (name, handler) => registrations.push({ name, ...handler }) };
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry });

    expect(registrations.length).toBe(1);
    expect(registrations[0].name).toBe('skill');
    expect(registrations[0].matches('skill')).toBe(true);
    expect(registrations[0].matches('skill:greet')).toBe(true);
    expect(registrations[0].matches('other')).toBe(false);
  });

  it('skill command lists all skills when no name provided', async () => {
    writeSkill('greet', 'Greet skill', '# Greet');

    const ext = await create({
      config: { skills: { skillsPath: tmpDir } },
    });

    const registrations = [];
    const registry = { register: (name, handler) => registrations.push({ name, ...handler }) };
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry });

    const handler = registrations[0];
    const result = await handler.handler(null, 'skill');
    expect(result.content).toContain('Available Skills');
    expect(result.content).toContain('greet');
  });

  it('skill command activates a skill by name', async () => {
    writeSkill('greet', 'Greet skill', '# Greet');

    const ext = await create({
      config: { skills: { skillsPath: tmpDir } },
    });

    const registrations = [];
    const registry = { register: (name, handler) => registrations.push({ name, ...handler }) };
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry });

    const handler = registrations[0];
    const result = await handler.handler(null, 'skill:greet');
    expect(result.content).toContain("Skill 'greet' activated.");
    expect(ext.getActiveSkills().length).toBe(1);
  });

  it('SYSTEM_PROMPT_BUILD returns preamble with active skills', async () => {
    writeSkill('greet', 'Greet skill', '# Greet\n\nDo greeting stuff.');

    const ext = await create({
      config: { skills: { skillsPath: tmpDir } },
    });

    ext.loader.activateSkill('greet');

    const result = await ext.hooks[HOOKS.SYSTEM_PROMPT_BUILD]({ agent: {} });
    expect(result).toBeDefined();
    expect(result.name).toBe('preamble');
    expect(result.priority).toBe(400);
    expect(result.content).toContain('greet');
  });

  it('SYSTEM_PROMPT_BUILD returns undefined when no active skills', async () => {
    const ext = await create({
      config: { skills: { skillsPath: tmpDir } },
    });

    const result = await ext.hooks[HOOKS.SYSTEM_PROMPT_BUILD]({ agent: {} });
    expect(result).toBeUndefined();
  });

  it('TOOLS_REGISTER registers load_skill tool', async () => {
    const ext = await create({
      config: { skills: { skillsPath: tmpDir } },
    });

    const registrations = [];
    const registry = { register: (name, tool) => registrations.push({ name, tool }) };
    await ext.hooks[HOOKS.TOOLS_REGISTER](registry);

    expect(registrations.length).toBe(1);
    expect(registrations[0].name).toBe('load_skill');
  });

  it('preload skills from config', async () => {
    writeSkill('greet', 'Greet skill', '# Greet');

    const ext = await create({
      config: {
        skills: {
          skillsPath: tmpDir,
          preloadSkills: ['greet'],
        },
      },
    });

    expect(ext.getActiveSkills().length).toBe(1);
    expect(ext.getActiveSkills()[0].name).toBe('greet');
  });

  it('preload skills from CLI args takes priority', async () => {
    writeSkill('greet', 'Greet skill', '# Greet');
    writeSkill('farewell', 'Farewell skill', '# Farewell');

    const ext = await create({
      config: {
        skills: {
          skillsPath: tmpDir,
          preloadSkills: ['farewell'],
        },
      },
      cli: { preloadSkills: ['greet'] },
    });

    expect(ext.getActiveSkills().length).toBe(1);
    expect(ext.getActiveSkills()[0].name).toBe('greet');
  });
});
