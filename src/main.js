#!/usr/bin/env bun
// oa-agent — AI agent harness with tool calling support.
// CLI entry point — wired to the extension architecture.

import {
  createHooks,
  createToolRegistry,
  createExtensionLoader,
  SessionManager,
  Agent,
  MessageBus,
} from "./core/index.js";
import {
  getExtensionsToLoad,
  emitConfigRegistration,
  discoverExtensions,
  getExtensionConfigDefaults,
} from "./core/extensions.js";
import { HOOKS } from "./hooks.js";
import { CliOutputSink } from "./ui/cli.js";
import { parseArgs, generateHelpText } from "./cli.js";
import { loadConfig, buildConfig } from "./config.js";
import { createConfigRegistry } from "./config-registry.js";
import { formatError } from "./context/error.js";
import { createSubcommandRegistry } from "./core/subcommand-registry.js";
import { Message } from "./context/message.js";
import {
  sessionExists,
  readSessionEntries,
  replayEntriesIntoContext,
} from "./session/session-log.js";

// ── Extension Loading ────────────────────────────────────────────────────────

/**
 * Load all extensions into the core based on config settings.
 * Extensions are auto-discovered from configured paths and loaded in
 * dependency order (refresh first, core-tools second, then others).
 *
 * @param {Object} core - The core object with hooks, extensions, etc.
 * @param {Object} options - Loading options.
 * @param {Object} options.taskManager - TaskManager instance for subagent tools.
 * @param {Object} options.config - Resolved config with extension settings.
 * @returns {Promise<Array>} Loaded extension instances.
 */
async function loadExtensions(core, { taskManager, config } = {}) {
  const loaded = [];

  // Discover extensions from config (returns sorted by dependency order)
  const extensionPaths = config?.extensionPaths || ["builtins"];
  const extensionAutoload = config?.extensionAutoload ?? false;
  const extensionsList = config?.extensions || [];

  const extensionsToLoad = await getExtensionsToLoad(
    extensionPaths,
    extensionAutoload,
    extensionsList,
  );

  // Load all extensions in dependency order via the extension loader.
  // The loader handles import + create() call. taskManager is passed
  // to all extensions (extensions that don't need it simply ignore it).
  // Also passes provides/dependsOn for capability tracking.
  // Guard: skip extensions already loaded (prevents double-loading when
  // loadExtensions is called multiple times, e.g., early for subcommands
  // then again with real taskManager for interactive mode).
  for (const ext of extensionsToLoad) {
    if (core.extensions.has(ext.name)) {
      continue; // already loaded, skip
    }
    const extInstance = await core.extensions.load(ext.name, ext.path, {
      taskManager,
      provides: ext.provides,
      dependsOn: ext.dependsOn,
    });
    if (extInstance) loaded.push(extInstance);
  }

  return loaded;
}

// ── Core Infrastructure ─────────────────────────────────────────────────────

/**
 * Create the core infrastructure: hooks, tool registry, extension loader.
 *
 * @param {Object} config - Configuration object.
 * @param {Object} [configRegistry] - Optional config registry for extension CLI flags & config params.
 * @param {Object} [cliSubcommandRegistry] - Optional CLI subcommand registry.
 * @param {Object} [options] - Optional additional options.
 * @param {string} [options.profileName] - Current profile name.
 * @param {Object} [options.profile] - Resolved profile object (includes manager flag, whitelistTools, etc.).
 * @param {Function} [options.buildConfig] - Optional buildConfig function for subcommand handlers.
 * @returns {Object} Core object with hooks, toolRegistry, extensions, config.
 */
function createCore(
  config,
  configRegistry,
  cliSubcommandRegistry,
  options = {},
) {
  const hooks = createHooks();
  const toolRegistry = createToolRegistry();

  // Merge profile info into config so extensions can access it
  // This must be done BEFORE creating the extension loader, because
  // extensions access core.config.profile during create() (e.g., subagents
  // checks core.config.profile.manager to decide whether to register tools).
  const coreConfig = {
    ...config,
    profileName: options.profileName || config.profileName || "default",
    profile: options.profile || config.profile || {},
  };

  const extensions = createExtensionLoader({
    hooks,
    toolRegistry,
    config: coreConfig,
    cliSubcommandRegistry,
    configRegistry,
  });

  return {
    hooks,
    toolRegistry,
    extensions,
    config: coreConfig,
    cliSubcommandRegistry,
    buildConfig: options.buildConfig,
  };
}

/**
 * Discover extensions and register their CLI flags and subcommands from metadata.
 * This reads extension.json files without loading any extension code.
 *
 * @param {Object} config - Configuration with extension paths and autoload settings.
 * @param {Object} configRegistry - Config registry to register CLI flags.
 * @param {Object} cliSubcommandRegistry - Subcommand registry to register subcommands.
 * @returns {Promise<Array>} Array of discovered extension metadata.
 */
async function registerExtensionMetadata(
  config,
  configRegistry,
  cliSubcommandRegistry,
) {
  const extensionPaths = config?.extensionPaths || ["builtins"];
  const extensionAutoload = config?.extensionAutoload ?? false;
  const extensionsList = config?.extensions || [];

  const extensionsToLoad = await getExtensionsToLoad(
    extensionPaths,
    extensionAutoload,
    extensionsList,
  );

  // Register CLI flags from extension metadata
  for (const ext of extensionsToLoad) {
    if (ext.cliFlags && ext.cliFlags.length > 0) {
      const flags = ext.cliFlags.map((flag) => ({
        short: flag.short,
        long: flag.long,
        description: flag.description,
        type: flag.type,
        default: flag.default,
      }));
      configRegistry.registerCliFlags(flags);
    }
  }

  // Register subcommands from extension metadata (for help/discovery without loading)
  for (const ext of extensionsToLoad) {
    if (ext.cliSubcommands && ext.cliSubcommands.length > 0) {
      for (const sc of ext.cliSubcommands) {
        cliSubcommandRegistry.register(sc.name, {
          description: sc.description || "",
          requiresConfig: sc.requiresConfig,
          requiresCore: sc.requiresCore,
          options: sc.options || [],
          // The handler will be set when the extension is loaded at runtime
          handler: null,
        });
      }
    }
  }

  return extensionsToLoad;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Create config registry for extension CLI flags & config params ──────
  const configRegistry = createConfigRegistry();

  // ── Build minimal config (defaults only, for extension discovery) ───────
  // We need this early to discover extensions and read their CLI flags /
  // subcommand declarations from extension.json without loading code.
  // Include extension schema defaults so extension-specific config keys
  // get their defaults merged into the base config.
  const extSchemaDefaults = await getExtensionConfigDefaults();
  const minimalConfig = await loadConfig(
    null,
    [...configRegistry.getConfigParams(), ...extSchemaDefaults],
  );

  // ── Discover extensions from metadata (no code loading) ─────────────────
  // Reads extension.json files to extract CLI flags and subcommand declarations.
  // This enables `--help` and subcommand discovery without loading any extension code.
  const cliSubcommandRegistry = createSubcommandRegistry();
  await registerExtensionMetadata(
    minimalConfig,
    configRegistry,
    cliSubcommandRegistry,
  );

  // ── Parse CLI args with extension flags ─────────────────────────────────
  let cli;
  try {
    cli = parseArgs(configRegistry, cliSubcommandRegistry.names());
  } catch (e) {
    if (e.message.startsWith("Unknown subcommand:")) {
      const knownSubcommands = cliSubcommandRegistry.names();
      const posLower = e.message
        .replace("Unknown subcommand: ", "")
        .toLowerCase();
      const similar = knownSubcommands.filter(
        (sc) =>
          sc.toLowerCase() !== posLower && sc.startsWith(posLower.slice(0, 2)),
      );
      if (similar.length === 1) {
        console.error(
          `Unknown subcommand: ${posLower}\n` + `Did you mean: ${similar[0]}?`,
        );
      } else {
        console.error(
          `Unknown subcommand: ${posLower}\n` +
            `Available subcommands: ${knownSubcommands.join(", ")}\n` +
            `To send a prompt, use -c or --prompt: oa-agent -c "your prompt"`,
        );
      }
      process.exit(1);
    }
    throw e;
  }

  // ── Build complete config ───────────────────────────────────────────────
  const { resolved, modelRegistry, providers } = await buildConfig(cli);
  const extParams = configRegistry.getConfigParams();
  const config = await loadConfig(cli.config, extParams);

  // ── Create core infrastructure ──────────────────────────────────────────
  const core = createCore(config, configRegistry, cliSubcommandRegistry, {
    profileName: resolved.profileName,
    profile: resolved.profile,
    buildConfig,
  });

  // Attach resolved config to core so extensions can access it
  core.resolved = resolved;

  // ── Load extensions ──────────────────────────────────────────────────────
  // Extensions register their handlers in create() via cliSubcommandRegistry.register().
  // Force autoload: true to ensure all extensions are loaded (not just explicitly listed ones).
  await loadExtensions(core, { taskManager: null, config });

  // Emit CLI args parsed hook after extensions are loaded (so handlers are registered)
  core.hooks.emit(HOOKS.CLI_ARGS_PARSED, { cli });

  // ── Subcommand dispatch ─────────────────────────────────────────────────
  if (cli.subcommand) {
    // Re-get after loading to pick up updated handler (in case hook modified subcommand)
    const getSubcommand = () => core.cliSubcommandRegistry.get(cli.subcommand);
    const subcommandDef = getSubcommand();
    if (subcommandDef && subcommandDef.handler) {
      await subcommandDef.handler(cli, core);
      return;
    }
    console.error(
      `Subcommand "${cli.subcommand}" handler not available after loading extensions.`,
    );
    process.exit(1);
  }

  if (cli.version) {
    console.log("oa-agent 0.1.0");
    process.exit(0);
  }
  if (cli.help) {
    const subcommandHelp = core.cliSubcommandRegistry.generateHelpText();
    const fullHelp = generateHelpText(configRegistry);
    console.log(fullHelp.replace("<subcommands>", subcommandHelp));
    process.exit(0);
  }

  console.error("No subcommand provided.");
  console.log(
    `Available subcommands: ${core.cliSubcommandRegistry.names().join(", ") || "(none)"}`,
  );
  process.exit(1);
}

// Only run main() when this module is the entry point (not when imported by tests).
if (process.argv[1]?.match(/(main\.js|oa-agent)$/)) {
  main().catch(async (e) => {
    console.error(formatError(e));
    process.exit(1);
  });
}
