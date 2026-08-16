// ToolExecutor

import { Message, type ToolCall, type ImageAttachment } from "./context/message.ts";
import { formatError, AssistantRetryableError, TransientError } from "./error.ts";
import { HOOKS, type HookSystem, type GateAction, type ToolResultHookResult } from "./hooks.ts";
import { logger } from "./logger.ts";
import { ToolContext } from "./extensions/tool-context.ts";
import { formatToolResult, TOOL_STOP_LOOP } from "./extensions/tool-utils.ts";
import type { ToolRegistry } from "./extensions/tool-registry.ts";
import type { Agent } from "./agent.ts";
import { Workspace } from "./../utils/workspace.ts";


export interface ToolResult {
  toolName: string;
  input: string;
  result: string;
  toolCallId: string;
  /** When true, signals the agent run loop to stop after this batch of tools. */
  stopLoop?: boolean;
}

export interface ToolExecutorDeps {
  toolRegistry: ToolRegistry;
  hooks: HookSystem;
  emitOutput<T extends string>(type: T, data: Record<string, unknown>): void;
  toolWhitelist: string[] | null;
  cwdBoundary: string | null;
  workspaceRoot: string | null;
  maxRetries: number;
  toolRetryDelay: number;
  /** Dynamic getter — isRestoring can change at runtime. */
  isRestoring: () => boolean;
  /** Agent reference — hook payloads and addMessage (fires CONTEXT_MESSAGE). */
  agent: Agent;
}

export class ToolExecutor {
  #deps: ToolExecutorDeps;

  constructor(deps: ToolExecutorDeps) {
    this.#deps = deps;
  }

  async execute(
    toolCalls: ToolCall[],
  ): Promise<{ outcome: "continue" | "return"; toolResults: ToolResult[] }> {
    const toolResults: ToolResult[] = [];

    for (const tc of toolCalls) {
      let result: ToolResult;
      try {
        result = await this.executeSingle(tc);
      } catch (e: unknown) {
        const toolName = tc.function?.name || "(unknown)";
        const toolCallId = tc.id || "";
        const errorMsg = `Tool execution failed: ${e instanceof Error ? e.message : String(e)}`;
        logger.error(`[tool:error] ${toolName}: ${formatError(e)}`);

        result = await this.#writeToolResult(
          toolName,
          tc.function?.arguments || "{}",
          errorMsg,
          toolCallId,
        );
      }
      toolResults.push(result);

      if (result.stopLoop) {
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
      this.#deps.agent.addMessage(msg);
      return { toolName: "(invalid)", input, result, toolCallId: toolCallId || "" };
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
    let success = false;
    let stopLoop = false;
    // Clamp to at least 1 so the tool always gets one attempt.
    const maxRetries = Math.max(1, this.#deps.maxRetries);
    let attempts = 0;

    while (attempts < maxRetries) {
      attempts++;
      try {
        result = await tool.execute(input, toolCtx);
        success = true;
        // Check for stop-loop sentinel on ToolResult
        if (result && typeof result === "object" && (result as Record<symbol, unknown>)[TOOL_STOP_LOOP] === true) {
          stopLoop = true;
        }
        break;
      } catch (e: unknown) {
        if (e instanceof TransientError && attempts < maxRetries) {
          const delay = Math.pow(2, attempts - 1) * this.#deps.toolRetryDelay * 1000;
          logger.warn(`[tool:retry] ${toolName} failed (transient), retrying attempt ${attempts + 1}/${maxRetries} after ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (e instanceof AssistantRetryableError) {
          const hint = e.hint ? `\n\nHINT: ${e.hint}` : "";
          result = `Error executing tool ${toolName}: ${e.message}${hint}`;
        } else {
          result = `Error executing tool ${toolName}: ${(e as Error).message}`;
        }
        success = false;
        break;
      }
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
      images as ImageAttachment[] | undefined,
      stopLoop,
    );
  }

  #buildToolContext(toolName: string): ToolContext {
    const toolCtx = new ToolContext();
    toolCtx.set("agent", this.#deps.agent);
    toolCtx.set("isSessionRestoring", this.#deps.isRestoring());
    toolCtx.set("cwdBoundary", this.#deps.cwdBoundary || null);
    toolCtx.set("workspaceRoot", this.#deps.workspaceRoot || null);

    // Build Workspace from cwdBoundary, workspaceRoot, or the process CWD.
    // Always constructing a Workspace means file tools go through resolveSafe()
    // and absolute-path escapes are rejected even when no boundary is configured.
    const boundary = this.#deps.cwdBoundary || this.#deps.workspaceRoot || process.cwd();
    try {
      toolCtx.set("workspace", new Workspace(boundary));
    } catch (e) {
      logger.warn(`Failed to create Workspace from '${boundary}': ${(e as Error).message}`);
      toolCtx.set("workspace", null);
    }

    return toolCtx;
  }

  async #writeToolResult(
    toolName: string,
    input: string,
    result: string,
    toolCallId: string,
    images?: ImageAttachment[],
    stopLoop = false,
  ): Promise<ToolResult> {
    this.#deps.emitOutput("tool_result", { toolName, input, result, toolCallId });
    const msg = new Message({
      role: "tool",
      content: result,
      toolCallId,
      images: images as ImageAttachment[] | undefined,
    });
    // Go through agent.addMessage() so the CONTEXT_MESSAGE hook fires and
    // extensions (session log) record the tool result.
    this.#deps.agent.addMessage(msg);
    return { toolName, input, result, toolCallId, stopLoop };
  }
}

export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  return new ToolExecutor(deps);
}
