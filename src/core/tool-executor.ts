// ToolExecutor

import { Message, type ImageAttachment } from "./context/message.ts";
import { formatError } from "./error.ts";
import { HOOKS, type HookSystem, type GateAction, type ToolResultHookResult } from "./hooks.ts";
import { logger } from "./logger.ts";
import { ToolContext } from "./extensions/tool-context.ts";
import { formatToolResult } from "./extensions/tool-utils.ts";
import type { ToolRegistry } from "./extensions/tool-registry.ts";
import type { Agent } from "./agent.ts";

export interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface ToolResult {
  toolName: string;
  input: string;
  result: string;
}

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
  agent: Agent;
}

export class ToolExecutor {
  #deps: ToolExecutorDeps;

  constructor(deps: ToolExecutorDeps) {
    this.#deps = deps;
  }

  async execute(
    toolCalls: ToolCall[],
  ): Promise<{ outcome: string; toolResults: ToolResult[] }> {
    const toolResults: ToolResult[] = [];

    for (const tc of toolCalls) {
      let result: ToolResult;
      try {
        result = await this.executeSingle(tc);
      } catch (e: unknown) {
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

      if (result.toolName === "wait") {
        return { outcome: "return", toolResults };
      }
    }

    return { outcome: "continue", toolResults };
  }

  async executeSingle(tc: ToolCall): Promise<ToolResult> {
    const toolName = tc.function?.name;
    const toolCallId = tc.id;
    let input = tc.function?.arguments || "{}";
    const t0 = Date.now();
    const { hooks, agent } = this.#deps;

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

    const callResult = await hooks.runHookPipeline<GateAction>(HOOKS.TOOL_CALL, {
      toolCallId,
      toolName,
      input,
      agent,
    });
    if (callResult.lastResult?.action === "block") {
      const blockedResult = formatToolResult(callResult.lastResult.result, toolName, false);
      return this.#writeToolResult(toolName, input, blockedResult, toolCallId);
    }
    if (callResult.lastResult?.action === "modify" && callResult.lastResult.input !== undefined) {
      input = callResult.lastResult.input;
    }

    const toolCtx = this.#buildToolContext(toolName);
    hooks.notifyHooks(HOOKS.AGENT_TOOL_CONTEXT, { toolCtx, toolName, agent });
    const tool = this.#deps.toolRegistry.get(toolName);
    if (!tool) {
      return this.#writeToolResult(
        toolName,
        input,
        `Unknown tool: ${toolName}`,
        toolCallId,
      );
    }

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

    hooks.notifyHooks(HOOKS.TOOL_AFTER_EXECUTE, {
      toolCallId,
      toolName,
      result,
      input,
      agent,
      success,
    });

    const resultHook = await hooks.runHookPipeline<ToolResultHookResult>(HOOKS.TOOL_RESULT, {
      toolCallId,
      toolName,
      result,
      success,
      input,
      agent,
    });
    if (resultHook.lastResult?.result !== undefined) {
      result = resultHook.lastResult.result;
    }
    const images = (result as { images?: unknown })?.images ?? null;

    const resultStr = formatToolResult(result, toolName, success);
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

  #buildToolContext(toolName: string): ToolContext {
    const toolCtx = new ToolContext();
    toolCtx.set("agent", this.#deps.agent);
    toolCtx.set("isSessionRestoring", this.#deps.isRestoring());
    toolCtx.set("cwdBoundary", this.#deps.cwdBoundary || null);
    toolCtx.set("workspaceRoot", this.#deps.workspaceRoot || null);
    return toolCtx;
  }

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

export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  return new ToolExecutor(deps);
}
