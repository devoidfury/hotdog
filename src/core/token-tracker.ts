// Session-wide accumulated totals plus the most recent call's values.
// "Net" prompt tokens = raw - cached, since cached tokens are free.

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

// Shape of the `usage` field in OpenAI-compatible streaming responses.
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

export type OnUsageCallback = (usage: TokenUsage) => void;

export class TokenTracker {
  #usage: TokenUsage;

  constructor() {
    this.#usage = { ...ZERO_USAGE };
  }

  static readonly DID_EMIT = Symbol("hotdog.tokenTracker.didEmit");

  record(rawUsage: RawUsage | null | undefined, onRecorded?: OnUsageCallback): void {
    if (!rawUsage) return;

    // The same response object may be processed more than once (e.g., hooks re-reading it).
    if ((rawUsage as Record<typeof TokenTracker.DID_EMIT, boolean>)[TokenTracker.DID_EMIT]) return;
    (rawUsage as Record<typeof TokenTracker.DID_EMIT, boolean>)[TokenTracker.DID_EMIT] = true;

    const promptTokens = rawUsage.prompt_tokens ?? 0;
    const cachedTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? 0;
    const completionTokens = rawUsage.completion_tokens ?? 0;
    const totalTokens = rawUsage.total_tokens ?? 0;

    this.#usage.sessionPromptTokens += promptTokens - cachedTokens;
    this.#usage.sessionCachedTokens += cachedTokens;
    this.#usage.sessionCompletionTokens += completionTokens;
    this.#usage.sessionTotalTokens += totalTokens;
    this.#usage.turns += 1;

    this.#usage.promptTokens = promptTokens - cachedTokens;
    this.#usage.cachedTokens = cachedTokens;
    this.#usage.completionTokens = completionTokens;
    this.#usage.totalTokens = totalTokens;

    if (onRecorded) {
      onRecorded(this.getUsage());
    }
  }

  getUsage(): TokenUsage {
    return { ...this.#usage };
  }

  clear(): void {
    this.#usage = { ...ZERO_USAGE };
  }
}
