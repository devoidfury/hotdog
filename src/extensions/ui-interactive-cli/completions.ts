import { execFile } from "node:child_process";
import type { CompletionContext, CompletionHandler } from "@core/completion.ts";
import type { AgentLike } from "@core/session/index.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import type { SessionManager } from "@core/session/index.ts";
import { logger } from "@core/logger.ts";

const MIN_CMD_LEN = 2;

export function parseCompletionContext(line: string, cursorPos: number, agent: AgentLike): CompletionContext {
  const text = line.slice(0, cursorPos).trimStart();

  let command: string | undefined;
  let commandArg: string | undefined;

  if (text.startsWith("/")) {
    const afterSlash = text.slice(1);
    const spaceIdx = afterSlash.indexOf(" ");
    if (spaceIdx === -1) {
      // No space yet -- completing the command name itself
      command = afterSlash.trim();
      commandArg = "";
    } else {
      // Command done -- completing its argument
      command = afterSlash.slice(0, spaceIdx).trim();
      commandArg = afterSlash.slice(spaceIdx + 1).trimStart();
    }
  }

  return {
    line,
    cursorPos,
    command,
    commandArg,
    agent,
  };
}

/**
 * Register the generic slash command name completion: /<tab> -> list all commands.
 * Command-specific argument completions are registered by each extension
 * via the `completion` field on their CommandDefinition.
 */
export function registerSlashCommandNameCompletion(completionService: CoreContext["completion"]): void {
  completionService.register(
    (ctx) => {
      const text = ctx.line.slice(0, ctx.cursorPos).trimStart();
      return text.startsWith("/") && !text.slice(1).includes(" ");
    },
    (ctx) => {
      const agent = ctx.agent;
      const afterSlash = ctx.line.slice(0, ctx.cursorPos).trimStart().slice(1);
      const prefix = afterSlash.toLowerCase();

      const commandNames = agent.commandRegistry?.names() || [];
      const matches = commandNames
        .filter((name) => name.toLowerCase().startsWith(prefix))
        .map((name) => ({ value: `/${name}` }));

      return matches;
    },
    "ui-interactive-cli:slash-commands",
  );
}

/**
 * Register completion handlers from command definitions.
 * Called during COMMANDS_REGISTER to wire up completions declared inline with commands.
 */
export function registerCommandCompletions(
  completionService: CoreContext["completion"],
  registry: { all: () => Map<string, { completion?: CompletionHandler }> },
  source: string,
): void {
  for (const [name, def] of registry.all()) {
    if (!def.completion) continue;

    const matcher = (ctx: CompletionContext): boolean => {
      const cmd = ctx.command;
      if (!cmd) return false;
      return cmd === name || cmd.startsWith(`${name}:`);
    };

    completionService.register(matcher, def.completion, `${source}:${name}`);
  }
}

/**
 * Register shell mode completion provider.
 * Bash-like completion: commands, flags (from --help), and files.
 */
export function registerShellCompletion(
  completionService: CoreContext["completion"],
  shellModeEnabled: boolean,
): void {
  if (!shellModeEnabled) return;

  // Bash script that performs completion based on the line context.
  // Handles: command completion, flag completion (--help parsing), file completion.
  const COMPLETION_SCRIPT = `
line="$1"

# Check if line ends with space (user typed command + space, wants file completion)
if [[ "$line" =~ \\ $ ]]; then
  set -- $line
  cmd="$1"
  compgen -f
else
  set -- $line
  cmd="$1"
  shift
  args_count=$#

  # Get the last word (the one being completed)
  word="$1"
  for w in "$@"; do word="$w"; done

  if [[ $args_count -eq 0 && -n "$cmd" ]]; then
    # Single word - command completion
    compgen -c -- "$cmd"
  elif [[ -z "$word" ]]; then
    # Space after command/flags - complete files in current dir
    compgen -f
  elif [[ "$word" == -* ]]; then
    # Flag completion - extract options from command's --help
    if command -v "$cmd" >/dev/null 2>&1; then
      opts=$("$cmd" --help 2>&1 | grep -oE "(^\\s+-[a-zA-Z]|(--[a-z][a-zA-Z0-9-]*|--help|--version))" | tr -d " " | sort -u | tr "\\n" " ")
      compgen -W "$opts" -- "$word"
    fi
  else
    # File/path completion
    compgen -f -- "$word"
  fi
fi
`;

  const runCompletion = (line: string): Promise<string[]> => {
    return new Promise((resolve) => {
      const child = execFile(
        "bash",
        ["-c", COMPLETION_SCRIPT, "--", line],
        { env: process.env, cwd: process.cwd() },
        (error, stdout) => {
          clearTimeout(timeout);
          if (error || !stdout) {
            resolve([]);
            return;
          }
          resolve(stdout.trim().split("\n").filter(Boolean));
        },
      );

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        resolve([]);
      }, 150);
    });
  };

  completionService.register(
    (ctx: CompletionContext) => {
      // Only activate in shell mode when not typing a slash command
      const text = ctx.line.slice(0, ctx.cursorPos).trimStart();
      return shellModeEnabled && !text.startsWith("/");
    },
    async (ctx: CompletionContext) => {
      const line = ctx.line.slice(0, ctx.cursorPos).trimStart();
      if (!line) return [];

      const words = line.split(/\s+/);
      const firstWord = words[0];
      if (!firstWord || firstWord.length < MIN_CMD_LEN) return [];

      try {
        const completions = await runCompletion(line);
        return completions.map((c) => ({ value: c }));
      } catch (e) {
        logger.debug(`ui-interactive-cli: shell completion error: ${(e as Error).message}`);
        return [];
      }
    },
    "ui-interactive-cli:shell",
  );
}

export function buildReadlineCompleter(
  sessionManager: SessionManager,
  core: CoreContext,
  shellMode: boolean,
): (line: string, callback: (err: Error | null, result: [string[], string]) => void) => void {
  return (line: string, callback: (err: Error | null, result: [string[], string]) => void) => {
    const currentAgent = sessionManager.getAgent();
    if (!currentAgent) {
      callback(null, [[], line]);
      return;
    }

    const cursorPos = line.length;
    const ctx = parseCompletionContext(line, cursorPos, currentAgent);

    let prefix = "";
    const text = line.slice(0, cursorPos).trimStart();
    if (text.startsWith("/")) {
      const afterSlash = text.slice(1);
      const spaceIdx = afterSlash.indexOf(" ");
      if (spaceIdx === -1) {
        const colonIdx = afterSlash.indexOf(":");
        if (colonIdx !== -1) {
          prefix = afterSlash.slice(colonIdx + 1);
        } else {
          prefix = "/" + afterSlash;
        }
      } else {
        prefix = afterSlash.slice(spaceIdx + 1).trimStart();
      }
    } else if (shellMode) {
      const words = line.split(/\s+/);
      prefix = words[words.length - 1] ?? "";
    } else {
      prefix = line;
    }

    core.completion
      .request(ctx, 200)
      .then((options) => {
        const matches = options.map((o) => o.value).filter((m) => m !== prefix);
        logger.debug(`[completion] "${line}" prefix="${prefix}" -> ${matches.length} matches`);
        callback(null, [matches, prefix]);
      })
      .catch((e) => {
        logger.error(`[completion] error: ${(e as Error).message}`);
        callback(null, [[], prefix]);
      });
  };
}
