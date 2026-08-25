import { HOOKS } from "../../core/hooks.ts";
import { CliSubcommandRegistryLike } from "../../core/extensions/registries.ts";
import { SkillsLoader } from "../skills/loader.ts";
import { DEFAULT_PROFILES_SUBPATH, DEFAULT_CONFIG_FILENAME } from "../../core/config/defaults.ts";
import { CliArgv, loadConfig, ProviderDef, resolveConfigDir } from "../../core/config/index.ts";
import { ProfileDef, ProfileManager } from "../../core/config/profiles.ts";
import {
  CONFIG_SCHEMA as CONFIG_KEYS,
  resolveKey,
  resolveLayerValue,
  SchemaProperty,
  SchemaLayer,
  type ResolutionContext,
} from "../../core/config/schema-loader.ts";
import { Agent, type AgentConfig } from "../../core/agent.ts";
import { CoreContext, ExtensionInstance, ResolvedConfig } from "../../core/extensions/types.ts";
import type { BuildAgentConfig } from "../../core/config/index.ts";
import path from "node:path";
import fs from "node:fs/promises";

interface ConnectivityResult {
  reachable: boolean;
  error: string | null;
}

interface TraceLayer extends SchemaLayer {
  matched?: boolean;
  value?: unknown;
  castSkipped?: boolean;
  castedValue?: unknown;
}

interface TraceResult {
  key: string;
  type: string;
  layers: TraceLayer[];
  resolvedValue: unknown;
  resolvedFrom: string | null;
}

interface TraceContext {
  cli: CliArgv;
  config: Record<string, unknown>;
  provider: ProviderDef | null;
  profile: Partial<ProfileDef>;
  profileName: string;
  profilesPath: string;
  [key: string]: unknown;
}

async function runInfo(cli: CliArgv, core: CoreContext): Promise<number> {
  const buildConfig = core.buildConfig!;
  const { resolved, modelRegistry, providers } = await buildConfig(cli);
  const configDir = resolved.configDir || resolveConfigDir(cli.configDir);
  const rawConfig = await loadConfig(cli.config, configDir);

  if (cli.config_debug) {
    return await printConfigDebug(cli, rawConfig, providers, resolved);
  }

  const client = core.createLlmClient({ stream: false });

  let connectivity: ConnectivityResult;
  try {
    await client.ping(resolved.model);
    connectivity = { reachable: true, error: null };
  } catch (e: unknown) {
    connectivity = { reachable: false, error: (e as Error).message };
  }

  const skillsLoader = new SkillsLoader(
    (cli.skillsPath as string | string[] | undefined) ||
      (typeof rawConfig.skills === "object" && rawConfig.skills !== null
        ? ((rawConfig.skills as Record<string, unknown>).path as string) || "/skills"
        : "/skills"),
  );
  await skillsLoader.loadSkills();

  if (cli.wantsJson) {
    return printInfoJson(resolved, modelRegistry, providers, skillsLoader, connectivity, rawConfig);
  }

  return printInfoText(resolved, modelRegistry, providers, skillsLoader, connectivity, rawConfig);
}

function printInfoText(
  resolved: BuildAgentConfig,
  modelRegistry: Record<string, unknown>,
  providers: ProviderDef[],
  skillsLoader: SkillsLoader,
  connectivity: ConnectivityResult,
  config: Record<string, unknown>,
): number {
  console.log("=== Agent Harness Info ===");
  console.log();
  console.log("Configuration:");
  const configDirAbs = resolved.configDir || resolveConfigDir(undefined);
  console.log(`  Config Dir:      ${configDirAbs}`);
  console.log(`  AI URL:          ${resolved.baseUrl}`);
  console.log(`  Default Model:   ${resolved.model}`);
  console.log(
    `  Skills Path:     ${(config?.skillsPath as string) || (config?.skills as Record<string, unknown>)?.path || "/skills"}`,
  );
  console.log(`  Chat Timeout:    ${resolved.chatTimeout}s`);
  console.log(`  Profile:         ${resolved.profileName}`);
  if (resolved.profileDef?.whitelistTools) {
    console.log(`  Whitelist Tools: ${(resolved.profileDef.whitelistTools as string[]).join(", ")}`);
  }
  if ((resolved.profileDef?.blacklistTools as string[])?.length > 0) {
    console.log(`  Blacklist Tools: ${(resolved.profileDef!.blacklistTools as string[]).join(", ")}`);
  }

  if (providers.length > 0) {
    console.log();
    console.log("Providers:");
    for (const p of providers) {
      const isActive = resolved.activeProvider === p.name;
      const isDefault = (config?.defaultProvider as string) === p.name;
      const marker = isActive ? " (active)" : isDefault ? " (default)" : "";
      const modelNames = (p.models || []).map((m) => m.name).join(", ");
      const displayUrl = p.url || `${resolved.baseUrl} (inherited)`;
      console.log(`  ${p.name}${marker} → ${displayUrl}  [${modelNames}]`);
    }
    if (resolved.activeProvider) {
      console.log();
      console.log(`Active Provider: ${resolved.activeProvider}`);
    }
  }

  console.log();
  console.log(`Models (${Object.keys(modelRegistry).length}):`);
  for (const name of Object.keys(modelRegistry)) {
    const m = modelRegistry[name] as Record<string, unknown>;
    const tagStr = ((m.tags as string[]) || []).length > 0 ? (m.tags as string[]).join(", ") : "no tags";
    console.log(`  ${name} [${tagStr}]`);
  }
  console.log();
  console.log(`Skills: ${skillsLoader.activeSkills().length} loaded`);

  const mcpServers =
    (config?.mcpServers as Array<{
      name: string;
      enabled?: boolean;
      url?: string;
      command?: string;
    }>) || [];
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
  resolved: BuildAgentConfig,
  modelRegistry: Record<string, unknown>,
  providers: ProviderDef[],
  skillsLoader: SkillsLoader,
  connectivity: ConnectivityResult,
  config: Record<string, unknown>,
): number {
  const json = {
    config: {
      ai_url: resolved.baseUrl,
      default_model: resolved.model,
      chat_timeout_secs: resolved.chatTimeout,
      skills_path:
        (config?.skillsPath as string) || (config?.skills as Record<string, unknown>)?.path || "/skills",
      profile: resolved.profileName,
      profile_whitelist: (resolved.profileDef?.whitelistTools as string[]) || null,
      profile_blacklist: (resolved.profileDef?.blacklistTools as string[]) || [],
    },
    providers: {
      configured: providers.map((p) => ({
        name: p.name,
        url: p.url || null,
        resolvedUrl: p.url || resolved.baseUrl,
        models: (p.models || []).map((m: { name: string }) => m.name),
      })),
      active: resolved.activeProvider || null,
    },
    models: Object.keys(modelRegistry).map((name) => {
      const m = modelRegistry[name] as Record<string, unknown>;
      return { name, tags: (m.tags as string[]) || [] };
    }),
    skills_loaded: skillsLoader.activeSkills(),
    mcp_servers: (
      (config?.mcpServers as Array<{
        name: string;
        enabled?: boolean;
        url?: string;
        command?: string;
      }>) || []
    ).map((s) => ({
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

// Resolves via the real resolver, then re-walks layers only for the trace display.
function traceConfigResolution(keyName: string, schema: SchemaProperty, context: TraceContext): TraceResult {
  const layers = schema.layers as SchemaLayer[] | undefined;
  const result: TraceResult = {
    key: keyName,
    type: schema.type || "unknown",
    layers: [],
    resolvedValue: undefined,
    resolvedFrom: null,
  };

  result.resolvedValue = resolveKey(keyName, schema, context);

  for (const layer of layers || []) {
    const layerInfo: TraceLayer = {
      ...layer,
      matched: false,
      value: undefined,
    };

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

async function printConfigDebug(
  cli: CliArgv,
  config: Record<string, unknown>,
  providers: ProviderDef[],
  resolved: BuildAgentConfig,
): Promise<number> {
  const profileName = (cli.profile as string) || (config.profileName as string) || "default";
  const configDir = resolved.configDir || resolveConfigDir(cli.configDir);
  const profilesPath = (resolved.profilesPath as string) || path.join(configDir, "profiles");
  let profileManager = resolved.profileManager;
  // Fallback for tests/backward compat
  if (!profileManager) {
    profileManager = await ProfileManager.create(
      profilesPath,
      (config.profiles as Record<string, ProfileDef>) || {},
    );
  }
  const configProfile: ProfileDef | null =
    (config.profiles as Record<string, ProfileDef> | undefined)?.[profileName] ?? null;
  const fileProfile: ProfileDef | null = profileManager.getFileProfiles()[profileName] ?? null;

  const providerName = (cli.provider as string) || (config.defaultProvider as string);
  const provider = providerName ? (providers.find((p) => p.name === providerName) ?? null) : null;

  // File profile wins on conflict, but only for fields it actually sets.
  const profile: Partial<ProfileDef> = {};
  if (configProfile) {
    Object.assign(profile, configProfile);
  }
  if (fileProfile) {
    if (fileProfile.role) profile.role = fileProfile.role;
    if (fileProfile.whitelistTools != null) profile.whitelistTools = fileProfile.whitelistTools;
    if (fileProfile.blacklistTools?.length) profile.blacklistTools = fileProfile.blacklistTools;
    if (fileProfile.manager) profile.manager = true;
  }

  const context: TraceContext = {
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
    `Config file: ${cli.config || ((config.profilesPath as string) ? path.join(config.profilesPath as string, "..", "defaults.json") : "(defaults only)")}`,
  );
  console.log();

  for (const [keyName, keySchema] of Object.entries(CONFIG_KEYS)) {
    const trace = traceConfigResolution(keyName, keySchema as SchemaProperty, context);
    const valueStr =
      trace.resolvedValue === undefined
        ? "(undefined)"
        : typeof trace.resolvedValue === "object"
          ? JSON.stringify(trace.resolvedValue)
          : String(trace.resolvedValue);

    console.log(`  ${keyName.padEnd(25)} → ${valueStr}`);
    console.log(`    Source: ${trace.resolvedFrom || "(none)"}`);
    console.log(`    Type: ${trace.type}`);

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

  console.log("=== Non-Declarative Values ===");
  console.log();
  console.log(`  ${"model".padEnd(25)} → ${resolved.model}`);
  console.log(`  ${"profileName".padEnd(25)} → ${resolved.profileName}`);
  console.log(`  ${"activeProvider".padEnd(25)} → ${resolved.activeProvider || "(none)"}`);
  console.log(
    `  ${"profile.whitelistTools".padEnd(25)} → ${(resolved.profileDef?.whitelistTools as string[]) ? JSON.stringify(resolved.profileDef!.whitelistTools) : "(none)"}`,
  );
  console.log(
    `  ${"profile.blacklistTools".padEnd(25)} → ${JSON.stringify((resolved.profileDef?.blacklistTools as string[]) || [])}`,
  );
  console.log(`  ${"profile.manager".padEnd(25)} → ${(resolved.profileDef?.manager as boolean) || false}`);
  console.log(`  ${"profile.role".padEnd(25)} → ${resolved.profileDef?.role}`);
  console.log(
    `  ${"profile.body".padEnd(25)} → ${resolved.profileBody ? `(${(resolved.profileBody as string).length} chars)` : "(none)"}`,
  );
  console.log();

  console.log("=== Config File Sources ===");
  console.log();
  const resolvedConfigDir = resolved.configDir || resolveConfigDir(cli.configDir);
  const resolvedConfigPath = path.join(resolvedConfigDir, DEFAULT_CONFIG_FILENAME);

  const resolvedExists = await checkFileExists(resolvedConfigPath);

  console.log(`  Config dir: ${resolvedConfigDir}`);
  console.log(`  Config file (${resolvedConfigPath}): ${resolvedExists ? "EXISTS" : "not found"}`);
  if (resolvedExists) {
    try {
      const content = await fs.readFile(resolvedConfigPath, "utf-8");
      console.log(`    Content: ${content.trim().slice(0, 200)}${content.trim().length > 200 ? "..." : ""}`);
    } catch {
      /* ignore */
    }
  }
  console.log();

  console.log("=== Extension Config ===");
  console.log();
  const coreConfigKeys = new Set([
    "providers",
    "defaultProvider",
    "aiUrl",
    "defaultModel",
    "temperature",
    "thinker",
    "toolfmt", // legacy spelling of toolCallDisplayFormat
    "toolCallDisplayFormat",
    "toolOutputFmt",
    "role",
    "hideTools",
    "hideThinking",
    "skillsPath",
    "profilesPath",
    "systemPromptTemplate",
    "chatTimeoutSecs",
    "embeddingsTimeoutSecs",
    "healthCheckTimeoutSecs",
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
  ]);
  const extConfigs = Object.entries(config).filter(([k]) => !coreConfigKeys.has(k));
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

async function checkFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Builds a throwaway agent so we can render the real system prompt + tool defs.
async function runShowPrompt(cli: CliArgv, core: CoreContext): Promise<number> {
  const { buildConfig } = core;
  const { resolved } = await buildConfig!(cli);
  const agent = new Agent({
    hooks: core.hooks,
    toolRegistry: core.toolRegistry,
    // Throwaway for prompt rendering; empty url/key so it can never send a request.
    llmClient: core.createLlmClient({ baseUrl: "", apiKey: "" }),
    model: resolved.model || "",
    maxIterations: (resolved.maxIterations as number) || 100,
    contextLimit: 128000,
    profileName: resolved.profileName || "default",
    role: resolved.role as string | undefined,
    profileBody: resolved.profileBody as string | undefined,
    config: resolved as AgentConfig,
  });
  await agent.ensureSystemPrompt();
  console.log(agent.context.getSystemPrompt());

  const toolDefs = await agent.getToolDefs();
  if (toolDefs.length > 0) {
    console.log();
    console.log("# Tools");
    console.log();
    console.log(
      "Note: actual format of tools prompt may be different than this output depending on provider.",
    );
    console.log();
    for (const def of toolDefs) {
      const name = (def.function as { name?: string })?.name || "(unknown)";
      const description = (def.function as { description?: string })?.description || "";
      const params = (def.function as { parameters?: Record<string, unknown> })?.parameters || {};
      console.log(`## ${name}`);
      console.log(description);
      console.log();
      console.log(JSON.stringify(params));
      console.log();
    }
  }
  return 0;
}

async function runProfileList(cli: CliArgv, core: CoreContext): Promise<number> {
  const { config, buildConfig } = core;
  const { resolved } = await buildConfig!(cli);

  // resolveConfigDir() ignores --config, so derive the dir from it here.
  let configDir = resolved.configDir;
  if (!configDir) {
    if (cli.configDir) {
      configDir = path.isAbsolute(cli.configDir) ? cli.configDir : path.resolve(cli.configDir);
    } else if (cli.config) {
      configDir = path.dirname(path.isAbsolute(cli.config) ? cli.config : path.resolve(cli.config));
    } else {
      configDir = resolveConfigDir();
    }
  }

  const profilesPath = resolved.profilesPath as string;
  if (!profilesPath) {
    console.error("Error: profilesPath not resolved");
    return 1;
  }
  let profileManager = resolved.profileManager;
  // Fallback: create ProfileManager if not available (for tests/backward compat)
  if (!profileManager) {
    profileManager = await ProfileManager.create(
      profilesPath,
      (config.profiles as Record<string, ProfileDef>) || {},
    );
  }

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
    configDir,
  );
}

function printProfileListText(
  profileFiles: Record<string, ProfileDef>,
  configProfiles: Record<string, Partial<ProfileDef>>,
  allNames: Set<string>,
  currentProfile: string,
  profilesPath: string,
  visibleWorkerNames: string[],
  configDir: string,
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
    const configProfile = configProfiles[name] || null;
    const isCurrent = name === currentProfile;
    const marker = isCurrent ? "  ← current" : "";

    console.log(`Profile: ${name}${marker}`);

    const description = fileProfile?.description || configProfile?.description || null;
    if (description) {
      console.log(`  Description: ${description}`);
    }

    const role = fileProfile?.role || configProfile?.role || null;
    if (role) {
      const roleDisplay = role.length > 200 ? `${role.slice(0, 200)}...` : role;
      console.log(`  Role: ${roleDisplay}`);
    }

    const model = configProfile?.model || fileProfile?.model || null;
    if (model) {
      console.log(`  Model: ${model}`);
    }

    const profileAspects = fileProfile?.aspects || configProfile?.aspects || [];
    if (profileAspects.length > 0) {
      console.log(`  Aspects: ${profileAspects.join(", ")}`);
    }

    // File profile wins, but only for non-empty values.
    const fileBlacklist = fileProfile?.blacklistTools || [];
    const cfgBlacklist = (configProfile?.blacklist_tools as string[]) || configProfile?.blacklistTools || [];
    const blacklistTools = fileBlacklist.length > 0 ? fileBlacklist : cfgBlacklist;

    const fileWhitelist = fileProfile?.whitelistTools;
    const cfgWhitelist = (configProfile?.whitelist_tools as string[]) || configProfile?.whitelistTools;
    const whitelistTools = fileWhitelist && fileWhitelist.length > 0 ? fileWhitelist : cfgWhitelist;

    if (blacklistTools.length > 0) {
      console.log(`  Blacklisted tools: ${blacklistTools.join(", ")}`);
    }
    if (whitelistTools && whitelistTools.length > 0) {
      console.log(`  Whitelisted tools: ${whitelistTools.join(", ")}`);
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
      const bodyLen = fileProfile.body.trim().length;
      console.log(`  Body: ${bodyLen} chars`);
    }

    const sources: string[] = [];
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
    const configProfile = configProfiles[name] || null;

    // File profile wins, but only for non-empty values.
    const fileBlacklist = fileProfile?.blacklistTools || [];
    const cfgBlacklist = (configProfile?.blacklist_tools as string[]) || configProfile?.blacklistTools || [];
    const blacklistTools = fileBlacklist.length > 0 ? fileBlacklist : cfgBlacklist;

    const fileWhitelist = fileProfile?.whitelistTools;
    const cfgWhitelist = (configProfile?.whitelist_tools as string[]) || configProfile?.whitelistTools;
    const whitelistTools = fileWhitelist && fileWhitelist.length > 0 ? fileWhitelist : cfgWhitelist;

    const profileAspects = fileProfile?.aspects || configProfile?.aspects || [];

    let profileRelPath: string | null = null;
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
      description: fileProfile?.description || configProfile?.description || null,
      role: fileProfile?.role || configProfile?.role || null,
      model: configProfile?.model || fileProfile?.model || null,
      aspects: profileAspects.length > 0 ? profileAspects : null,
      blacklistTools: blacklistTools.length > 0 ? blacklistTools : null,
      whitelistTools,
      manager: fileProfile?.manager || false,
      subagent: fileProfile?.visibleWorker || false,
      availableSubagents: fileProfile?.manager ? visibleWorkerNames.filter((n) => n !== name) : null,
      bodyLength: fileProfile?.body ? fileProfile.body.trim().length : 0,
      sources: [fileProfile ? "file" : null, configProfile ? "config" : null].filter(Boolean),
      profileRelPath,
    });
  }

  console.log(JSON.stringify(profiles, null, 2));
  return 0;
}

export function create(core: CoreContext): ExtensionInstance {
  return {
    hooks: {
      [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry: CliSubcommandRegistryLike) => {
        registry.register("info", {
          description: "Show system info and diagnostics",
          handler: async (cli: CliArgv, core: CoreContext) => {
            return await runInfo(cli, core);
          },
        });

        registry.register("show-prompt", {
          description: "Show rendered system prompt with tool definitions",
          handler: runShowPrompt,
        });

        registry.register("profiles", {
          description: "List all available profiles with their roles and tool restrictions",
          handler: async (cli: CliArgv, core: CoreContext) => {
            return await runProfileList(cli, core);
          },
        });
      },
    },
  };
}
