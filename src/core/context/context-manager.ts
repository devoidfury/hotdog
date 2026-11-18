import { MessageLog } from "./message-log.ts";
import { Message } from "./message.ts";
import { TokenTracker, type TokenUsage, type RawUsage } from "../token-tracker.ts";
import { SystemPromptBuilder, type AgentConfigForPrompt } from "./system-prompt.ts";
import { estimateContextTokens } from "@utils/token-estimate.ts";

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

  /**
   * @param template - Loaded system prompt template text (from buildConfig's resolved config).
   *   Omitted only by standalone callers.
   */
  constructor(template?: string) {
    this.#log = new MessageLog();
    this.#tokenTracker = new TokenTracker();
    this.#systemPromptBuilder = new SystemPromptBuilder(template);
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

  /**
   * Image-inclusive chars/4 estimate of the FULL outgoing request context
   * (system prompt + log). The ctx consumers bill this against the
   * provider-reported number with a max(): some providers exclude image
   * payloads from reported usage (2026-11-18 incident: 66,569 reported vs
   * a >262,144 request once the ~7.9 MB of base64 screenshots were billed),
   * so neither source alone is a trustworthy gauge -- the larger of the two
   * is the honest floor.
   */
  estimateRequestTokens(): number {
    return estimateContextTokens(this.buildForLlmCall());
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

export function createContextManager(template?: string): ContextManager {
  return new ContextManager(template);
}
