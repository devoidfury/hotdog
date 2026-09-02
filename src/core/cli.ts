// Core config flags come from core.config.json via ConfigRegistry.
// Only structural/meta flags are hardcoded here (--config, --model, --help, etc.).

import { CliError } from "./error.ts";
import { parseCliFlagKey } from "../utils/strings.ts";
import type { ConfigRegistry } from "./extensions/config.ts";
import type { CliFlagDef } from "./config/schema-types.ts";

export interface FlagEntry {
  short?: string | null;
  long: string;
  type: string;
  hasValue: boolean;
  structural?: boolean;
  isSubcommand?: boolean;
  description?: string;
  parse?: (value: string) => unknown;
}

export interface ParsedCliOptions {
  config: string | null;
  configDir: string | null;
  model: string | null;
  aiUrl: string | null;
  apiKey: string | null;
  profile: string | null;
  provider: string | null;
  systemPromptTemplate: string | null;
  loud: boolean;
  wantsJson: boolean;
  version: boolean;
  help: boolean;
  subcommand: string | null;
  args: string[];
  prompt?: string;
  [key: string]: unknown;
}

// Structural flags that are NOT config values (config file paths, model selection, etc.)
// These are parsed directly and passed to the config resolver as CLI context.
const STRUCTURAL_FLAGS: CliFlagDef[] = [
  { short: "-f", long: "--config", type: "string", description: "Config file path" },
  { short: "-d", long: "--config-dir", type: "string", description: "Config directory" },
  { short: "-m", long: "--model", type: "string", description: "Model name" },
  { short: undefined, long: "--ai-url", type: "string", description: "AI URL" },
  { short: "-k", long: "--api-key", type: "string", description: "API key" },
  { short: undefined, long: "--profile", type: "string", description: "Profile name" },
  { short: undefined, long: "--provider", type: "string", description: "AI provider" },
  {
    short: undefined,
    long: "--system-prompt-template",
    type: "string",
    description: "Custom system prompt template",
  },
  { short: "-l", long: "--loud", type: "boolean", description: "Print full JSON API responses" },
  { short: undefined, long: "--json", type: "boolean", description: "Output as JSON" },
  { short: "-v", long: "--version", type: "boolean", description: "Show version" },
  { short: "-h", long: "--help", type: "boolean", description: "Show help" },
];

/** True when a and b differ by at most one edit (insert/delete/substitute). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  let i = 0;
  while (i < short.length && long[i] === short[i]) i++;
  if (i === short.length) return true; // remainder = one insert
  if (long.length === short.length) {
    return long.slice(i + 1) === short.slice(i + 1); // one substitution
  }
  return long.slice(i + 1) === short.slice(i); // one deletion
}

/**
 * Suggest registered flags close to an unknown one: separator/case-insensitive
 * exact match, then prefix/substring near-matches, then one-edit typos
 * (a dropped char like --modl for --model defeats substring matching alone).
 * Long flags only.
 */
function suggestFlags(arg: string, flagMap: Map<string, FlagEntry>): string[] {
  const key = (name: string) => name.replace(/^-+/, "").toLowerCase().replace(/[-_]/g, "");
  const target = key(arg);
  if (!target) return [];

  const names = Array.from(flagMap.keys()).filter((k) => k.startsWith("--"));
  const exact = names.filter((n) => key(n) === target);
  if (exact.length > 0) return exact.slice(0, 5);

  const near = names.filter((n) => {
    const k = key(n);
    return k.length > 2 && (k.includes(target) || target.includes(k));
  });
  if (near.length > 0) return near.slice(0, 5);

  return names.filter((n) => withinOneEdit(key(n), target)).slice(0, 5);
}

export function parseArgs(
  configRegistry: ConfigRegistry | null = null,
  knownSubcommands: string[] | null = null,
): ParsedCliOptions {
  const args = process.argv.slice(2);
  const options: ParsedCliOptions = {
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
    subcommand: null,
    args: [],
  };

  if (configRegistry) {
    const extDefaults = configRegistry.buildDefaults();
    for (const [key] of Object.entries(extDefaults)) {
      options[key] = null;
    }
  }

  const flagMap = new Map<string, FlagEntry>();

  // Structural flags (always available, no config needed)
  for (const flag of STRUCTURAL_FLAGS) {
    const entry: FlagEntry = {
      ...flag,
      hasValue: flag.type !== "boolean",
      structural: true,
    };
    if (flag.short) flagMap.set(flag.short, entry);
    flagMap.set(flag.long, entry);
  }

  // Registered flags (from core schema + extensions via ConfigRegistry)
  if (configRegistry) {
    const registeredFlags = configRegistry.getCliFlags();
    for (const flag of registeredFlags) {
      const entry: FlagEntry = {
        type: flag.type || "string",
        hasValue: flag.hasValue ?? flag.type !== "boolean",
        description: flag.description,
        long: flag.long,
        short: flag.short || null,
      };
      if (flag.parse) entry.parse = flag.parse;
      if (flag.short) flagMap.set(flag.short, entry);
      if (flag.long) flagMap.set(flag.long, entry);
    }
  }

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;
    const flagDef = flagMap.get(arg);

    if (flagDef) {
      if (flagDef.isSubcommand) {
        options.subcommand = "prompt";
        if (flagDef.hasValue && i + 1 < args.length) {
          options.prompt = args[++i];
        }
        i++;
        continue;
      }

      if (!flagDef.hasValue) {
        const key = parseCliFlagKey(flagDef.long || arg);
        // Special mapping for --json flag
        const mappedKey = key === "json" ? "wantsJson" : key;
        options[mappedKey] = true;
        i++;
        continue;
      }

      if (i + 1 >= args.length) {
        throw CliError.MissingValue(arg);
      }

      const value = args[++i]!;

      let parsedValue: unknown = value;
      if (flagDef.type === "number" || flagDef.type === "int") {
        parsedValue = parseInt(value, 10);
        if (isNaN(parsedValue as number)) {
          throw CliError.InvalidValue(arg);
        }
      } else if (flagDef.type === "array") {
        parsedValue = value.split(",");
      } else if (typeof flagDef.parse === "function") {
        parsedValue = flagDef.parse(value);
      }

      const key = parseCliFlagKey(flagDef.long);
      options[key] = parsedValue;
      i++;
      continue;
    }

    if (arg.startsWith("-")) {
      // Fatal, not a warning: a dropped flag means the run proceeds with
      // wrong config and the user never connects the two.
      throw CliError.UnknownFlag(arg, suggestFlags(arg, flagMap));
    }

    if (!options.subcommand) {
      const isKnownSubcommand = knownSubcommands
        ? knownSubcommands.includes(arg)
        : arg === "info" || arg === "show-prompt" || arg === "sessions";

      if (isKnownSubcommand) {
        options.subcommand = arg;
      } else {
        throw CliError.UnknownSubcommand(arg);
      }
    } else {
      options.args.push(arg);
    }
    i++;
  }

  return options;
}

const HELP_TEXT = `hotdog - AI agent harness with tool calling support

Usage: hotdog [options] [prompt]
       hotdog info
       hotdog show-prompt
       hotdog sessions show [--session-id <id>] [--json] [--tool-index]
       hotdog sessions delete <id>
       hotdog sessions cleanup [--older-than <days>]
       hotdog prompt "One-shot prompt"

Subcommands:
  <subcommands>

Options:
  -f, --config <path>       Config file path
  -d, --config-dir <path>   Config directory (overrides default ./config)
  -m, --model <name>        Model name
      --ai-url <url>        AI URL
  -k, --api-key <key>       API key
      --profile <name>      Profile name
      --provider <name>     AI provider to use
      --system-prompt-template <path> Custom system prompt template
  -l, --loud                Print full JSON API responses
  --json                    Output as JSON
  -v, --version             Show version
  -h, --help                Show help
  <config_flags>`;

export function generateHelpText(
  configRegistry: { getCliHelpText: () => string | null } | null | undefined,
): string {
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
