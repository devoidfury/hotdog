// ToolExecutor — executes tool calls through the full pipeline:
//   whitelist → gate hook → context build → resolve → validate → execute
//   → after-execute hook → result hook → format → write to context.

import { Message, type ImageAttachment } from "./context/message.ts";
import { formatError } from "./error.ts";
import { HOOKS, type HookSystem } from "./hooks.ts";
import { logger } from "./logger.ts";
import { ToolContext } from "./extensions/tool-context.ts";
import { formatToolResult } from "./extensions/tool-utils.ts";
import type { ToolRegistry } from "./extensions/tool-registry.ts";

/**
 * Minimal tool call shape from the LLM (normalized OpenAI format).
 */
export interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

/**
 * Result of executing a single tool call.
 */
export interface ToolResult {
  toolName: string;
  input: string;
  result: string;
}

/**
 * Dependencies that ToolExecutor needs from its host (the Agent).
 * Using a minimal interface avoids a circular import of Agent.
 */
export interface ToolExecutorDeps {
  toolRegistry: ToolRegistry;
  hooks: HookSystem;
  addMessage(msg: Message): void;
  emitOutput(type: string, data: Record<string, unknown>): void;
  toolWhitelist: string[] | null;
  cwdBoundary: string | null;
  workspaceRoot: string | null;
  /** Dynamic getter — isRestoring can change at runtime. */
  isRestoring: () => boolean;
  /** Agent reference for hook payloads (not used for method calls). */
  agent: unknown;
}

/**
 * ToolExecutor - Executes tool calls through the full pipeline.
 *
 * The pipeline for each tool call:
 *   1. Validate tool name (reject empty/missing names)
 *   2. Check tool whitelist (if configured)
 *   3. TOOL_CALL gate hook — extensions can block or modify input
 *   4. Build and enrich ToolContext via AGENT_TOOL_CONTEXT hook
 *   5. Resolve tool from registry
 *   6. Validate arguments against tool's JSON Schema
 *   7. Execute the tool
 *   8. TOOL_AFTER_EXECUTE notification hook
 *   9. TOOL_RESULT pipeline hook — extensions can transform the result
 *   10. Format result and write to context
 *   11. TOOL_METRICS notification (fire-and-forget)
 */
export class ToolExecutor {
  #deps: ToolExecutorDeps;

  constructor(deps: ToolExecutorDeps) {
    this.#deps = deps;
  }

  /**
   * Execute all tool calls from an LLM response.
   *
   * @param toolCalls — Tool calls from the LLM (normalized format).
   * @returns { outcome: 'continue' | 'return', toolResults }
   *   - 'continue' means the agent should proceed to the next iteration
   *   - 'return' means the agent should yield control (e.g., wait tool)
   */
  async execute(
    toolCalls: ToolCall[],
  ): Promise<{ outcome: string; toolResults: ToolResult[] }> {
    const toolResults: ToolResult[] = [];

    for (const tc of toolCalls) {
      let result: ToolResult;
      try {
        result = await this.executeSingle(tc);
      } catch (e: unknown) {
        // Log the error and produce a fallback result so the LLM sees a
        // structured failure rather than losing the tool call entirely.
        const toolName = tc.function?.name || "(unknown)";
        const toolCallId = tc.id || "";
        const errorMsg = `Tool execution failed: ${(e as Error).message}`;
        logger.error(`[tool:error] ${toolName}: ${formatError(e)}`);

        result = await this.#writeToolResult(
          toolName,
          tc.function?.arguments || "{}",
          errorMsg,
          toolCallId,
        );
      }
      toolResults.push(result);

      // Check for wait tool — model is yielding control
      if (result.toolName === "wait") {
        return { outcome: "return", toolResults };
      }
    }

    return { outcome: "continue", toolResults };
  }

  /**
   * Execute a single tool call through the full pipeline:
   *   whitelist → gate hook → context build → resolve → validate → execute
   *   → after-execute hook → result hook → format → write to context.
   *
   * @param tc — Tool call from the LLM response (normalized format).
   * @returns { toolName, input, result }
   */
  async executeSingle(tc: ToolCall): Promise<ToolResult> {
    const toolName = tc.function?.name;
    const toolCallId = tc.id;
    let input = tc.function?.arguments || "{}";
    const t0 = Date.now();
    const { hooks, agent } = this.#deps;

    // Guard: reject empty or missing tool names before any further processing.
    if (
      !toolName ||
      typeof toolName !== "string" ||
      toolName.trim().length === 0
    ) {
      const result = `Tool call missing a valid name (got: ${JSON.stringify(toolName)})`;
      this.#deps.emitOutput("tool_result", {
        toolName: "(invalid)",
        input,
        result,
        toolCallId,
      });
      const msg = new Message({
        role: "tool",
        content: result,
        toolCallId,
      });
      this.#deps.addMessage(msg);
      return { toolName: "(invalid)", input, result };
    }

    if (
      this.#deps.toolWhitelist &&
      !this.#deps.toolWhitelist.includes(toolName)
    ) {
      const msg = `Tool '${toolName}' is not available for this agent`;
      return this.#writeToolResult(toolName, input, msg, toolCallId);
    }

    this.#deps.emitOutput("tool_call", { toolName, input, toolCallId });
    hooks.notifyHooks(HOOKS.TOOL_BEFORE_EXECUTE, {
      toolCallId,
      toolName,
      input,
      agent,
    });

    // Tool call gate — sequential, modifiable. Handlers can block, modify input args, or allow execution to proceed.
    //    Actions: { action: "continue" } | { action: "modify", input } | { action: "block", result }
    const callResult = await hooks.runHookPipeline(HOOKS.TOOL_CALL, {
      toolCallId,
      toolName,
      input,
      agent,
    });
    if (
      callResult.lastResult &&
      (callResult.lastResult as { action?: string }).action === "block"
    ) {
      // Extension blocked this tool call — use provided result
      const blockedResult = formatToolResult(
        (callResult.lastResult as { result?: unknown }).result,
        toolName,
        false,
      );
      return this.#writeToolResult(toolName, input, blockedResult, toolCallId);
    }
    if (
      callResult.lastResult &&
      (callResult.lastResult as { action?: string }).action === "modify" &&
      (callResult.lastResult as { input?: unknown }).input !== undefined
    ) {
      // Extension modified the input args
      input = (callResult.lastResult as { input: string }).input;
    }

    // Build and enrich tool context via hook
    const toolCtx = this.#buildToolContext(toolName);
    hooks.notifyHooks(HOOKS.AGENT_TOOL_CONTEXT, {
      toolCtx,
      toolName,
      agent,
    });

    // Resolve tool from registry
    const tool = this.#deps.toolRegistry.get(toolName);
    if (!tool) {
      return this.#writeToolResult(
        toolName,
        input,
        `Unknown tool: ${toolName}`,
        toolCallId,
      );
    }

    // Validate arguments against tool's JSON Schema
    const validationError = await this.#deps.toolRegistry.validateToolArgs(
      toolName,
      input,
    );
    if (validationError) {
      return this.#writeToolResult(
        toolName,
        input,
        `Parameter validation error:\n${validationError}`,
        toolCallId,
      );
    }

    // Execute the tool
    let result: unknown;
    let success: boolean;
    try {
      result = await (
        tool as {
          execute: (input: string, ctx: ToolContext) => Promise<unknown>;
        }
      ).execute(input, toolCtx);
      success = true;
    } catch (e: unknown) {
      result = `Error executing tool ${toolName}: ${(e as Error).message}`;
      success = false;
    }

    // After-execute hook + result modification hook
    hooks.notifyHooks(HOOKS.TOOL_AFTER_EXECUTE, {
      toolCallId,
      toolName,
      result,
      input,
      agent,
      success,
    });

    // Tool result — sequential, modifiable. Handlers can transform the
    // result before it reaches the LLM context.
    // Returns { result } to replace the result (any value: string, ToolResult, object)
    const resultHook = await hooks.runHookPipeline(HOOKS.TOOL_RESULT, {
      toolCallId,
      toolName,
      result,
      success,
      input,
      agent,
    });
    if (
      resultHook.lastResult &&
      (resultHook.lastResult as { result?: unknown }).result !== undefined
    ) {
      result = (resultHook.lastResult as { result: unknown }).result;
    }
    const images = (result as { images?: unknown })?.images ?? null;

    // Format and write result to context
    const resultStr = formatToolResult(result, toolName, success);

    // Fire metrics notification (fire-and-forget — non-blocking).
    // Enables telemetry, profiling, and anomaly detection without
    // adding latency to the tool execution path.
    const durationMs = Date.now() - t0;
    const resultSize = typeof resultStr === "string" ? resultStr.length : 0;
    hooks.notifyHooks(HOOKS.TOOL_METRICS, {
      toolName,
      toolCallId,
      durationMs,
      success,
      resultSize,
      input,
      agent,
    });

    return this.#writeToolResult(
      toolName,
      input,
      resultStr,
      toolCallId,
      images as ImageAttachment[] | null,
    );
  }

  /**
   * Build a ToolContext with standard infrastructure fields.
   * Extensions can further enrich it via the AGENT_TOOL_CONTEXT hook.
   *
   * @param toolName
   * @returns ToolContext
   */
  #buildToolContext(toolName: string): ToolContext {
    const toolCtx = new ToolContext();
    toolCtx.set("agent", this.#deps.agent);
    toolCtx.set("isSessionRestoring", this.#deps.isRestoring());
    toolCtx.set("cwdBoundary", this.#deps.cwdBoundary || null);
    toolCtx.set("workspaceRoot", this.#deps.workspaceRoot || null);
    return toolCtx;
  }

  /**
   * Write a tool result to output, context, and emit the context message hook.
   * Shared helper used by both error paths and the happy path in executeSingle.
   *
   * @param toolName
   * @param input
   * @param result
   * @param toolCallId
   * @param images — Optional images
   * @returns { toolName, input, result }
   */
  async #writeToolResult(
    toolName: string,
    input: string,
    result: string,
    toolCallId: string,
    images?: ImageAttachment[] | null,
  ): Promise<ToolResult> {
    this.#deps.emitOutput("tool_result", { toolName, input, result });
    const msg = new Message({
      role: "tool",
      content: result,
      toolCallId,
      images: images as ImageAttachment[] | null | undefined,
    });
    this.#deps.addMessage(msg);
    return { toolName, input, result };
  }
}

/**
 * Create a new ToolExecutor instance.
 */
export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  return new ToolExecutor(deps);
}
