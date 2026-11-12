/**
 * reresolve.ts -- the re-resolve pipeline (design §2.1, batch B4).
 *
 * The cheap half of what boot does (`buildConfig`, config/index.ts), run after
 * a validated config-file write to produce the NEXT ConfigGeneration:
 *   loadConfig -> buildAgentConfig -> (modelRegistry CARRIED FORWARD) ->
 *   extension-block resolve/merge/validate.
 *
 * Never calls `core.buildConfig` / `buildConfig` (main.ts's buildConfigOnce
 * memo would hand back the BOOT result, and a fresh buildConfig would run the
 * network half) and never calls `buildModelRegistry` -- NO network on the
 * write path; provider-catalog work belongs to the health sweep / its apply
 * hook (§3.3). The full pipeline (not an "affected subtree" diff) is deliberate:
 * `resolveAll` is a pure loop over CONFIG_SCHEMA, the fs touches are ms-scale,
 * and scoping the resolve to one subtree would fork the resolution semantics
 * into a second code path (design §2.1).
 *
 * May THROW (ConfigError on an unset `$VAR` in the file, schema validation
 * failure, a profile/template read that fails) -- callers MUST implement the
 * §2.3 last-good posture: keep the file write, keep the store's previous
 * generation, say so plainly in the reply. No retry machinery: the next
 * successful write re-runs the pipeline against the whole file.
 */
import type { ConfigGeneration } from "./store.ts";
import type { CoreConfigWithExtensions } from "./schema-loader.ts";
import { resolveConfigDir } from "./defaults.ts";
import {
  loadConfig,
  buildAgentConfig,
  resolveExtensionConfig,
  validateConfig,
  failOnInvalidConfig,
  getLayerDefault,
  CONFIG_SCHEMA,
  type CliArgv,
} from "./index.ts";
import type { ConfigRegistry } from "../extensions/config.ts";
import type { ResolutionContext } from "./schema-loader.ts";
import type { ResolvedConfig } from "../extensions/types.ts";
import type { ProviderDef } from "./providers.ts";

export interface CandidateGeneration {
  config: CoreConfigWithExtensions;
  resolved: ResolvedConfig;
}

/**
 * Re-run the cheap half against the live file. `cliArgv` is the live parsed
 * argv (the cli layer stays honest: boot's flags keep applying, and the write
 * transaction pins `config` to the exact file the write chain verified).
 *
 * configDir threading (the sketch's noted gap, design §2.1 NOTE): the REAL
 * buildAgentConfig signature REQUIRES `configDir` (config/index.ts:341-347,
 * `configDir: string`). This threads the RESOLVED config dir the boot
 * pipeline used -- `previous.resolved.configDir` (BuildAgentConfigExtra),
 * which is what boot passed through -- falling back to the standard
 * resolveConfigDir chain only for a hand-built previous bag that never
 * recorded one.
 *
 * `previous.resolved` must exist (the `!` on modelRegistry): re-resolve only
 * runs post-boot-adopt inside the write transaction (§2.4), so the previous
 * generation always carries a resolved bag.
 */
export async function reresolveConfig(
  cliArgv: CliArgv,
  configRegistry: ConfigRegistry,
  previous: ConfigGeneration,
): Promise<CandidateGeneration> {
  const extParams = configRegistry.getConfigParams();

  // 1. loadConfig: a fresh read of the in-use file -- $VAR interpolation
  //    (CAN THROW on an unset var, interpolateEnvVars), normalize, deepMerge
  //    over schema + extension defaults.
  const config = await loadConfig(
    cliArgv.config ?? undefined,
    cliArgv.configDir ?? undefined,
    extParams,
  );

  // 2. buildAgentConfig: the resolveAll layer machine over the fresh file.
  //    fs-only: ProfileManager.create (profiles dir scan),
  //    initSystemPromptTemplate (template file read), expandWorkspacePaths
  //    (existence checks). resolveAll/resolveKey are pure over (schema, ctx)
  //    -- no memo anywhere, so there is no staleness to defeat here.
  const configDir =
    previous.resolved?.configDir ?? resolveConfigDir(cliArgv.configDir ?? undefined);
  const resolved = await buildAgentConfig({
    cli: cliArgv,
    config: config as CoreConfigWithExtensions,
    configDir,
    providers: ((config as CoreConfigWithExtensions).providers as ProviderDef[] | undefined) ?? [],
    defaultModel: getLayerDefault(CONFIG_SCHEMA.defaultModel) as string | null,
  });

  // 3. Mutable identity #1 (§1.5): CARRY FORWARD the live model-registry
  //    object. The provider-health catalog piggyback upserts into it by
  //    design ("UPSERT ONLY, never remove"), so the sweep's live updates
  //    survive publishes; re-resolve never builds a new one (that is the
  //    network half).
  resolved.modelRegistry = previous.resolved!.modelRegistry;

  // 4. The exact boot tail (config/index.ts:321-335): extension-block
  //    resolveExtensionConfig + Object.assign + validateConfig. Runs whenever
  //    a registry is present (boot runs it for an empty param list too --
  //    validateConfig covers the CORE schema keys on its own, so a corrupted
  //    file fails here and lands in the §2.3 last-good posture).
  const extContext: ResolutionContext = {
    cli: cliArgv,
    config: config as Record<string, unknown>,
    configDir: resolved.configDir,
    provider: null,
    profile: resolved.profileDef,
    profileName: resolved.profileName,
  };
  const resolvedExtConfig = resolveExtensionConfig(extParams, extContext);
  Object.assign(config as Record<string, unknown>, resolvedExtConfig);
  const extensionSchemas = extParams
    .filter((p) => p.schema)
    .map((p) => ({ key: p.key, schema: p.schema }));
  failOnInvalidConfig(validateConfig(config as CoreConfigWithExtensions, extensionSchemas));

  return {
    config: config as CoreConfigWithExtensions,
    resolved: resolved as unknown as ResolvedConfig,
  };
}
