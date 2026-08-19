// AGENTS.md Extension
// Loads AGENTS.md from CWD and contributes the Project Context section chunk.

import fsPromises from "node:fs/promises";
import { join } from "node:path";
import { HOOKS } from "@core/hooks.ts";
import { logger } from "@core/logger.ts";
import { render } from "@utils/render.ts";
import { getExtensionConfig, type CoreContext, type ExtensionInstance } from "@core/extensions/types.ts";

/** Load AGENTS.md from CWD if it exists. */
async function loadAgentsMd(): Promise<string> {
  try {
    const filePath = join(process.cwd(), "AGENTS.md");
    return await fsPromises.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

/** Build the agents-md chunk content. */
async function buildAgentsMdChunk(autoload: boolean): Promise<string> {
  // When autoload is false, skip reading the file entirely
  const agentsMd = autoload ? await loadAgentsMd() : "";

  const TEMPLATE_PATH = join(import.meta.dirname, "agents_md_chunk.md");

  let template: string;
  try {
    template = await fsPromises.readFile(TEMPLATE_PATH, "utf-8");
  } catch {
    logger.warn(`agents-md template ${TEMPLATE_PATH} not found`);
    return "";
  }

  return render(template, { agents_md: agentsMd });
}

/** Create the agents-md extension. */
export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<{ autoload?: boolean }>(core, "agentsMd");
  const autoload = config.autoload !== false;

  return {
    hooks: {
      [HOOKS.SYSTEM_PROMPT_BUILD]: async (_data) => {
        const content = await buildAgentsMdChunk(autoload);
        return { name: "project-context", priority: 300, content };
      },
    },
  };
}
