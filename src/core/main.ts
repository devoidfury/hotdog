#!/usr/bin/env bun

import { initializeLogger, logger, resolveLogLevel, resolveLogTarget, logBootConfigWarnings } from "@utils/logger.ts";
import { suggestCandidates } from "@utils/strings.ts";
import { createToolRegistry } from "./extensions/tool-registry.ts";
import {
  createExtensionLoader,
  registerExtensionMetadata,
  resolveExtensionsToLoad,
  sdkCompatibilityWarning,
  validateServiceContracts,
  type LoaderCore,
} from "./extensions/extensions.ts";
import { createServiceRegistry } from "./extensions/service-registry.ts";
import { createHooks, HOOKS, type HookSystem, type HookTraceOptions } from "./hooks.ts";
import { migrateDataLayout } from "./data-migration.ts";
import { createCompletionService } from "./completion.ts";
import type { CoreContext, ExtensionInstance, ToolMetadataPayload } from "./extensions/types.ts";
import type { ToolMetadata } from "./extensions/tool-registry.ts";
import { parseArgs, generateHelpText } from "./cli.ts";
import { loadConfig, buildConfig, getDefaultConfig, type CliArgv } from "./config/index.ts";
import { createConfigStore, type ConfigStore } from "./config/store.ts";
import { registerConfigApplyHook } from "./config/apply-hooks.ts";
import { peekLogBootPosture } from "./config/boot-posture.ts";
import { enumHintsFromValidationErrors, runRescue } from "./config/rescue.ts";
import { runExtensionValidate } from "./extensions/validate.ts";
import type { ProfileDef } from "./config/profiles.ts";
import type { ResolvedConfig } from "./extensions/types.ts";
import type { ProviderDef } from "./config/providers.ts";
import { getLayerDefault } from "./config/schema-loader.ts";
import { cliFlagsFromSchema, CONFIG_SCHEMA, type CoreConfigWithExtensions } from "./config/schema-loader.ts";
import { ConfigRegistry } from "./extensions/config.ts";
import { CliError, ConfigError, USAGE_ERROR_EXIT_CODE, formatError } from "./error.ts";
import { spoofSafe } from "@utils/spoof.ts";
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

  const extensionsToLoad = await resolveExtensionsToLoad(config);

  for (const ext of extensionsToLoad) {
    if (core.extensions.has(ext.name)) continue;
    const sdkWarn = sdkCompatibilityWarning(ext, pkg.version);
    if (sdkWarn) logger.warn(sdkWarn);
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
    /** Inject a store (embeds/tests); defaults to a fresh createConfigStore(). */
    store?: ConfigStore;
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
  // core.config during create() (e.g., profile-dependent metadata and tool wiring).
  const coreConfig: CoreConfigWithExtensions = {
    ...config,
    profileName: options.profileName || config.profileName || "default",
    profileDef: options.profile || config.profileDef,
  };

  // The store owns the config/resolved surface: it adopts this boot bag now
  // (the main.ts resolved-adopt is the second adopt), and the core's config/
  // resolved properties below delegate to it. At boot nobody publishes, so
  // current() answers exactly this bag -- byte-identical to the pre-store core.
  const store = options.store ?? createConfigStore();
  store.adopt(coreConfig);

  // Extensions is set after construction to break the circular dependency;
  // the loader must receive this same core reference main() uses.
  const core = {
    hooks,
    toolRegistry,
    extensions: null!,
    services,
    completion,
    // Property access at call time against the current generation: the stable
    // read surface, live from the first swap onward (the CoreContext interface
    // stays property-shaped so hand-built test cores keep plain properties).
    get config(): CoreConfigWithExtensions {
      return store.current().config;
    },
    set resolved(r: ResolvedConfig) {
      store.adopt(coreConfig, r); // boot path: the single production assignment at main.ts (resolved-adopt)
    },
    get resolved(): ResolvedConfig | undefined {
      return store.current().resolved as ResolvedConfig;
    },
    configStore: store,
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
        // Schema-default fallbacks (core.config.json layers), same doctrine as
        // maxRetries below: hand-built resolved bags stay valid without
        // code-resident literals. Note: the chatTimeout schema default is 600.
        chatTimeoutSecs: resolved?.chatTimeout ?? (getLayerDefault(CONFIG_SCHEMA.chatTimeout) as number),
        healthCheckTimeoutSecs:
          resolved?.healthCheckTimeout ?? (getLayerDefault(CONFIG_SCHEMA.healthCheckTimeout) as number),
        streamIdleTimeoutSecs: resolved?.streamIdleTimeout as number | undefined,
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

  // §3.3 hookTrace row (B4): the once-at-boot reassignment in main() stays
  // (boot posture); this is its live twin. Registered here, in createCore --
  // core hooks land in the table before extension hooks by load order
  // (createCore runs before loadExtensions), and every host that builds a
  // core gets the row without extra wiring. Apply phase: a one-line reassign
  // of the public hooks.trace, reading the RESOLVED bag (the CLI/env/config
  // chain the boot posture used -- the raw config-bag member alone would
  // miss the --hook-trace flag layer).
  registerConfigApplyHook({
    keyPath: "hookTrace",
    phase: "apply",
    handle: (ctx) => {
      const v = ctx.store.current().resolved?.hookTrace;
      // A resolved bag without the key (hand-built embeds) leaves the running
      // posture alone; a real re-resolve always resolves it (schema default
      // false, --hook-trace/env layers above).
      if (v === undefined) return;
      ctx.core.hooks.trace = v as boolean | HookTraceOptions;
    },
  });

  return core;
}

/**
 * Best-effort extract config-location flags from raw argv before parseArgs can run and metadata registers.
 * The early metadata load must read the same config the real parse will resolve; otherwise a broken host default
 * aborts the run even when the user pointed --config-dir at a good one.
 */
export function peekConfigFlags(argv: readonly string[]): {
  config: string | null;
  configDir: string | null;
} {
  let config: string | null = null;
  let configDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (i + 1 >= argv.length) break;
    if (arg === "-d" || arg === "--config-dir") {
      configDir = argv[++i]!;
    } else if (arg === "-f" || arg === "--config") {
      config = argv[++i]!;
    }
  }
  return { config, configDir };
}

export async function main(): Promise<number> {
  // Hooks + logger must exist before any error output can happen.
  const hooks = createHooks();
  // ...but the logger's OWN posture rides the config file, and the file
  // must be consulted BEFORE init (posture from line one, no stderr-first
  // fix-up). peekConfigFlags + peekLogBootPosture resolve the same in-use
  // file loadConfig will; precedence stays env > config > default inside
  // resolve*, and a failed peek degrades to env/default silently.
  const earlyConfigFlags = peekConfigFlags(process.argv.slice(2));
  const logPosture = peekLogBootPosture(earlyConfigFlags);
  const minLevel = resolveLogLevel(logPosture.logLevel);
  const logTarget = resolveLogTarget(logPosture.logTarget);
  initializeLogger({ hooks, minLevel, target: logTarget });
  // An out-of-set config value fell back to the default above; name it once
  // now that an output channel exists. With logTarget "none" these warns are
  // suppressed by design (no writer is attached) -- silence was requested.
  for (const warning of logBootConfigWarnings(logPosture)) logger.warn(warning);

  // One-shot sessions/data layout migration (moved workflows/ and
  // task-lanes/ out of the sessions dir). Must run before any extension or
  // subcommand touches those dirs; never fatal.
  migrateDataLayout();

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
    // Same flag layer parseArgs will apply (flag > env > cwd/etc): a broken
    // host config must not abort a run whose --config/-config-dir points
    // somewhere valid.
    minimalConfig = await loadConfig(earlyConfigFlags.config, earlyConfigFlags.configDir);
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
      json: cliArgs.wantsJson === true,
      configParams: configRegistry.getConfigParams(),
    });
  cliSubcommandRegistry.register("rescue", {
    description:
      "Diagnose config files: paths, resolution chain, syntax, invalid enum values. 'fix' repairs comments/trailing commas and resets out-of-set enums to their schema default (.bak kept)",
    handler: rescueHandler,
  });
  // Extension diagnostics ride the same above-the-config seat: validating an
  // extension directory must work even when defaults.json is broken.
  const extensionHandler = (cliArgs: CliArgv) =>
    runExtensionValidate({
      args: Array.isArray(cliArgs.args) ? (cliArgs.args as string[]) : [],
      json: cliArgs.wantsJson === true,
    });
  cliSubcommandRegistry.register("extension", {
    description:
      "Extension diagnostics: 'validate <dir>' checks the manifest (strict JSON, field types, sdk range), the entry point, config defaults, service contracts, and dry-loads through the real loader; names unanchored SDK imports with the bun link fix",
    handler: extensionHandler,
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
    if (e instanceof CliError) {
      // Parse-phase usage failure: getopt-style exit 2 so scripts can tell
      // "invoked wrong" from runtime failures (1). The offending token goes
      // through spoofSafe (escapes/bidi must not reach the terminal).
      if (e.subcommand !== undefined) {
        const knownSubcommands = cliSubcommandRegistry.names();
        const posLower = e.subcommand.toLowerCase();
        const echo = spoofSafe(posLower);
        const similar = suggestCandidates(posLower, knownSubcommands, {
          normalize: (s) => s.toLowerCase(),
        });
        if (similar.length === 1) {
          logger.error(`Unknown subcommand: ${echo}\n` + `Did you mean: ${similar[0]}?`);
        } else {
          logger.error(
            `Unknown subcommand: ${echo}\n` +
              `Available subcommands: ${knownSubcommands.join(", ")}\n` +
              `To send a prompt, use -p or --prompt: hotdog -p "your prompt"`,
          );
        }
      } else {
        logger.error(formatError(e));
      }
      return USAGE_ERROR_EXIT_CODE;
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

  // Same above-the-config seat as rescue: extension validation reads a
  // directory the user named, not the config being diagnosed.
  if (cli.subcommand === "extension") {
    return await extensionHandler(cli as CliArgv);
  }

  if (earlyConfigError) {
    logger.error(formatError(earlyConfigError));
    console.error(
      "The config file is broken, so nothing else can start. Run `hotdog rescue` for the exact line,\n" +
        "or `hotdog rescue fix` to automatically repair comments and trailing commas (keeps a .bak).",
    );
    return 1;
  }

  // Single-flight buildConfig: boot builds once, and subcommand handlers
  // (info/profiles/show-prompt) receive the exact same argv object that main
  // just built with (dispatch calls handler(cli, core)). Without memoization
  // their core.buildConfig call rebuilds everything -- including a second
  // /v1/models round for every fetchModels provider, doubling cold-boot cost
  // and doubling offline timeout pain. The memo lives inside main(), so
  // repeated main() calls (tests, embedded hosts) each build fresh.
  let bootBuild: ReturnType<typeof buildConfig> | null = null;
  const buildConfigOnce = (cliArgv: CliArgv) => {
    bootBuild ??= buildConfig(cliArgv, configRegistry);
    return bootBuild;
  };

  let built;
  try {
    built = await buildConfigOnce(cli as CliArgv);
  } catch (e) {
    logger.error(formatError(e));
    console.error("Run `hotdog rescue` for config diagnostics (paths, syntax, unknown keys).");
    // Out-of-set enum values parse fine and fail here, in validation: name the
    // repair command the way the broken-syntax path does, plus every offending
    // key and its accepted set (the owner ruled boot keeps failing; rescue
    // makes getting out easy).
    const badEnums = e instanceof ConfigError ? enumHintsFromValidationErrors(e.validationErrors) : [];
    if (badEnums.length > 0) {
      console.error(
        `Out-of-set value${badEnums.length === 1 ? "" : "s"} - \`hotdog rescue fix\` ${badEnums.length === 1 ? "resets it" : "resets each of them"} to the schema default and keeps a .bak:` +
          badEnums.map((b) => `\n  ${b.key}: accepted ${b.accepted.join(" | ")}`).join(""),
      );
    }
    return 1;
  }
  const { resolved, config } = built;

  if (!resolved.baseUrl) {
    logger.warn(
      "No AI URL configured. LLM calls will fail until one is provided.\n" +
        "Set one via:\n" +
        "  --ai-url <url>              (CLI flag)\n" +
        "  HOTDOG_AI_URL=<url>         (env var)\n" +
        "  aiUrl in ./config/defaults.json\n" +
        "  or provider.url in your config.",
    );
  } else if (!resolved.apiKey) {
    logger.warn(
      "No API key configured for the AI endpoint. Unauthenticated inference endpoints are a " +
        "free API for anything that can reach them and an open prompt-injection surface -- " +
        "prefer HOTDOG_API_KEY plus a key requirement on the server (llama.cpp / vllm --api-key, " +
        "llama-swap api_key).",
    );
  }

  hooks.trace = resolved.hookTrace as boolean | HookTraceOptions;

  const core = createCore(config, configRegistry, cliSubcommandRegistry, {
    hooks,
    profileName: resolved.profileName,
    profile: resolved.profileDef,
    // Bound so the extension-facing core.buildConfig runs the same full
    // pipeline (incl. extension config resolution + validation) as main();
    // single-flight, so a handler rebuild reuses boot's build (see buildConfigOnce).
    buildConfig: (cli) => buildConfigOnce(cli as CliArgv),
  });

  core.resolved = resolved as ResolvedConfig;
  // Keep the parsed CLI bag reachable for the config re-resolve (§2.1): the
  // daemon's live argv IS the boot argv (it cannot change at runtime), and
  // re-resolve must keep honoring its layers (the §4.2 provenance rule --
  // dropping it would silently discard the operator's flag overrides).
  core.cliArgv = cli as CliArgv;

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
