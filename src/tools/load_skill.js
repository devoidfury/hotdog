// Load skill tool — load a skill's full instructions into context.

import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolContext, toolDef, param, toolResult } from './registry.js';
import { DEFAULT_SKILLS_PATH } from '../config.js';

export class LoadSkillTool {
  static TOOL_NAME = 'load_skill';
  static FIRST_USE_HELP = `Load a skill's instructions. Skills are Markdown files in the skills directory.`;

  constructor(options = {}) {
    this.skillsPath = options.skillsPath || DEFAULT_SKILLS_PATH;
  }

  static tryNewFromContext(ctx) {
    return new LoadSkillTool({
      skillsPath: DEFAULT_SKILLS_PATH,
    });
  }

  toToolDef() {
    return toolDef(
      LoadSkillTool.TOOL_NAME,
      'Load a skill. Skills are Markdown files that provide specialized workflows.',
      {
        properties: {
          name: param('string', 'The name of the skill to load.'),
        },
        required: ['name'],
      }
    );
  }

  callDisplay(input) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    return `load_skill: ${args.name}`;
  }

  firstUseHelp() {
    return LoadSkillTool.FIRST_USE_HELP;
  }

  async execute(input, ctx) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    const skillName = args.name;

    // Try to load the skill file
    const skillFile = path.join(this.skillsPath, skillName, 'SKILL.md');

    try {
      const content = await fs.readFile(skillFile, 'utf-8');

      // Notify context about skill activation
      if (ctx?.onActivateSkill) {
        ctx.onActivateSkill(skillName);
      }

      return toolResult(content);
    } catch (e) {
      // Try loading directly by name
      try {
        const directPath = path.join(this.skillsPath, `${skillName}.md`);
        const content = await fs.readFile(directPath, 'utf-8');
        if (ctx?.onActivateSkill) {
          ctx.onActivateSkill(skillName);
        }
        return toolResult(content);
      } catch {
        return toolResult(`Skill not found: ${skillName}`);
      }
    }
  }
}
