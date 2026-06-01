// Load skill tool — load a skill's full instructions into context.

import fs from "node:fs/promises";
import path from "node:path";
import { toolDef, param, ToolResult, toolResult } from "./registry.js";
import { DEFAULT_SKILLS_PATH } from "../../src/config.js";

export class LoadSkillTool {
  static TOOL_NAME = "load_skill";

  constructor(options = {}) {
    this.skillsPath = options.skillsPath || DEFAULT_SKILLS_PATH;
  }

  toToolDef() {
    return toolDef(
      LoadSkillTool.TOOL_NAME,
      "Load a skill. Skills are Markdown files that provide specialized workflows.",
      {
        properties: {
          name: param("string", "The name of the skill to load."),
        },
        required: ["name"],
      },
    );
  }

  callDisplay(input) {
    const args = typeof input === "string" ? JSON.parse(input) : input;
    return `load_skill: ${args.name}`;
  }

  async execute(input, ctx) {
    const args = typeof input === "string" ? JSON.parse(input) : input;
    const skillName = args.name;

    // Try to load the skill file
    const skillFile = path.join(this.skillsPath, skillName, "SKILL.md");

    try {
      const content = await fs.readFile(skillFile, "utf-8");

      // Notify context about skill activation
      if (ctx?.onActivateSkill) {
        ctx.onActivateSkill(skillName);
      }

      const contentLength = content.length;
      return ToolResult.ok(content).withEntries({
        skill: skillName,
        content_length: String(contentLength),
        source: "directory",
      });
    } catch (e) {
      // Try loading directly by name
      try {
        const directPath = path.join(this.skillsPath, `${skillName}.md`);
        const content = await fs.readFile(directPath, "utf-8");
        if (ctx?.onActivateSkill) {
          ctx.onActivateSkill(skillName);
        }
        const contentLength = content.length;
        return ToolResult.ok(content).withEntries({
          skill: skillName,
          content_length: String(contentLength),
          source: "file",
        });
      } catch {
        return ToolResult.err(`Skill not found: ${skillName}`);
      }
    }
  }
}
