// Skills Extension
// Manages skills loading, activation, and system prompt integration.
// Hooks: systemPrompt:build, agent:toolContext, tools:register, commands:register
// Config defaults are defined in extension.json configSchema.
// CLI flags are registered via the hook since they need programmatic control.

import extensionData from "./extension.json";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";
import { HOOKS } from "../../core/hooks.js";
import { render } from "../../utils/render.js";
import { patternMatches, SkillsLoader } from "./loader.js";
import { LoadSkillTool } from "./load-skill.js";
export { LoadSkillTool };

/**
 * Create the skills extension.
 * Config defaults come from extension.json configSchema.
 */
export async function create(core) {
  // Config defaults come from extension.json configSchema
  const config = core.config?.skills || {};
  const skillsPath = config.skillsPath ?? extensionData.configSchema.properties.skillsPath.default;
  const loader = new SkillsLoader(skillsPath);
  await loader.loadSkills();

  // Preload skills from config (CLI → config file priority)
  const preloadSkills = _resolvePreloadSkills(core);
  if (preloadSkills.length > 0) {
    loader.preloadSkills(preloadSkills);
  }

  return {
    hooks: {
      /**
       * Register CLI flag for preloading skills.
       * Kept here because CLI flags need programmatic registration.
       */
      [HOOKS.CONFIG_CLI_FLAGS_REGISTER]: (configRegistry) => {
        configRegistry.registerCliFlags([
          {
            short: null,
            long: "--preload-skills",
            description: "Preload skills by name (comma-separated)",
            type: "array",
            default: [],
          },
        ]);
      },

      /**
       * Build skills preamble for system prompt.
       */
      [HOOKS.SYSTEM_PROMPT_BUILD]: async ({ agent, promptParts }) => {
        const preamble = await buildSkillsPreamble(loader);
        if (preamble) {
          promptParts.push(preamble);
        }
      },

      /**
       * Mount the skills loader on the shared context container.
       * Tools access it via toolCtx.get('skillsLoader').
       */
      [HOOKS.AGENT_TOOL_CONTEXT]: async ({ toolCtx }) => {
        toolCtx.set("skillsLoader", loader);
      },

      /**
       * Register the load_skill tool.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        const tool = new LoadSkillTool({ loader });
        registry.register("load_skill", tool);
      },

      /**
       * Register commands for skills.
       */
      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
        registry.register("skill", {
          description: "List skills or activate a skill (skill:<name>)",
          matches: (cmd) => cmd.startsWith("skill"),
          handler: async (agent, cmdValue) => {
            const name = cmdValue.slice(6).trim();
            if (!name) {
              // List all skills
              const skills = loader.allSkills();
              const active = loader.activeSkills();
              const lines = skills
                .map(
                  (s) =>
                    `${s.loaded ? "[x]" : "[ ]"} ${s.name}: ${s.description}`,
                )
                .join("\n");
              return { content: `## Available Skills\n\n${lines}` };
            }
            // Activate skill
            loader.activateSkill(name);
            return { content: `Skill '${name}' activated.` };
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
    getCombinedToolPatterns() {
      const patterns = new Set();
      for (const skill of loader.activeSkills()) {
        for (const tool of skill.includeTools || []) {
          patterns.add(tool.toLowerCase());
        }
        for (const tool of skill.allowedTools || []) {
          patterns.add(tool.toLowerCase());
        }
      }
      return patterns;
    },

    /**
     * Check if a tool is allowed by active skills.
     */
    isToolAllowed(toolName) {
      const patterns = this.getCombinedToolPatterns();
      if (patterns.size === 0) return true;
      const nameLower = toolName.toLowerCase();
      return Array.from(patterns).some((pattern) =>
        patternMatches(pattern, nameLower),
      );
    },
  };
}

/**
 * Build skills preamble content for the system prompt.
 */
export async function buildSkillsPreamble(loader) {
  const visibleSkills = loader.agentViewableSkills();
  if (visibleSkills.length === 0) return "";

  // Load the skills preamble template
  const templatePath = join(cwd(), "config", "templates", "skills_preamble.md");
  let template;
  try {
    template = await readFile(templatePath, "utf-8");
  } catch {
    console.warn(`skills preamble ${templatePath} not found`);
    return "";
  }

  // Transform skills to match template expectations
  const renderedSkills = visibleSkills.map((s) => ({
    ...s,
    additional_files: s.additionalFiles || [],
  }));

  const context = {
    skills: renderedSkills,
    skill_directories: loader.directories(),
  };

  return render(template, context);
}

/**
 * Resolve preload skills from CLI args or config.
 * Priority: CLI args → config file → empty.
 *
 * @param {Object} core - The core object.
 * @returns {string[]} Array of skill names to preload.
 */
function _resolvePreloadSkills(core) {
  // Check CLI args first
  const cliSkills = core.cli?.preloadSkills;
  if (cliSkills && cliSkills.length > 0) {
    return cliSkills;
  }

  const config = core.config?.skills || {};
  const configSkills = config.preloadSkills;
  if (configSkills && configSkills.length > 0) {
    return configSkills;
  }

  return [];
}
