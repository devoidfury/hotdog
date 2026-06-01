// Skills Extension
// Manages skills loading, activation, and system prompt integration.
// Hooks: systemPrompt:build, agent:toolContext, tools:register, slashCommands:register

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { HOOKS } from "../../src/hooks.js";
import { render } from "../../src/context/render.js";
import { patternMatches, SkillsLoader } from "./loader.js";
export { LoadSkillTool } from "./load_skill.js";

/**
 * Create the skills extension.
 */
export function create(core) {
  const skillsPath = core.config?.skillsPath || "/skills";
  const loader = new SkillsLoader(skillsPath);
  loader.loadSkills();

  return {
    hooks: {
      /**
       * Build skills preamble for system prompt.
       */
      [HOOKS.SYSTEM_PROMPT_BUILD]: async ({ agent, promptParts }) => {
        const preamble = buildSkillsPreamble(loader);
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
        const { LoadSkillTool } = await import("./load_skill.js");
        const tool = new LoadSkillTool({ loader });
        registry.register("load_skill", tool);
      },

      /**
       * Register slash commands for skills.
       */
      [HOOKS.SLASH_COMMANDS_REGISTER]: async ({ registry }) => {
        registry.register("skill", {
          description: "List skills or activate a skill (skill:<name>)",
          matches: (cmd) => cmd.startsWith("skill:"),
          handler: async (agent, cmdValue) => {
            const name = cmdValue.slice(6).trim();
            if (!name) {
              // List all skills
              const skills = loader.allSkills();
              const active = loader.activeSkills();
              const lines = skills
                .map(
                  (s) => `${s.loaded ? "[x]" : "[ ]"} ${s.name}: ${s.description}`,
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
export function buildSkillsPreamble(loader) {
  const visibleSkills = loader.agentViewableSkills();
  if (visibleSkills.length === 0) return "";

  // Load the skills preamble template
  const templatePath = join(cwd(), "config", "templates", "skills_preamble.md");
  let template;
  try {
    template = readFileSync(templatePath, "utf-8");
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
