// Compaction Strategy Registry and Base Class
// Provides the strategy interface and registry for managing compaction strategies.

import { AgentError } from "../../core/error.ts";

export interface Message {
  role: string;
  content: string;
  reasoning_content?: string;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecent: number;
  targetTokens?: number;
  contextLimit?: number;
}

export interface CompactResult {
  summary: string | null;
  messagesCompacted: number;
  metadata?: Record<string, unknown>;
}

/**
 * Base class for all compaction strategies.
 * All strategies must extend this and implement `execute()`.
 */
export class CompactionStrategy {
  name: string = "base";
  description: string = "Base compaction strategy.";

  /**
   * Execute the compaction strategy.
   */
  async execute(
    _messages: Message[],
    _settings: CompactionSettings,
    _llmChat: (messages: Array<{ role: string; content: string }>, model: string) => Promise<string>,
    _model: string,
  ): Promise<CompactResult | null> {
    throw AgentError.NotImplemented();
  }

  /**
   * Check if compaction is applicable for the given message set.
   * Override for strategies with special preconditions.
   */
  canCompact(messages: Message[], settings: CompactionSettings): boolean {
    return messages.length > (settings.keepRecent || 3) * 2;
  }
}

/**
 * CompactionStrategyRegistry — holds and manages compaction strategies.
 * Follows the ToolRegistry pattern for consistency.
 */
export class CompactionStrategyRegistry {
  private readonly #strategies: Map<string, CompactionStrategy> = new Map();

  /**
   * Register a strategy.
   */
  register(strategy: CompactionStrategy): void {
    if (!strategy.name) {
      throw new AgentError("Strategy must have a name property");
    }
    this.#strategies.set(strategy.name, strategy);
  }

  /**
   * Get a strategy by name.
   */
  get(name: string): CompactionStrategy | undefined {
    return this.#strategies.get(name);
  }

  /**
   * Check if a strategy exists.
   */
  has(name: string): boolean {
    return this.#strategies.has(name);
  }

  /**
   * Get all registered strategies.
   */
  getAll(): CompactionStrategy[] {
    return Array.from(this.#strategies.values());
  }

  /**
   * Get the default strategy.
   */
  getDefault(): CompactionStrategy | undefined {
    return this.#strategies.get("summarize");
  }
}
