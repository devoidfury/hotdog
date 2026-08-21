// Skills Extension
// Manages skills loading, activation, and system prompt integration.
// Hooks: systemPrompt:build, agent:toolContext, tools:register, commands:register
// Config defaults and CLI flags are defined in extension.json.

import { HOOKS } from "../../core/hooks.ts";
import { ACTIONS } from "../../core/commands.ts";
import { patternMatches, Skill, SkillsLoader } from "./loader.ts";
import { LoadSkillTool } from "./load-skill.ts";
import { Message } from "../../core/context/message.ts";
import {
  CoreContext,
  ExtensionInstance,
  ToolsRegisterPayload,
  CommandsRegisterPayload,
  getExtensionConfig,
} from "../../core/extensions/types.ts";
import { ExtensionError } from "../../core/error.ts";
import { matcher, createCompletionHandler } from "./completions.ts";

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
    throw ExtensionError.ConfigFailed("skills", "skills path not configured");
  }

  const loader = new SkillsLoader(config.path);
  await loader.loadSkills();

  // Preload skills from config
  const preloadSkills = config.preloadSkills;
  if (preloadSkills && preloadSkills.length > 0) {
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

  const instance: ExtensionInstance & {
    loader: SkillsLoader;
    getAllSkills(): Skill[];
    getActiveSkills(): Skill[];
    getCombinedToolPatterns(): Set<string>;
    isToolAllowed(toolName: string): boolean;
  } = {
    hooks: {
      /**
       * Build skills preamble for system prompt.
       */
      [HOOKS.SYSTEM_PROMPT_BUILD]: async (_data) => {
        const preamble = await loader.buildSkillsPreamble();
        if (preamble) {
          return { name: "preamble", priority: 400, content: preamble };
        }
      },

      /**
       * Mount the skills loader on the shared context container.
       * Tools access it via toolCtx.get('skillsLoader').
       */
      [HOOKS.AGENT_TOOL_CONTEXT]: async ({ toolCtx, agent }) => {
        (toolCtx as { set: (key: string, value: unknown) => void }).set(
          "skillsLoader",
          loader,
        );
        (agent as { skillsLoader?: typeof loader }).skillsLoader = loader;
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
          handler: async (agent, cmdValue) => {
            const name = cmdValue?.slice(6).trim();
            if (!name) {
              const skills = loader.allSkills();
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

            // If the conversation already has messages, inject the skill content
            // as a system message so the agent sees it immediately without
            // reloading the system prompt (which would bust the cached prefix).
            const messages = agent.context?.getMessages?.();
            const hasConversationTurns = messages?.some(
              (m: any) => m.role === "user" || m.role === "harness",
            );
            if (hasConversationTurns && typeof agent.addMessage === "function") {
              const skill = loader.getSkill(name);
              if (skill) {
                const renderedContent = await loader.renderSkillContent(skill);
                agent.addMessage(
                  new Message({
                    role: "harness",
                    content: renderedContent,
                    // Skill body is local file content (trusted layer, same as
                    // the system prompt it also feeds), so no inner escaping.
                    source: "harness",
                  }),
                );
              }
            }

            return {
              action: ACTIONS.DISPLAY,
              content: `Skill '${name}' activated.`,
            };
          },
          completion: createCompletionHandler(() => loader.allSkills()),
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

  // Register completion with completion service (if available)
  if (core.completion) {
    core.completion.register(matcher, createCompletionHandler(() => loader.allSkills()), "skills:skill");
  }

  return instance;
}
