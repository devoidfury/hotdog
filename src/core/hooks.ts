// Hook system — the foundation for the extension architecture.
// Extensions register handlers via `on()`. The core notifies hooks via:
//   notifyHooks(hookName, data)         — fire-and-forget (handles both sync and async handlers)
//   runHookPipeline(hookName, data, opts?) — async, sequential, returns results

import { formatError } from "./error.ts";
import { logger } from "./logger.ts";
import { isPromise } from "../utils/promise.ts";

// ── Gate Action Discriminated Unions ─────────────────────────────────────────

/**
 * Result returned by gate hooks (TOOL_CALL, INPUT, etc.).
 * Controls whether processing continues, is modified, or is blocked.
 */
export type GateAction =
  | { action: "continue" }
  | { action: "modify"; input?: string; result?: unknown }
  | { action: "block"; result: unknown }
  | { action: "handled" };

/**
 * Result returned by the CONTEXT hook pipeline.
 * Allows handlers to replace the messages array.
 */
export type ContextHookResult = { messages: unknown[] };

/**
 * Result returned by the PROVIDER_REQUEST hook pipeline.
 * Allows handlers to replace messages, modelConfig, or toolDefs.
 */
export type ProviderRequestHookResult = {
  messages?: unknown[];
  modelConfig?: unknown;
  toolDefs?: unknown[];
};

/**
 * Result returned by the TOOL_RESULT hook pipeline.
 * Allows handlers to replace the tool result before it reaches the LLM.
 */
export type ToolResultHookResult = { result: unknown };

/**
 * Result returned by the INPUT hook pipeline.
 * Allows handlers to transform input text/images or short-circuit entirely.
 */
export type InputHookResult =
  | { action: "continue" }
  | { action: "transform"; text: string; images?: unknown[] }
  | { action: "handled" };

/**
 * Chunk returned by the SYSTEM_PROMPT_BUILD hook.
 * Chunks are sorted by priority and rendered into the system prompt template.
 */
export type SystemPromptChunk = {
  name: string;
  priority: number;
  content: string;
};

// ── Trace Helpers ────────────────────────────────────────────────────────────

/**
 * Summarize a hook handler return value for trace output.
 * Keeps output short and readable while showing the action taken.
 */
function _summarizeResult(value: unknown): string {
  if (value == null) return "null";
  // Error objects — show the message, not internal properties
  if (value instanceof Error) return `Error: ${value.message}`;
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  const keys = Object.keys(value);
  if (keys.length === 0) return "{}";
  // Show action field first if present (common for gate hooks)
  if ("action" in value) {
    const action = JSON.stringify((value as Record<string, unknown>).action);
    const extra = keys.filter((k) => k !== "action");
    if (extra.length === 0) return `{ action: ${action} }`;
    return `{ action: ${action}, ${extra.join(", ")} }`;
  }
  // Generic object summary
  if (keys.length <= 3) return `{ ${keys.join(", ")} }`;
  return `{ ${keys.slice(0, 3).join(", ")}, +${keys.length - 3} }`;
}

import type { HookPayloads } from "./extensions/types.ts";

export interface HookHandlerEntry {
  id: number;
  handler: HookHandlerAny;
  source: string | undefined;
}

/**
 * Hook handler function type, typed by hook name.
 * Uses HookPayloads to derive the correct payload type for each hook.
 * For known hook names, the data parameter is automatically typed.
 * For unknown hook names, data is `unknown`.
 * @template H — The hook name. If it's a key of HookPayloads, data is typed.
 */
export type HookHandler<H extends string> = (
  data: H extends keyof HookPayloads ? HookPayloads[H] : unknown,
) => void | Promise<void> | unknown;

/**
 * Fallback handler type for hooks not in HookPayloads.
 * Used for backward compatibility and custom hooks.
 */
export type HookHandlerAny = (data: unknown) => void | Promise<void> | unknown;

export interface HookPipelineOptions {
  shouldStop?: (result: unknown) => boolean;
}

/**
 * Result of running a hook pipeline.
 * @template R — The expected return type of handlers in this pipeline.
 */
export interface HookPipelineResult<R = unknown> {
  results: Array<{ result: R; source: string | null }>;
  lastResult: R | undefined;
  stopped: boolean;
  data: unknown;
}

export interface HookTraceOptions {
  enabled?: boolean;
  enabledHooks?: string[];
  disabledSources?: string[];
}

export class HookSystem {
  #hooks: Map<string, HookHandlerEntry[]>;
  #trace: boolean | HookTraceOptions;
  #handlerCounter: number;

  constructor() {
    this.#hooks = new Map();
    this.#trace = false;
    this.#handlerCounter = 0;
  }

  /**
   * Register a handler for a hook.
   * @param hookName - The hook name (e.g., "context:message").
   *   When using a known hook name from HookPayloads, the handler's
   *   data parameter is automatically typed.
   * @param handler - Function(data) or async Function(data).
   *   The data parameter is typed based on the hook name.
   * @param source - Optional source identifier (e.g., extension name).
   *   Used for tracking which extension registered a handler.
   * @returns A removal function that unregisters this handler.
   */
  on<H extends string>(
    hookName: H,
    handler: HookHandler<H>,
    source?: string,
  ): () => void {
    if (!this.#hooks.has(hookName)) this.#hooks.set(hookName, []);
    const handlers = this.#hooks.get(hookName)!;
    const id = ++this.#handlerCounter;
    handlers.push({ id, handler: handler as HookHandlerAny, source });

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
   * @param hookName
   * @param handler - The exact handler function to remove.
   * @returns true if handler was found and removed.
   */
  off(hookName: string, handler: HookHandlerAny): boolean {
    const handlers = this.#hooks.get(hookName);
    if (!handlers) return false;
    const idx = handlers.findIndex((h) => h.handler === handler);
    if (idx !== -1) {
      handlers.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Notify hooks (fire-and-forget).
   * All handlers are invoked synchronously in order. Return values are ignored.
   * Handlers may return Promises; these are not awaited but errors are caught and logged.
   * @param hookName - The hook name. Data is type-checked against HookPayloads.
   * @param data - The payload, typed based on the hook name.
   */
  notifyHooks<H extends string>(
    hookName: H,
    data: H extends keyof HookPayloads ? HookPayloads[H] : unknown,
  ): void {
    const handlers = this.#hooks.get(hookName) || [];
    let doTrace = this._shouldTrace(hookName);

    for (let i = 0; i < handlers.length; i++) {
      const entry = handlers[i];
      if (!entry) continue;

      const t0 = doTrace ? Date.now() : 0;
      try {
        const result = entry.handler(data);

        // Check if the handler returned a Promise
        if (isPromise(result)) {
          // Attach error handling to catch async errors without blocking
          (result as Promise<unknown>).then(
            () => {
              if (doTrace && !this._isTraceDisabled(entry.source)) {
                const ms = Date.now() - t0;
                const label = entry.source ? ` (${entry.source})` : "";
                logger.debug(
                  `[hook:trace] ${hookName} — ${i + 1}/${handlers.length}${label} — ${ms}ms`,
                );
              }
            },
            (e: unknown) => {
              if (doTrace && !this._isTraceDisabled(entry.source)) {
                const ms = Date.now() - t0;
                const label = entry.source ? ` (${entry.source})` : "";
                logger.debug(
                  `[hook:trace] ${hookName} — ${i + 1}/${handlers.length}${label} — ${ms}ms — error`,
                );
              }
              logger.error(`[hook:${hookName}] ${formatError(e)}`);
            },
          );
        } else {
          // Synchronous handler completed
          if (doTrace && !this._isTraceDisabled(entry.source)) {
            const ms = Date.now() - t0;
            const label = entry.source ? ` (${entry.source})` : "";
            logger.debug(
              `[hook:trace] ${hookName} — ${i + 1}/${handlers.length}${label} — ${ms}ms`,
            );
          }
        }
      } catch (e) {
        // Synchronous error from the handler call itself
        if (doTrace && !this._isTraceDisabled(entry.source)) {
          const ms = Date.now() - t0;
          const label = entry.source ? ` (${entry.source})` : "";
          logger.debug(
            `[hook:trace] ${hookName} — ${i + 1}/${handlers.length}${label} — ${ms}ms — error`,
          );
        }
        logger.error(`[hook:${hookName}] ${formatError(e)}`);
      }
    }
  }

  /**
   * Run a hook pipeline sequentially.
   * Handlers run one at a time, each seeing the accumulated state.
   *
   * @param hookName - The hook name. Data is type-checked against HookPayloads.
   * @param data — Mutable data object passed to each handler, typed by hook name.
   * @param opts
   * @param opts.shouldStop — Called with each handler's return value.
   *   Return true to stop processing further handlers.
   * @returns results — all non-undefined return values from handlers
   *   lastResult — the last handler's return value (or undefined)
   *   stopped — true if shouldStop caused early termination
   *   data — the (possibly mutated) data object
   */
  async runHookPipeline<R = unknown, H extends string = keyof HookPayloads>(
    hookName: H,
    data: H extends keyof HookPayloads ? HookPayloads[H] : unknown,
    opts: HookPipelineOptions = {},
  ): Promise<HookPipelineResult<R>> {
    const handlers = this.#hooks.get(hookName) || [];
    const results: Array<{ result: R; source: string | null }> = [];
    let lastResult: R | undefined;
    let stopped = false;
    let doTrace = this._shouldTrace(hookName);

    for (let i = 0; i < handlers.length; i++) {
      const entry = handlers[i];
      if (!entry) continue;
      const t0 = doTrace ? Date.now() : 0;
      try {
        const result = entry.handler(data);
        const resolved = (isPromise(result) ? await result : result) as R;
        if (resolved !== undefined) {
          results.push({ result: resolved, source: entry.source || null });
          lastResult = resolved;
        }
        if (doTrace && !this._isTraceDisabled(entry.source)) {
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
          if (doTrace && !this._isTraceDisabled(entry.source)) {
            logger.debug(
              `[hook:trace] ${hookName} — stopped at handler ${i + 1}/${handlers.length}`,
            );
          }
          break;
        }
      } catch (e) {
        if (doTrace && !this._isTraceDisabled(entry.source)) {
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
   * @param hookName - Optional hook name to clear.
   */
  clear(hookName?: string): void {
    if (hookName) {
      this.#hooks.delete(hookName);
    } else {
      this.#hooks.clear();
    }
  }

  /**
   * Get the number of registered handlers for a hook.
   * @param hookName
   * @returns number of handlers
   */
  handlerCount(hookName: string): number {
    return (this.#hooks.get(hookName) || []).length;
  }

  /**
   * Get all registered hook names.
   * @returns array of hook names
   */
  hookNames(): string[] {
    return Array.from(this.#hooks.keys());
  }

  /**
   * Enable/disable trace logging for hooks.
   * @param value — boolean or HookTraceOptions
   */
  get trace(): boolean | HookTraceOptions {
    return this.#trace;
  }
  set trace(value: boolean | HookTraceOptions) {
    this.#trace = value;
  }

  /**
   * Get the internal handler map (exposed for testing).
   * @returns Map of hook name → handler entries
   */
  get hooksMap(): Map<string, HookHandlerEntry[]> {
    return this.#hooks;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _shouldTrace(hookName: string): boolean {
    if (hookName === "log") return false;
    if (typeof this.#trace === "boolean") {
      return this.#trace;
    }
    if (typeof this.#trace === "object" && this.#trace !== null) {
      let doTrace = this.#trace.enabled ?? false;
      if (this.#trace.enabledHooks && this.#trace.enabledHooks.length > 0) {
        doTrace = doTrace && this.#trace.enabledHooks.includes(hookName);
      }
      return doTrace;
    }
    return false;
  }

  private _isTraceDisabled(source: string | undefined): boolean {
    if (typeof this.#trace === "object" && this.#trace !== null) {
      return this.#trace.disabledSources
        ? this.#trace.disabledSources.includes(source ?? "")
        : false;
    }
    return false;
  }
}

// ── Standard Hook Names ──────────────────────────────────────────────────────

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

  // Turn end — emitted at the end of each agent loop iteration, and always
  // emitted with stopped: true when the agent exits (even on cancellation).
  // Handlers receive { turnIndex, message, toolResults, stopped, cancelled, agent } as notification.
  // - message: the assistant's text response (may be empty if only tool calls or cancelled)
  // - toolResults: array of { toolName, input, result } for tools executed this turn
  // - stopped: boolean indicating if the agent has finished processing (true) or
  //   will continue to the next iteration (false)
  // - cancelled: boolean indicating if processing ended due to cancellation (default: false)
  // Enables: per-turn analysis, cost tracking, audit logging, UI prompt control.
  TURN_END: "turn:end",

  // Tool metrics — notification hook fired after each individual tool execution.
  // Handlers receive { toolName, toolCallId, durationMs, success, resultSize, input, agent }
  // as notification (not modifiable — use runHookPipeline, not fire-and-forget).
  // Enables: telemetry, performance profiling, cost tracking, anomaly detection.
  TOOL_METRICS: "tool:metrics",

  // Logging — emitted by the logger module, intercepted by handlers.
  // Payload: { level: "debug"|"info"|"warn"|"error", message: string, metadata?: object }
  LOG: "log",
} as const;

/**
 * Extension capability constants.
 * Extensions can export a `provides` array declaring what they offer.
 */
export const EXTENSION_PROVIDES = {
  CLI_SUBCOMMANDS: "cli:subcommands", // Extension provides CLI subcommands
  TOOLS: "tools", // Extension provides tools
} as const;

/**
 * Create a new HookSystem instance.
 * @returns HookSystem
 */
export function createHooks(): HookSystem {
  return new HookSystem();
}
