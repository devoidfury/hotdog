// Skills Extension
// Manages skills loading, activation, and system prompt integration.
// Hooks: systemPrompt:build, agent:toolContext, tools:register, commands:register
// Config defaults and CLI flags are defined in extension.json.

import { HOOKS } from "../../core/hooks.ts";
import { ACTIONS } from "../../core/commands.ts";
import { patternMatches, SkillsLoader } from "./loader.ts";
import { LoadSkillTool } from "./load-skill.ts";
export { LoadSkillTool };
import {
  CoreContext,
  ExtensionInstance,
  ToolsRegisterPayload,
  CommandsRegisterPayload,
  getExtensionConfig,
} from "../../core/extensions/types.ts";

interface Skill {
  name: string;
  description: string;
  loaded: boolean;
  includeTools?: string[];
  allowedTools?: string[];
}

interface ToolCtx {
  set(key: string, value: unknown): void;
}

interface SkillsLoaderConfig {
  path?: string;
  preloadSkills?: string[];
}

/**
 * Create the skills extension.
 * Config defaults come from extension.json configSchema.
 */
export async function create(core: CoreContext): Promise<ExtensionInstance> {
  // Config defaults come from extension.json configSchema
  const config = getExtensionConfig<SkillsLoaderConfig>(core, "skills");

  if (!config.path) {
    throw new Error("skills path not configured");
  }

  const loader = new SkillsLoader(config.path);
  await loader.loadSkills();

  // Preload skills from config
  const preloadSkills = config.preloadSkills ?? [];
  if (preloadSkills.length > 0) {
    loader.preloadSkills(preloadSkills);
  }

  const getCombinedToolPatterns = (): Set<string> => {
    const patterns = new Set<string>();
    for (const skill of loader.activeSkills()) {
      for (const tool of skill.includeTools || []) {
        patterns.add(tool.toLowerCase());
      }
      for (const tool of skill.allowedTools || []) {
        patterns.add(tool.toLowerCase());
      }
    }
    return patterns;
  };

  const isToolAllowed = (toolName: string): boolean => {
    const patterns = getCombinedToolPatterns();
    if (patterns.size === 0) return true;
    const nameLower = toolName.toLowerCase();
    return Array.from(patterns).some((pattern) =>
      patternMatches(pattern, nameLower),
    );
  };

  return {
    hooks: {
      /**
       * Build skills preamble for system prompt.
       */
      [HOOKS.SYSTEM_PROMPT_BUILD]: async (_data: unknown) => {
        const preamble = await loader.buildSkillsPreamble();
        if (preamble) {
          return { name: "preamble", priority: 400, content: preamble };
        }
      },

      /**
       * Mount the skills loader on the shared context container.
       * Tools access it via toolCtx.get('skillsLoader').
       */
      [HOOKS.AGENT_TOOL_CONTEXT]: async ({ toolCtx }) => {
        (toolCtx as { set: (key: string, value: unknown) => void }).set("skillsLoader", loader);
      },

      /**
       * Register the load_skill tool.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry: ToolsRegisterPayload) => {
        const tool = new LoadSkillTool({ loader });
        registry.register("load_skill", tool);
      },

      /**
       * Register commands for skills.
       */
      [HOOKS.COMMANDS_REGISTER]: async (payload: CommandsRegisterPayload) => {
        const { registry } = payload;
        registry.register("skill", {
          description: "List skills or activate a skill (skill:<name>)",
          matches: (cmd: string) => cmd.startsWith("skill"),
          handler: async (_agent: unknown, cmdValue: string) => {
            const name = cmdValue.slice(6).trim();
            if (!name) {
              const skills = loader.agentViewableSkills();
              const lines = skills
                .map(
                  (s: Skill) =>
                    `${s.loaded ? "[x]" : "[ ]"} ${s.name}: ${s.description}`,
                )
                .join("\n\n");
              return {
                action: ACTIONS.DISPLAY,
                content: `## Available Skills\n\n${lines}`,
              };
            }
            // Activate skill
            loader.activateSkill(name);
            return {
              action: ACTIONS.DISPLAY,
              content: `Skill '${name}' activated.`,
            };
          },
        });
      },
    },

    // Expose for external use
    loader,

    /**
     * Get all skills.
     */
    getAllSkills() {
      return loader.allSkills();
    },

    /**
     * Get active skills.
     */
    getActiveSkills() {
      return loader.activeSkills();
    },

    /**
     * Get combined tool patterns from active skills.
     */
    getCombinedToolPatterns,

    /**
     * Check if a tool is allowed by active skills.
     */
    isToolAllowed,
  };
}
