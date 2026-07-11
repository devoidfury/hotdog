// Environment - Contributes the Environment section chunk to the system prompt.
// Hooks: systemPrompt:build

import { join } from "node:path";
import { cwd, platform } from "node:process";
import { readFile } from "node:fs/promises";
import { HOOKS } from "../../core/hooks.ts";
import { logger } from "../../core/logger.ts";
import { render } from "../../utils/render.ts";
import { ExtensionInstance } from "../../core/extensions/types.ts";

const TEMPLATE_PATH = join(import.meta.dirname, "environment_chunk.md");

interface Agent {
  model?: string;
  _profileName?: string;
}

/**
 * Build the environment chunk content.
 */
async function buildEnvironmentChunk(agent: Agent): Promise<string> {
  let template: string;
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
export function create(): ExtensionInstance {
  return {
    hooks: {
      [HOOKS.SYSTEM_PROMPT_BUILD]: async ({ agent }: { agent: Agent }) => {
        const content = await buildEnvironmentChunk(agent);
        return { name: "info", priority: 100, content };
      },
    },
  };
}
