import { MessageLog } from "./message-log.ts";
import { Message } from "./message.ts";
import { TokenTracker, type TokenUsage, type RawUsage } from "../token-tracker.ts";
import { SystemPromptBuilder, type AgentConfigForPrompt } from "./system-prompt.ts";
import { estimateContextTokens } from "../../extensions/compaction/utils.ts";

// Minimal hook surface for system prompt building; avoids coupling to the full HookSystem type.
export interface HookPipelineRunner {
  runHookPipeline(
    hookName: string,
    data: unknown,
  ): Promise<{ results: Array<{ result: unknown; source: string | null }> }>;
}

// Composes MessageLog, TokenTracker, and SystemPromptBuilder behind a thin interface.
export class ContextManager {
  #log: MessageLog;
  #tokenTracker: TokenTracker;
  #systemPromptBuilder: SystemPromptBuilder;

  constructor(templatePath?: string) {
    this.#log = new MessageLog();
    this.#tokenTracker = new TokenTracker();
    this.#systemPromptBuilder = new SystemPromptBuilder(templatePath);
  }

  addMessage(msg: Message): void {
    this.#log.push(msg);
  }

  getMessages(): Message[] {
    return this.#log.getAll();
  }

  /** Compaction writes back compacted messages via this. */
  replaceMessages(messages: Message[]): void {
    this.#log.replace(messages);
  }

  clear(): void {
    this.#log.clear();
    this.#tokenTracker.clear();
    this.#systemPromptBuilder.clear();
  }

  get length(): number {
    return this.#log.length;
  }

  getSystem(): Message[] {
    return this.#log.getSystem();
  }

  getNonSystem(): Message[] {
    return this.#log.getNonSystem();
  }

  async ensureSystemPrompt(
    hooks: HookPipelineRunner,
    agent: unknown,
    config: AgentConfigForPrompt,
  ): Promise<string> {
    return this.#systemPromptBuilder.ensureBuilt(hooks, agent, config);
  }

  getSystemPrompt(): string | null {
    return this.#systemPromptBuilder.getPrompt();
  }

  clearSystemPrompt(): void {
    this.#systemPromptBuilder.clear();
  }

  recordUsage(rawUsage: RawUsage | null | undefined, onRecorded?: (usage: TokenUsage) => void): void {
    this.#tokenTracker.record(rawUsage, onRecorded);
  }

  getTokenUsage(): TokenUsage {
    return this.#tokenTracker.getUsage();
  }

  /** chars/4 heuristic; defaults to the current log. */
  estimateTokens(messages?: Message[]): number {
    const msgs = messages ?? this.#log.getAll();
    return estimateContextTokens(msgs);
  }

  buildForLlmCall(): Message[] {
    const systemPrompt = this.#systemPromptBuilder.getPrompt();
    return this.#log.buildMessages(systemPrompt);
  }

  /** @internal For testing/migration. */
  get log(): MessageLog {
    return this.#log;
  }
}

export function createContextManager(templatePath?: string): ContextManager {
  return new ContextManager(templatePath);
}
