// Designed to be extensible via hooks and reusable by future UIs (web UI).

import { logger } from "@utils/logger.ts";
import type { AgentLike } from "./session/index.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CompletionContext {
  /** Full input buffer text. */
  line: string;
  cursorPos: number;
  /** Parsed command if applicable (e.g., "model" for "/model <tab>"). */
  command?: string;
  commandArg?: string;
  agent: AgentLike;
}

export interface CompletionOption {
  /** The value that gets inserted when selected. */
  value: string;
  /** Optional display text shown in the completion list. Defaults to value. */
  display?: string;
}

export type CompletionMatcher = (ctx: CompletionContext) => boolean;

/** May return null to indicate no completions. */
export type CompletionHandler = (
  ctx: CompletionContext,
) => CompletionOption[] | Promise<CompletionOption[]> | null;

export interface CompletionRegistration {
  matcher: CompletionMatcher;
  handler: CompletionHandler;
  /** Optional source identifier (e.g., extension name) for debugging. */
  source?: string;
}

// ── CompletionService ────────────────────────────────────────────────────────

/**
 * Service that manages completion providers and fires completion requests.
 *
 * Providers register via `register(matcher, handler, source?)`.
 * Completion requests are made via `request(ctx, timeoutMs)`.
 *
 * Async handlers are invoked with a timeout -- late results are dropped.
 * Errors are logged to debug and never block completion.
 */
export class CompletionService {
  #registrations: CompletionRegistration[];

  constructor() {
    this.#registrations = [];
  }

  /** Returns a removal function that unregisters this handler. */
  register(
    matcher: CompletionMatcher,
    handler: CompletionHandler,
    source?: string,
  ): () => void {
    const registration: CompletionRegistration = { matcher, handler, source };
    this.#registrations.push(registration);

    return () => {
      const idx = this.#registrations.indexOf(registration);
      if (idx !== -1) {
        this.#registrations.splice(idx, 1);
      }
    };
  }

  /**
   * Async handlers are subject to the timeout -- late results are dropped.
   * Errors are logged to debug only and never thrown.
   */
  async request(ctx: CompletionContext, timeoutMs: number = 200): Promise<CompletionOption[]> {
    const matching = this.#registrations.filter((r) => {
      try {
        return r.matcher(ctx);
      } catch (e) {
        logger.debug(
          `[completion] Matcher error from ${r.source ?? "unknown"}: ${(e as Error).message}`,
        );
        return false;
      }
    });

    if (matching.length === 0) {
      return [];
    }

    const allResults: CompletionOption[] = [];

    const handlerPromises = matching.map(async (r) => {
      const handlerName = r.source ?? "unknown";
      try {
        const result = await this.#invokeWithTimeout(r.handler, ctx, timeoutMs);
        if (result && result.length > 0) {
          return result;
        }
        return null;
      } catch (e) {
        logger.debug(
          `[completion] Handler error from ${handlerName}: ${(e as Error).message}`,
        );
        return null;
      }
    });

    const results = await Promise.all(handlerPromises);
    const seen = new Set<string>();
    for (const options of results) {
      if (!options) continue;
      for (const option of options) {
        if (!seen.has(option.value)) {
          seen.add(option.value);
          allResults.push(option);
        }
      }
    }

    return allResults;
  }

  #invokeWithTimeout(
    handler: CompletionHandler,
    ctx: CompletionContext,
    timeoutMs: number,
  ): Promise<CompletionOption[]> {
    return new Promise((resolve) => {
      let settled = false;

      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          logger.debug(
            `[completion] Handler timed out after ${timeoutMs}ms`,
          );
          resolve([]);
        }
      }, timeoutMs);

      try {
        const result = handler(ctx);
        const promise = result instanceof Promise ? result : Promise.resolve(result);

        promise
          .then((value) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              resolve(value ?? []);
            }
          })
          .catch(() => {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              resolve([]);
            }
          });
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          resolve([]);
        }
      }
    });
  }

  handlerCount(): number {
    return this.#registrations.length;
  }

  clear(): void {
    this.#registrations = [];
  }
}

export function createCompletionService(): CompletionService {
  return new CompletionService();
}

// ── Shared input parsing ─────────────────────────────────────────────────────
// Used by every UI that wires completions so replacement semantics stay identical.

function lastWord(text: string): string {
  const ws = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\t"));
  return text.slice(ws + 1);
}

/** Parse input text into a CompletionContext: slash command name + argument. */
export function parseCompletionContext(
  line: string,
  cursorPos: number,
  agent: AgentLike,
): CompletionContext {
  const text = line.slice(0, cursorPos).trimStart();

  let command: string | undefined;
  let commandArg: string | undefined;

  if (text.startsWith("/")) {
    const afterSlash = text.slice(1);
    const spaceIdx = afterSlash.indexOf(" ");
    if (spaceIdx === -1) {
      command = afterSlash.trim();
      commandArg = "";
    } else {
      command = afterSlash.slice(0, spaceIdx).trim();
      commandArg = afterSlash.slice(spaceIdx + 1).trimStart();
    }
  }

  return { line, cursorPos, command, commandArg, agent };
}

/**
 * The text a completion should replace only the word under the cursor, not the whole line.
 * For "/cmd" (no space) it is the command word itself, including the leading slash;
 * for "/prompt:name" it is what follows the colon.
 * A completion mid-sentence must not clobber the preceding text.
 */
export function completionPrefix(line: string, cursorPos: number): string {
  const text = line.slice(0, cursorPos).trimStart();
  if (!text.startsWith("/")) return lastWord(line.slice(0, cursorPos));

  const afterSlash = text.slice(1);
  const spaceIdx = afterSlash.indexOf(" ");
  if (spaceIdx === -1) {
    const colonIdx = afterSlash.indexOf(":");
    if (colonIdx !== -1) return afterSlash.slice(colonIdx + 1);
    return "/" + afterSlash;
  }
  return lastWord(afterSlash.slice(spaceIdx + 1));
}

// ── Shared registration helpers ──────────────────────────────────────────────

/**
 * Register the generic slash command name completion: /<tab> -> list all commands.
 * Command-specific argument completions are registered via registerCommandCompletions from COMMANDS_REGISTER hook.
 */
export function registerSlashCommandNameCompletion(
  completionService: CompletionService,
): void {
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
      return commandNames
        .filter((name) => name.toLowerCase().startsWith(prefix))
        .map((name) => ({ value: `/${name}` }));
    },
    "core:slash-commands",
  );
}

/**
 * Register completion handlers from command definitions (COMMANDS_REGISTER). `seen`, when provided,
 * dedupes across repeated hook fires (multi-session UIs fire COMMANDS_REGISTER once per agent build with the same names).
 */
export function registerCommandCompletions(
  completionService: CompletionService,
  registry: { all: () => Map<string, { completion?: CompletionHandler }> },
  source: string,
  seen?: Set<string>,
): void {
  for (const [name, def] of registry.all()) {
    if (!def.completion) continue;
    if (seen) {
      if (seen.has(name)) continue;
      seen.add(name);
    }

    const matcher = (ctx: CompletionContext): boolean => {
      const cmd = ctx.command;
      if (!cmd) return false;
      return cmd === name || cmd.startsWith(`${name}:`);
    };

    completionService.register(matcher, def.completion, `${source}:${name}`);
  }
}
