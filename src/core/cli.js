// CLI argument parsing.
// Supports dynamic CLI flags registered via ConfigRegistry.

export function parseArgs(configRegistry = null, knownSubcommands = null) {
  const args = process.argv.slice(2);
  const options = {
    config: null,
    configDir: null,
    model: null,
    aiUrl: null,
    apiKey: null,
    profile: null,
    provider: null,
    role: null,
    skillsPath: null,
    promptsPath: null,
    chatTimeout: null,
    embeddingsTimeout: null,
    stream: true,
    hideTools: true,
    hideThinking: false,
    version: false,
    help: false,
    thinker: null,
    toolfmt: null,
    toolOutputFmt: null,
    noLog: false,
    loud: false,
    compactDebug: false,
    sessionId: null,
    tokens: false,
    theme: null,
    colors: null,
    subcommand: null,
    reviewToolIndex: false,
    systemPromptTemplate: null,
    wantsJson: false,
  };

  // Initialize extension-provided options from defaults
  if (configRegistry) {
    const extDefaults = configRegistry.buildDefaults();
    for (const [key, value] of Object.entries(extDefaults)) {
      options[key] = null; // Will be set from CLI or config file
    }
  }

  // Build a lookup map of all known flags (core + extension)
  const flagMap = new Map();

  // Core flags
  const coreFlags = [
    { short: "-f", long: "--config", type: "string", hasValue: true },
    { short: "-d", long: "--config-dir", type: "string", hasValue: true },
    { short: "-m", long: "--model", type: "string", hasValue: true },
    { short: null, long: "--ai-url", type: "string", hasValue: true },
    {
      short: null,
      long: "--url",
      type: "string",
      hasValue: true,
      deprecated: true,
    },
    { short: "-k", long: "--api-key", type: "string", hasValue: true },
    { short: "-p", long: "--profile", type: "string", hasValue: true },
    { short: null, long: "--provider", type: "string", hasValue: true },
    { short: null, long: "--role", type: "string", hasValue: true },
    { short: null, long: "--skills-path", type: "string", hasValue: true },
    { short: null, long: "--prompts-path", type: "string", hasValue: true },
    { short: null, long: "--chat-timeout", type: "number", hasValue: true },
    {
      short: null,
      long: "--embeddings-timeout",
      type: "number",
      hasValue: true,
    },
    { short: null, long: "--no-stream", type: "boolean", hasValue: false },
    { short: null, long: "--show-tools", type: "boolean", hasValue: false },
    { short: null, long: "--hide-tools", type: "boolean", hasValue: false },
    { short: null, long: "--show-thinking", type: "boolean", hasValue: false },
    { short: null, long: "--hide-thinking", type: "boolean", hasValue: false },
    { short: "-t", long: "--thinker", type: "string", hasValue: true },
    { short: null, long: "--toolfmt", type: "string", hasValue: true },
    { short: null, long: "--tool-output-fmt", type: "string", hasValue: true },
    { short: null, long: "--no-log", type: "boolean", hasValue: false },
    { short: "-l", long: "--loud", type: "boolean", hasValue: false },
    { short: null, long: "--compact-debug", type: "boolean", hasValue: false },
    { short: "-s", long: "--session-id", type: "string", hasValue: true },
    { short: null, long: "--tokens", type: "boolean", hasValue: false },
    { short: null, long: "--theme", type: "string", hasValue: true },
    { short: null, long: "--colors", type: "boolean", hasValue: false },
    { short: null, long: "--no-colors", type: "boolean", hasValue: false },
    {
      short: null,
      long: "--system-prompt-template",
      type: "string",
      hasValue: true,
    },
    { short: null, long: "--json", type: "boolean", hasValue: false },
    { short: "-v", long: "--version", type: "boolean", hasValue: false },
    { short: "-h", long: "--help", type: "boolean", hasValue: false },
  ];

  for (const flag of coreFlags) {
    if (flag.short) {
      flagMap.set(flag.short, flag);
    }
    flagMap.set(flag.long, flag);
  }

  // Add extension flags
  if (configRegistry) {
    const extFlags = configRegistry.getCliFlags();
    for (const flag of extFlags) {
      const entry = {
        type: flag.type || "string",
        hasValue: flag.type !== "boolean",
        description: flag.description,
        extension: true,
        // Store the original long flag name for key extraction
        longName: flag.long,
      };
      if (flag.parse) {
        entry.parse = flag.parse;
      }
      if (flag.short) {
        flagMap.set(flag.short, entry);
      }
      if (flag.long) {
        flagMap.set(flag.long, entry);
      }
    }
  }

  // Helper: extract option key from flag name
  function extractKey(flagName) {
    return flagName.replace(/^-+/, "").replace(/-/g, "_").toLowerCase();
  }

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    // Check if this is a known flag
    const flagDef = flagMap.get(arg);

    if (flagDef) {
      // Handle subcommand aliases (like "prompt" as a subcommand)
      if (flagDef.isSubcommand) {
        options.subcommand = "prompt";
        if (flagDef.hasValue && i + 1 < args.length) {
          options.prompt = args[++i];
        }
        i++;
        continue;
      }

      // Handle deprecated flags
      if (flagDef.deprecated) {
        console.warn(`Warning: ${arg} is deprecated, use ${flagDef.long}`);
      }

      // Handle boolean flags
      if (!flagDef.hasValue) {
        // Core boolean flags (explicit handling)
        if (arg === "--no-stream") {
          options.stream = false;
        } else if (arg === "--show-tools") {
          options.hideTools = false;
        } else if (arg === "--hide-tools") {
          options.hideTools = true;
        } else if (arg === "--show-thinking") {
          options.hideThinking = false;
        } else if (arg === "--hide-thinking") {
          options.hideThinking = true;
        } else if (arg === "--no-log") {
          options.noLog = true;
        } else if (arg === "--tokens") {
          options.tokens = true;
        } else if (arg === "--colors") {
          options.colors = true;
        } else if (arg === "--no-colors") {
          options.colors = false;
        } else if (arg === "--json") {
          options.wantsJson = true;
        } else if (arg === "--version") {
          options.version = true;
        } else if (arg === "--help") {
          options.help = true;
        } else if (arg === "--loud") {
          options.loud = true;
        } else if (arg === "--compact-debug") {
          options.compactDebug = true;
        }
        // Extension boolean flags (generic handling)
        else if (flagDef.extension) {
          // Use the arg itself to extract the key (handles both short and long)
          const key = extractKey(arg);
          options[key] = true;
        }
        i++;
        continue;
      }

      // Handle flags with values
      if (i + 1 >= args.length) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(1);
      }

      const value = args[++i];

      // Parse the value based on type
      let parsedValue = value;
      if (flagDef.type === "number" || flagDef.type === "int") {
        parsedValue = parseInt(value, 10);
        if (isNaN(parsedValue)) {
          console.error(`Error: ${arg} requires a numeric value`);
          process.exit(1);
        }
      } else if (flagDef.type === "array") {
        parsedValue = value.split(",");
      } else if (typeof flagDef.parse === "function") {
        parsedValue = flagDef.parse(value);
      }

      // Store in options using the long flag name as key
      // For extension flags, use longName; for core flags, use long
      const flagLong = flagDef.extension ? flagDef.longName : flagDef.long;
      const key = extractKey(flagLong);
      options[key] = parsedValue;
      i++;
      continue;
    }

    // Check if this looks like an unknown flag
    if (arg.startsWith("-")) {
      // Could be an unknown flag — warn and skip
      console.warn(`Warning: unknown flag '${arg}'`);
      i++;
      continue;
    }

    // Positional argument — treat as subcommand or throw
    const isKnownSubcommand = knownSubcommands
      ? knownSubcommands.includes(arg)
      : arg === "info" || arg === "show-prompt" || arg === "review";

    if (isKnownSubcommand) {
      options.subcommand = arg;
    } else {
      // Unknown positional argument — throw to let main.js handle it
      throw new Error(`Unknown subcommand: ${arg}`);
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
      --ai-url <url>        AI URL (deprecated: --url)
  -k, --api-key <key>       API key
  -p, --profile <name>      Profile name
      --provider <name>     AI provider to use
      --role <text>         System prompt role
      --skills-path <path>  Skills directory path
      --prompts-path <path> Prompts directory path
      --chat-timeout <s>    Chat request timeout in seconds
      --embeddings-timeout <s> Embeddings request timeout in seconds
  --no-stream               Disable streaming
  --show-tools              Show tool calls
  --show-thinking           Show thinking output
  -t, --thinker <fmt>       Thinking format string
  --toolfmt <fmt>           Tool call format string
  --tool-output-fmt <fmt>   Tool result format string
  --no-log                  Disable session logging
  -l, --loud                Print full JSON API responses
      --compact-debug       Write compaction output to compaction.out.json
  -s, --session-id <id>   Resumable session ID
      --tokens              Display token usage stats
  --theme <name>            Theme (dark, light, monochrome, or file path)
  --colors                  Enable colors
  --no-colors               Disable colors
  --system-prompt-template <path> Custom system prompt template
  -v, --version             Show version
  -h, --help                Show help`;

/**
 * Generate combined help text including extension flags.
 *
 * @param {import('./config-registry.js').ConfigRegistry} [configRegistry]
 * @returns {string}
 */
export function generateHelpText(configRegistry) {
  let help = HELP_TEXT;

  if (configRegistry) {
    const extHelp = configRegistry.getCliHelpText();
    if (extHelp) {
      help = help.replace(/(-h, --help\s+Show help)/, `$1\n${extHelp}`);
    }
  }

  return help;
}
