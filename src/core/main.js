#!/usr/bin/env bun
// oa-agent — AI agent harness with tool calling support.
// CLI entry point — wired to the extension architecture.

import { createHooks, SessionManager, Agent, MessageBus } from "./index.js";
import {
  createToolRegistry,
  createExtensionLoader,
  getExtensionsToLoad,
  registerExtensionMetadata,
} from "./extensions/index.js";
import { HOOKS } from "./hooks.js";
import { CliOutputSink } from "./ui/cli.js";
import { parseArgs, generateHelpText } from "./cli.js";
import { loadConfig, buildConfig } from "./config.js";
import { createConfigRegistry } from "./extensions/config-registry.js";
import { formatError } from "./error.js";
import { createSubcommandRegistry } from "./extensions/registries.js";
import { Message } from "./context/message.js";
import {
  sessionExists,
  readSessionEntries,
  replayEntriesIntoContext,
} from "./session/session-log.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

// ── Main ─────────────────────────────────────────────────────────────────────

export async function main() {
  // ── Create config registry for extension CLI flags & config params ──────
  const configRegistry = createConfigRegistry();

  // ── Build minimal config (defaults only, for extension discovery) ───────
  // We need this early to discover extensions and read their CLI flags /
  // subcommand declarations from extension.json without loading code.
  const minimalConfig = await loadConfig(null);

  // ── Discover extensions from metadata (no code loading) ─────────────────
  // Reads extension.json files to extract CLI flags, subcommand declarations,
  // and config params from configSchema.
  // Config params from schema are registered automatically, making extension.json
  // the single source of truth for extension configuration.
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
      return 1;
    }
    throw e;
  }

  // ── Build complete config ───────────────────────────────────────────────
  const { resolved, modelRegistry, providers } = await buildConfig(cli);
  const extParams = configRegistry.getConfigParams();
  const config = await loadConfig(cli.config, cli.configDir, extParams);

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

  // Emit CLI subcommand registration hook so extensions can register their handlers.
  // Subcommand metadata (description, options) was already registered from extension.json;
  // this hook allows extensions to attach the actual handler functions.
  core.hooks.emit(HOOKS.CLI_SUBCOMMANDS_REGISTER, core.cliSubcommandRegistry);

  // Emit CLI_ARGS_PARSED hook after extensions are loaded, before performing any actions.
  core.hooks.emit(HOOKS.CLI_ARGS_PARSED, { cli });

  // ── Subcommand dispatch ─────────────────────────────────────────────────
  if (cli.subcommand) {
    // Re-get after loading to pick up updated handler (in case hook modified subcommand)
    const getSubcommand = () => core.cliSubcommandRegistry.get(cli.subcommand);
    const subcommandDef = getSubcommand();
    if (subcommandDef && subcommandDef.handler) {
      return await subcommandDef.handler(cli, core);
    }
    console.error(
      `Subcommand "${cli.subcommand}" handler not available after loading extensions.`,
    );
    return 1;
  }

  if (cli.version) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      await readFile(join(__dirname, "../../package.json"), "utf-8"),
    );
    const VERSION = pkg.version;
    console.log(`oa-agent ${VERSION}`);
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

  console.error("No subcommand provided.");
  console.log(
    `Available subcommands: ${core.cliSubcommandRegistry.names().join(", ") || "(none)"}`,
  );
  return 1;
}

// Only run main() when this module is the entry point (not when imported by tests).
if (import.meta.main) {
  main()
    .catch(async (e) => {
      console.error(formatError(e));
      return 1;
    })
    .then((code) => process.exit(code));
}
