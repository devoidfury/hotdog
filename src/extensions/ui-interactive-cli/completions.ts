import { execFile } from "node:child_process";
import type { CompletionContext } from "@core/completion.ts";
import {
  parseCompletionContext,
  completionPrefix,
} from "@core/completion.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import type { SessionManager } from "@core/session/index.ts";
import { logger } from "@utils/logger.ts";

export {
  parseCompletionContext,
  registerSlashCommandNameCompletion,
  registerCommandCompletions,
} from "@core/completion.ts";

const MIN_CMD_LEN = 2;

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
): (line: string, callback: (err: Error | null, result: [string[], string]) => void) => void {
  return (line: string, callback: (err: Error | null, result: [string[], string]) => void) => {
    const currentAgent = sessionManager.getAgent();
    if (!currentAgent) {
      callback(null, [[], line]);
      return;
    }

    const cursorPos = line.length;
    const ctx = parseCompletionContext(line, cursorPos, currentAgent);

    // Readline replaces the trailing prefix with the chosen completion, so it
    // must be only the word under the cursor -- not the whole line, or a
    // completion mid-sentence would wipe out the preceding text.
    const prefix = completionPrefix(line, cursorPos);

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
