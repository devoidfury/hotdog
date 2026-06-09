// Aspects Extension
// Loads .aspect.md files and contributes the Guidelines section chunk.
// Reads aspect names from profile file front matter or config file.

import fsPromises from "node:fs/promises";
import { join } from "node:path";
import { HOOKS } from "../../core/hooks.js";
import { render } from "../../utils/render.js";
import { parseFrontMatter, loadAspects } from "../../utils/file-utils.js";

const TEMPLATE_PATH = join(import.meta.dirname, "aspects_chunk.md");

/**
 * Resolve aspect names from profile file and/or config.
 * Priority: profile file front matter > config file aspects array.
 *
 * @param {Object} core - The core object with config and resolved config.
 * @returns {Promise<string[]>} Array of aspect names to load.
 */
async function resolveAspectNames(core) {
  const resolved = core.resolved || {};
  const rawConfig = core.config || {};

  const profileName = resolved.profileName || "default";
  const profilesPath =
    resolved.profilesPath || rawConfig.profilesPath || "./config/profiles";

  // Try to read aspect names from profile file front matter
  const profileFilePath = join(profilesPath, `${profileName}.profile.md`);
  try {
    const content = await fsPromises.readFile(profileFilePath, "utf-8");
    const parsed = parseFrontMatter(content);
    if (parsed?.frontMatter?.aspects?.length) {
      return parsed.frontMatter.aspects;
    }
  } catch {
    // Profile file not found or not readable
  }

  // Fall back to config file aspects array
  const configAspects = rawConfig.aspects || [];
  if (configAspects.length > 0) {
    return configAspects;
  }

  return [];
}

/**
 * Build the aspects chunk content.
 * @param {string[]} aspectNames - Names of aspects to load.
 * @param {string} profilesPath - Path to profiles directory (for aspects subdirectory).
 * @returns {Promise<string>} Rendered guidelines section.
 */
async function buildAspectsChunk(aspectNames, profilesPath) {
  if (!aspectNames || aspectNames.length === 0) {
    return "";
  }

  // Aspects are in a sibling directory to profiles: config/aspects/
  // (not config/profiles/aspects/)
  const aspectsDir = join(profilesPath, "..", "aspects");
  const aspects = await loadAspects(aspectNames, aspectsDir);

  if (aspects.length === 0) {
    return "";
  }

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
  return {
    hooks: {
      [HOOKS.SYSTEM_PROMPT_BUILD]: async ({ agent, contribute }) => {
        const aspectNames = await resolveAspectNames(core);
        const resolved = core.resolved || {};
        const rawConfig = core.config || {};
        const profilesPath =
          resolved.profilesPath ||
          rawConfig.profilesPath ||
          "./config/profiles";
        const content = await buildAspectsChunk(aspectNames, profilesPath);
        contribute("guidelines", 200, content);
      },
    },
  };
}
