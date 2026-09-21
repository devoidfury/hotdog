// Tool-call repair -- recover malformed tool calls.
//
// This extension hooks the PROVIDER_RESPONSE pipeline: when a response carries no structured calls,
// it scans content and reasoning for a leaked call at the tail of the text and, if the grammar in ./grammar.ts
// parses one cleanly, rewrites the response in place with forged tool-call ids, stripped visible text --
// so the agent's normal tool-execution path picks the calls up and the loop continues.
//
// It also hooks PROVIDER_ERROR: when the backend rejects every request because the stored history
// holds a tool call with truncated (unparseable) arguments -- the classic state after interrupting a
// hung call -- it drops the corrupt calls and their orphaned tool results, then asks for one retry.
//
// Disable the extension(config or autoload list) for strict tool - calling enforcement.

import { HOOKS } from "@core/hooks.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
import { logger } from "@utils/logger.ts";
import type { Message } from "@core/context/message.ts";
import { getExtensionConfig, type CoreContext, type ExtensionInstance } from "@core/extensions/types.ts";
import { repairCallsInText } from "./grammar.ts";

interface RepairConfig {
  enabled: boolean;
  maxRepairsPerTurn: number;
}

/**
 * True if the error is the llama.cpp-family backend rejecting the whole request
 * because a stored tool call's arguments are invalid JSON (typically a call
 * truncated mid-stream after an interrupt). Such a message bricks the session:
 * every subsequent request carries the same corrupt history.
 */
function isToolArgsParseError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return msg.includes("failed to parse tool call arguments") || msg.includes("missing closing quote");
}

/**
 * True when a tool call's `arguments` fail JSON.parse. Empty/blank arguments
 * count as valid no-arg calls, matching tool-utils parseToolInput.
 */
function isCorruptArgs(args: unknown): boolean {
  if (typeof args !== "string" || args.trim() === "") return false;
  try {
    JSON.parse(args);
    return false;
  } catch {
    return true;
  }
}

/**
 * Drop tool calls whose arguments fail JSON.parse from assistant messages
 * (mutates the Messages in place -- getMessages hands back live references),
 * and collect the ids so the caller can strand-proof the history: any tool
 * result pointing at a dropped call is removed from the returned list.
 */
export function stripCorruptToolCalls(messages: Message[]): {
  corruptIds: Set<string>;
  droppedCalls: number;
  kept: Message[];
} {
  const corruptIds = new Set<string>();
  let droppedCalls = 0;
  for (const m of messages) {
    if (m.role !== "assistant" || !m.toolCalls || m.toolCalls.length === 0) continue;
    const valid = m.toolCalls.filter((tc) => {
      if (!isCorruptArgs(tc.function?.arguments)) return true;
      droppedCalls++;
      if (tc.id) corruptIds.add(tc.id);
      return false;
    });
    if (valid.length !== m.toolCalls.length) m.toolCalls = valid.length > 0 ? valid : null;
  }
  const kept =
    corruptIds.size === 0
      ? messages
      : messages.filter((m) => !(m.role === "tool" && m.toolCallId && corruptIds.has(m.toolCallId)));
  return { corruptIds, droppedCalls, kept };
}

export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<RepairConfig>(core, "toolCallRepair");
  if (config.enabled === false) {
    return {};
  }

  // sessionId -> repairs used this user turn. iterationCount is 1 on each run()'s first LLM call, so seeing iteration 1 is the turn boundary.
  const repairsUsed = new Map<string, number>();

  return {
    hooks: {
      [HOOKS.PROVIDER_RESPONSE]: ({ response, agent }) => {
        if (!agent || agent.cancelled) return;

        if (agent.iterationCount <= 1) repairsUsed.delete(agent.sessionId);

        if (response.finalToolCalls && response.finalToolCalls.length > 0) return;
        // Never repair on the final iteration -- the loop could not run tools anyway.
        if (agent.iterationCount >= agent.maxIterations) return;

        const used = repairsUsed.get(agent.sessionId) ?? 0;

        const sources = ["fullText", "fullReasoning"] as const;
        for (const field of sources) {
          const src = response[field];
          if (!src || src.indexOf("<") === -1) continue;
          const result = repairCallsInText(src);
          if (!result.repaired) continue;

          if (config.maxRepairsPerTurn >= 0 && used >= config.maxRepairsPerTurn) {
            logger.warn(
              `[tool-call-repair] repair budget (${config.maxRepairsPerTurn}) reached this turn; leaving call in text`,
            );
            // Chat-visible: the call is stranded in the transcript and the user should know why.
            agent.sink?.emit({
              type: OUTPUT_EVENT.SYSTEM_MESSAGE,
              content: `Tool-call repair budget (${config.maxRepairsPerTurn}/turn) reached; leaving the malformed call(s) in the text.`,
            });
            return;
          }
          repairsUsed.set(agent.sessionId, used + 1);

          // Mutate in place AND return { response }: core applies the pipeline result for message building and tool execution, and
          // holders of the original reference see the repaired text too.
          response.finalToolCalls = result.calls;
          if (field === "fullText") response.fullText = result.text;
          else response.fullReasoning = result.text;
          response.finishReason = "tool_calls";

          logger.info(
            `[tool-call-repair] recovered ${result.calls.length} malformed call(s) from ${field} ` +
              `in session ${agent.sessionId}: ${result.calls.map((c) => c.function.name).join(", ")}`,
          );
          // Chat-visible: the repair rewrote the model's text, so the user should see it in the session log
          agent.sink?.emit({
            type: OUTPUT_EVENT.SYSTEM_MESSAGE,
            content: `Repaired ${result.calls.length} malformed tool call(s) leaked into the model's text: ${result.calls
              .map((c) => c.function.name)
              .join(", ")}.`,
          });
          return { response };
        }
      },

      [HOOKS.PROVIDER_ERROR]: ({ error, params, agent }) => {
        if (!agent || agent.cancelled) return;
        if (!isToolArgsParseError(error)) return;

        const messages = agent.getMessages();
        const { corruptIds, droppedCalls, kept } = stripCorruptToolCalls(messages);
        // Nothing corrupt in our history -- the 500 has another cause; do not retry.
        if (droppedCalls === 0) return;

        if (kept.length !== messages.length) {
          agent.replaceContext(kept);
          // params.messages is a separate array captured before the sanitize;
          // prune the same orphaned tool results so the retry doesn't resend them.
          params.messages = params.messages.filter(
            (m) => !(m.role === "tool" && m.toolCallId && corruptIds.has(m.toolCallId)),
          );
        }
        logger.info(
          `[tool-call-repair] dropped ${droppedCalls} tool call(s) with unparseable arguments from session ` +
            `${agent.sessionId}; retrying the request`,
        );
        agent.sink?.emit({
          type: OUTPUT_EVENT.SYSTEM_MESSAGE,
          content: `Dropped ${droppedCalls} tool call(s) with corrupted (truncated) arguments from history and retried the request.`,
        });
        return { retry: true };
      },
    },
  };
}
