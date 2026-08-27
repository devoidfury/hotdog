#!/usr/bin/env bun

import { createHooks, initializeLogger, logger, resolveLogLevel, resolveLogTarget } from "./index.ts";
import {
  createToolRegistry,
  createExtensionLoader,
  createServiceRegistry,
  getExtensionsToLoad,
  registerExtensionMetadata,
  validateServiceContracts,
  type LoaderCore,
} from "./extensions/index.ts";
import { HOOKS, type HookSystem, type HookTraceOptions } from "./hooks.ts";
import { createCompletionService } from "./completion.ts";
import type { CoreContext, ExtensionInstance, ToolMetadataPayload } from "./extensions/types.ts";
import type { ToolMetadata } from "./extensions/tool-registry.ts";
import { parseArgs, generateHelpText } from "./cli.ts";
import {
  loadConfig,
  buildConfig,
  buildAgentConfig,
  validateConfig,
  failOnInvalidConfig,
  resolveConfigDir,
  type CliArgv,
} from "./config/index.ts";
import type { ProfileDef } from "./config/profiles.ts";
import type { ResolvedConfig } from "./extensions/types.ts";
import type { ModelConfig, ProviderDef } from "./config/providers.ts";
import { buildModelRegistry } from "./config/providers.ts";
import { castAs } from "../utils/json-schema.ts";
import { getLayerDefault } from "./config/schema-loader.ts";
import {
  cliFlagsFromSchema,
  CONFIG_SCHEMA,
  resolveExtensionConfig,
  type ResolutionContext,
  type CoreConfigWithExtensions,
} from "./config/schema-loader.ts";
import { ConfigRegistry } from "./extensions/config.ts";
import { CliError } from "./error.ts";
import { createSubcommandRegistry, type CliSubcommandRegistry } from "./extensions/registries.ts";
import {
  createToolFormatRegistry,
  toolFormatForName,
  TOOL_FORMAT_DEFAULT_NAME,
} from "./extensions/tool-format.ts";
import { xmlToolFormat } from "./extensions/tool-format-xml.ts";
import { createLlmProtocolRegistry } from "./llm-client/protocol.ts";
import { openaiProtocol } from "./llm-client/openai-protocol.ts";
import { LlmClient, type LlmClientOptions } from "./llm-client/client.ts";
import { MarkerMangler, CORE_PROTECTED_PREFIXES } from "./marker-mangler.ts";

import pkg from "@package.json" with { type: "json" };

async function loadExtensions(
  core: CoreInfrastructure,
  { taskManager, config }: { taskManager: unknown; config: CoreConfigWithExtensions } = {
    taskManager: null,
    config: {} as CoreConfigWithExtensions,
  },
): Promise<ExtensionInstance[]> {
  const loaded: ExtensionInstance[] = [];

  const extensionPaths = (config?.extensionPaths as string[]) || ["@extensions"];
  const extensionAutoload = (config?.extensionAutoload as boolean) ?? false;
  const extensionsList = (config?.extensions as string[]) || [];

  const extensionsToLoad = await getExtensionsToLoad(
    extensionPaths,
    extensionAutoload,
    extensionsList,
    config,
  );

  for (const ext of extensionsToLoad) {
    if (core.extensions.has(ext.name)) continue;
    const extInstance = await core.extensions.load(ext.name, ext.path ?? "", {
      taskManager,
      provides: ext.provides,
      dependsOn: ext.dependsOn,
    });
    if (extInstance) loaded.push(extInstance);
  }

  // Fired once, after all tools are registered, so extensions see the complete set.
  const toolMetadataMap = new Map<string, ToolMetadata | undefined>();
  for (const [name, tool] of core.toolRegistry.getAll()) {
    toolMetadataMap.set(name, tool.metadata);
  }
  core.hooks.notifyHooks(HOOKS.TOOL_METADATA, { tools: toolMetadataMap } as ToolMetadataPayload);

  // Only validate extensions that were actually loaded.
  const loadedExtensions = extensionsToLoad.filter((ext) => core.extensions.has(ext.name));
  const serviceErrors = validateServiceContracts(loadedExtensions, core.services);
  for (const err of serviceErrors) {
    // Missing services crash at runtime, so surface them as errors.
    logger.error(`[services] ${err.message}`);
  }

  return loaded;
}

// The internal core object that powers the extension loader and is passed to extensions as CoreContext.
export interface CoreInfrastructure extends CoreContext {
  buildConfig?: typeof buildConfig;
}

export function createCore(
  config: CoreConfigWithExtensions,
  configRegistry: ConfigRegistry,
  cliSubcommandRegistry: CliSubcommandRegistry,
  options: {
    hooks?: HookSystem;
    profileName?: string;
    profile?: ProfileDef | null;
    buildConfig?: typeof buildConfig;
  } = {},
): CoreInfrastructure {
  const hooks = options.hooks || createHooks();
  const toolRegistry = createToolRegistry();
  const toolFormatRegistry = createToolFormatRegistry();
  toolFormatRegistry.register(xmlToolFormat);
  const llmProtocolRegistry = createLlmProtocolRegistry();
  llmProtocolRegistry.register(openaiProtocol);
  const services = createServiceRegistry();
  const completion = createCompletionService();

  // Must happen before the extension loader is created: extensions read
  // core.config.profileDef during create() (e.g., subagents checks .manager
  // to decide whether to register tools).
  const coreConfig: CoreConfigWithExtensions = {
    ...config,
    profileName: options.profileName || config.profileName || "default",
    profileDef: options.profile || config.profileDef,
  };

  // Extensions is set after construction to break the circular dependency;
  // the loader must receive this same core reference main() uses.
  const core = {
    hooks,
    toolRegistry,
    extensions: null!,
    services,
    completion,
    config: coreConfig,
    cliSubcommandRegistry,
    configRegistry,
    toolFormatRegistry,
    llmProtocolRegistry,
    service: (name: string) => services.get(name),
    buildConfig: options.buildConfig,
    createLlmClient(overrides?: Partial<LlmClientOptions>): LlmClient {
      const resolved = this.resolved;
      // The global ToolFormat default comes from the *resolved* config (CLI >
      // config > schema default) -- the raw file in this.config never carries
      // CLI values. Seed the session mangler with that format's markers
      // (per-model formats/controlTokens still grow the union via
      // ensureManglerCovers on first use).
      const modelToolFormat =
        (resolved?.modelToolFormat as string | undefined) ?? TOOL_FORMAT_DEFAULT_NAME;
      // Unknown names throw LlmError("config") at the request boundary,
      // mirroring unknown protocol/format ids (no silent fallback to xml).
      const defaultToolFormat = toolFormatForName(modelToolFormat, this.toolFormatRegistry);
      return new LlmClient({
        baseUrl: resolved?.baseUrl ?? null,
        apiKey: resolved?.apiKey ?? null,
        stream: resolved ? resolved.stream !== false : true,
        chatTimeoutSecs: resolved?.chatTimeout || 30,
        healthCheckTimeoutSecs: resolved?.healthCheckTimeout || 5,
        // Schema default (core.config.json) as fallback when resolved is
        // unset; ?? so an explicit 0 (no retries) survives.
        maxRetries: resolved?.maxRetries ?? (getLayerDefault(CONFIG_SCHEMA.maxRetries) as number),
        providers: (this.config.providers as ProviderDef[]) || [],
        toolFormat: modelToolFormat,
        toolFormatRegistry: this.toolFormatRegistry,
        llmProtocolRegistry: this.llmProtocolRegistry,
        markerMangler: new MarkerMangler([
          ...CORE_PROTECTED_PREFIXES,
          ...defaultToolFormat.markers,
        ]),
        ...overrides,
      });
    },
  } as CoreInfrastructure;

  core.extensions = createExtensionLoader(core as LoaderCore);

  return core;
}

async function buildFullConfig(
  cli: CliArgv,
  configRegistry: ConfigRegistry,
): Promise<{
  resolved: ResolvedConfig;
  config: CoreConfigWithExtensions;
  modelRegistry: Record<string, ModelConfig>;
  providers: ProviderDef[];
}> {
  const extParams = configRegistry.getConfigParams();

  const configDir = resolveConfigDir(cli.configDir ?? undefined);
  const config = await loadConfig(cli.config ?? undefined, cli.configDir ?? undefined, extParams);

  const resolved = await buildAgentConfig({
    cli,
    config: config as CoreConfigWithExtensions,
    configDir,
    providers: config.providers || [],
    defaultModel: getLayerDefault(CONFIG_SCHEMA.defaultModel) as string,
  });

  const modelRegistry = await buildModelRegistry(
    {
      providers: castAs<ProviderDef[]>(config.providers || []),
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
    },
    128000,
  );
  resolved.modelRegistry = modelRegistry;

  const extContext: ResolutionContext = {
    cli,
    config: config as Record<string, unknown>,
    configDir: resolved.configDir,
    provider: null,
    profile: resolved.profileDef,
    profileName: resolved.profileName,
  };
  const resolvedExtConfig = resolveExtensionConfig(extParams, extContext);
  Object.assign(config as Record<string, unknown>, resolvedExtConfig);

  const extensionSchemas = extParams.filter((p) => p.schema).map((p) => ({ key: p.key, schema: p.schema }));
  const validationResult = validateConfig(config as CoreConfigWithExtensions, extensionSchemas);
  failOnInvalidConfig(validationResult);

  return {
    resolved: resolved as ResolvedConfig,
    config: config as CoreConfigWithExtensions,
    modelRegistry,
    providers: (config.providers || []) as ProviderDef[],
  };
}

export async function main(): Promise<number> {
  // Hooks + logger must exist before any error output can happen.
  const hooks = createHooks();
  const minLevel = resolveLogLevel();
  const logTarget = resolveLogTarget();
  initializeLogger({ hooks, minLevel, target: logTarget });

  const configRegistry = new ConfigRegistry();

  // Core CLI flags come from the schema; these inverses don't map to a single key.
  configRegistry.registerCliFlags(cliFlagsFromSchema(CONFIG_SCHEMA));
  configRegistry.registerCliFlags([
    { long: "--hide-tools", type: "boolean", description: "Hide tool calls" },
    {
      long: "--show-thinking",
      type: "boolean",
      description: "Show thinking output",
    },
    { long: "--no-colors", type: "boolean", description: "Disable colors" },
  ]);

  // Defaults-only config, needed early to read extension.json metadata
  // (CLI flags, subcommands, config params) without loading extension code --
  // this is what makes `--help` and subcommand discovery work pre-parse.
  const minimalConfig = await loadConfig(undefined);

  const cliSubcommandRegistry = createSubcommandRegistry();
  await registerExtensionMetadata(
    minimalConfig as CoreConfigWithExtensions,
    configRegistry,
    cliSubcommandRegistry,
  );

  let cli;
  try {
    cli = parseArgs(configRegistry, cliSubcommandRegistry.names());
  } catch (e: unknown) {
    if (e instanceof CliError && e.message.startsWith("Unknown subcommand:")) {
      const knownSubcommands = cliSubcommandRegistry.names();
      const posLower = e.message.replace("Unknown subcommand: ", "").toLowerCase();
      const similar = knownSubcommands.filter(
        (sc) => sc.toLowerCase() !== posLower && sc.startsWith(posLower.slice(0, 2)),
      );
      if (similar.length === 1) {
        logger.error(`Unknown subcommand: ${posLower}\n` + `Did you mean: ${similar[0]}?`);
      } else {
        logger.error(
          `Unknown subcommand: ${posLower}\n` +
            `Available subcommands: ${knownSubcommands.join(", ")}\n` +
            `To send a prompt, use -p or --prompt: hotdog -p "your prompt"`,
        );
      }
      return 1;
    }
    throw e;
  }

  if (cli.version) {
    console.log(`hotdog ${pkg.version}`);
    return 0;
  }

  if (cli.help) {
    const subcommandHelp = cliSubcommandRegistry.generateHelpText();
    const fullHelp = generateHelpText(configRegistry);
    console.log(fullHelp.replace("<subcommands>", subcommandHelp));
    return 0;
  }

  const { resolved, config, modelRegistry, providers } = await buildFullConfig(
    cli as CliArgv,
    configRegistry,
  );

  if (!resolved.baseUrl) {
    logger.warn(
      "No AI URL configured. Set a URL via --ai-url, aiUrl in config, provider.url, or HOTDOG_AI_URL environment variable. " +
        "LLM calls will fail until a URL is provided.",
    );
  }

  hooks.trace = resolved.hookTrace as boolean | HookTraceOptions;

  const core = createCore(config, configRegistry, cliSubcommandRegistry, {
    hooks,
    profileName: resolved.profileName,
    profile: resolved.profileDef,
    buildConfig,
  });

  core.resolved = resolved as ResolvedConfig;

  await loadExtensions(core, { taskManager: null, config });

  // Metadata already came from extension.json; this hook lets extensions attach handler functions.
  core.hooks.notifyHooks(HOOKS.CLI_SUBCOMMANDS_REGISTER, core.cliSubcommandRegistry);

  core.hooks.notifyHooks(HOOKS.CLI_ARGS_PARSED, { cli });

  if (cli.subcommand) {
    const subcommandDef = core.cliSubcommandRegistry.get(cli.subcommand);
    if (subcommandDef && subcommandDef.handler) {
      return await subcommandDef.handler(cli, core);
    }
    logger.error(`Subcommand "${cli.subcommand}" handler not available after loading extensions.`);
    return 1;
  }

  if (process.stdin.isTTY) {
    const defaultSubcommandName = config.defaultSubcommand || "cli";
    const defaultSubcommand = core.cliSubcommandRegistry.get(defaultSubcommandName);
    if (defaultSubcommand && defaultSubcommand.handler) {
      return await defaultSubcommand.handler(cli, core);
    }
  }

  logger.error("No subcommand provided.");
  console.log(`Available subcommands: ${core.cliSubcommandRegistry.names().join(", ") || "(none)"}`);
  return 1;
}
