// Skills Extension
// Manages skills loading, activation, and system prompt integration.
// Hooks: systemPrompt:build, agent:toolContext, tools:register, command:dispatch

import { HOOKS } from "../../src/hooks.js";
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
       * Enrich tool context with skills loader — extensions can access
       * toolCtx.skillsLoader instead of agent._skillsLoader.
       */
      [HOOKS.AGENT_TOOL_CONTEXT]: async ({ toolCtx }) => {
        toolCtx.skillsLoader = loader;
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
       * Handle skill activation commands.
       */
      [HOOKS.COMMAND_DISPATCH]: async ({ command, agent }) => {
        if (command.type !== "skill") return;

        if (command.value) {
          loader.activateSkill(command.value);
          return { content: `Skill '${command.value}' activated.` };
        } else {
          const skills = loader.allSkills();
          const active = loader.activeSkills();
          const lines = skills
            .map(
              (s) => `${s.loaded ? "[x]" : "[ ]"} ${s.name}: ${s.description}`,
            )
            .join("\n");
          return { content: `## Available Skills\n\n${lines}` };
        }
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
  const allSkills = loader.allSkills();
  if (allSkills.length === 0) return "";

  const skillDirs = loader.directories().join("\n") || "/skills";
  const visibleSkills = allSkills.filter(
    (s) => s.visible && !s.disableModelInvocation,
  );
  if (visibleSkills.length === 0) return "";

  const loadedSkills = visibleSkills.filter((s) => s.loaded);
  const unloadedSkills = visibleSkills.filter((s) => !s.loaded);

  let preamble = `# Available Skills\n\nSkill directories: ${skillDirs}\n\n`;

  // Loaded skills with full content
  if (loadedSkills.length > 0) {
    preamble += "## Loaded Skills\n\n";
    for (const skill of loadedSkills) {
      preamble += `<skill_content name="${skill.name}">\n${skill.content}\n</skill_content>\n\n`;
    }
  }

  // Unloaded skills with descriptions
  if (unloadedSkills.length > 0) {
    preamble += "## Available Skills\n\n";
    for (const skill of unloadedSkills) {
      preamble += `<name>${skill.name}</name>\n${skill.description}\n\n`;
    }
  }

  return preamble;
}
