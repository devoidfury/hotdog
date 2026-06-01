// Hook system — the foundation for the extension architecture.
// Extensions register handlers via `on()`, core emits events via `emit()`.
// Sync hooks run synchronously; async hooks run via `emitAsync()` and errors
// don't stop the chain (each handler is wrapped in try/catch).

export class HookSystem {
  constructor() {
    this._hooks = new Map();
  }

  /**
   * Register a handler for a hook.
   * @param {string} hookName - The hook name (e.g., "context:message").
   * @param {Function} handler - Function(data) or async Function(data).
   */
  on(hookName, handler) {
    if (!this._hooks.has(hookName)) this._hooks.set(hookName, []);
    this._hooks.get(hookName).push(handler);
  }

  /**
   * Emit a sync hook — all handlers run synchronously.
   * If any handler returns a value, that value is returned (for short-circuit patterns).
   * @param {string} hookName
   * @param {*} data
   * @returns {*} Last handler return value, or undefined.
   */
  emit(hookName, data) {
    const handlers = this._hooks.get(hookName) || [];
    let lastResult;
    for (const handler of handlers) {
      const result = handler(data);
      if (result !== undefined) lastResult = result;
    }
    return lastResult;
  }

  /**
   * Emit an async hook — all handlers run concurrently.
   * Errors in individual handlers are caught and logged, never propagated.
   * @param {string} hookName
   * @param {*} data
   * @returns {Promise<void>}
   */
  async emitAsync(hookName, data) {
    const handlers = this._hooks.get(hookName) || [];
    const results = [];
    for (const handler of handlers) {
      try {
        const result = handler(data);
        if (result && typeof result.then === 'function') {
          results.push(result.catch((e) => {
            console.error(`[hook:${hookName}] ${e.message}`);
          }));
        }
      } catch (e) {
        console.error(`[hook:${hookName}] ${e.message}`);
      }
    }
    await Promise.all(results);
  }

  /**
   * Emit an async hook sequentially — handlers run one at a time.
   * Errors in individual handlers are caught and logged, never propagated.
   * @param {string} hookName
   * @param {*} data
   * @returns {Promise<void>}
   */
  async emitAsyncSeq(hookName, data) {
    const handlers = this._hooks.get(hookName) || [];
    for (const handler of handlers) {
      try {
        const result = handler(data);
        if (result && typeof result.then === 'function') {
          await result;
        }
      } catch (e) {
        console.error(`[hook:${hookName}] ${e.message}`);
      }
    }
  }

  /**
   * Remove all handlers for a hook (or all hooks if no name given).
   * @param {string} [hookName] - Optional hook name to clear.
   */
  clear(hookName) {
    if (hookName) {
      this._hooks.delete(hookName);
    } else {
      this._hooks.clear();
    }
  }

  /**
   * Get the number of registered handlers for a hook.
   * @param {string} hookName
   * @returns {number}
   */
  handlerCount(hookName) {
    return (this._hooks.get(hookName) || []).length;
  }

  /**
   * Get all registered hook names.
   * @returns {string[]}
   */
  hookNames() {
    return Array.from(this._hooks.keys());
  }
}

/**
 * Standard hook names used by the core.
 * Each entry documents the hook name and the shape of its data payload.
 */
export const HOOKS = {
  // Session lifecycle
  SESSION_CREATE:     'session:create',
  SESSION_SWAP:       'session:swap',
  SESSION_SERIALIZE:  'session:serialize',
  SESSION_DESERIALIZE:'session:deserialize',

  // Agent run loop
  AGENT_BEFORE_RUN:   'agent:beforeRun',
  AGENT_AFTER_RUN:    'agent:afterRun',
  AGENT_CANCELLED:    'agent:cancelled',

  // Message flow
  MESSAGES_BUILD:     'messages:build',
  MESSAGES_AFTER_LLM: 'messages:afterLLM',

  // Tool execution
  TOOLS_REGISTER:     'tools:register',
  TOOL_BEFORE_EXECUTE:'tool:beforeExecute',
  TOOL_AFTER_EXECUTE: 'tool:afterExecute',

  // Context management
  CONTEXT_FULL:       'context:full',
  CONTEXT_MESSAGE:    'context:message',

  // System prompt
  SYSTEM_PROMPT_BUILD:'systemPrompt:build',

  // Commands
  COMMAND_DISPATCH:   'command:dispatch',

  // Output
  OUTPUT_EVENT:       'output:event',
};

/**
 * Create a new HookSystem instance.
 * @returns {HookSystem}
 */
export function createHooks() {
  return new HookSystem();
}
