// TokenTracker — accumulates and reports LLM token usage per session.
//
// Tracks both accumulated session totals and the last-reported values
// from the provider. Real prompt tokens are computed as (prompt - cached)
// since cached tokens are free.

/**
 * Token usage stats for a session.
 *
 * Accumulated totals:
 *   - promptTokens: real prompt tokens (prompt - cached), accumulated
 *   - cachedTokens: cached prompt tokens, accumulated
 *   - completionTokens: completion tokens, accumulated
 *   - totalTokens: total tokens, accumulated
 *   - turns: number of LLM calls
 *
 * Last-reported values (from the most recent provider response):
 *   - lastPromptTokens: real prompt tokens for last call
 *   - lastCachedTokens: cached tokens for last call
 *   - lastCompletionTokens: completion tokens for last call
 *   - lastTotalTokens: total tokens for last call
 */
export interface TokenUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  turns: number;
  lastPromptTokens: number;
  lastCachedTokens: number;
  lastCompletionTokens: number;
  lastTotalTokens: number;
  [key: string]: unknown;
}

/**
 * Raw usage data from an LLM provider response.
 * Matches the shape of the `usage` field in OpenAI-compatible streaming responses.
 */
export interface RawUsage {
  prompt_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens?: number;
  total_tokens?: number;
}

const ZERO_USAGE: TokenUsage = {
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  turns: 0,
  lastPromptTokens: 0,
  lastCachedTokens: 0,
  lastCompletionTokens: 0,
  lastTotalTokens: 0,
};

/**
 * Callback invoked when new usage data is recorded.
 * Receives the updated accumulated totals.
 */
export type OnUsageCallback = (usage: TokenUsage) => void;

/**
 * Accumulates LLM token usage across a session.
 *
 * Usage:
 *   const tracker = new TokenTracker();
 *   tracker.record(rawUsageFromProvider, (usage) => emitEvent(usage));
 *   const stats = tracker.getUsage();
 *   tracker.clear(); // reset on context clear
 */
export class TokenTracker {
  #usage: TokenUsage;

  constructor() {
    this.#usage = { ...ZERO_USAGE };
  }

  /**
   * Record token usage from a provider response.
   *
   * Parses the raw usage object, accumulates session totals, and saves
   * the last-reported values. Uses a marker on the usage object to
   * prevent double-counting if the same response object is processed
   * multiple times.
   *
   * @param rawUsage - Raw usage data from the provider, or null/undefined.
   * @param onRecorded - Optional callback invoked with the updated totals.
   */
  record(rawUsage: Record<string, unknown> | null | undefined, onRecorded?: OnUsageCallback): void {
    if (!rawUsage) return;

    // Guard against double-counting: the same response object may be
    // processed multiple times (e.g., hooks re-reading the object).
    if ((rawUsage as Record<string, unknown>).__didEmitTokenUsage) return;
    (rawUsage as Record<string, unknown>).__didEmitTokenUsage = true;

    // Parse per-call values from the provider.
    const promptTokens = (rawUsage.prompt_tokens as number) || 0;
    const cachedTokens =
      ((rawUsage.prompt_tokens_details as Record<string, unknown>)?.cached_tokens as number) || 0;
    const completionTokens = (rawUsage.completion_tokens as number) || 0;
    const totalTokens = (rawUsage.total_tokens as number) || 0;

    // Accumulate session totals. Real prompt = prompt - cached (cached tokens are free).
    this.#usage.promptTokens += promptTokens - cachedTokens;
    this.#usage.cachedTokens += cachedTokens;
    this.#usage.completionTokens += completionTokens;
    this.#usage.totalTokens += totalTokens;
    this.#usage.turns += 1;

    // Save last-reported values for reference.
    this.#usage.lastPromptTokens = promptTokens - cachedTokens;
    this.#usage.lastCachedTokens = cachedTokens;
    this.#usage.lastCompletionTokens = completionTokens;
    this.#usage.lastTotalTokens = totalTokens;

    // Notify caller with updated totals.
    if (onRecorded) {
      onRecorded(this.getUsage());
    }
  }

  /**
   * Get a defensive copy of the current token usage stats.
   * @returns TokenUsage snapshot.
   */
  getUsage(): TokenUsage {
    return { ...this.#usage };
  }

  /**
   * Reset all counters. Called when the context is cleared.
   */
  clear(): void {
    this.#usage = { ...ZERO_USAGE };
  }
}

/**
 * Create a new TokenTracker instance.
 * @returns TokenTracker
 */
export function createTokenTracker(): TokenTracker {
  return new TokenTracker();
}
