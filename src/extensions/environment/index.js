// Environment Extension
// Contributes the Environment section chunk to the system prompt.
// Hooks: systemPrompt:build

import { join } from "node:path";
import { cwd, platform } from "node:process";
import { readFile } from "node:fs/promises";
import { HOOKS } from "../../core/hooks.js";
import { logger } from "../../core/logger.js";
import { render } from "../../utils/render.js";

const TEMPLATE_PATH = join(import.meta.dirname, "environment_chunk.md");

/**
 * Build the environment chunk content.
 * @param {Object} agent - The agent instance.
 * @returns {Promise<string>} Rendered environment section.
 */
async function buildEnvironmentChunk(agent) {
  let template;
  try {
    template = await readFile(TEMPLATE_PATH, "utf-8");
  } catch {
    logger.warn(`environment template ${TEMPLATE_PATH} not found`);
    return "";
  }

  const context = {
    model: agent.model || "",
    profile_name: agent._profileName || "default",
    cwd: cwd(),
    platform: platform,
    session_start: new Date().toISOString().slice(0, 10),
  };

  return render(template, context);
}

/**
 * Create the environment extension.
 */
export function create() {
  return {
    hooks: {
      [HOOKS.SYSTEM_PROMPT_BUILD]: async ({ agent }) => {
        const content = await buildEnvironmentChunk(agent);
        return { name: "info", priority: 100, content };
      },
    },
  };
}
