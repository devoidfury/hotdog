import { Message, type ToolCall, type ImageAttachment } from "./context/message.ts";
import { formatError, AssistantRetryableError, TransientError } from "./error.ts";
import { HOOKS, type HookSystem, type GateAction, type ToolResultHookResult } from "./hooks.ts";
import { logger } from "./logger.ts";
import { ToolContext } from "./extensions/tool-context.ts";
import { formatToolResult, TOOL_STOP_LOOP } from "./extensions/tool-utils.ts";
import type { ToolRegistry } from "./extensions/tool-registry.ts";
import type { Agent } from "./agent.ts";
import { Workspace } from "./../utils/workspace.ts";
import type { ToolFormatRegistry } from "./extensions/tool-format.ts";

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
  workspaceRoots: string[] | null;
  workspaceDeny: readonly string[] | null;
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

  /**
   * @param toolFormatName - ToolFormat registry name resolved by the caller
   *   (the agent loop resolves it per model); falls back to the seam default
   *   when omitted.
   * @param toolFormatRegistry - The session's ToolFormat registry; passed
   *   through so format resolution never depends on process-global state.
   */
  /**
   * @param availableToolNames - Names of the tools the model was actually
   *   offered this iteration (the agent passes its request's tool defs).
   *   Omitted only by standalone callers: availability is then resolved
   *   once from the agent's defs. Either way it is resolved ONCE per batch,
   *   not per tool call.
   */
  async execute(
    toolCalls: ToolCall[],
    toolFormatName?: string,
    toolFormatRegistry?: ToolFormatRegistry | null,
    availableToolNames?: string[],
  ): Promise<{ outcome: "continue" | "return"; toolResults: ToolResult[] }> {
    const toolResults: ToolResult[] = [];

    const available = new Set(
      availableToolNames ?? (await this.#deps.agent.getToolDefs()).map((d) => d.function.name),
    );

    for (const tc of toolCalls) {
      let result: ToolResult;
      try {
        result = await this.executeSingle(tc, available, toolFormatName, toolFormatRegistry);
      } catch (e: unknown) {
        const toolName = tc.function?.name || "(unknown)";
        const toolCallId = tc.id || "";
        const errorMsg = `Tool execution failed: ${e instanceof Error ? e.message : String(e)}`;
        logger.error(`[tool:error] ${toolName}: ${formatError(e)}`);

        result = await this.#writeToolResult(toolName, tc.function?.arguments || "{}", errorMsg, toolCallId);
      }
      toolResults.push(result);

      if (result.stopLoop) {
        return { outcome: "return", toolResults };
      }
    }

    return { outcome: "continue", toolResults };
  }

  async executeSingle(
    tc: ToolCall,
    available: Set<string>,
    toolFormatName?: string,
    toolFormatRegistry?: ToolFormatRegistry | null,
  ): Promise<ToolResult> {
    const toolName = tc.function?.name;
    const toolCallId = tc.id;
    let input = tc.function?.arguments || "{}";
    const t0 = Date.now();
    const { hooks, agent } = this.#deps;

    if (!toolName || typeof toolName !== "string" || toolName.trim().length === 0) {
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
        source: "tool",
      });
      this.#deps.agent.addMessage(msg);
      return { toolName: "(invalid)", input, result, toolCallId: toolCallId || "" };
    }

    if (!available.has(toolName)) {
      return this.#writeToolResult(
        toolName,
        input,
        unavailableToolMessage(toolName, available),
        toolCallId,
      );
    }

    this.#deps.emitOutput("tool_call", { toolName, input, toolCallId });
    hooks.notifyHooks(HOOKS.TOOL_BEFORE_EXECUTE, {
      toolCallId,
      toolName,
      input,
      agent,
    });

    // failOnError: a gate handler that throws must not be treated as a
    // pass — the error propagates to execute()'s catch and becomes the tool
    // result, so the tool never runs (fail closed).
    const callResult = await hooks.runHookPipeline<GateAction>(HOOKS.TOOL_CALL, {
      toolCallId,
      toolName,
      input,
      agent,
    }, { failOnError: true });
    if (callResult.lastResult?.action === "block") {
      const blockedResult = formatToolResult(
        callResult.lastResult.result,
        toolName,
        false,
        toolFormatName,
        toolFormatRegistry,
      );
      return this.#writeToolResult(toolName, input, blockedResult, toolCallId);
    }
    if (callResult.lastResult?.action === "modify" && callResult.lastResult.input !== undefined) {
      input = callResult.lastResult.input;
    }

    const toolCtx = this.#buildToolContext();
    hooks.notifyHooks(HOOKS.AGENT_TOOL_CONTEXT, { toolCtx, toolName, agent });
    const tool = this.#deps.toolRegistry.get(toolName);
    if (!tool) {
      return this.#writeToolResult(toolName, input, `Unknown tool: ${toolName}`, toolCallId);
    }

    const validationError = await this.#deps.toolRegistry.validateToolArgs(toolName, input);
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

    // maxRetries counts retries AFTER the initial attempt (total attempts = 1 + maxRetries).
    const maxAttempts = 1 + Math.max(0, this.#deps.maxRetries);
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        result = await tool.execute(input, toolCtx);
        success = true;
        // Check for stop-loop sentinel on ToolResult
        if (
          result &&
          typeof result === "object" &&
          (result as Record<symbol, unknown>)[TOOL_STOP_LOOP] === true
        ) {
          stopLoop = true;
        }
        break;
      } catch (e: unknown) {
        if (e instanceof TransientError && attempts < maxAttempts) {
          const delay = Math.pow(2, attempts - 1) * this.#deps.toolRetryDelay * 1000;
          logger.warn(
            `[tool:retry] ${toolName} failed (transient), retrying attempt ${attempts + 1}/${maxAttempts} after ${delay}ms...`,
          );
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

    const resultStr = formatToolResult(result, toolName, success, toolFormatName, toolFormatRegistry);
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

  #buildToolContext(): ToolContext {
    const toolCtx = new ToolContext();
    toolCtx.set("agent", this.#deps.agent);
    toolCtx.set("isSessionRestoring", this.#deps.isRestoring());
    // Build Workspace from the configured roots, or the process CWD. Roots
    // are pre-validated at config resolution (expandWorkspacePaths); if
    // construction still throws, let it surface as an unexpected error rather
    // than silently degrading to an unbounded workspace.
    const roots =
      this.#deps.workspaceRoots && this.#deps.workspaceRoots.length > 0
        ? this.#deps.workspaceRoots
        : [process.cwd()];
    // A configured deny list (even an explicit []) wins; null means
    // unconfigured and falls back to the built-in DEFAULT_DENY_PATTERNS.
    const deny = this.#deps.workspaceDeny;
    toolCtx.set(
      "workspace",
      deny !== null ? new Workspace(roots, deny) : new Workspace(roots),
    );

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
      source: "tool",
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

/** Case- and separator-insensitive key for fuzzy tool-name matching. */
function toolNameKey(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
}

/**
 * "Tool not available" result text, with actionable candidates so the model
 * can self-correct: models frequently misspell names, flip case ("Read" for
 * "read"), or reach for a tool filtered out by profile/difficulty. A bare
 * rejection strands them; suggesting near-matches from the offered set
 * recovers the turn in one retry.
 */
export function unavailableToolMessage(toolName: string, available: Set<string>): string {
  const base = `Tool '${toolName}' is not available for this agent.`;
  const target = toolNameKey(toolName);
  if (!target) return base;

  const names = Array.from(available).sort();
  const exact = names.filter((n) => toolNameKey(n) === target);
  if (exact.length > 0) {
    return `${base} Did you mean: ${exact.slice(0, 5).join(", ")}? (names differ only in case/separators)`;
  }

  const close = names
    .filter((n) => {
      const k = toolNameKey(n);
      return k.length > 2 && (k.includes(target) || target.includes(k));
    })
    .slice(0, 5);
  if (close.length > 0) {
    return `${base} Did you mean: ${close.join(", ")}?`;
  }
  return base;
}
