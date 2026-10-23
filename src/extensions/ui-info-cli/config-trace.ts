// `hotdog info --config-debug`: the config-resolution layer trace. Resolves
// via the real resolver, then re-walks the schema layers purely for display.
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG_FILENAME } from "@core/config/defaults.ts";
import type { BuildAgentConfig, CliArgv, DefaultConfig } from "@core/config/index.ts";
import { getDefaultConfig, ProviderDef, resolveConfigDir } from "@core/config/index.ts";
import { ProfileDef } from "@core/config/profiles.ts";
import {
  CONFIG_SCHEMA,
  resolveKey,
  resolveLayerValue,
  type SchemaProperty,
  type SchemaLayer,
} from "@core/config/schema-loader.ts";
import { ensureProfileManager } from "./profiles.ts";

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

export async function printConfigDebug(
  cli: CliArgv,
  config: DefaultConfig,
  providers: ProviderDef[],
  resolved: BuildAgentConfig,
): Promise<number> {
  const profileName = (cli.profile as string) || config.profileName || "default";
  const configDir = resolved.configDir || resolveConfigDir(cli.configDir);
  const profilesPath = resolved.profilesPath || path.join(configDir, "profiles");
  const profileManager = await ensureProfileManager(resolved, config, profilesPath);
  const configProfile: ProfileDef | null = config.profiles?.[profileName] ?? null;
  const fileProfile: ProfileDef | null = profileManager.getFileProfiles()[profileName] ?? null;

  const providerName = (cli.provider as string) || config.defaultProvider;
  const provider = providerName ? (providers.find((p) => p.name === providerName) ?? null) : null;

  // File profile wins on conflict, but only for fields it actually sets.
  const profile: Partial<ProfileDef> = {};
  if (configProfile) {
    Object.assign(profile, configProfile);
  }
  if (fileProfile) {
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
    `Config file: ${cli.config || (config.profilesPath ? path.join(config.profilesPath, "..", "defaults.json") : "(defaults only)")}`,
  );
  console.log();

  for (const [keyName, keySchema] of Object.entries(CONFIG_SCHEMA)) {
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
  console.log(`  ${"model".padEnd(25)} → ${resolved.model || "(none)"}`);
  console.log(`  ${"profileName".padEnd(25)} → ${resolved.profileName}`);
  console.log(`  ${"activeProvider".padEnd(25)} → ${resolved.activeProvider || "(none)"}`);
  console.log(
    `  ${"profile.whitelistTools".padEnd(25)} → ${(resolved.profileDef?.whitelistTools as string[]) ? JSON.stringify(resolved.profileDef!.whitelistTools) : "(none)"}`,
  );
  console.log(
    `  ${"profile.blacklistTools".padEnd(25)} → ${JSON.stringify((resolved.profileDef?.blacklistTools as string[]) || [])}`,
  );
  console.log(`  ${"profile.manager".padEnd(25)} → ${(resolved.profileDef?.manager as boolean) || false}`);
  console.log(
    `  ${"profile.body".padEnd(25)} → ${resolved.profileBody ? `(${(resolved.profileBody as string).length} chars)` : "(none)"}`,
  );
  console.log();

  console.log("=== Config File Sources ===");
  console.log();
  const resolvedConfigPath = path.join(configDir, DEFAULT_CONFIG_FILENAME);

  const resolvedExists = await checkFileExists(resolvedConfigPath);

  console.log(`  Config dir: ${configDir}`);
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
  const coreConfigKeys = new Set([...Object.keys(getDefaultConfig())]);
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
