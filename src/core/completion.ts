// Tab completion system -- core types and CompletionService.
// Designed to be extensible via hooks and reusable by future UIs (web UI).
//
// Completion providers register matchers and handlers. When a completion
// request comes in, matching handlers are invoked (async, with timeout).
// Results are merged and returned to the UI layer.

import { logger } from "./logger.ts";
import type { Agent } from "./agent.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Context passed to completion handlers.
 */
export interface CompletionContext {
  /** Full input buffer text. */
  line: string;
  /** Current cursor position in the line. */
  cursorPos: number;
  /** Parsed command if applicable (e.g., "model" for "/model <tab>"). */
  command?: string;
  /** Current argument being typed after the command. */
  commandArg?: string;
  /** The current agent instance. */
  agent: Agent;
}

/**
 * A single completion option returned by a handler.
 */
export interface CompletionOption {
  /** The value that gets inserted when selected. */
  value: string;
  /** Optional display text shown in the completion list. Defaults to value. */
  display?: string;
}

/**
 * Matcher function -- determines if a handler should be invoked for a given context.
 */
export type CompletionMatcher = (ctx: CompletionContext) => boolean;

/**
 * Handler function -- returns completion options for a given context.
 * Can be sync or async. May return null to indicate no completions.
 */
export type CompletionHandler = (
  ctx: CompletionContext,
) => CompletionOption[] | Promise<CompletionOption[]> | null;

/**
 * A registered completion provider.
 */
export interface CompletionRegistration {
  /** Matcher to determine if this handler applies. */
  matcher: CompletionMatcher;
  /** Handler that returns completions. */
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

  /**
   * Register a completion provider.
   * @param matcher - Function that returns true if this handler should be invoked.
   * @param handler - Function that returns completion options.
   * @param source - Optional source identifier for debugging.
   * @returns A removal function that unregisters this handler.
   */
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
   * Request completions for the given context.
   * Invokes all matching handlers, collects results, and merges them.
   * Async handlers are subject to the timeout -- late results are dropped.
   * Errors are logged to debug only and never thrown.
   *
   * @param ctx - The completion context.
   * @param timeoutMs - Timeout in milliseconds for async handlers (default: 200).
   * @returns Array of completion options from all matching handlers.
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

    // Invoke all matching handlers concurrently with timeout
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
    for (const options of results) {
      if (options && options.length > 0) {
        allResults.push(...options);
      }
    }

    return allResults;
  }

  /**
   * Invoke a handler with a timeout.
   * @param handler - The handler function.
   * @param ctx - The completion context.
   * @param timeoutMs - Timeout in milliseconds.
   * @returns Handler result, or empty array if timed out.
   * @throws If the handler throws (before timeout).
   */
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

  /**
   * Get the number of registered handlers.
   */
  handlerCount(): number {
    return this.#registrations.length;
  }

  /**
   * Remove all registered handlers.
   */
  clear(): void {
    this.#registrations = [];
  }
}

/**
 * Create a new CompletionService instance.
 */
export function createCompletionService(): CompletionService {
  return new CompletionService();
}
