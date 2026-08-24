import { AgentError } from "../../core/error.ts";
import { Message } from "../../core/context/message.ts";

export { Message };

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentMessages: number;
  targetTokens?: number;
  contextLimit?: number;
}

export interface CompactResult {
  summary: string | null;
  messagesCompacted: number;
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
