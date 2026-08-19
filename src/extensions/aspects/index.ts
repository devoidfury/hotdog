// Aspects Extension - Reads aspects from profiles, loads .aspect.md files, composable system prompt chunks.

import fsPromises from "node:fs/promises";
import path from "node:path";
import { HOOKS } from "@core/hooks.ts";
import { logger } from "@core/logger.ts";
import { render } from "@utils/render.ts";
import { parseFrontMatter, loadAspects } from "@utils/file-utils.ts";
import { CoreContext, ExtensionInstance } from "@core/extensions/types.ts";

const TEMPLATE_PATH = path.join(import.meta.dirname, "aspects_chunk.md");

/** Validate an aspect name before it is used to build a file path. */
const ASPECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const ASPECT_NAME_MAX_LEN = 64;

export function isValidAspectName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= ASPECT_NAME_MAX_LEN &&
    ASPECT_NAME_RE.test(name)
  );
}

/** Resolve aspect names from profile file front matter. */
async function resolveAspectNames(core: CoreContext): Promise<string[]> {
  const profileManager = core.resolved?.profileManager;
  if (profileManager) {
    const profileName = core.resolved?.profileName || "default";
    const profile = profileManager.getProfile(profileName);
    return profile?.aspects || [];
  }
  // Fallback: read profile file directly (for tests/backward compat)
  const profileName = core.resolved?.profileName || "default";
  const profilesPath = core.resolved?.profilesPath;
  if (!profilesPath) return [];

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

  return [];
}

/** Build the aspects chunk content. Aspects are in config/aspects/ */
async function buildAspectsChunk(aspectNames: string[], configDir: string): Promise<string> {
  if (!aspectNames || aspectNames.length === 0) {
    return "";
  }

  const validNames = aspectNames.filter((name) => {
    const ok = isValidAspectName(name);
    if (!ok) {
      logger.warn(`[aspects] rejected invalid aspect name: ${JSON.stringify(String(name).slice(0, 80))}`);
    }
    return ok;
  });
  if (validNames.length === 0) {
    return "";
  }

  const aspectsDir = path.join(configDir, "aspects");
  const aspects = await loadAspects(validNames, aspectsDir);

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

/** Create the aspects extension. */
export function create(core: CoreContext): ExtensionInstance {
  return {
    hooks: {
      [HOOKS.SYSTEM_PROMPT_BUILD]: async (_data) => {
        const configDir = core.resolved?.configDir;
        if (!configDir) throw new Error("configDir not resolved");
        const content = await buildAspectsChunk(await resolveAspectNames(core), configDir);
        return { name: "guidelines", priority: 200, content };
      },
    },
  };
}
