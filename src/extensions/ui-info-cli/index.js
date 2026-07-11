// Info-Show-Prompt Extension
// Provides CLI subcommands (info, show-prompt) that run outside the agent loop.
// Registers subcommands via the cli:subcommandsRegister hook.

import { HOOKS } from "../../core/hooks.js";
import { LlmClient } from "../../core/llm-client/client.js";
import { SkillsLoader } from "../skills/loader.js";
import {
  DEFAULT_SKILLS_PATH,
  DEFAULT_PROFILES_SUBPATH,
  DEFAULT_CONFIG_FILENAME,
} from "../../core/config/defaults.js";
import { loadConfig, resolveConfigDir } from "../../core/config/index.js";
import { loadProfileFiles } from "../../core/config/profiles.js";
import {
  CONFIG_SCHEMA as CONFIG_KEYS,
  resolveKey,
  resolveLayerValue,
} from "../../core/config/schema-loader.js";
import { Agent } from "../../core/agent.js";
import path from "node:path";
import fs from "node:fs/promises";

/**
 * Run the info subcommand.
 */
async function runInfo(cli, config, buildConfig) {
  const { resolved, modelRegistry, providers } = await buildConfig(cli);
  const configDir = resolved.configDir || resolveConfigDir(cli.configDir);
  const rawConfig = await loadConfig(cli.config, cli.configDir);

  // If --config-debug is set, show config resolution details and exit
  if (cli.config_debug) {
    return await printConfigDebug(cli, rawConfig, providers, resolved);
  }

  // Check connectivity
  const client = new LlmClient({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    stream: false,
    chatTimeoutSecs: resolved.chatTimeout,
    maxRetries: resolved.maxRetries,
    providers: rawConfig.providers || [],
  });

  let connectivity;
  try {
    if (client.ping) await client.ping();
    connectivity = { reachable: true, error: null };
  } catch (e) {
    connectivity = { reachable: false, error: e.message };
  }

  const skillsLoader = new SkillsLoader(
    cli.skillsPath || rawConfig.skills?.path || DEFAULT_SKILLS_PATH,
  );
  await skillsLoader.loadSkills();

  if (cli.wantsJson) {
    return printInfoJson(
      resolved,
      modelRegistry,
      providers,
      skillsLoader,
      connectivity,
      rawConfig,
    );
  }

  return printInfoText(
    resolved,
    modelRegistry,
    providers,
    skillsLoader,
    connectivity,
    rawConfig,
  );
}

function printInfoText(
  resolved,
  modelRegistry,
  providers,
  skillsLoader,
  connectivity,
  config,
) {
  console.log("=== Agent Harness Info ===");
  console.log();
  console.log("Configuration:");
  const configDirAbs = resolved.configDir || resolveConfigDir(null);
  console.log(`  Config Dir:      ${configDirAbs}`);
  console.log(`  AI URL:          ${resolved.baseUrl}`);
  console.log(`  Default Model:   ${resolved.model}`);
  console.log(
    `  Skills Path:     ${config?.skillsPath || DEFAULT_SKILLS_PATH}`,
  );
  console.log(`  Chat Timeout:    ${resolved.chatTimeout}s`);
  console.log(`  Profile:         ${resolved.profileName}`);
  if (resolved.profile?.whitelistTools) {
    console.log(
      `  Whitelist Tools: ${resolved.profile.whitelistTools.join(", ")}`,
    );
  }
  if (resolved.profile?.blacklistTools?.length > 0) {
    console.log(
      `  Blacklist Tools: ${resolved.profile.blacklistTools.join(", ")}`,
    );
  }

  if (providers.length > 0) {
    console.log();
    console.log("Providers:");
    for (const p of providers) {
      const isActive = resolved.activeProvider === p.name;
      const isDefault = config?.defaultProvider === p.name;
      const marker = isActive ? " (active)" : isDefault ? " (default)" : "";
      const modelNames = (p.models || []).map((m) => m.name).join(", ");
      console.log(`  ${p.name}${marker} → ${p.url}  [${modelNames}]`);
    }
    if (resolved.activeProvider) {
      console.log();
      console.log(`Active Provider: ${resolved.activeProvider}`);
    }
  }

  console.log();
  console.log(`Models (${Object.keys(modelRegistry).length}):`);
  for (const name of Object.keys(modelRegistry)) {
    const m = modelRegistry[name];
    const tagStr = (m.tags || []).length > 0 ? m.tags.join(", ") : "no tags";
    console.log(`  ${name} [${tagStr}]`);
  }
  console.log();
  console.log(`Skills: ${skillsLoader.activeSkills().length} loaded`);

  const mcpServers = config?.mcpServers || [];
  if (mcpServers.length > 0) {
    console.log();
    console.log("MCP Servers:");
    for (const server of mcpServers) {
      const enabled = server.enabled !== false ? "enabled" : "disabled";
      const transport = server.url
        ? `HTTP (${server.url})`
        : server.command
          ? `stdio (${server.command})`
          : "unknown";
      console.log(`  ${server.name}: ${transport} [${enabled}]`);
    }
  }

  console.log();
  console.log("Connectivity:");
  if (connectivity.reachable) {
    console.log(`  ${resolved.baseUrl} - reachable`);
  } else {
    console.log(`  ${resolved.baseUrl} - unreachable: ${connectivity.error}`);
  }
  return 0;
}

function printInfoJson(
  resolved,
  modelRegistry,
  providers,
  skillsLoader,
  connectivity,
  config,
) {
  const json = {
    config: {
      ai_url: resolved.baseUrl,
      default_model: resolved.model,
      chat_timeout_secs: resolved.chatTimeout,
      skills_path: config?.skillsPath || DEFAULT_SKILLS_PATH,
      profile: resolved.profileName,
      profile_whitelist: resolved.profile?.whitelistTools || null,
      profile_blacklist: resolved.profile?.blacklistTools || [],
    },
    providers: {
      configured: providers.map((p) => ({
        name: p.name,
        url: p.url,
        models: (p.models || []).map((m) => m.name),
      })),
      active: resolved.activeProvider || null,
    },
    models: Object.keys(modelRegistry).map((name) => {
      const m = modelRegistry[name];
      return { name, tags: m.tags || [] };
    }),
    skills_loaded: skillsLoader.activeSkills(),
    mcp_servers: (config?.mcpServers || []).map((s) => ({
      name: s.name,
      enabled: s.enabled !== false,
      url: s.url || null,
      command: s.command || null,
    })),
    connectivity: {
      url: resolved.baseUrl,
      reachable: connectivity.reachable,
      error: connectivity.error || null,
    },
  };
  console.log(JSON.stringify(json, null, 2));
  return 0;
}

/**
 * Trace config resolution for a single key, showing which layer provided the value.
 * Uses resolveKey() from the schema-loader for the core resolution logic, then
 * walks layers separately to build the trace display.
 */
function traceConfigResolution(keyName, schema, context) {
  const { layers } = schema;
  const result = {
    key: keyName,
    type: schema.type || "unknown",
    layers: [],
    resolvedValue: undefined,
    resolvedFrom: null,
  };

  // Use the real resolver to get the final value
  result.resolvedValue = resolveKey(keyName, schema, context);

  // Walk layers to build trace display info (separate from resolution logic)
  for (const layer of layers) {
    const layerInfo = { ...layer, matched: false, value: undefined };

    if ("default" in layer) {
      const defaultValue = resolveLayerValue(layer, context);
      layerInfo.matched = true;
      layerInfo.value = defaultValue;
      result.resolvedFrom = "default";
      result.layers.push(layerInfo);
      break;
    }

    const value = resolveLayerValue(layer, context);
    layerInfo.value = value;

    if (value !== undefined && value !== null && value !== "") {
      if (layer.cast && typeof layer.cast === "function") {
        const casted = layer.cast(value, context);
        if (casted === undefined) {
          layerInfo.castSkipped = true;
          result.layers.push(layerInfo);
          continue;
        }
        layerInfo.matched = true;
        layerInfo.castedValue = casted;
        result.resolvedFrom = `${layer.source}${layer.key ? ` (${layer.key})` : layer.path ? ` (${layer.path})` : ""}`;
        result.layers.push(layerInfo);
        break;
      }
      layerInfo.matched = true;
      result.resolvedFrom = `${layer.source}${layer.key ? ` (${layer.key})` : layer.path ? ` (${layer.path})` : ""}`;
      result.layers.push(layerInfo);
      break;
    }

    result.layers.push(layerInfo);
  }

  return result;
}

/**
 * Print config resolution debug output.
 * Shows each config key, its resolved value, and which source (layer) provided it.
 */
async function printConfigDebug(cli, config, providers, resolved) {
  const profileName = cli.profile || config.profile || "default";
  const configDir = resolved.configDir || resolveConfigDir(cli.configDir);
  const profilesPath =
    config.profilesPath || path.join(configDir, DEFAULT_PROFILES_SUBPATH);
  const profileFiles = await loadProfileFiles(profilesPath);
  const configProfile = config.profiles?.[profileName] ?? null;
  const fileProfile = profileFiles[profileName] ?? null;

  // Provider resolution
  const providerName = cli.provider || config.defaultProvider;
  const provider = providerName
    ? (providers.find((p) => p.name === providerName) ?? null)
    : null;

  // Profile merge
  let profile;
  if (configProfile || fileProfile) {
    profile = { ...configProfile };
    if (fileProfile) {
      if (fileProfile.role) profile.role = fileProfile.role;
      if (fileProfile.whitelistTools != null)
        profile.whitelistTools = fileProfile.whitelistTools;
      if (fileProfile.blacklistTools?.length)
        profile.blacklistTools = fileProfile.blacklistTools;
      if (fileProfile.manager) profile.manager = true;
    }
  } else {
    profile = {
      whitelistTools: null,
      blacklistTools: [],
      skills: [],
      role: null,
      model: null,
      manager: false,
      cwdBoundary: null,
    };
  }

  const context = {
    cli,
    config,
    provider,
    profile,
    profileName,
    profilesPath,
  };

  console.log("=== Config Resolution Debug ===");
  console.log();
  console.log(`Profile: ${profileName}`);
  console.log(`Provider: ${provider?.name || "(none)"}`);
  console.log(`CLI config path: ${cli.config || "(none)"}`);
  console.log(
    `Config file: ${cli.config || (config.profilesPath ? path.join(config.profilesPath, "..", "defaults.json") : "(defaults only)")}`,
  );
  console.log();

  // Print each config key with resolution details
  for (const [keyName, keySchema] of Object.entries(CONFIG_KEYS)) {
    const trace = traceConfigResolution(keyName, keySchema, context);
    const valueStr =
      trace.resolvedValue === undefined
        ? "(undefined)"
        : typeof trace.resolvedValue === "object"
          ? JSON.stringify(trace.resolvedValue)
          : String(trace.resolvedValue);

    console.log(`  ${keyName.padEnd(25)} → ${valueStr}`);
    console.log(`    Source: ${trace.resolvedFrom || "(none)"}`);
    console.log(`    Type: ${trace.type}`);

    // Show layer details
    for (const layer of trace.layers) {
      const status = layer.matched ? "✓" : layer.castSkipped ? "✗ (cast)" : "·";
      const layerDesc =
        layer.source === "default"
          ? `default: ${JSON.stringify(layer.default)}`
          : `${layer.source}${layer.key ? ` [${layer.key}]` : layer.path ? ` [${layer.path}]` : ""}`;
      console.log(
        `      ${status} ${layerDesc}${layer.value !== undefined ? ` → ${JSON.stringify(layer.value)}` : ""}`,
      );
    }
    console.log();
  }

  // Non-declarative values (model, profile, etc.)
  console.log("=== Non-Declarative Values ===");
  console.log();
  console.log(`  ${"model".padEnd(25)} → ${resolved.model}`);
  console.log(`  ${"profileName".padEnd(25)} → ${resolved.profileName}`);
  console.log(
    `  ${"activeProvider".padEnd(25)} → ${resolved.activeProvider || "(none)"}`,
  );
  console.log(
    `  ${"profile.whitelistTools".padEnd(25)} → ${resolved.profile?.whitelistTools ? JSON.stringify(resolved.profile.whitelistTools) : "(none)"}`,
  );
  console.log(
    `  ${"profile.blacklistTools".padEnd(25)} → ${JSON.stringify(resolved.profile?.blacklistTools || [])}`,
  );
  console.log(
    `  ${"profile.manager".padEnd(25)} → ${resolved.profile?.manager || false}`,
  );
  console.log(`  ${"profile.role".padEnd(25)} → ${resolved.profile?.role}`);
  console.log(
    `  ${"profile.body".padEnd(25)} → ${resolved.profileBody ? `(${resolved.profileBody.length} chars)` : "(none)"}`,
  );
  console.log();

  // Config file sources
  console.log("=== Config File Sources ===");
  console.log();
  const resolvedConfigDir =
    resolved.configDir || resolveConfigDir(cli.configDir);
  const resolvedConfig = path.join(resolvedConfigDir, DEFAULT_CONFIG_FILENAME);

  const resolvedExists = await checkFileExists(resolvedConfig);

  console.log(`  Config dir: ${resolvedConfigDir}`);
  console.log(
    `  Config file (${resolvedConfig}): ${resolvedExists ? "EXISTS" : "not found"}`,
  );
  if (resolvedExists) {
    try {
      const content = await fs.readFile(resolvedConfig, "utf-8");
      console.log(
        `    Content: ${content.trim().slice(0, 200)}${content.trim().length > 200 ? "..." : ""}`,
      );
    } catch {
      /* ignore */
    }
  }
  console.log();

  // Extension config
  console.log("=== Extension Config ===");
  console.log();
  const extConfigs = Object.entries(config).filter(
    ([k]) =>
      ![
        "providers",
        "defaultProvider",
        "aiUrl",
        "defaultModel",
        "temperature",
        "thinker",
        "toolfmt",
        "toolOutputFmt",
        "role",
        "hideTools",
        "hideThinking",
        "skillsPath",
        "profilesPath",
        "systemPromptTemplate",
        "chatTimeoutSecs",
        "embeddingsTimeoutSecs",
        "extensionPaths",
        "extensionAutoload",
        "extensions",
        "profile",
        "profiles",
        "theme",
        "colors",
        "apiKey",
        "noLog",
        "compactDebug",
        "mcpServers",
        "showTokenUse",
      ].includes(k),
  );
  if (extConfigs.length > 0) {
    for (const [extKey, extVal] of extConfigs) {
      console.log(
        `  ${extKey.padEnd(25)} → ${typeof extVal === "object" ? JSON.stringify(extVal) : String(extVal)}`,
      );
    }
  } else {
    console.log("  (no extension-specific config)");
  }
  console.log();

  return 0;
}

/**
 * Check if a file exists.
 */
async function checkFileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the show-prompt subcommand.
 * Creates an agent, outputs the generated system prompt and tool definitions.
 */
async function runShowPrompt(cli, core, config, buildConfig) {
  const { resolved } = await buildConfig(cli);
  const agent = new Agent({
    hooks: core.hooks,
    toolRegistry: core.toolRegistry,
    llmClient: null, // Not needed — we only want the system prompt
    model: resolved.model || "",
    maxIterations: resolved.maxIterations,
    maxTokens: resolved.maxTokens,
    profileName: resolved.profileName || "default",
    role: resolved.role || "",
    profileBody: resolved.profileBody || "",
    config,
  });
  // Build the system prompt via the real hook mechanism
  await agent.ensureSystemPrompt();
  // Output the actual system prompt
  console.log(agent.systemPrompt);

  // Output tool definitions
  const toolDefs = await core.toolRegistry.getToolDefs();
  if (toolDefs.length > 0) {
    console.log();
    console.log("# Tools");
    console.log();
    console.log(
      "Note: actual format of tools prompt may be different than this output depending on provider.",
    );
    console.log();
    for (const def of toolDefs) {
      const name = def.function?.name || "(unknown)";
      const description = def.function?.description || "";
      const params = def.function?.parameters || {};
      console.log(`## ${name}`);
      console.log(description);
      console.log();
      console.log(JSON.stringify(params));
      console.log();
    }
  }
  return 0;
}

// ── Profile List Subcommand ─────────────────────────────────────────────

/**
 * Run the profiles subcommand.
 * Lists all available profiles with their roles, tool restrictions, and metadata.
 */
async function runProfileList(cli, config, buildConfig) {
  const { resolved } = await buildConfig(cli);

  // Resolve config dir: prefer resolved value, fall back to --config-dir,
  // or derive from --config file path. resolveConfigDir() ignores --config,
  // so we handle that here.
  let configDir = resolved.configDir;
  if (!configDir) {
    if (cli.configDir) {
      configDir = path.isAbsolute(cli.configDir)
        ? cli.configDir
        : path.resolve(cli.configDir);
    } else if (cli.config) {
      // Derive config dir from the config file path
      configDir = path.dirname(
        path.isAbsolute(cli.config) ? cli.config : path.resolve(cli.config),
      );
    } else {
      configDir = resolveConfigDir();
    }
  }

  // Resolve profiles path. Prefer the schema-resolved value if absolute
  // (the compute layer joined it to configDir correctly). If relative or
  // missing, fall back to configDir/profiles. We avoid using the raw config
  // profilesPath directly because defaults like "./config/profiles" are
  // uncomputed and CWD-relative, not configDir-relative.
  let profilesPath;
  if (resolved.profilesPath && path.isAbsolute(resolved.profilesPath)) {
    profilesPath = resolved.profilesPath;
  } else {
    profilesPath = path.join(configDir, DEFAULT_PROFILES_SUBPATH);
  }

  // Load all profile files from disk
  const profileFiles = await loadProfileFiles(profilesPath);

  // Get config-defined profiles
  const configProfiles = config.profiles || {};

  // Aspects — from global resolved config (extension-resolved)
  const aspects = resolved.aspects || [];

  // Collect all profile names from both sources
  const allNames = new Set([
    ...Object.keys(configProfiles),
    ...Object.keys(profileFiles),
  ]);

  // Visible worker names (available as subagents)
  const visibleWorkerNames = Object.entries(profileFiles)
    .filter(([, p]) => p.visibleWorker)
    .map(([name]) => name);

  if (cli.wantsJson) {
    return printProfileListJson(
      profileFiles,
      configProfiles,
      allNames,
      aspects,
      resolved.profileName,
      profilesPath,
      visibleWorkerNames,
    );
  }

  return printProfileListText(
    profileFiles,
    configProfiles,
    allNames,
    resolved.profileName,
    aspects,
    profilesPath,
    visibleWorkerNames,
    configDir,
  );
}

/**
 * Print profile list as formatted text.
 */
function printProfileListText(
  profileFiles,
  configProfiles,
  allNames,
  currentProfile,
  globalAspects,
  profilesPath,
  visibleWorkerNames,
  configDir,
) {
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
    const configProfile = configProfiles[name] || null;
    const isCurrent = name === currentProfile;
    const marker = isCurrent ? "  ← current" : "";

    console.log(`Profile: ${name}${marker}`);

    // Description
    const description =
      fileProfile?.description || configProfile?.description || null;
    if (description) {
      console.log(`  Description: ${description}`);
    }

    // Role
    const role = fileProfile?.role || configProfile?.role || null;
    if (role) {
      // Truncate long roles for display
      const roleDisplay = role.length > 200 ? `${role.slice(0, 200)}...` : role;
      console.log(`  Role: ${roleDisplay}`);
    }

    // Model override
    const model = configProfile?.model || fileProfile?.model || null;
    if (model) {
      console.log(`  Model: ${model}`);
    }

    // Aspects — from global resolved config (extension-resolved)
    if (globalAspects && globalAspects.length > 0) {
      console.log(`  Aspects: ${globalAspects.join(", ")}`);
    }

    // Tool restrictions — file profile values take priority, but only if non-empty
    const fileBlacklist = fileProfile?.blacklistTools || [];
    const cfgBlacklist =
      configProfile?.blacklist_tools || configProfile?.blacklistTools || [];
    const blacklistTools =
      fileBlacklist.length > 0 ? fileBlacklist : cfgBlacklist;

    const fileWhitelist = fileProfile?.whitelistTools;
    const cfgWhitelist =
      configProfile?.whitelist_tools || configProfile?.whitelistTools;
    const whitelistTools =
      fileWhitelist && fileWhitelist.length > 0 ? fileWhitelist : cfgWhitelist;

    if (blacklistTools.length > 0) {
      console.log(`  Blacklisted tools: ${blacklistTools.join(", ")}`);
    }
    if (whitelistTools && whitelistTools.length > 0) {
      console.log(`  Whitelisted tools: ${whitelistTools.join(", ")}`);
    }

    // Manager / subagents
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

    // Body length
    if (fileProfile?.body) {
      const bodyLen = fileProfile.body.trim().length;
      console.log(`  Body: ${bodyLen} chars`);
    }

    // Source + relative path
    const sources = [];
    if (fileProfile) sources.push("file");
    if (configProfile) sources.push("config");
    console.log(`  Source: ${sources.join(" + ")}`);
    if (fileProfile && profilesPath) {
      try {
        const filePath = path.join(profilesPath, `${name}.profile.md`);
        console.log(`  Profile: ${filePath}`);
      } catch {
        // Ignore path resolution errors
      }
    }

    console.log();
  }

  return 0;
}

/**
 * Print profile list as JSON.
 */
function printProfileListJson(
  profileFiles,
  configProfiles,
  allNames,
  globalAspects,
  currentProfile,
  profilesPath,
  visibleWorkerNames,
) {
  const names = Array.from(allNames).sort();
  const profiles = [];

  for (const name of names) {
    const fileProfile = profileFiles[name] || null;
    const configProfile = configProfiles[name] || null;

    // Tool restrictions — file profile values take priority, but only if non-empty
    const fileBlacklist = fileProfile?.blacklistTools || [];
    const cfgBlacklist =
      configProfile?.blacklist_tools || configProfile?.blacklistTools || [];
    const blacklistTools =
      fileBlacklist.length > 0 ? fileBlacklist : cfgBlacklist;

    const fileWhitelist = fileProfile?.whitelistTools;
    const cfgWhitelist =
      configProfile?.whitelist_tools || configProfile?.whitelistTools;
    const whitelistTools =
      fileWhitelist && fileWhitelist.length > 0 ? fileWhitelist : cfgWhitelist;

    // Compute path for file-sourced profiles
    let profileRelPath = null;
    if (fileProfile && profilesPath) {
      try {
        const filePath = path.join(profilesPath, `${name}.profile.md`);
        profileRelPath = filePath;
      } catch {
        // Ignore path resolution errors
      }
    }

    profiles.push({
      name,
      current: name === currentProfile,
      description:
        fileProfile?.description || configProfile?.description || null,
      role: fileProfile?.role || configProfile?.role || null,
      model: configProfile?.model || fileProfile?.model || null,
      aspects: globalAspects && globalAspects.length > 0 ? globalAspects : null,
      blacklistTools: blacklistTools.length > 0 ? blacklistTools : null,
      whitelistTools,
      manager: fileProfile?.manager || false,
      subagent: fileProfile?.visibleWorker || false,
      availableSubagents: fileProfile?.manager
        ? visibleWorkerNames.filter((n) => n !== name)
        : null,
      bodyLength: fileProfile?.body ? fileProfile.body.trim().length : 0,
      sources: [
        fileProfile ? "file" : null,
        configProfile ? "config" : null,
      ].filter(Boolean),
      profileRelPath,
    });
  }

  console.log(JSON.stringify(profiles, null, 2));
  return 0;
}

// ── Extension Entry Point ───────────────────────────────────────────────────

/**
 * Create the info-show-prompt extension.
 * Registers subcommands via the cli:subcommandsRegister hook.
 */
export function create(core) {
  return {
    hooks: core.hooks
      ? {
          [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry) => {
            registry.register("info", {
              description: "Show system info and diagnostics",
              handler: async (cli, core) => {
                const { config, buildConfig } = core;
                return await runInfo(cli, config, buildConfig);
              },
            });

            registry.register("show-prompt", {
              description: "Show rendered system prompt with tool definitions",
              handler: async (cli, core) => {
                const { config, buildConfig } = core;
                return await runShowPrompt(cli, core, config, buildConfig);
              },
            });

            registry.register("profiles", {
              description:
                "List all available profiles with their roles and tool restrictions",
              handler: async (cli, core) => {
                const { config, buildConfig } = core;
                return await runProfileList(cli, config, buildConfig);
              },
            });
          },
        }
      : undefined,
  };
}
