// Aspects Extension
// Loads .aspect.md files and contributes the Guidelines section chunk.
// Reads aspect names from profile file front matter or config file.

import fsPromises from "node:fs/promises";
import path from "node:path";
import { HOOKS } from "../../core/hooks.ts";
import { logger } from "../../core/logger.ts";
import { render } from "../../utils/render.ts";
import { parseFrontMatter, loadAspects } from "../../utils/file-utils.ts";
import { resolveConfigDir } from "../../core/config/index.ts";
import { DEFAULT_PROFILES_SUBPATH } from "../../core/config/defaults.ts";
import { CoreContext, ExtensionInstance } from "../../core/extensions/types.ts";

const TEMPLATE_PATH = path.join(import.meta.dirname, "aspects_chunk.md");

/**
 * Resolve aspect names from profile file and/or config.
 * Priority: profile file front matter > config file aspects array.
 */
async function resolveAspectNames(core: CoreContext): Promise<string[]> {
  const resolved = core.resolved || {};
  const rawConfig = core.config || {};
  const configDir = (resolved.configDir as string) || resolveConfigDir();

  const profileName = (resolved.profileName as string) || "default";
  const profilesPath =
    (resolved.profilesPath as string) ||
    (rawConfig.profilesPath as string) ||
    path.join(configDir, DEFAULT_PROFILES_SUBPATH);

  // Try to read aspect names from profile file front matter
  const profileFilePath = path.join(profilesPath, `${profileName}.profile.md`);
  try {
    const content = await fsPromises.readFile(profileFilePath, "utf-8");
    const parsed = parseFrontMatter(content);
    if (
      parsed?.frontMatter?.aspects &&
      Array.isArray(parsed.frontMatter.aspects) &&
      parsed.frontMatter.aspects.length
    ) {
      return parsed.frontMatter.aspects as string[];
    }
  } catch {
    // Profile file not found or not readable
  }

  // Fall back to config file aspects array
  const configAspects = (rawConfig.aspects as string[]) || [];
  if (configAspects.length > 0) {
    return configAspects;
  }

  return [];
}

/**
 * Build the aspects chunk content.
 */
async function buildAspectsChunk(
  aspectNames: string[],
  profilesPath: string,
): Promise<string> {
  if (!aspectNames || aspectNames.length === 0) {
    return "";
  }

  // Aspects are in a sibling directory to profiles: config/aspects/
  // (not config/profiles/aspects/)
  const aspectsDir = path.join(profilesPath, "..", "aspects");
  const aspects = await loadAspects(aspectNames, aspectsDir);

  if (aspects.length === 0) {
    return "";
  }

  let template: string;
  try {
    template = await fsPromises.readFile(TEMPLATE_PATH, "utf-8");
  } catch {
    logger.warn(`aspects template ${TEMPLATE_PATH} not found`);
    return "";
  }

  return render(template, { aspects });
}

/**
 * Create the aspects extension.
 */
export function create(core: CoreContext): ExtensionInstance {
  return {
    hooks: {
      [HOOKS.SYSTEM_PROMPT_BUILD]: async (_data: unknown) => {
        const aspectNames = await resolveAspectNames(core);
        const resolved = core.resolved || {};
        const rawConfig = core.config || {};
        const configDir = (resolved.configDir as string) || resolveConfigDir();
        const profilesPath =
          (resolved.profilesPath as string) ||
          (rawConfig.profilesPath as string) ||
          path.join(configDir, DEFAULT_PROFILES_SUBPATH);
        const content = await buildAspectsChunk(aspectNames, profilesPath);
        return { name: "guidelines", priority: 200, content };
      },
    },
  };
}
