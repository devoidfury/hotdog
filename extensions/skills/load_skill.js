// Load skill tool — load a skill's full instructions into context.

import { toolDef, param, ToolResult, defaultCallDisplay } from "../core-tools/registry.js";

export class LoadSkillTool {
  static TOOL_NAME = "load_skill";

  constructor(options = {}) {
    this.loader = options.loader;
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
    return defaultCallDisplay(input, (args) => `load_skill: ${args.name}`);
  }

  async execute(input, ctx) {
    const args = typeof input === "string" ? JSON.parse(input) : input;
    const skillName = args.name;

    if (!this.loader) {
      return ToolResult.err("Skills loader not available");
    }

    // Use the loader to get the skill
    const skill = this.loader.getSkill(skillName);

    if (!skill) {
      return ToolResult.err(`Skill not found: ${skillName}`);
    }

    // Notify context about skill activation
    if (ctx?.onActivateSkill) {
      ctx.onActivateSkill(skillName);
    }

    const contentLength = skill.content?.length || 0;
    return ToolResult.ok(skill.content).withEntries({
      skill: skillName,
      content_length: String(contentLength),
      source: skill.source || "unknown",
    });
  }
}
