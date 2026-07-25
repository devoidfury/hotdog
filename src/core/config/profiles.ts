/**
 * Profile loading and resolution.
 */

import fsPromises from "node:fs/promises";
import path from "node:path";

import { parseFrontMatter } from "../../utils/file-utils.ts";
import { DEFAULT_PROFILES_SUBPATH } from "./defaults.ts";
import { Dirent } from "node:fs";
import { normalizeConfigKeys } from "./index.ts";

export interface ProfileDef {
  aspects?: string[];
  name: string;
  description: string;
  role: string | null;
  body: string;
  model: string | null;
  blacklistTools: string[];
  whitelistTools: string[] | null;
  /** Snake_case alias for blacklistTools (from JSON config). */
  blacklist_tools?: string[];
  /** Snake_case alias for whitelistTools (from JSON config). */
  whitelist_tools?: string[] | null;
  manager: boolean;
  visibleWorker: boolean;
}

export interface SwitchProfile {
  role: string;
  body: string;
  model: string | null;
}

/**
 * Resolve the profiles directory path.
 */
export function resolveProfilesPath(
  cliProfilesPath?: string | null,
  configDir?: string | null,
  configProfilesPath?: string | null,
): string {
  if (cliProfilesPath) {
    return path.resolve(cliProfilesPath);
  }
  if (configProfilesPath) {
    return path.resolve(configProfilesPath);
  }
  if (configDir) {
    return path.join(configDir, DEFAULT_PROFILES_SUBPATH);
  }
  return "./config/profiles";
}

/**
 * Load a profile from a .profile.md file.
 */
export async function loadProfileFile(
  profilesPath: string,
  profileName: string,
): Promise<ProfileDef | null> {
  let filePath: string;
  try {
    filePath = path.join(profilesPath, `${profileName}.profile.md`);
    const content = await fsPromises.readFile(filePath, "utf-8");
    const parsed = parseFrontMatter(content);
    if (!parsed) return null;
    const fm = normalizeConfigKeys(parsed.frontMatter) as Partial<ProfileDef>;
    const body = parsed.body as string;
    return {
      name: (fm.name as string) || profileName,
      description: (fm.description as string) || "",
      role: (fm.role as string) || null,
      body: body || "",
      model: (fm.model as string) || null,
      blacklistTools: (fm.blacklistTools as string[]) || [],
      whitelistTools: (fm.whitelistTools as string[]) || null,
      manager: !!fm.manager,
      visibleWorker: !!fm.visibleWorker,
    };
  } catch {
    return null;
  }
}

/**
 * Load all .profile.md files from a directory.
 */
export async function loadProfileFiles(
  profilesPath: string,
): Promise<Record<string, ProfileDef>> {
  const result: Record<string, ProfileDef> = {};

  let entries: Dirent[];
  try {
    entries = await fsPromises.readdir(profilesPath, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".profile.md")) continue;

    const filePath = path.join(profilesPath, entry.name);
    let content: string;
    try {
      content = await fsPromises.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const parsed = parseFrontMatter(content);
    if (!parsed) continue;

    const fm = normalizeConfigKeys(parsed.frontMatter) as Record<
      string,
      unknown
    >;
    const fileStem = entry.name.replace(/\.profile\.md$/, "");

    result[fileStem] = {
      name: (fm.name as string) || fileStem,
      description: (fm.description as string) || "",
      role: (fm.role as string) || "",
      body: (parsed.body as string) || "",
      blacklistTools: (fm.blacklistTools as string[]) || [],
      whitelistTools: (fm.whitelistTools as string[]) || null,
      model: (fm.model as string) || null,
      manager: !!fm.manager,
      visibleWorker: !!fm.visibleWorker,
    };
  }

  return result;
}

/**
 * Get all profile names that have visibleWorker: true.
 */
export async function getVisibleWorkerProfiles(
  profilesPath: string,
): Promise<string[]> {
  let dir: string[];
  try {
    dir = await fsPromises.readdir(profilesPath);
  } catch {
    return [];
  }

  const profiles: string[] = [];
  for (const entry of dir) {
    if (!entry.endsWith(".profile.md")) continue;
    const profileName = entry.slice(0, -".profile.md".length);
    const profile = await loadProfileFile(profilesPath, profileName);
    if (profile && profile.visibleWorker) {
      profiles.push(profileName);
    }
  }
  return profiles;
}

/**
 * Resolve a single profile's SwitchProfile data.
 *
 * @private
 */
function resolveSwitchProfile(
  fileProfile: ProfileDef | null,
  configProfile: ProfileDef | null,
): SwitchProfile {
  const role = fileProfile?.role?.trim() || configProfile?.role || "";
  const body = fileProfile?.body || "";
  const model = configProfile?.model || null;
  return { role, body, model };
}

export interface AllProfilesOptions {
  profileFiles?: Record<string, Partial<ProfileDef>> | null;
  configProfiles?: Record<string, Partial<ProfileDef>> | null;
  profilesPath?: string;
}

/**
 * Get all profiles available for switching.
 * Merges config profiles with file profiles.
 */
export function allProfilesForSwitch(
  options: AllProfilesOptions,
): Record<string, SwitchProfile> {
  const { profileFiles, configProfiles } = options;
  const result: Record<string, SwitchProfile> = {};

  const allNames = new Set([
    ...Object.keys(configProfiles || {}),
    ...Object.keys(profileFiles || {}),
  ]);

  for (const name of allNames) {
    const fileProfile = (profileFiles?.[name] as ProfileDef) || null;
    const configProfile = (configProfiles?.[name] as ProfileDef) || null;
    const sp = resolveSwitchProfile(fileProfile, configProfile);
    result[name] = sp;
  }

  return result;
}

export interface ResolveProfileResult {
  profileName: string;
  profilesPath: string;
  profile: ProfileDef;
  profileFiles: Record<string, ProfileDef>;
  profiles: Record<string, SwitchProfile>;
}

export interface ProfileCliArgs {
  profile?: string;
  profilesPath?: string;
}
