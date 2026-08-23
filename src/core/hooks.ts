// Hook system. notifyHooks() is fire-and-forget; runHookPipeline() runs
// handlers sequentially and accumulates their return values.

import { formatError } from "./error.ts";
import { logger } from "./logger.ts";
import { isPromise } from "../utils/promise.ts";
import type { Message } from "./context/message.ts";
import type { ImageAttachment } from "./context/message.ts";
import type { ModelConfig } from "./config/providers.ts";
import type { ToolDef } from "./extensions/tool-registry.ts";

export type GateAction =
  | { action: "continue" }
  | { action: "modify"; input?: string; result?: unknown }
  | { action: "block"; result: unknown }
  | { action: "handled" };

export function isGateActionBlock(action: GateAction | undefined | null): action is Extract<GateAction, { action: "block" }> {
  return action?.action === "block";
}

export function isGateActionModify(action: GateAction | undefined | null): action is Extract<GateAction, { action: "modify" }> {
  return action?.action === "modify";
}

export function isGateActionContinue(action: GateAction | undefined | null): action is Extract<GateAction, { action: "continue" }> {
  return action?.action === "continue";
}

export function isGateActionHandled(action: GateAction | undefined | null): action is Extract<GateAction, { action: "handled" }> {
  return action?.action === "handled";
}

export type ContextHookResult = { messages: Message[] };

export type ProviderRequestHookResult = {
  messages?: Message[];
  modelConfig?: ModelConfig;
  toolDefs?: ToolDef[];
};

export type ToolResultHookResult = { result: unknown };

export type InputHookResult =
  | { action: "continue" }
  | { action: "transform"; text: string; images?: ImageAttachment[] }
  | { action: "handled" };

export function isInputTransform(result: InputHookResult | undefined | null): result is Extract<InputHookResult, { action: "transform" }> {
  return result?.action === "transform";
}

export function isInputHandled(result: InputHookResult | undefined | null): result is Extract<InputHookResult, { action: "handled" }> {
  return result?.action === "handled";
}

export type SystemPromptChunk = {
  name: string;
  priority: number;
  content: string;
};

function _summarizeResult(value: unknown): string {
  if (value == null) return "null";
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
  if (keys.length <= 3) return `{ ${keys.join(", ")} }`;
  return `{ ${keys.slice(0, 3).join(", ")}, +${keys.length - 3} }`;
}

import type { HookPayloads } from "./extensions/types.ts";

export interface HookHandlerEntry {
  id: number;
  handler: HookHandlerAny;
  source: string | undefined;
  priority: number;
}

// Handler data is typed by hook name where known, `unknown` otherwise.
export type HookHandler<H extends string> = (
  data: H extends keyof HookPayloads ? HookPayloads[H] : unknown,
) => void | Promise<void> | unknown;

export type HookHandlerAny = (data: unknown) => void | Promise<void> | unknown;

export interface HookPipelineOptions {
  shouldStop?: (result: unknown) => boolean;
}

export interface HookPipelineResult<R = unknown, D = unknown> {
  results: Array<{ result: R; source: string | null }>;
  lastResult: R | undefined;
  stopped: boolean;
  data: D;
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

  // Returns a removal function.
  on<H extends string>(
    hookName: H,
    handler: HookHandler<H>,
    sourceOrOptions?: string | { source?: string; priority?: number },
  ): () => void {
    let source: string | undefined;
    let priority = 0;

    if (typeof sourceOrOptions === "string") {
      source = sourceOrOptions;
    } else if (sourceOrOptions && typeof sourceOrOptions === "object") {
      source = sourceOrOptions.source;
      priority = sourceOrOptions.priority ?? 0;
    }

    if (!this.#hooks.has(hookName)) this.#hooks.set(hookName, []);
    const handlers = this.#hooks.get(hookName)!;
    const id = ++this.#handlerCounter;
    handlers.push({ id, handler: handler as HookHandlerAny, source, priority });

    // Priority descending; Array.prototype.sort is stable, so ties keep insertion order.
    handlers.sort((a, b) => b.priority - a.priority);

    return () => {
      const idx = handlers.findIndex((h) => h.id === id);
      if (idx !== -1) {
        handlers.splice(idx, 1);
      }
    };
  }

  // Remove a handler by function reference. Returns true if found.
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

  // Fire-and-forget: handlers run in order, return values ignored. Async
  // handlers are not awaited; their errors are caught and logged.
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

        if (isPromise(result)) {
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
          if (doTrace && !this._isTraceDisabled(entry.source)) {
            const ms = Date.now() - t0;
            const label = entry.source ? ` (${entry.source})` : "";
            logger.debug(
              `[hook:trace] ${hookName} — ${i + 1}/${handlers.length}${label} — ${ms}ms`,
            );
          }
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
  }

  // Sequential pipeline: each handler sees prior transformations; returns all results.
  async runHookPipeline<R = unknown, H extends string = keyof HookPayloads>(
    hookName: H,
    data: H extends keyof HookPayloads ? HookPayloads[H] : unknown,
    opts: HookPipelineOptions = {},
  ): Promise<HookPipelineResult<R, typeof data>> {
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

  // Clear one hook, or all hooks if no name given.
  clear(hookName?: string): void {
    if (hookName) {
      this.#hooks.delete(hookName);
    } else {
      this.#hooks.clear();
    }
  }

  handlerCount(hookName: string): number {
    return (this.#hooks.get(hookName) || []).length;
  }

  hookNames(): string[] {
    return Array.from(this.#hooks.keys());
  }

  get trace(): boolean | HookTraceOptions {
    return this.#trace;
  }
  set trace(value: boolean | HookTraceOptions) {
    this.#trace = value;
  }

  /** @internal Exposed for testing. */
  get hooksMap(): Map<string, HookHandlerEntry[]> {
    return this.#hooks;
  }

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

// Standard hook names. Payload and return shapes live in HookPayloads (extensions/types.ts).
export const HOOKS = {
  SESSION_CREATE: "session:create",
  SESSION_SWAP: "session:swap",
  SESSION_SERIALIZE: "session:serialize",
  SESSION_DESERIALIZE: "session:deserialize",
  SESSION_RESTORE_ACTIVE: "session:restoreActive",

  AGENT_TOOL_CONTEXT: "agent:toolContext",

  MODEL_CHANGE: "model:change",

  MESSAGES_AFTER_LLM: "messages:afterLLM",

  TOOLS_REGISTER: "tools:register",
  TOOL_METADATA: "tool:metadata",
  TOOL_BEFORE_EXECUTE: "tool:beforeExecute",
  // Fired synchronously during extension load so services are available to downstream extensions.
  SERVICES_REGISTER: "services:register",
  TOOL_AFTER_EXECUTE: "tool:afterExecute",
  LOOP_DETECTED: "loop:detected",

  CONTEXT_MESSAGE: "context:message",
  CONTEXT_REPLACED: "context:replaced",

  SYSTEM_PROMPT_BUILD: "systemPrompt:build",

  COMMAND_DISPATCH: "command:dispatch",
  COMMANDS_REGISTER: "commands:register",

  OUTPUT_EVENT: "output:event",

  SHUTDOWN_CLEANUP: "shutdown:cleanup",

  CLI_SUBCOMMANDS_REGISTER: "cli:subcommandsRegister",

  // Emitted after CLI args are parsed, before subcommand dispatch.
  CLI_ARGS_PARSED: "cli:argsParsed",

  // Pipeline; stops on "handled".
  INPUT: "input",

  // Pipeline run before each LLM call; handlers can replace { messages }.
  CONTEXT: "context",

  // Gate pipeline: continue / modify input / block with a provided result.
  TOOL_CALL: "tool:call",

  // Pipeline: handlers can replace the tool result before it reaches context.
  TOOL_RESULT: "tool:result",

  // Pipeline run before each LLM HTTP request; can replace messages/modelConfig/toolDefs.
  PROVIDER_REQUEST: "provider:request",

  PROVIDER_RESPONSE: "provider:response",

  TURN_START: "turn:start",

  // Emitted at the end of every agent loop iteration, and always with stopped: true
  // when the agent exits (even on cancellation).
  TURN_END: "turn:end",

  TOOL_METRICS: "tool:metrics",

  LOG: "log",

  COMPLETION_REQUEST: "completion:request",
} as const;

export const EXTENSION_PROVIDES = {
  CLI_SUBCOMMANDS: "cli:subcommands",
  TOOLS: "tools",
  LLM_PROTOCOLS: "llm:protocols",
  TOOL_FORMATS: "tool:formats",
} as const;

export function createHooks(): HookSystem {
  return new HookSystem();
}
