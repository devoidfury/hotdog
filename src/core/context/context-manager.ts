// ContextManager — unified conversation context management.
//
// Composes MessageLog, TokenTracker, and SystemPromptBuilder into a single
// module with a thin public interface. Owns message storage, token tracking,
// system prompt lifecycle, and building the final message array for LLM calls.
//
// Compaction remains an extension that hooks into the agent and uses
// ContextManager's public methods (getMessages, replaceMessages, estimateTokens).

import { MessageLog } from "./message-log.ts";
import { Message } from "./message.ts";
import { TokenTracker, type TokenUsage, type RawUsage } from "../token-tracker.ts";
import { SystemPromptBuilder, type AgentConfigForPrompt } from "./system-prompt.ts";
import { estimateContextTokens } from "../../extensions/compaction/utils.ts";

/**
 * Minimal hook interface needed for system prompt building.
 * Extracted to avoid coupling ContextManager to the full HookSystem type.
 */
export interface HookPipelineRunner {
  runHookPipeline(
    hookName: string,
    data: unknown,
  ): Promise<{ results: Array<{ result: unknown; source: string | null }> }>;
}

/**
 * Unified conversation context manager.
 *
 * Responsibilities:
 * - Message storage (via MessageLog)
 * - Token usage tracking (via TokenTracker)
 * - System prompt building and caching (via SystemPromptBuilder)
 * - Building the final message array for LLM calls
 * - Token estimation (via compaction utility)
 *
 * Compaction is handled externally by the compaction extension, which uses:
 * - getMessages() to read current messages
 * - replaceMessages() to write compacted messages
 * - estimateTokens() to check token counts
 */
export class ContextManager {
  #log: MessageLog;
  #tokenTracker: TokenTracker;
  #systemPromptBuilder: SystemPromptBuilder;

  constructor(templatePath?: string) {
    this.#log = new MessageLog();
    this.#tokenTracker = new TokenTracker();
    this.#systemPromptBuilder = new SystemPromptBuilder(templatePath);
  }

  // ── Message Storage ──────────────────────────────────────────────────────

  /**
   * Add a message to the conversation log.
   * @param msg — Message to add.
   */
  addMessage(msg: Message): void {
    this.#log.push(msg);
  }

  /**
   * Get a defensive copy of all messages.
   * @returns Copy of the message array.
   */
  getMessages(): Message[] {
    return this.#log.getAll();
  }

  /**
   * Replace the entire message array.
   * Used by compaction extensions to write back compacted messages.
   * @param messages — New message array (all elements must be Message instances).
   */
  replaceMessages(messages: Message[]): void {
    this.#log.replace(messages);
  }

  /**
   * Clear all messages from the log.
   */
  clear(): void {
    this.#log.clear();
    this.#tokenTracker.clear();
    this.#systemPromptBuilder.clear();
  }

  /**
   * Get the number of messages in the log.
   */
  get length(): number {
    return this.#log.length;
  }

  /**
   * Get system messages (role === 'system').
   * @returns Copy of system messages.
   */
  getSystem(): Message[] {
    return this.#log.getSystem();
  }

  /**
   * Get non-system messages (role !== 'system').
   * @returns Copy of non-system messages.
   */
  getNonSystem(): Message[] {
    return this.#log.getNonSystem();
  }

  // ── System Prompt ────────────────────────────────────────────────────────

  /**
   * Ensure the system prompt is built and cached.
   * @param hooks — Hook pipeline runner for collecting prompt chunks.
   * @param agent — Agent instance (passed to hook handlers).
   * @param config — Agent config with role, profileBody, model, profileName.
   * @returns The built system prompt string.
   */
  async ensureSystemPrompt(
    hooks: HookPipelineRunner,
    agent: unknown,
    config: AgentConfigForPrompt,
  ): Promise<string> {
    return this.#systemPromptBuilder.ensureBuilt(hooks, agent, config);
  }

  /**
   * Get the cached system prompt, or null if not yet built.
   * @returns System prompt string or null.
   */
  getSystemPrompt(): string | null {
    return this.#systemPromptBuilder.getPrompt();
  }

  /**
   * Clear the cached system prompt.
   * Used when the profile changes or context is reset.
   */
  clearSystemPrompt(): void {
    this.#systemPromptBuilder.clear();
  }

  // ── Token Tracking ───────────────────────────────────────────────────────

  /**
   * Record token usage from an LLM provider response.
   * @param rawUsage — Raw usage data from the provider.
   * @param onRecorded — Optional callback invoked with updated totals.
   */
  recordUsage(rawUsage: RawUsage | null | undefined, onRecorded?: (usage: TokenUsage) => void): void {
    this.#tokenTracker.record(rawUsage, onRecorded);
  }

  /**
   * Get current token usage stats.
   * @returns Defensive copy of token usage.
   */
  getTokenUsage(): TokenUsage {
    return this.#tokenTracker.getUsage();
  }

  // ── Token Estimation ─────────────────────────────────────────────────────

  /**
   * Estimate token count for messages using chars/4 heuristic.
   * @param messages — Messages to estimate. Defaults to current log if not provided.
   * @returns Estimated token count.
   */
  estimateTokens(messages?: Message[]): number {
    const msgs = messages ?? this.#log.getAll();
    return estimateContextTokens(msgs);
  }

  // ── Build for LLM Call ───────────────────────────────────────────────────

  /**
   * Build the full message array for an LLM call, prepending the system prompt.
   * @returns Message array with system prompt first (if available).
   */
  buildForLlmCall(): Message[] {
    const systemPrompt = this.#systemPromptBuilder.getPrompt();
    return this.#log.buildMessages(systemPrompt);
  }

  // ── Internal Access (for testing / migration) ────────────────────────────

  /**
   * Get the internal MessageLog (for testing and migration).
   * @internal
   */
  get log(): MessageLog {
    return this.#log;
  }
}

/**
 * Create a new ContextManager instance.
 */
export function createContextManager(templatePath?: string): ContextManager {
  return new ContextManager(templatePath);
}
