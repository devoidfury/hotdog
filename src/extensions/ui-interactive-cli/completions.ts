import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import type { CompletionContext } from "@core/completion.ts";
import {
  parseCompletionContext,
  completionPrefix,
} from "@core/completion.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import type { SessionManager } from "@core/session/index.ts";
import type { Completion, EditorView } from "@utils/cli/renderer/index.ts";
import { formatError } from "@core/error.ts";
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
        logger.debug(`ui-interactive-cli: shell completion error: ${formatError(e)}`);
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
        logger.error(`[completion] error: ${formatError(e)}`);
        callback(null, [[], prefix]);
      });
  };
}
// ── Stage-3b editor popup completions ──────────────────────────────────────

/** Cap on raw directory entries per completion request (popup shows far fewer). */
const PATH_COMPLETION_LIMIT = 200;

/**
 * Zero-dep file-path completer: readdirSync on the directory part of the
 * word plus a prefix filter, so file completion exists without the shell
 * provider's bash subprocess. Directories keep a trailing "/" in both the
 * label and the insert text so repeated Tabs descend the path. Hidden
 * entries only appear once the prefix itself starts with a dot. Any readdir
 * failure (missing/gone directory, not a directory) means "no candidates".
 */
export function pathCompletions(word: string): Completion[] {
  const slash = word.lastIndexOf("/");
  const dirPrefix = slash >= 0 ? word.slice(0, slash + 1) : "";
  const prefix = word.slice(slash + 1);
  let entries;
  try {
    entries = readdirSync(dirPrefix === "" ? "." : dirPrefix, { withFileTypes: true });
  } catch (e) {
    logger.debug(`ui-interactive-cli: path completion failed: ${formatError(e)}`);
    return [];
  }
  const out: Completion[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    if (!prefix.startsWith(".") && entry.name.startsWith(".")) continue;
    const isDir = entry.isDirectory();
    const value = `${dirPrefix}${entry.name}${isDir ? "/" : ""}`;
    out.push({ label: value, insert: value });
    if (out.length >= PATH_COMPLETION_LIMIT) break;
  }
  return out;
}

export interface EditorPopupCompleter {
  /**
   * word is the span text the popup was requested for and `from` its buffer
   * start; the span end is always the cursor. (Fewer parameters than
   * EditorInputHandlers.popup by design -- TS drops the unused tail.)
   */
  (word: string, from: number): Completion[] | undefined;
}

/**
 * The synchronous popup provider for the mounted EditorView (Tab at key
 * time cannot await). The core.completion providers are async, so this uses
 * the cache-or-degrade contract: the request itself answers instantly with
 * the live readdir candidates plus whatever the providers returned for this
 * word on an earlier round, and separately fires the provider request; when
 * that resolves, the popup is (re-)opened in place -- but only while the
 * buffer span is still the exact word the request was made for, so a late
 * reply never overwrites what the user has since typed. A cold cache on a
 * provider-only word degrades to no popup on that Tab and a cache-hit popup
 * on the next one.
 */
export function buildEditorCompleter(
  sessionManager: SessionManager,
  core: CoreContext,
  getView: () => EditorView | null,
  shellMode: boolean,
): EditorPopupCompleter {
  const providerCache = new Map<string, Completion[]>();
  const inFlight = new Set<string>();

  return (word, from) => {
    const view = getView();
    if (!view) return undefined;
    const lineBeforeCursor = view.text.slice(0, view.cursor);
    const slashNameSpan = lineBeforeCursor.trimStart().startsWith("/") && from === 0;

    // readdir applies to real path words and to any shell-mode span; a
    // slash-command NAME span ("/mod|") is command-name territory only.
    const wantPaths = !slashNameSpan && (word.includes("/") || shellMode);
    const paths = wantPaths ? pathCompletions(word) : [];

    // One provider round per word at a time; results merge into the cache.
    const agent = sessionManager.getAgent();
    if (agent && !inFlight.has(word)) {
      inFlight.add(word);
      const ctx = parseCompletionContext(view.text, view.cursor, agent);
      core.completion
        .request(ctx, 200)
        .then((options) => {
          providerCache.set(
            word,
            options.map((o) => ({ label: o.display ?? o.value, insert: o.value })),
          );
          const live = getView();
          if (live && live.text.slice(from, live.cursor) === word) {
            live.openPopup(mergeCandidates(providerCache.get(word) ?? [], wantPaths ? pathCompletions(word) : []), from);
          }
        })
        .catch((e) => {
          logger.debug(`ui-interactive-cli: popup completion error: ${formatError(e)}`);
        })
        .finally(() => {
          inFlight.delete(word);
        });
    }

    const merged = mergeCandidates(providerCache.get(word) ?? [], paths);
    return merged.length > 0 ? merged : undefined;
  };
}

/**
 * Merge two candidate lists by label, first-list-first order. Directory
 * names ignore a trailing slash for equality: compgen offers `data` for a
 * directory while the readdir completer offers `data/` -- one thing gets one
 * row (and one unique-match auto-complete). The slash form wins the slot:
 * it is the canonical directory completion (bash inserts it that way too).
 * Exported for the merge-contract tests.
 */
export function mergeCandidates(a: Completion[], b: Completion[]): Completion[] {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const strip = (label: string) => (label.endsWith("/") ? label.slice(0, -1) : label);
  const at = new Map<string, number>();
  const out: Completion[] = [];
  for (const c of [...a, ...b]) {
    const key = strip(c.label);
    const slot = at.get(key);
    if (slot === undefined) {
      at.set(key, out.length);
      out.push(c);
    } else if (!out[slot]!.label.endsWith("/") && c.label.endsWith("/")) {
      out[slot] = c; // directory form replaces the slash-less twin, in place
    }
  }
  return out;
}
