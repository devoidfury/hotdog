// Load skill tool — load a skill's full instructions into context.
import {
  toolDef,
  param,
  ToolResult,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import type { ToolMetadata } from "../../core/extensions/tool-registry.ts";
import { type ToolContext } from "../../core/extensions/types.ts";
import { SkillsLoader } from "./loader.ts";


export class LoadSkillTool {
  static readonly TOOL_NAME = "load_skill";
  metadata: ToolMetadata = { sideEffects: false, difficulty: 2 };

  private readonly loader: SkillsLoader | null;

  constructor(options: { loader?: SkillsLoader } = {}) {
    this.loader = options.loader || null;
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

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(input, (args: Record<string, unknown>) => `load_skill: ${args?.name}`);
  }

  async execute(input: string | Record<string, unknown> | null, ctx?: ToolContext): Promise<ToolResult> {
    const args = typeof input === "string" ? JSON.parse(input) : input;
    const skillName = args?.name as string;

    if (!this.loader) {
      return ToolResult.err("Skills loader not available");
    }

    // Use the loader to get the skill
    const skill = this.loader.getSkill(skillName);

    if (!skill) {
      return ToolResult.err(`Skill not found: ${skillName}`);
    }

    // Render the skill content using the shared template
    const renderedContent = await this.loader.renderSkillContent(skill);
    return ToolResult.ok(renderedContent).withEntries({
      skill: skillName,
      content_length: String(renderedContent.length),
    });
  }
}
