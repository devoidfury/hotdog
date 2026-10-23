// `hotdog profiles` subcommand: list file + config profiles, their tool
// restrictions, and (for manager profiles) their available subagents.
import path from "node:path";
import type { BuildAgentConfig, CliArgv } from "@core/config/index.ts";
import { ProfileDef, ProfileManager } from "@core/config/profiles.ts";
import type { CoreContext } from "@core/extensions/types.ts";

// Fallback for tests/backward compat
export async function ensureProfileManager(
  resolved: BuildAgentConfig,
  config: Record<string, unknown>,
  profilesPath: string,
): Promise<ProfileManager> {
  if (resolved.profileManager) {
    return resolved.profileManager;
  }
  return await ProfileManager.create(profilesPath, (config.profiles as Record<string, ProfileDef>) || {});
}

export async function runProfileList(cli: CliArgv, core: CoreContext): Promise<number> {
  const { config, buildConfig } = core;
  const { resolved } = await buildConfig!(cli);

  const profilesPath = resolved.profilesPath as string;
  if (!profilesPath) {
    console.error("Error: profilesPath not resolved");
    return 1;
  }
  const profileManager = await ensureProfileManager(resolved, config, profilesPath);

  const profileFiles = profileManager.getFileProfiles();
  const configProfiles = profileManager.getConfigProfiles();
  const allNames = new Set(profileManager.getAllNames());
  const visibleWorkerNames = profileManager.getVisibleWorkerProfiles();

  if (cli.wantsJson) {
    return printProfileListJson(
      profileFiles,
      configProfiles,
      allNames,
      resolved.profileName ?? "default",
      profilesPath,
      visibleWorkerNames,
    );
  }

  return printProfileListText(
    profileFiles,
    configProfiles,
    allNames,
    resolved.profileName ?? "default",
    profilesPath,
    visibleWorkerNames,
  );
}

interface ProfileView {
  description: string | null;
  model: string | null;
  aspects: string[];
  blacklistTools: string[];
  whitelistTools: string[] | null | undefined;
  profilePath: string | null;
  bodyLength: number;
  sources: string[];
}

// Merges file and config profile definitions. File profile wins, but only for non-empty values.
function buildProfileView(
  name: string,
  fileProfile: ProfileDef | null,
  configProfile: Partial<ProfileDef> | null,
  profilesPath: string,
): ProfileView {
  const fileBlacklist = fileProfile?.blacklistTools || [];
  const cfgBlacklist = configProfile?.blacklist_tools || configProfile?.blacklistTools || [];
  const fileWhitelist = fileProfile?.whitelistTools;
  const cfgWhitelist = configProfile?.whitelist_tools || configProfile?.whitelistTools;

  let profilePath: string | null = null;
  if (fileProfile && profilesPath) {
    try {
      profilePath = path.join(profilesPath, `${name}.profile.md`);
    } catch {
      // Ignore path resolution errors
    }
  }

  return {
    description: fileProfile?.description || configProfile?.description || null,
    model: configProfile?.model || fileProfile?.model || null,
    aspects: fileProfile?.aspects || configProfile?.aspects || [],
    blacklistTools: fileBlacklist.length > 0 ? fileBlacklist : cfgBlacklist,
    whitelistTools: fileWhitelist && fileWhitelist.length > 0 ? fileWhitelist : cfgWhitelist,
    profilePath,
    bodyLength: fileProfile?.body ? fileProfile.body.trim().length : 0,
    sources: [fileProfile ? "file" : null, configProfile ? "config" : null].filter(
      (s): s is string => s !== null,
    ),
  };
}

function printProfileListText(
  profileFiles: Record<string, ProfileDef>,
  configProfiles: Record<string, Partial<ProfileDef>>,
  allNames: Set<string>,
  currentProfile: string,
  profilesPath: string,
  visibleWorkerNames: string[],
): number {
  const names = Array.from(allNames).sort();

  if (names.length === 0) {
    console.log("No profiles configured.");
    console.log(`Profiles directory: (not found or empty)`);
    return 0;
  }

  console.log(`=== Profiles (${names.length}) ===`);
  console.log();

  for (const name of names) {
    const fileProfile = profileFiles[name] || null;
    const view = buildProfileView(name, fileProfile, configProfiles[name] || null, profilesPath);
    const isCurrent = name === currentProfile;
    const marker = isCurrent ? "  ← current" : "";

    console.log(`Profile: ${name}${marker}`);

    if (view.description) {
      console.log(`  Description: ${view.description}`);
    }

    if (view.model) {
      console.log(`  Model: ${view.model}`);
    }

    if (view.aspects.length > 0) {
      console.log(`  Aspects: ${view.aspects.join(", ")}`);
    }

    if (view.blacklistTools.length > 0) {
      console.log(`  Blacklisted tools: ${view.blacklistTools.join(", ")}`);
    }
    if (view.whitelistTools && view.whitelistTools.length > 0) {
      console.log(`  Whitelisted tools: ${view.whitelistTools.join(", ")}`);
    }

    if (fileProfile?.manager) {
      const available = visibleWorkerNames.filter((n) => n !== name);
      if (available.length > 0) {
        console.log(`  Manager: yes (subagents: ${available.join(", ")})`);
      } else {
        console.log(`  Manager: yes (no subagents available)`);
      }
    }
    if (fileProfile?.visibleWorker) {
      console.log(`  Subagent: yes`);
    }

    if (fileProfile?.body) {
      console.log(`  Body: ${view.bodyLength} chars`);
    }

    console.log(`  Source: ${view.sources.join(" + ")}`);
    if (view.profilePath) {
      console.log(`  Profile: ${view.profilePath}`);
    }

    console.log();
  }

  return 0;
}

function printProfileListJson(
  profileFiles: Record<string, ProfileDef>,
  configProfiles: Record<string, Partial<ProfileDef>>,
  allNames: Set<string>,
  currentProfile: string,
  profilesPath: string,
  visibleWorkerNames: string[],
): number {
  const names = Array.from(allNames).sort();
  const profiles: Array<Record<string, unknown>> = [];

  for (const name of names) {
    const fileProfile = profileFiles[name] || null;
    const view = buildProfileView(name, fileProfile, configProfiles[name] || null, profilesPath);

    profiles.push({
      name,
      current: name === currentProfile,
      description: view.description,
      model: view.model,
      aspects: view.aspects.length > 0 ? view.aspects : null,
      blacklistTools: view.blacklistTools.length > 0 ? view.blacklistTools : null,
      whitelistTools: view.whitelistTools,
      manager: fileProfile?.manager || false,
      subagent: fileProfile?.visibleWorker || false,
      availableSubagents: fileProfile?.manager ? visibleWorkerNames.filter((n) => n !== name) : null,
      bodyLength: view.bodyLength,
      sources: view.sources,
      profileRelPath: view.profilePath,
    });
  }

  console.log(JSON.stringify(profiles, null, 2));
  return 0;
}
