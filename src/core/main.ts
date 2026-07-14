#!/usr/bin/env bun
// CLI entry point — wired to the extension architecture.

import {
  createHooks,
  initializeLogger,
  logger,
  resolveLogLevel,
  resolveLogTarget,
} from "./index.ts";
import {
  createToolRegistry,
  createExtensionLoader,
  createServiceRegistry,
  getExtensionsToLoad,
  registerExtensionMetadata,
  validateServiceContracts,
  type LoaderCore,
  type ExtensionLoader,
} from "./extensions/index.ts";
import { HOOKS, type HookSystem, type HookTraceOptions } from "./hooks.ts";
import { parseArgs, generateHelpText } from "./cli.ts";
import {
  loadConfig,
  buildConfig,
  validateConfig,
  failOnInvalidConfig,
  type CliArgv,
  type AgentConfig,
} from "./config/index.ts";
import {
  cliFlagsFromSchema,
  CONFIG_SCHEMA,
  resolveExtensionConfig,
  type ExtensionConfigParam,
  type ResolutionContext,
  type CoreConfig,
} from "./config/schema-loader.ts";
import { createConfigRegistry, type ConfigRegistry } from "./extensions/config-registry.ts";
import { CliError } from "./error.ts";
import { createSubcommandRegistry, type CliSubcommandRegistry } from "./extensions/registries.ts";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── Extension Loading ────────────────────────────────────────────────────────

/**
 * Load all extensions into the core based on config settings.
 * Extensions are auto-discovered from configured paths and loaded in
 * dependency order.
 *
 * @param core - The core object with hooks, extensions, etc.
 * @param options - Loading options.
 * @param options.taskManager - TaskManager instance for subagent tools.
 * @param options.config - Resolved config with extension settings.
 * @returns Loaded extension instances.
 */
async function loadExtensions(
  core: CoreInfrastructure,
  {
    taskManager,
    config,
  }: { taskManager: unknown; config: CoreConfig } = {
    taskManager: null,
    config: {} as CoreConfig,
  },
): Promise<unknown[]> {
  const loaded: unknown[] = [];

  // Discover extensions from config (returns sorted by dependency order)
  const extensionPaths = (config?.extensionPaths as string[]) || ["builtins"];
  const extensionAutoload = (config?.extensionAutoload as boolean) ?? false;
  const extensionsList =
    (config?.extensions as string[]) || [];

  const extensionsToLoad = await getExtensionsToLoad(
    extensionPaths,
    extensionAutoload,
    extensionsList,
    config,
  );

  for (const ext of extensionsToLoad) {
    if (core.extensions.has(ext.name)) {
      continue; // already loaded, skip
    }
    const extInstance = await core.extensions.load(
      ext.name,
      ext.path ?? "",
      {
        taskManager,
        provides: ext.provides,
        dependsOn: ext.dependsOn,
      },
    );
    if (extInstance) loaded.push(extInstance);
  }

  // Validate service contracts after all extensions are loaded.
  // Only validate extensions that were actually loaded (create() returned non-null).
  const loadedExtensions = extensionsToLoad.filter((ext) =>
    core.extensions.has(ext.name),
  );
  const serviceErrors = validateServiceContracts(
    loadedExtensions,
    core.services,
  );
  for (const err of serviceErrors) {
    // Missing services will cause runtime crashes — surface them as errors
    logger.error(`[services] ${err.message}`);
  }

  return loaded;
}

// ── Core Infrastructure ─────────────────────────────────────────────────────

/**
 * Create the core infrastructure: hooks, tool registry, extension loader.
 *
 * @param config - Configuration object.
 * @param configRegistry - Optional config registry for extension CLI flags & config params.
 * @param cliSubcommandRegistry - Optional CLI subcommand registry.
 * @param options - Optional additional options.
 * @param options.hooks - Pre-created hook system.
 * @param options.profileName - Current profile name.
 * @param options.profile - Resolved profile object (includes manager flag, whitelistTools, etc.).
 * @param options.buildConfig - Optional buildConfig function for subcommand handlers.
 * @returns Core object with hooks, toolRegistry, extensions, config.
 */
/**
 * Core infrastructure type — the internal core object that powers both
 * the extension loader and the CoreContext passed to extensions.
 */
export interface CoreInfrastructure extends LoaderCore {
  extensions: ExtensionLoader;
  service: (name: string) => unknown;
  buildConfig?: typeof buildConfig;
  resolved?: AgentConfig;
}

function createCore(
  config: CoreConfig,
  configRegistry: ConfigRegistry,
  cliSubcommandRegistry: CliSubcommandRegistry,
  options: {
    hooks?: HookSystem;
    profileName?: string;
    profile?: Record<string, unknown>;
    buildConfig?: typeof buildConfig;
  } = {},
): CoreInfrastructure {
  const hooks = options.hooks || createHooks();
  const toolRegistry = createToolRegistry();
  const services = createServiceRegistry();

  // Merge profile info into config so extensions can access it
  // This must be done BEFORE creating the extension loader, because
  // extensions access core.config.profile during create() (e.g., subagents
  // checks core.config.profile.manager to decide whether to register tools).
  const coreConfig = {
    ...config,
    profileName: options.profileName || config.profileName || "default",
    profile: options.profile || config.profile || {},
  } as CoreConfig;

  const extensions = createExtensionLoader({
    hooks,
    toolRegistry,
    services,
    config: coreConfig,
    cliSubcommandRegistry,
    configRegistry,
  });

  return {
    hooks,
    toolRegistry,
    extensions,
    services,
    config: coreConfig,
    cliSubcommandRegistry,
    configRegistry,
    service: (name: string) => services.get(name),
    buildConfig: options.buildConfig,
  } as CoreInfrastructure;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function main(): Promise<number> {
  // ── Create hooks + logger early (needed before any error output) ────────
  const hooks = createHooks();
  const minLevel = resolveLogLevel();
  const logTarget = resolveLogTarget();
  initializeLogger({ hooks, minLevel, target: logTarget });

  // ── Create config registry for extension CLI flags & config params ──────
  const configRegistry = createConfigRegistry();

  // Register core CLI flags from schema (single source of truth)
  const coreFlags = cliFlagsFromSchema(CONFIG_SCHEMA);
  configRegistry.registerCliFlags(
    coreFlags.map((f) => ({
      short: f.short ?? undefined,
      long: f.long,
      description: f.description,
      type: f.type,
      default: undefined,
    })),
  );

  // Register inverse flags not in schema (schema has one cliFlag per key)
  configRegistry.registerCliFlags([
    { long: "--hide-tools", type: "boolean", description: "Hide tool calls" },
    {
      long: "--show-thinking",
      type: "boolean",
      description: "Show thinking output",
    },
    { long: "--no-colors", type: "boolean", description: "Disable colors" },
  ]);

  // ── Build minimal config (defaults only, for extension discovery) ───────
  // We need this early to discover extensions and read their CLI flags /
  // subcommand declarations from extension.json without loading code.
  const minimalConfig = await loadConfig(undefined);

  // ── Discover extensions from metadata (no code loading) ─────────────────
  // Reads extension.json files to extract CLI flags, subcommand declarations, and config params.
  // Config params from schema are registered automatically, making extension.json the source of truth for extension configuration.
  // This enables `--help` and subcommand discovery without loading any extension code.
  const cliSubcommandRegistry = createSubcommandRegistry();
  await registerExtensionMetadata(
    minimalConfig as CoreConfig,
    configRegistry,
    cliSubcommandRegistry,
  );

  // ── Parse CLI args with extension flags ─────────────────────────────────
  let cli;
  try {
    cli = parseArgs(configRegistry, cliSubcommandRegistry.names());
  } catch (e: unknown) {
    if (e instanceof CliError && e.message.startsWith("Unknown subcommand:")) {
      const knownSubcommands = cliSubcommandRegistry.names();
      const posLower = e.message
        .replace("Unknown subcommand: ", "")
        .toLowerCase();
      const similar = knownSubcommands.filter(
        (sc) =>
          sc.toLowerCase() !== posLower && sc.startsWith(posLower.slice(0, 2)),
      );
      if (similar.length === 1) {
        logger.error(
          `Unknown subcommand: ${posLower}\n` + `Did you mean: ${similar[0]}?`,
        );
      } else {
        logger.error(
          `Unknown subcommand: ${posLower}\n` +
            `Available subcommands: ${knownSubcommands.join(", ")}\n` +
            `To send a prompt, use -c or --prompt: hotdog -c "your prompt"`,
        );
      }
      return 1;
    }
    throw e;
  }

  // ── Build complete config ───────────────────────────────────────────────
  const { resolved, modelRegistry, providers } = await buildConfig(cli as CliArgv);

  // Warn if no AI URL is configured
  if (!resolved.baseUrl) {
    logger.warn(
      "No AI URL configured. Set a URL via --ai-url, aiUrl in config, provider.url, or HOTDOG_AI_URL environment variable. " +
        "LLM calls will fail until a URL is provided.",
    );
  }

  // Enable hook tracing if configured
  hooks.trace = resolved.hookTrace as boolean | HookTraceOptions;

  const extParams = configRegistry.getConfigParams();
  const config = await loadConfig(cli.config ?? undefined, cli.configDir ?? undefined, extParams);

  // ── Resolve extension config keys through their declared layers ──────────
  // Extension keys (e.g., webui, coreTools) are resolved using the layers
  // defined in their extension.json configSchema. This allows nested properties
  // to have their own layers (e.g., apiKey with config + env + default).
  const extContext: ResolutionContext = {
    cli: cli as Record<string, unknown>,
    config: config as Record<string, unknown>,
    configDir: resolved.configDir,
    provider: resolved.activeProvider
      ? { name: resolved.activeProvider }
      : null,
    profile: resolved.profile,
    profileName: resolved.profileName,
  };
  const resolvedExtConfig = resolveExtensionConfig(extParams as unknown as ExtensionConfigParam[], extContext);
  // Merge resolved extension keys back into config so extensions see the resolved values
  Object.assign(config as Record<string, unknown>, resolvedExtConfig);

  // ── Validate config against core schema and extension schemas ────────────
  const extensionSchemas = extParams
    .filter((p) => p.schema)
    .map((p) => ({ key: p.key, schema: p.schema }));
  const validationResult = validateConfig(config as CoreConfig, extensionSchemas);
  failOnInvalidConfig(validationResult);

  // ── Create core infrastructure ──────────────────────────────────────────
  const core = createCore(config as CoreConfig, configRegistry, cliSubcommandRegistry, {
    hooks,
    profileName: resolved.profileName,
    profile: resolved.profile,
    buildConfig,
  });

  // Attach resolved config to core so extensions can access it
  core.resolved = resolved;

  // ── Load extensions ──────────────────────────────────────────────────────
  // Extensions register their handlers in create() via cliSubcommandRegistry.register().
  // Force autoload: true to ensure all extensions are loaded (not just explicitly listed ones).
  await loadExtensions(core, { taskManager: null, config: config as CoreConfig });

  // Emit CLI subcommand registration hook so extensions can register their handlers.
  // Subcommand metadata (description, options) was already registered from extension.json;
  // this hook allows extensions to attach the actual handler functions.
  core.hooks.notifyHooks(
    HOOKS.CLI_SUBCOMMANDS_REGISTER,
    core.cliSubcommandRegistry,
  );

  // Emit CLI_ARGS_PARSED hook after extensions are loaded, before performing any actions.
  core.hooks.notifyHooks(HOOKS.CLI_ARGS_PARSED, { cli });

  // ── Subcommand dispatch ─────────────────────────────────────────────────
  if (cli.subcommand) {
    // Re-get after loading to pick up updated handler (in case hook modified subcommand)
    const subcommandDef = core.cliSubcommandRegistry.get(cli.subcommand);
    if (subcommandDef && subcommandDef.handler) {
      return await subcommandDef.handler(cli, core);
    }
    logger.error(
      `Subcommand "${cli.subcommand}" handler not available after loading extensions.`,
    );
    return 1;
  }

  if (cli.version) {
    const pkg = JSON.parse(
      await readFile(
        join(dirname(fileURLToPath(import.meta.url)), "../../package.json"),
        "utf-8",
      ),
    );
    const VERSION = pkg.version;
    console.log(`hotdog ${VERSION}`);
    return 0;
  }

  if (cli.help) {
    const subcommandHelp = core.cliSubcommandRegistry.generateHelpText();
    const fullHelp = generateHelpText(configRegistry);
    console.log(fullHelp.replace("<subcommands>", subcommandHelp));
    return 0;
  }

  // No explicit subcommand — use default_subcommand from config when stdin is a TTY
  if (process.stdin.isTTY) {
    const defaultSubcommandName = config.defaultSubcommand || "cli";
    const defaultSubcommand = core.cliSubcommandRegistry.get(
      defaultSubcommandName,
    );
    if (defaultSubcommand && defaultSubcommand.handler) {
      return await defaultSubcommand.handler(cli, core);
    }
  }

  logger.error("No subcommand provided.");
  console.log(
    `Available subcommands: ${core.cliSubcommandRegistry.names().join(", ") || "(none)"}`,
  );
  return 1;
}
