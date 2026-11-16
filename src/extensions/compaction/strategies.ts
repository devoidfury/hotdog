import { AgentError, ConfigError } from "@core/error.ts";
import { Message } from "@core/context/message.ts";
import type { WireRenderContext } from "./utils.ts";

export { Message };

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentMessages: number;
  /**
   * Context window size in tokens. The caller (compaction extension)
   * resolves this per run: explicit compaction.contextLimit, else the
   * EFFECTIVE model window (resolveModelConfig -- the same value the
   * shouldCompact trigger bills), else (views with no agent context) the
   * core contextLimit. Strategies must never guess it. Guard with
   * requireContextLimit().
   */
  contextLimit?: number;
  /**
   * System-notice text appended by pass-the-baton. Threaded through the
   * settings so strategies see the configured value; the schema default
   * lives in extension.json, BATON_NOTICE_PROMPT is the code-side fallback.
   */
  batonNoticePrompt?: string;
  /**
   * Runtime directive (injected by callers, NEVER a config key): pop the
   * tail immediately even with no baton notice in the context. The
   * PROVIDER_ERROR overflow rescue sets it (the full-size request already
   * failed; there is no room for notice-first), and so does a manual
   * /compact -- a user command orders compaction, not a wrap-up notice.
   */
  batonPopNow?: boolean;
}

/**
 * Resolve a positive context budget, failing loudly otherwise. Strategies
 * must not fall back to a hardcoded or model-name-derived window size:
 * a missing value is a config resolution bug and guessing masks it.
 */
export function requireContextLimit(limit: number | string | undefined): number {
  const num = typeof limit === "string" ? Number(limit) : limit;
  if (typeof num !== "number" || !Number.isFinite(num) || num <= 0) {
    throw new ConfigError(
      `Compaction requires a positive contextLimit in tokens (got ${limit === undefined ? "undefined" : String(limit)}). ` +
        `Set compaction.contextLimit or the core contextLimit.`,
    );
  }
  return num;
}

export interface CompactResult {
  summary: string | null;
  messagesCompacted: number;
  /**
   * Which side `messagesCompacted` counts from. Omitted / "front": the
   * oldest N are removed and the kept window is messages.slice(N).
   * "tail": the newest N are popped and the kept window is
   * messages.slice(0, length - N) — a strict prefix of the previous
   * prompt, so prefix-cached runners re-read it from cache.
   */
  keepFrom?: "front" | "tail";
  /**
   * Harness system-notice text appended after the kept window
   * (pass-the-baton orders the model to wrap up and hand off).
   */
  appendNotice?: string | null;
  /**
   * Messages the tail-cut hands to the extension's stash for replay into
   * the continuation session (pass-the-baton): the popped tail on a pop,
   * or the current recent window on a notice-only append (nothing has
   * popped yet, but a handoff this turn must still have verbatim recents
   * to replay). The notice itself never rides. Mirrored to the live baton
   * map and the <session-id>.baton.json file; the TURN_END paths arm the
   * CONTEXT-hook replay with it.
   */
  batonStash?: Message[];
  metadata?: Record<string, unknown>;
}

export class CompactionStrategy {
  name: string = "base";
  description: string = "Base compaction strategy.";

  async execute(
    _messages: Message[],
    _settings: CompactionSettings,
    _llmChat: (messages: Array<{ role: string; content: string }>, model: string) => Promise<string>,
    _model: string,
    _wire?: WireRenderContext | null,
  ): Promise<CompactResult | null> {
    throw AgentError.NotImplemented();
  }

  // Default precondition: enough messages beyond the keep-recent window.
  canCompact(messages: Message[], settings: CompactionSettings): boolean {
    return messages.length > settings.keepRecentMessages * 2;
  }
}

// Mirrors the ToolRegistry pattern for consistency.
export class CompactionStrategyRegistry {
  #strategies: Map<string, CompactionStrategy> = new Map();

  register(strategy: CompactionStrategy): void {
    if (!strategy.name) {
      throw new AgentError("Strategy must have a name property");
    }
    this.#strategies.set(strategy.name, strategy);
  }

  get(name: string): CompactionStrategy | undefined {
    return this.#strategies.get(name);
  }

  has(name: string): boolean {
    return this.#strategies.has(name);
  }

  getAll(): CompactionStrategy[] {
    return Array.from(this.#strategies.values());
  }

  getDefault(): CompactionStrategy | undefined {
    return this.#strategies.get("summarize");
  }
}
