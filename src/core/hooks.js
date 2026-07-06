// Hook system — the foundation for the extension architecture.
// Extensions register handlers via `on()`. The core notifies hooks via:
//   notifyHooks(hookName, data)         — sync,  fire-and-forget
//   notifyHooksAsync(hookName, data)    — async, fire-and-forget (concurrent)
//   runHookPipeline(hookName, data, opts?) — async, sequential, returns results

import { formatError } from "./error.js";
import { logger } from "./logger.js";

// ── Trace Helpers ────────────────────────────────────────────────────────────

/**
 * Summarize a hook handler return value for trace output.
 * Keeps output short and readable while showing the action taken.
 */
function _summarizeResult(value) {
  if (value == null) return "null";
  // Error objects — show the message, not internal properties
  if (value instanceof Error) return `Error: ${value.message}`;
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  const keys = Object.keys(value);
  if (keys.length === 0) return "{}";
  // Show action field first if present (common for gate hooks)
  if ("action" in value) {
    const action = JSON.stringify(value.action);
    const extra = keys.filter((k) => k !== "action");
    if (extra.length === 0) return `{ action: ${action} }`;
    return `{ action: ${action}, ${extra.join(", ")} }`;
  }
  // Generic object summary
  if (keys.length <= 3) return `{ ${keys.join(", ")} }`;
  return `{ ${keys.slice(0, 3).join(", ")}, +${keys.length - 3} }`;
}

export class HookSystem {
  constructor() {
    this._hooks = new Map();
    this._trace = false;
    this._handlerCounter = 0;
  }

  /**
   * Register a handler for a hook.
   * @param {string} hookName - The hook name (e.g., "context:message").
   * @param {Function} handler - Function(data) or async Function(data).
   * @param {string} [source] - Optional source identifier (e.g., extension name).
   *   Used for tracking which extension registered a handler.
   * @returns {Function} A removal function that unregisters this handler.
   */
  on(hookName, handler, source) {
    if (!this._hooks.has(hookName)) this._hooks.set(hookName, []);
    const handlers = this._hooks.get(hookName);
    const id = ++this._handlerCounter;
    handlers.push({ id, handler, source });

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
   * Notify hooks synchronously (fire-and-forget).
   * All handlers run synchronously in order. Return values are ignored.
   * @param {string} hookName
   * @param {*} data
   */
  notifyHooks(hookName, data) {
    const handlers = this._hooks.get(hookName) || [];
    const doTrace = this._trace && hookName !== "log";
    for (let i = 0; i < handlers.length; i++) {
      const entry = handlers[i];
      const t0 = doTrace ? Date.now() : 0;
      entry.handler(data);
      if (doTrace) {
        const ms = Date.now() - t0;
        const label = entry.source ? ` (${entry.source})` : "";
        logger.debug(
          `[hook:trace] ${hookName} — ${i + 1}/${handlers.length}${label} — ${ms}ms`,
        );
      }
    }
  }

  /**
   * Notify hooks asynchronously (fire-and-forget, concurrent).
   * All handlers launch concurrently. Errors are caught and logged.
   * @param {string} hookName
   * @param {*} data
   * @returns {Promise<void>}
   */
  async notifyHooksAsync(hookName, data) {
    const handlers = this._hooks.get(hookName) || [];
    const promises = [];
    const doTrace = this._trace && hookName !== "log";
    if (doTrace && handlers.length > 0) {
      logger.debug(
        `[hook:trace] ${hookName} — ${handlers.length} handler(s) fired concurrently`,
      );
    }
    for (let i = 0; i < handlers.length; i++) {
      const entry = handlers[i];
      const t0 = doTrace ? Date.now() : 0;
      try {
        const result = entry.handler(data);
        if (result && typeof result.then === "function") {
          promises.push(
            result.then(
              (v) => {
                if (doTrace) {
                  const ms = Date.now() - t0;
                  const label = entry.source ? ` (${entry.source})` : "";
                  logger.debug(
                    `[hook:trace] ${hookName} — handler${label} — ${ms}ms`,
                  );
                }
              },
              (e) => {
                if (doTrace) {
                  const ms = Date.now() - t0;
                  const label = entry.source ? ` (${entry.source})` : "";
                  logger.debug(
                    `[hook:trace] ${hookName} — handler${label} — ${ms}ms — error`,
                  );
                }
                logger.error(`[hook:${hookName}] ${formatError(e)}`);
              },
            ),
          );
        } else if (doTrace) {
          const ms = Date.now() - t0;
          const label = entry.source ? ` (${entry.source})` : "";
          logger.debug(
            `[hook:trace] ${hookName} — handler${label} — ${ms}ms (sync)`,
          );
        }
      } catch (e) {
        if (doTrace) {
          const ms = Date.now() - t0;
          const label = entry.source ? ` (${entry.source})` : "";
          logger.debug(
            `[hook:trace] ${hookName} — handler${label} — ${ms}ms — error`,
          );
        }
        logger.error(`[hook:${hookName}] ${formatError(e)}`);
      }
    }
    await Promise.all(promises);
  }

  /**
   * Run a hook pipeline sequentially.
   * Handlers run one at a time, each seeing the accumulated state.
   *
   * @param {string} hookName
   * @param {*} data — Mutable data object passed to each handler.
   * @param {Object} [opts]
   * @param {Function} [opts.shouldStop] — Called with each handler's return value.
   *   Return true to stop processing further handlers.
   * @returns {Promise<{ results: Array<{result: *, source: string|null}>, lastResult: *, stopped: boolean, data: * }>}
   *   results — all non-undefined return values from handlers
   *   lastResult — the last handler's return value (or undefined)
   *   stopped — true if shouldStop caused early termination
   *   data — the (possibly mutated) data object
   */
  async runHookPipeline(hookName, data, opts = {}) {
    const handlers = this._hooks.get(hookName) || [];
    const results = [];
    let lastResult;
    let stopped = false;
    const doTrace = this._trace && hookName !== "log";
    for (let i = 0; i < handlers.length; i++) {
      const entry = handlers[i];
      const t0 = doTrace ? Date.now() : 0;
      try {
        const result = entry.handler(data);
        const resolved =
          result && typeof result.then === "function" ? await result : result;
        if (resolved !== undefined) {
          results.push({ result: resolved, source: entry.source || null });
          lastResult = resolved;
        }
        if (doTrace) {
          const ms = Date.now() - t0;
          const label = entry.source ? ` (${entry.source})` : "";
          const action =
            resolved !== undefined
              ? ` returned ${_summarizeResult(resolved)}`
              : " no return";
          logger.debug(
            `[hook:trace] ${hookName} — ${i + 1}/${handlers.length}${label} — ${ms}ms${action}`,
          );
        }
        if (opts.shouldStop && resolved && opts.shouldStop(resolved)) {
          stopped = true;
          if (doTrace) {
            logger.debug(
              `[hook:trace] ${hookName} — stopped at handler ${i + 1}/${handlers.length}`,
            );
          }
          break;
        }
      } catch (e) {
        if (doTrace) {
          const ms = Date.now() - t0;
          const label = entry.source ? ` (${entry.source})` : "";
          logger.debug(
            `[hook:trace] ${hookName} — ${i + 1}/${handlers.length}${label} — ${ms}ms — error`,
          );
        }
        logger.error(`[hook:${hookName}] ${formatError(e)}`);
      }
    }
    return { results, lastResult, stopped, data };
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
  SESSION_CREATE: "session:create",
  SESSION_SWAP: "session:swap",
  SESSION_SERIALIZE: "session:serialize",
  SESSION_DESERIALIZE: "session:deserialize",
  SESSION_RESTORE_ACTIVE: "session:restoreActive",

  // Tool context enrichment — extensions add fields to tool context
  AGENT_TOOL_CONTEXT: "agent:toolContext",

  // Model changes
  MODEL_CHANGE: "model:change",

  // Message flow
  MESSAGES_AFTER_LLM: "messages:afterLLM",

  // Tool execution
  TOOLS_REGISTER: "tools:register",
  TOOL_BEFORE_EXECUTE: "tool:beforeExecute",

  // Service registration — extensions register abstract service implementations here.
  // Fired synchronously during extension load so services are available to
  // downstream extensions. Handler receives the ServiceRegistry instance.
  SERVICES_REGISTER: "services:register",
  TOOL_AFTER_EXECUTE: "tool:afterExecute",
  LOOP_DETECTED: "loop:detected",

  // Context management
  CONTEXT_MESSAGE: "context:message",
  CONTEXT_REPLACED: "context:replaced",

  // System prompt — handlers return a chunk object { name, priority, content }
  // or an array of chunk objects. The agent collects all chunks, sorts by priority,
  // and renders them into the system prompt template.
  SYSTEM_PROMPT_BUILD: "systemPrompt:build",

  // Commands — generic command system (not UI-specific)
  COMMAND_DISPATCH: "command:dispatch",
  COMMANDS_REGISTER: "commands:register",

  // Output
  OUTPUT_EVENT: "output:event",

  // Shutdown — extensions register cleanup handlers here
  SHUTDOWN_CLEANUP: "shutdown:cleanup",

  // CLI subcommand registration — extensions register subcommand handlers here
  CLI_SUBCOMMANDS_REGISTER: "cli:subcommandsRegister",

  // CLI — emitted after CLI args are parsed, before subcommand dispatch
  CLI_ARGS_PARSED: "cli:argsParsed",

  // Input preprocessing — run before user input reaches the agent.
  // Handlers can transform the text, attach images, or short-circuit entirely.
  // Result: { action: "continue" } | { action: "transform", text, images? } | { action: "handled" }
  // Uses runHookPipeline with shouldStop to stop on "handled".
  INPUT: "input",

  // Context modification — run sequentially before each LLM call.
  // Handlers receive { messages, agent } and can return { messages } to replace.
  // Runs via runHookPipeline so each handler sees prior transformations.
  CONTEXT: "context",

  // Tool call gate — BLOCK or MUTATE tool input arguments before execution.
  // Run sequentially via runHookPipeline. Handlers receive
  // { toolCallId, toolName, input, agent } and can return:
  //   { action: "continue" }       — proceed with original input
  //   { action: "modify", input }  — proceed with modified input
  //   { action: "block", result }  — skip execution, use provided result
  TOOL_CALL: "tool:call",

  // Tool result — MODIFY tool output before it reaches the LLM context.
  // Run sequentially via runHookPipeline. Handlers receive
  // { toolCallId, toolName, result, input, agent } and can return:
  //   { result } — replace the result (any value: string, ToolResult, object)
  TOOL_RESULT: "tool:result",

  // Provider request — run sequentially BEFORE the HTTP request to the LLM.
  // Handlers receive { messages, modelConfig, toolDefs, agent } and can return:
  //   { messages } — replace the messages array
  //   { modelConfig } — replace the model config
  //   { toolDefs } — replace the tool definitions
  // Runs via runHookPipeline so each handler sees prior transformations.
  // Enables: request logging, last-minute message injection, request modification.
  PROVIDER_REQUEST: "provider:request",

  // Provider response — emitted AFTER the LLM response is fully received.
  // Handlers receive { response, modelConfig, agent } as notification.
  // Enables: response logging, metrics, cost tracking, telemetry.
  PROVIDER_RESPONSE: "provider:response",

  // Turn start — emitted at the beginning of each agent loop iteration.
  // Handlers receive { turnIndex, timestamp, agent } as notification.
  // Enables: per-turn metrics, timing, analytics.
  TURN_START: "turn:start",

  // Turn end — emitted at the end of each agent loop iteration.
  // Handlers receive { turnIndex, message, toolResults, stopped, agent } as notification.
  // - message: the assistant's text response (may be empty if only tool calls)
  // - toolResults: array of { toolName, input, result } for tools executed this turn
  // - stopped: boolean indicating if the agent has finished processing (true) or
  //   will continue to the next iteration (false)
  // Enables: per-turn analysis, cost tracking, audit logging, UI prompt control.
  TURN_END: "turn:end",

  // Logging — emitted by the logger module, intercepted by handlers.
  // Payload: { level: "debug"|"info"|"warn"|"error", message: string, metadata?: object }
  LOG: "log",
};

/**
 * Extension capability constants.
 * Extensions can export a `provides` array declaring what they offer.
 */
export const EXTENSION_PROVIDES = {
  CLI_SUBCOMMANDS: "cli:subcommands", // Extension provides CLI subcommands
  TOOLS: "tools", // Extension provides tools
};

/**
 * Create a new HookSystem instance.
 * @returns {HookSystem}
 */
export function createHooks() {
  return new HookSystem();
}
