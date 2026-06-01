// Hook system — the foundation for the extension architecture.
// Extensions register handlers via `on()`, core emits events via `emit()`.
// Sync hooks run synchronously; async hooks run via `emitAsync()` and errors
// don't stop the chain (each handler is wrapped in try/catch).

let _handlerCounter = 0;

export class HookSystem {
  constructor() {
    this._hooks = new Map();
  }

  /**
   * Register a handler for a hook.
   * @param {string} hookName - The hook name (e.g., "context:message").
   * @param {Function} handler - Function(data) or async Function(data).
   * @returns {Function} A removal function that unregisters this handler.
   */
  on(hookName, handler) {
    if (!this._hooks.has(hookName)) this._hooks.set(hookName, []);
    const handlers = this._hooks.get(hookName);
    const id = ++_handlerCounter;
    handlers.push({ id, handler });

    // Return a removal function
    return () => {
      const idx = handlers.findIndex((h) => h.id === id);
      if (idx !== -1) {
        handlers.splice(idx, 1);
      }
    };
  }

  /**
   * Remove a specific handler from a hook by its function reference.
   * @param {string} hookName
   * @param {Function} handler - The exact handler function to remove.
   * @returns {boolean} true if handler was found and removed.
   */
  off(hookName, handler) {
    const handlers = this._hooks.get(hookName);
    if (!handlers) return false;
    const idx = handlers.findIndex((h) => h.handler === handler);
    if (idx !== -1) {
      handlers.splice(idx, 1);
      return true;
    }
    return false;
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
    for (const entry of handlers) {
      const result = entry.handler(data);
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
    for (const entry of handlers) {
      try {
        const result = entry.handler(data);
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
    for (const entry of handlers) {
      try {
        const result = entry.handler(data);
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
  SESSION_RESTORE_ACTIVE: 'session:restoreActive',

  // Agent run loop
  AGENT_BEFORE_RUN:   'agent:beforeRun',
  AGENT_AFTER_RUN:    'agent:afterRun',
  AGENT_CANCELLED:    'agent:cancelled',

  // Tool context enrichment — extensions add fields to tool context
  AGENT_TOOL_CONTEXT: 'agent:toolContext',

  // Model changes
  MODEL_CHANGE:       'model:change',

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
  COMMAND_DISPATCH:        'command:dispatch',
  SLASH_COMMANDS_REGISTER: 'slashCommands:register',

  // Output
  OUTPUT_EVENT:       'output:event',

  // Shutdown — extensions register cleanup handlers here
  SHUTDOWN_CLEANUP:   'shutdown:cleanup',

  // CLI subcommand registration — extensions register subcommand handlers here
  CLI_SUBCOMMANDS_REGISTER: 'cli:subcommandsRegister',

  // Compaction — extension exposes strategy list and current setting
  COMPACT_STRATEGY_LIST: 'compact:strategyList',
  COMPACT_STRATEGY_SET: 'compact:strategySet',

  // Config — extensions register their CLI flags and config params
  CONFIG_CLI_FLAGS_REGISTER: 'config:cliFlagsRegister',
  CONFIG_PARAMS_REGISTER: 'config:paramsRegister',
};

/**
 * Extension capability constants.
 * Extensions can export a `provides` array declaring what they offer.
 */
export const EXTENSION_PROVIDES = {
  CLI_SUBCOMMANDS: 'cli:subcommands',  // Extension provides CLI subcommands
  TOOLS: 'tools',                      // Extension provides tools
};

/**
 * Create a new HookSystem instance.
 * @returns {HookSystem}
 */
export function createHooks() {
  return new HookSystem();
}
