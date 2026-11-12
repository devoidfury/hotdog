import fsPromises from "node:fs/promises";
import { join } from "node:path";
import { HOOKS } from "@core/hooks.ts";
import { logger } from "@utils/logger.ts";
import { render } from "@utils/render.ts";
import { getExtensionConfig, type CoreContext, type ExtensionInstance } from "@core/extensions/types.ts";

async function loadAgentsMd(): Promise<string> {
  try {
    const filePath = join(process.cwd(), "AGENTS.md");
    return await fsPromises.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function buildAgentsMdChunk(autoload: boolean): Promise<string> {
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

export function create(core: CoreContext): ExtensionInstance {
  // B7 (§4.1/§4.3 agentsMd.autoload row): nothing is captured here. The gate
  // is read at EVERY SYSTEM_PROMPT_BUILD, so a live write lands on the next
  // prompt rebuild -- both directions: `false` stops shipping the chunk from
  // the next build, a later `true` brings it back. A rebuild is the natural
  // boundary: an in-flight request already carries the prompt it was built
  // with (P8's general rule, nothing retroactively rewrites it).
  return {
    hooks: {
      [HOOKS.SYSTEM_PROMPT_BUILD]: async (_data) => {
        const autoload = getExtensionConfig<{ autoload?: boolean }>(core, "agentsMd").autoload !== false;
        const content = await buildAgentsMdChunk(autoload);
        return { name: "project-context", priority: 300, content };
      },
    },
  };
}
