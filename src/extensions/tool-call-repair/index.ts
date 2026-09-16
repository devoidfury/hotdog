// Tool-call repair -- recover malformed tool calls.
//
// This extension hooks the PROVIDER_RESPONSE pipeline: when a response carries no structured calls,
// it scans content and reasoning for a leaked call at the tail of the text and, if the grammar in ./grammar.ts
// parses one cleanly, rewrites the response in place with forged tool-call ids, stripped visible text --
// so the agent's normal tool-execution path picks the calls up and the loop continues.
//
// Disable the extension(config or autoload list) for strict tool - calling enforcement.

import { HOOKS } from "@core/hooks.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
import { logger } from "@utils/logger.ts";
import { getExtensionConfig, type CoreContext, type ExtensionInstance } from "@core/extensions/types.ts";
import { repairCallsInText } from "./grammar.ts";

interface RepairConfig {
  enabled: boolean;
  maxRepairsPerTurn: number;
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
    },
  };
}
