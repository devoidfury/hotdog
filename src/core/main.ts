#!/usr/bin/env bun

import { initializeLogger, logger, resolveLogLevel, resolveLogTarget } from "@utils/logger.ts";
import { suggestCandidates } from "@utils/strings.ts";
import { createToolRegistry } from "./extensions/tool-registry.ts";
import {
  createExtensionLoader,
  getExtensionsToLoad,
  registerExtensionMetadata,
  validateServiceContracts,
  type LoaderCore,
} from "./extensions/extensions.ts";
import { createServiceRegistry } from "./extensions/service-registry.ts";
import { createHooks, HOOKS, type HookSystem, type HookTraceOptions } from "./hooks.ts";
import { createCompletionService } from "./completion.ts";
import type { CoreContext, ExtensionInstance, ToolMetadataPayload } from "./extensions/types.ts";
import type { ToolMetadata } from "./extensions/tool-registry.ts";
import { parseArgs, generateHelpText } from "./cli.ts";
import { loadConfig, buildConfig, getDefaultConfig, type CliArgv } from "./config/index.ts";
import { runRescue } from "./config/rescue.ts";
import type { ProfileDef } from "./config/profiles.ts";
import type { ResolvedConfig } from "./extensions/types.ts";
import type { ProviderDef } from "./config/providers.ts";
import { getLayerDefault } from "./config/schema-loader.ts";
import { cliFlagsFromSchema, CONFIG_SCHEMA, type CoreConfigWithExtensions } from "./config/schema-loader.ts";
import { ConfigRegistry } from "./extensions/config.ts";
import { CliError, formatError } from "./error.ts";
import { createSubcommandRegistry, type CliSubcommandRegistry } from "./extensions/registries.ts";
import {
  createWireFormatRegistry,
} from "./extensions/wire-format.ts";
import { createRoleMappingRegistry } from "./extensions/role-mapping.ts";
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
  const extensionAutoload = (config?.extensionAutoload as boolean) ?? true;
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
  await core.hooks.notifyHooks(HOOKS.TOOL_METADATA, { tools: toolMetadataMap } as ToolMetadataPayload);

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
  const wireFormatRegistry = createWireFormatRegistry();
  const roleMappingRegistry = createRoleMappingRegistry();
  const llmProtocolRegistry = createLlmProtocolRegistry();
  llmProtocolRegistry.register(openaiProtocol);
  const services = createServiceRegistry();
  const completion = createCompletionService();

  // Must happen before the extension loader is created: extensions read
  // core.config during create() (e.g., profile-dependent metadata and
  // tool wiring).
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
    wireFormatRegistry,
    roleMappingRegistry,
    llmProtocolRegistry,
    service: (name: string) => services.get(name),
    buildConfig: options.buildConfig,
    createLlmClient(overrides?: Partial<LlmClientOptions>): LlmClient {
      const resolved = this.resolved;
      // The global WireFormat NAME comes from the resolved config (CLI >
      // config > core.config.json default) -- core holds no default of its
      // own. The SHAPE behind that name comes from whichever extension
      // registers it (the autoloaded wire-format-xml for "xml"), so seed the
      // session mangler with its markers only when the registry actually has
      // it. A name nothing registers is not a client-creation error: it
      // throws LlmError(config) ("Unknown wire format") on the first request
      // (#requestWireFormat); a name that is simply unset throws at the wire
      // only when a wrapper needs rendering. Per-model formats/controlTokens
      // grow the union via ensureManglerCovers, called from every request.
      const modelWireFormat =
        (resolved?.modelWireFormat as string | undefined) ??
        (getLayerDefault(CONFIG_SCHEMA.modelWireFormat) as string | undefined);
      const seedMarkers =
        (modelWireFormat !== undefined ? this.wireFormatRegistry.get(modelWireFormat)?.markers : undefined) ?? [];
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
        wireFormat: modelWireFormat ?? null,
        wireFormatRegistry: this.wireFormatRegistry,
        // Same doctrine for the role mapping: resolved config name, else the
        // schema default ("system-first"); the extension supplies the mappings.
        roleMapping:
          (resolved?.modelRoleMapping as string | undefined) ??
          (getLayerDefault(CONFIG_SCHEMA.modelRoleMapping) as string | undefined) ?? null,
        roleMappingRegistry: this.roleMappingRegistry,
        llmProtocolRegistry: this.llmProtocolRegistry,
        markerMangler: new MarkerMangler([...CORE_PROTECTED_PREFIXES, ...seedMarkers]),
        ...overrides,
      });
    },
  } as CoreInfrastructure;

  core.extensions = createExtensionLoader(core as LoaderCore);

  return core;
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
  // A broken defaults.json must not kill this path: keep the error and keep
  // going on built-in defaults so `rescue` can reach the user.
  let earlyConfigError: unknown = null;
  let minimalConfig;
  try {
    minimalConfig = await loadConfig(undefined);
  } catch (e) {
    earlyConfigError = e;
    minimalConfig = getDefaultConfig();
  }

  const cliSubcommandRegistry = createSubcommandRegistry();
  // Core diagnostic subcommand, registered directly (not via extension.json):
  // when the config is broken no extension handler ever loads, so rescue must
  // live above the config layer. Dispatched below before buildConfig().
  const rescueHandler = (cliArgs: CliArgv) =>
    runRescue({
      configDirArg: cliArgs.configDir ?? null,
      configFileArg: cliArgs.config ?? null,
      fix: Array.isArray(cliArgs.args) && (cliArgs.args as string[]).includes("fix"),
      configParams: configRegistry.getConfigParams(),
    });
  cliSubcommandRegistry.register("rescue", {
    description:
      "Diagnose config files: paths, resolution chain, syntax. 'fix' repairs comments/trailing commas",
    handler: rescueHandler,
  });
  await registerExtensionMetadata(
    minimalConfig as CoreConfigWithExtensions,
    configRegistry,
    cliSubcommandRegistry,
  );

  let cli;
  try {
    cli = parseArgs(configRegistry, cliSubcommandRegistry.names());
  } catch (e: unknown) {
    if (e instanceof CliError && e.subcommand !== undefined) {
      const knownSubcommands = cliSubcommandRegistry.names();
      const posLower = e.subcommand.toLowerCase();
      const similar = suggestCandidates(posLower, knownSubcommands, {
        normalize: (s) => s.toLowerCase(),
      });
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
    // trimStart: the placeholder line is already indented, so the block's own
    // leading spaces would push its first line two columns right of the rest.
    console.log(fullHelp.replace("<subcommands>", subcommandHelp.trimStart()));
    return 0;
  }

  // rescue runs before anything that reads the config it is diagnosing.
  if (cli.subcommand === "rescue") {
    return await rescueHandler(cli as CliArgv);
  }

  if (earlyConfigError) {
    logger.error(formatError(earlyConfigError));
    console.log(
      "The config file is broken, so nothing else can start. Run `hotdog rescue` for the exact line,\n" +
        "or `hotdog rescue fix` to automatically repair comments and trailing commas (keeps a .bak).",
    );
    return 1;
  }

  let built;
  try {
    built = await buildConfig(cli as CliArgv, configRegistry);
  } catch (e) {
    logger.error(formatError(e));
    console.log("Run `hotdog rescue` for config diagnostics (paths, syntax, unknown keys).");
    return 1;
  }
  const { resolved, config } = built;

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
    // Bound so the extension-facing core.buildConfig runs the same full
    // pipeline (incl. extension config resolution + validation) as main().
    buildConfig: (cli) => buildConfig(cli as CliArgv, configRegistry),
  });

  core.resolved = resolved as ResolvedConfig;

  // bail early when we won't be running any subcommand
  if (!cli.subcommand && !process.stdin.isTTY) {
    logger.error("No subcommand provided.");
    console.log(`Available subcommands: ${core.cliSubcommandRegistry.names().join(", ") || "(none)"}`);
    return 1;
  }

  await loadExtensions(core, { taskManager: null, config });

  // Metadata already came from extension.json; this hook lets extensions attach handler functions.
  await core.hooks.notifyHooks(HOOKS.CLI_SUBCOMMANDS_REGISTER, core.cliSubcommandRegistry);

  await core.hooks.notifyHooks(HOOKS.CLI_ARGS_PARSED, { cli });

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
