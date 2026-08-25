// Designed to be extensible via hooks and reusable by future UIs (web UI).

import { logger } from "./logger.ts";
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
          .catch((e) => {
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
