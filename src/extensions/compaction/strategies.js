// Compaction Strategy Registry and Base Class
// Provides the strategy interface and registry for managing compaction strategies.

import { AgentError } from "../../core/error.js";

/**
 * Base class for all compaction strategies.
 * All strategies must extend this and implement `execute()`.
 */
export class CompactionStrategy {
  /** @type {string} - Unique strategy identifier (e.g., "summarize", "drop"). */
  name = 'base';

  /** @type {string} - Human-readable description for help output. */
  description = 'Base compaction strategy.';

  /**
   * Execute the compaction strategy.
   *
   * @param {Array} messages - Array of message objects (plain JS, not Message instances).
   * @param {object} settings - Compaction settings.
   * @param {boolean} settings.enabled - Whether compaction is enabled.
   * @param {number} settings.reserveTokens - Token reserve to maintain.
   * @param {number} settings.keepRecent - Number of recent message pairs to keep.
   * @param {number} [settings.targetTokens] - Target token count (for token-aware strategy).
   * @param {Function} llmChat - Async LLM chat function: (messages, model) => string.
   * @param {string} model - Model name to use for LLM calls.
   * @returns {Promise<CompactResult>} Result of compaction.
   */
  async execute(messages, settings, llmChat, model) {
    throw AgentError.NotImplemented();
  }

  /**
   * Check if compaction is applicable for the given message set.
   * Override for strategies with special preconditions.
   *
   * @param {Array} messages - Current messages.
   * @param {object} settings - Compaction settings.
   * @returns {boolean} True if compaction should proceed.
   */
  canCompact(messages, settings) {
    return messages.length > (settings.keepRecent || 3) * 2;
  }
}

/**
 * CompactionStrategyRegistry — holds and manages compaction strategies.
 * Follows the ToolRegistry pattern for consistency.
 */
export class CompactionStrategyRegistry {
  constructor() {
    this._strategies = new Map();
  }

  /**
   * Register a strategy.
   * @param {CompactionStrategy} strategy
   */
  register(strategy) {
    if (!strategy.name) {
      throw new AgentError("Strategy must have a name property");
    }
    this._strategies.set(strategy.name, strategy);
  }

  /**
   * Get a strategy by name.
   * @param {string} name
   * @returns {CompactionStrategy|undefined}
   */
  get(name) {
    return this._strategies.get(name);
  }

  /**
   * Check if a strategy exists.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this._strategies.has(name);
  }

  /**
   * Get all registered strategies.
   * @returns {Array<CompactionStrategy>}
   */
  getAll() {
    return Array.from(this._strategies.values());
  }

  /**
   * Get the default strategy.
   * @returns {CompactionStrategy}
   */
  getDefault() {
    return this._strategies.get('summarize');
  }
}
