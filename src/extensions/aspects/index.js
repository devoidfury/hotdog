// Aspects Extension
// Loads .aspect.md files and contributes the Guidelines section chunk.
// Hooks: systemPrompt:build

import fsPromises from "node:fs/promises";
import { join } from "node:path";
import { HOOKS } from "../../core/hooks.js";
import { render } from "../../utils/render.js";
import { loadAspects } from "../../utils/file-utils.js";

const TEMPLATE_PATH = join(
  import.meta.dirname,
  "templates",
  "aspects_chunk.md",
);

/**
 * Build the aspects chunk content.
 * @param {string[]} aspectNames - Names of aspects to load.
 * @returns {Promise<string>} Rendered guidelines section.
 */
async function buildAspectsChunk(aspectNames) {
  const aspects = await loadAspects(aspectNames);

  let template;
  try {
    template = await fsPromises.readFile(TEMPLATE_PATH, "utf-8");
  } catch {
    console.warn(`aspects template ${TEMPLATE_PATH} not found`);
    return "";
  }

  return render(template, { aspects });
}

/**
 * Create the aspects extension.
 */
export function create(core) {
  const resolvedConfig = core.config?.resolved || {};

  return {
    hooks: {
      [HOOKS.SYSTEM_PROMPT_BUILD]: async ({ agent, contribute }) => {
        const aspectNames = resolvedConfig.aspects || [];
        const content = await buildAspectsChunk(aspectNames);
        contribute("guidelines", 200, content);
      },
    },
  };
}
