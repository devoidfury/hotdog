// CLI argument parsing.
// Core config flags come from core.config.json via ConfigRegistry.
// Only structural/meta flags are hardcoded here (--config, --model, --help, etc.).

import { logger } from "./logger.js";

// Structural flags that are NOT config values (config file paths, model selection, etc.)
// These are parsed directly and passed to the config resolver as CLI context.
const STRUCTURAL_FLAGS = [
  { short: "-f", long: "--config", type: "string" },
  { short: "-d", long: "--config-dir", type: "string" },
  { short: "-m", long: "--model", type: "string" },
  { short: null, long: "--ai-url", type: "string" },
  { short: "-k", long: "--api-key", type: "string" },
  { short: "-p", long: "--profile", type: "string" },
  { short: null, long: "--provider", type: "string" },
  {
    short: null,
    long: "--system-prompt-template",
    type: "string",
  },
  // Meta/structural booleans
  { short: "-l", long: "--loud", type: "boolean" },
  { short: null, long: "--json", type: "boolean" },
  { short: "-v", long: "--version", type: "boolean" },
  { short: "-h", long: "--help", type: "boolean" },
];

export function parseArgs(configRegistry = null, knownSubcommands = null) {
  const args = process.argv.slice(2);
  const options = {
    // Structural flags (parsed directly)
    config: null,
    configDir: null,
    model: null,
    aiUrl: null,
    apiKey: null,
    profile: null,
    provider: null,
    systemPromptTemplate: null,
    loud: false,
    wantsJson: false,
    version: false,
    help: false,
    // Meta
    subcommand: null,
    args: [],
  };

  // Initialize extension-registered options from defaults
  if (configRegistry) {
    const extDefaults = configRegistry.buildDefaults();
    for (const [key] of Object.entries(extDefaults)) {
      options[key] = null;
    }
  }

  // Build a lookup map of all known flags (structural + registered)
  const flagMap = new Map();

  // Structural flags (always available, no config needed)
  for (const flag of STRUCTURAL_FLAGS) {
    const entry = { ...flag, hasValue: flag.type !== "boolean", structural: true };
    if (flag.short) flagMap.set(flag.short, entry);
    flagMap.set(flag.long, entry);
  }

  // Registered flags (from core schema + extensions via ConfigRegistry)
  if (configRegistry) {
    const registeredFlags = configRegistry.getCliFlags();
    for (const flag of registeredFlags) {
      const entry = {
        type: flag.type || "string",
        hasValue: flag.type !== "boolean",
        description: flag.description,
        longName: flag.long,
      };
      if (flag.parse) entry.parse = flag.parse;
      if (flag.short) flagMap.set(flag.short, entry);
      if (flag.long) flagMap.set(flag.long, entry);
    }
  }

  // Helper: extract option key from flag name (kebab-case → camelCase)
  function extractKey(flagName) {
    return flagName
      .replace(/^-+/, "")
      .split("-")
      .map((part, i) =>
        i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
      )
      .join("");
  }

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    const flagDef = flagMap.get(arg);

    if (flagDef) {
      // Handle subcommand aliases
      if (flagDef.isSubcommand) {
        options.subcommand = "prompt";
        if (flagDef.hasValue && i + 1 < args.length) {
          options.prompt = args[++i];
        }
        i++;
        continue;
      }

      // Handle boolean flags — all handled generically now
      if (!flagDef.hasValue) {
        const key = extractKey(flagDef.long || arg);
        // Semantic renames only — camelCase conversion is handled by extractKey()
        const keyMap = { json: "wantsJson" };
        options[keyMap[key] || key] = true;
        i++;
        continue;
      }

      // Handle flags with values
      if (i + 1 >= args.length) {
        throw new Error(`${arg} requires a value`);
      }

      const value = args[++i];

      // Parse the value based on type
      let parsedValue = value;
      if (flagDef.type === "number" || flagDef.type === "int") {
        parsedValue = parseInt(value, 10);
        if (isNaN(parsedValue)) {
          throw new Error(`${arg} requires a numeric value`);
        }
      } else if (flagDef.type === "array") {
        parsedValue = value.split(",");
      } else if (typeof flagDef.parse === "function") {
        parsedValue = flagDef.parse(value);
      }

      // Store in options using the extracted key
      const flagLong = flagDef.longName || flagDef.long;
      const key = extractKey(flagLong);
      options[key] = parsedValue;
      i++;
      continue;
    }

    // Unknown flag
    if (arg.startsWith("-")) {
      logger.warn(`Warning: unknown flag '${arg}'`);
      i++;
      continue;
    }

    // Positional arguments
    if (!options.subcommand) {
      const isKnownSubcommand = knownSubcommands
        ? knownSubcommands.includes(arg)
        : arg === "info" || arg === "show-prompt" || arg === "review";

      if (isKnownSubcommand) {
        options.subcommand = arg;
      } else {
        throw new Error(`Unknown subcommand: ${arg}`);
      }
    } else {
      options.args.push(arg);
    }
    i++;
  }

  return options;
}

export const HELP_TEXT = `oa-agent - AI agent harness with tool calling support

Usage: oa-agent [options] [prompt]
       oa-agent info
       oa-agent show-prompt
       oa-agent review [--session-id <id>] [--json] [--tool-index]
       oa-agent prompt "One-shot prompt"

Subcommands:
  <subcommands>

Options:
  -f, --config <path>       Config file path
  -d, --config-dir <path>   Config directory (overrides default ./config)
  -m, --model <name>        Model name
      --ai-url <url>        AI URL
  -k, --api-key <key>       API key
  -p, --profile <name>      Profile name
      --provider <name>     AI provider to use
      --system-prompt-template <path> Custom system prompt template
  -l, --loud                Print full JSON API responses
  --json                    Output as JSON
  -v, --version             Show version
  -h, --help                Show help

Config flags (from schema):
  <config_flags>`;

/**
 * Generate combined help text including config flags from schema.
 *
 * @param {import('./config-registry.js').ConfigRegistry} [configRegistry]
 * @returns {string}
 */
export function generateHelpText(configRegistry) {
  let help = HELP_TEXT;

  if (configRegistry) {
    const configFlagsHelp = configRegistry.getCliHelpText();
    if (configFlagsHelp) {
      help = help.replace("<config_flags>", configFlagsHelp);
    } else {
      help = help.replace("\n  <config_flags>", "");
    }
  }

  return help;
}
