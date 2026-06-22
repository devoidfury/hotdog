// AGENTS.md Extension
// Loads AGENTS.md from CWD and contributes the Project Context section chunk.

import fsPromises from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";
import { HOOKS } from "../../core/hooks.js";
import { logger } from "../../core/logger.js";
import { render } from "../../utils/render.js";
import extensionData from "./extension.json";

/**
 * Load AGENTS.md from CWD if it exists.
 * @returns {Promise<string>} AGENTS.md content or empty string.
 */
async function loadAgentsMd() {
  try {
    const path = join(cwd(), "AGENTS.md");
    return await fsPromises.readFile(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Build the agents-md chunk content.
 * @param {boolean} autoload - Whether to read AGENTS.md from disk.
 * @returns {Promise<string>} Rendered project context section.
 */
async function buildAgentsMdChunk(autoload) {
  // When autoload is false, skip reading the file entirely
  const agentsMd = autoload ? await loadAgentsMd() : "";

  const TEMPLATE_PATH = join(import.meta.dirname, "agents_md_chunk.md");

  let template;
  try {
    template = await fsPromises.readFile(TEMPLATE_PATH, "utf-8");
  } catch {
    logger.warn(`agents-md template ${TEMPLATE_PATH} not found`);
    return "";
  }

  return render(template, { agents_md: agentsMd });
}

/**
 * Create the agents-md extension.
 * Config defaults come from extension.json configSchema.
 */
export function create(core) {
  const config = core.config?.agentsMd || {};
  const autoload = config.autoload !== false;

  return {
    hooks: {
      [HOOKS.SYSTEM_PROMPT_BUILD]: async ({ agent }) => {
        const content = await buildAgentsMdChunk(autoload);
        return { name: "project-context", priority: 300, content };
      },
    },
  };
}
