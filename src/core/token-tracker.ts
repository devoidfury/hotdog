// TokenTracker — accumulates and reports LLM token usage per session.
//
// Tracks both accumulated session totals and the most recent call values
// from the provider. Real prompt tokens are computed as (prompt - cached)
// since cached tokens are free.

/**
 * Token usage stats for a session.
 *
 * Accumulated totals (session-wide):
 *   - sessionPromptTokens: net prompt tokens (raw - cached), accumulated
 *   - sessionCachedTokens: cached prompt tokens, accumulated
 *   - sessionCompletionTokens: completion tokens, accumulated
 *   - sessionTotalTokens: total tokens, accumulated
 *   - turns: number of LLM calls
 *
 * Most recent call values (from the provider's last response):
 *   - promptTokens: net prompt tokens for last call
 *   - cachedTokens: cached tokens for last call
 *   - completionTokens: completion tokens for last call
 *   - totalTokens: total tokens for last call
 */
export interface TokenUsage {
  sessionPromptTokens: number;
  sessionCachedTokens: number;
  sessionCompletionTokens: number;
  sessionTotalTokens: number;
  turns: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  [key: string]: number | undefined;
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
  sessionPromptTokens: 0,
  sessionCachedTokens: 0,
  sessionCompletionTokens: 0,
  sessionTotalTokens: 0,
  turns: 0,
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
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
   * Internal marker symbol to prevent double-counting.
   */
  static readonly DID_EMIT = Symbol("hotdog.tokenTracker.didEmit");

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
  record(rawUsage: RawUsage | null | undefined, onRecorded?: OnUsageCallback): void {
    if (!rawUsage) return;

    // Guard against double-counting: the same response object may be
    // processed multiple times (e.g., hooks re-reading the object).
    if ((rawUsage as Record<typeof TokenTracker.DID_EMIT, boolean>)[TokenTracker.DID_EMIT]) return;
    (rawUsage as Record<typeof TokenTracker.DID_EMIT, boolean>)[TokenTracker.DID_EMIT] = true;

    // Parse per-call values from the provider.
    const promptTokens = rawUsage.prompt_tokens ?? 0;
    const cachedTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? 0;
    const completionTokens = rawUsage.completion_tokens ?? 0;
    const totalTokens = rawUsage.total_tokens ?? 0;

    // Accumulate session totals. Real prompt = prompt - cached (cached tokens are free).
    this.#usage.sessionPromptTokens += promptTokens - cachedTokens;
    this.#usage.sessionCachedTokens += cachedTokens;
    this.#usage.sessionCompletionTokens += completionTokens;
    this.#usage.sessionTotalTokens += totalTokens;
    this.#usage.turns += 1;

    // Save most recent call values for reference.
    this.#usage.promptTokens = promptTokens - cachedTokens;
    this.#usage.cachedTokens = cachedTokens;
    this.#usage.completionTokens = completionTokens;
    this.#usage.totalTokens = totalTokens;

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
