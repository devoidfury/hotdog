/**
 * Profile loading and resolution.
 */

import fsPromises from "node:fs/promises";
import path from "node:path";

import { parseFrontMatter } from "../../utils/file-utils.ts";
import { DEFAULT_PROFILES_SUBPATH } from "./defaults.ts";

export interface ProfileDef {
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
    const fm = parsed.frontMatter as Record<string, unknown>;
    const body = parsed.body as string;
    return {
      name: (fm.name as string) || profileName,
      description: (fm.description as string) || "",
      role: (fm.role as string) || null,
      body: body || "",
      model: (fm.model as string) || null,
      blacklistTools:
        (fm["blacklist-tools"] as string[]) ||
        (fm.blacklist_tools as string[]) ||
        [],
      whitelistTools:
        (fm["whitelist-tools"] as string[]) ||
        (fm.whitelist_tools as string[]) ||
        null,
      manager: !!fm.manager,
      visibleWorker:
        !!(fm["visible-worker"] as boolean) || !!(fm.visible_worker as boolean),
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

  let entries: Array<{ name: string | NonSharedBuffer; isFile: () => boolean }>;
  try {
    entries = await fsPromises.readdir(profilesPath, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const entryName = typeof entry.name === "string" ? entry.name : entry.name.toString();
    if (!entry.isFile() || !entryName.endsWith(".profile.md")) continue;

    const filePath = path.join(profilesPath, entryName);
    let content: string;
    try {
      content = await fsPromises.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const parsed = parseFrontMatter(content);
    if (!parsed) continue;

    const fm = parsed.frontMatter as Record<string, unknown>;
    const fileStem = entryName.replace(/\.profile\.md$/, "");

    result[fileStem] = {
      name: (fm.name as string) || fileStem,
      description: (fm.description as string) || "",
      role: (fm.role as string) || "",
      body: (parsed.body as string) || "",
      blacklistTools:
        (fm["blacklist-tools"] as string[]) ||
        (fm.blacklist_tools as string[]) ||
        [],
      whitelistTools:
        (fm["whitelist-tools"] as string[]) ||
        (fm.whitelist_tools as string[]) ||
        null,
      model: (fm.model as string) || null,
      manager: !!fm.manager,
      visibleWorker:
        !!(fm["visible-worker"] as boolean) || !!(fm.visible_worker as boolean),
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
  profileName: string,
  fileProfile: ProfileDef | null,
  configProfile: ProfileDef | null,
): SwitchProfile {
  const role =
    fileProfile && fileProfile.role && fileProfile.role.trim()
      ? fileProfile.role
      : configProfile && configProfile.role
        ? configProfile.role
        : "";

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
    const sp = resolveSwitchProfile(name, fileProfile, configProfile);
    result[name] = sp;
  }

  return result;
}

/**
 * Merge a config profile with a file profile.
 * File profile wins for role, whitelist, blacklist, manager.
 */
export function mergeProfile(
  configProfile?: Partial<ProfileDef> | null,
  fileProfile?: Partial<ProfileDef> | null,
): ProfileDef {
  if (configProfile || fileProfile) {
    const profile = { ...configProfile } as ProfileDef;
    if (fileProfile) {
      if (fileProfile.role) profile.role = fileProfile.role;
      if (fileProfile.whitelistTools != null)
        profile.whitelistTools = fileProfile.whitelistTools;
      if (fileProfile.blacklistTools?.length)
        profile.blacklistTools = fileProfile.blacklistTools;
      if (fileProfile.manager) profile.manager = true;
    }
    return profile;
  }

  return {
    name: "default",
    description: "",
    role: null,
    body: "",
    model: null,
    blacklistTools: [],
    whitelistTools: null,
    manager: false,
    visibleWorker: false,
  };
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

/**
 * Main profile resolution function.
 */
export async function resolveProfile(
  cliArgs: ProfileCliArgs,
  fileConfig: Record<string, unknown>,
  configDir: string | null,
): Promise<ResolveProfileResult> {
  const profilesPath = resolveProfilesPath(
    cliArgs.profilesPath,
    configDir,
    (fileConfig.profilesPath as string) ?? undefined,
  );

  const profileName =
    cliArgs.profile || (fileConfig.profile as string) || "default";

  const profileFiles = await loadProfileFiles(profilesPath);

  const configProfile =
    ((fileConfig.profiles as Record<string, ProfileDef>)?.[profileName] ??
      null) as ProfileDef | null;
  const fileProfile = profileFiles[profileName] || null;

  const profile = mergeProfile(configProfile, fileProfile);

  const profiles = allProfilesForSwitch({
    profileFiles,
    configProfiles: (fileConfig.profiles as Record<string, ProfileDef>) || {},
    profilesPath,
  });

  return {
    profileName,
    profilesPath,
    profile,
    profileFiles,
    profiles,
  };
}
