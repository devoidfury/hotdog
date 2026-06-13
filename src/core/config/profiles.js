/**
 * Profile loading and resolution — consolidated from config.js.
 *
 * Provides a single `resolveProfile()` function that replaces the overlapping
 * `loadProfileFile()`, `getProfile()`, `loadProfileFiles()`, `allProfilesForSwitch()`,
 * `resolveSwitchProfile()`, and `resolveProfileFile()` functions.
 */

import fsPromises from "node:fs/promises";
import path from "node:path";

import { parseFrontMatter } from "../../utils/file-utils.js";
import { render } from "../../utils/render.js";
import { DEFAULT_PROFILES_SUBPATH } from "./defaults.js";

/**
 * Resolve the profiles directory path.
 *
 * @param {string} [cliProfilesPath] - Profiles path from CLI.
 * @param {string} [configDir] - Resolved config directory.
 * @param {string} [configProfilesPath] - Profiles path from config file.
 * @returns {string} Resolved profiles directory path.
 */
export function resolveProfilesPath(cliProfilesPath, configDir, configProfilesPath) {
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
 * Profile files use YAML front matter with fields: name, role, blacklist-tools, model, preload-skills, manager.
 *
 * @param {string} profilesPath - Directory containing .profile.md files.
 * @param {string} profileName - Name of the profile to load (without .profile.md extension).
 * @returns {Promise<object|null>} Parsed profile object or null if not found.
 */
export async function loadProfileFile(profilesPath, profileName) {
  let filePath;
  try {
    filePath = path.join(profilesPath, `${profileName}.profile.md`);
    const content = await fsPromises.readFile(filePath, "utf-8");
    const parsed = parseFrontMatter(content);
    if (!parsed) return null;
    const fm = parsed.frontMatter;
    const body = parsed.body;
    return {
      name: fm.name || profileName,
      role: fm.role || null,
      body: body || "",
      model: fm.model || null,
      blacklistTools: fm["blacklist-tools"] || fm.blacklist_tools || [],
      whitelistTools: fm["whitelist-tools"] || fm.whitelist_tools || null,
      manager: fm.manager || false,
      visibleWorker: fm["visible-worker"] || fm.visible_worker || false,
    };
  } catch {
    return null;
  }
}

/**
 * Load all .profile.md files from a directory.
 *
 * @param {string} profilesPath - Directory containing .profile.md files.
 * @returns {Promise<object>} Map of profile name → profile object.
 */
export async function loadProfileFiles(profilesPath) {
  const result = {};

  let entries;
  try {
    entries = await fsPromises.readdir(profilesPath, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".profile.md")) continue;

    const filePath = path.join(profilesPath, entry.name);
    let content;
    try {
      content = await fsPromises.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const parsed = parseFrontMatter(content);
    if (!parsed) continue;

    const fm = parsed.frontMatter;
    const fileStem = entry.name.replace(/\.profile\.md$/, "");

    result[fileStem] = {
      name: fm.name || fileStem,
      description: fm.description || "",
      role: fm.role || "",
      body: parsed.body || "",
      blacklistTools: fm["blacklist-tools"] || fm.blacklist_tools || [],
      whitelistTools: fm["whitelist-tools"] || fm.whitelist_tools || null,
      model: fm.model || null,
      manager: fm.manager || false,
    };
  }

  return result;
}

/**
 * Get all profile names that have visibleWorker: true.
 * Scans all .profile.md files in the profiles directory.
 *
 * @param {string} profilesPath - Directory containing .profile.md files.
 * @returns {Promise<string[]>} Array of profile name strings.
 */
export async function getVisibleWorkerProfiles(profilesPath) {
  let dir;
  try {
    dir = await fsPromises.readdir(profilesPath);
  } catch {
    return []; // Profiles directory not found or not readable
  }

  const profiles = [];
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
 * @param {string} profileName - Profile name.
 * @param {object} [fileProfile] - Profile from .profile.md file.
 * @param {object} [configProfile] - Profile from config file.
 * @returns {object} SwitchProfile data with role, body, model.
 */
export function resolveSwitchProfile(profileName, fileProfile, configProfile) {
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

/**
 * Get all profiles available for switching.
 * Merges config profiles with file profiles.
 *
 * @param {object} options - Options object.
 * @param {object} [options.profileFiles] - Profiles loaded from .profile.md files.
 * @param {object} [options.configProfiles] - Profiles from config file.
 * @param {string} [options.profilesPath] - Profiles directory path.
 * @returns {object} Map of profile name → SwitchProfile data.
 */
export function allProfilesForSwitch(options) {
  const { profileFiles, configProfiles, profilesPath } = options;
  const result = {};

  // Collect all profile names from both sources
  const allNames = new Set([
    ...Object.keys(configProfiles || {}),
    ...Object.keys(profileFiles || {}),
  ]);

  for (const name of allNames) {
    const fileProfile = profileFiles?.[name] || null;
    const configProfile = configProfiles?.[name] || null;
    const sp = resolveSwitchProfile(name, fileProfile, configProfile);
    result[name] = sp;
  }

  return result;
}

/**
 * Merge a config profile with a file profile.
 * File profile wins for role, whitelist, blacklist, manager.
 *
 * @param {object} [configProfile] - Profile from config file.
 * @param {object} [fileProfile] - Profile from .profile.md file.
 * @returns {object} Merged profile object.
 */
export function mergeProfile(configProfile, fileProfile) {
  if (configProfile || fileProfile) {
    const profile = { ...configProfile };
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

  // Default profile: no restrictions
  return {
    whitelistTools: null,
    blacklistTools: [],
    skills: [],
    role: null,
    model: null,
    manager: false,
    cwdBoundary: null,
  };
}

/**
 * Get resolved profile from config and profile files.
 * Priority: JSON config profile → .profile.md file → default.
 *
 * @param {object} config - Config object with profiles and profilesPath.
 * @param {string} profileName - Name of the profile to resolve.
 * @returns {Promise<object>} Resolved profile object.
 */
export async function getProfile(config, profileName) {
  // 1. Check JSON config profiles
  if (config.profiles && config.profiles[profileName]) {
    return config.profiles[profileName];
  }
  // 2. Check profile markdown files
  const fileProfile = await loadProfileFile(config.profilesPath, profileName);
  if (fileProfile) {
    return fileProfile;
  }
  // Default profile: no restrictions
  return {
    whitelistTools: null,
    blacklistTools: [],
    skills: [],
    role: null,
    model: null,
    manager: false,
    cwdBoundary: null,
  };
}

/**
 * Main profile resolution function — consolidates all profile loading.
 *
 * @param {object} cliArgs - Parsed CLI arguments.
 * @param {object} fileConfig - Config loaded from file.
 * @param {string} configDir - Resolved config directory.
 * @returns {Promise<object>} Object with profile, profileName, profileFiles, profiles (for switch).
 */
export async function resolveProfile(cliArgs, fileConfig, configDir) {
  const profilesPath = resolveProfilesPath(
    cliArgs.skillsPath
      ? path.join(cliArgs.skillsPath, "..", "profiles")
      : undefined,
    configDir,
    fileConfig.profilesPath,
  );

  const profileName = cliArgs.profile || fileConfig.profile || "default";

  // Load all profiles once
  const profileFiles = await loadProfileFiles(profilesPath);

  // Get the selected profile sources
  const configProfile = fileConfig.profiles?.[profileName] || null;
  const fileProfile = profileFiles[profileName] || null;

  // Merge: file profile wins for role/whitelist/blacklist/manager
  const profile = mergeProfile(configProfile, fileProfile);

  // All profiles for switch
  const profiles = allProfilesForSwitch({
    profileFiles,
    configProfiles: fileConfig.profiles || {},
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
