// Load skill tool — load a skill's full instructions into context.
import {
  toolDef,
  param,
  ToolResult,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";

interface Skill {
  name: string;
  content: string;
  source?: string;
}

interface SkillsLoader {
  getSkill(name: string): Skill | null;
}

interface ToolContext {
  get(key: string): unknown;
}

export class LoadSkillTool {
  static readonly TOOL_NAME = "load_skill";

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
    return defaultCallDisplay(input, (args: Record<string, unknown>) => `load_skill: ${args.name as string}`);
  }

  async execute(input: string | Record<string, unknown> | null, ctx?: ToolContext): Promise<ToolResult> {
    const args: Record<string, unknown> = typeof input === "string" ? JSON.parse(input) : (input as Record<string, unknown>);
    const skillName = args.name as string;

    if (!this.loader) {
      return ToolResult.err("Skills loader not available");
    }

    // Use the loader to get the skill
    const skill = this.loader.getSkill(skillName);

    if (!skill) {
      return ToolResult.err(`Skill not found: ${skillName}`);
    }

    // Notify context about skill activation
    const onActivateSkill = ctx?.get("onActivateSkill") as ((name: string) => void) | undefined;
    if (onActivateSkill) {
      onActivateSkill(skillName);
    }

    const contentLength = skill.content?.length || 0;
    return ToolResult.ok(skill.content).withEntries({
      skill: skillName,
      content_length: String(contentLength),
      source: skill.source || "unknown",
    });
  }
}
