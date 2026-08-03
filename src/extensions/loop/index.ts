// Loop extension — provides the /loop slash command for repeatedly
// running a prompt until cancelled by the user.

import { HOOKS } from "../../core/hooks.ts";
import { ACTIONS } from "../../core/commands.ts";
import { formatError } from "../../core/error.ts";
import {
  CoreContext,
  ExtensionInstance,
  getExtensionConfig,
} from "../../core/extensions/types.ts";
import type { Agent } from "../../core/agent.ts";

interface LoopState {
  prompt: string;
  count: number;
  startTime: number;
  active: boolean;
}

/**
 * Create the loop extension.
 *
 * Uses a mutable state object so hooks can share loop state.
 * The /loop command handler initializes state and enqueues the first prompt.
 * TURN_END hook detects agent completion, clears context, and re-enqueues.
 * INPUT hook intercepts /quit during an active loop.
 */
export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<{ enabled: boolean; maxLoops: number }>(core, "loop");

  if (config.enabled === false) {
    return {};
  }

  const maxLoops = config.maxLoops;

  // Mutable loop state shared between hooks
  const loop: LoopState = {
    prompt: "",
    count: 0,
    startTime: 0,
    active: false,
  };

  /**
   * Emit output via the agent's sink (and hooks).
   * Uses emitOutput which routes to both the output sink and hook listeners.
   */
  function emit(agent: Agent, content: string): void {
    agent.emitOutput("command_result", { content });
  }

  /**
   * Stop the loop and emit a summary.
   */
  function stopLoop(agent: Agent, cancelled: boolean): void {
    loop.active = false;
    const elapsed = ((Date.now() - loop.startTime) / 1000).toFixed(1);
    const reason = cancelled ? " (cancelled by user)" : "";
    emit(agent, `Loop ended: ${loop.count} iteration(s) in ${elapsed}s${reason}`);
    loop.prompt = "";
  }

  return {
    hooks: {
      /**
       * Register the /loop command.
       */
      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
        registry.register("loop", {
          description: "Loop a prompt until cancelled (loop <prompt>)",
          matches: (cmd: string) => cmd === "loop" || cmd.startsWith("loop "),
          handler: async (agent: Agent, cmdValue: string | null) => {
            const prompt = (cmdValue ?? "").slice(5).trim();

            if (!prompt) {
              return {
                action: ACTIONS.DISPLAY,
                content: "Usage: /loop <prompt>",
              };
            }

            // Initialize loop state
            loop.prompt = prompt;
            loop.count = 0;
            loop.startTime = Date.now();
            loop.active = true;

            emit(agent, `Starting loop with prompt: "${prompt}"`);

            // Enqueue the first prompt — the TURN_END hook will re-enqueue
            // after each completion until the loop is stopped.
            agent.enqueue(prompt);

            return {
              action: ACTIONS.DISPLAY,
              content: "",
            };
          },
        });
      },

      /**
       * Detect when the agent finishes processing a message.
       * If a loop is active, clear context and re-enqueue the prompt.
       * Also fires on cancellation (via agent's finally block) — in that
       * case, print the summary and stop without re-enqueuing.
       */
      [HOOKS.TURN_END]: async ({ stopped, cancelled, agent }) => {
        if (!stopped || !agent || !loop.active) return;

        // Cancellation — print summary and stop
        if (cancelled || agent.cancelled) {
          stopLoop(agent, true);
          return;
        }

        // Check max loops
        if (maxLoops > 0 && loop.count >= maxLoops) {
          emit(agent, `Max loops (${maxLoops}) reached.`);
          loop.active = false;
          loop.prompt = "";
          return;
        }

        loop.count++;

        emit(agent, `── Loop ${loop.count} ──`);

        // Clear context for the next iteration
        try {
          await agent.clearContext();
        } catch (e: unknown) {
          emit(agent, `Warning: failed to clear context — ${formatError(e)}`);
          stopLoop(agent, false);
          return;
        }

        emit(agent, `Loop ${loop.count} complete.`);

        // Re-enqueue the loop prompt
        agent.enqueue(loop.prompt);
      },

      /**
       * Intercept /quit and /exit during an active loop.
       */
      [HOOKS.INPUT]: ({text, agent}) => {
        if (!loop.active || !text || !agent) return;

        const trimmed = text.trim();
        const trimmedLower = trimmed.toLowerCase();
        if (trimmedLower === "/quit" || trimmedLower === "/exit") {
          stopLoop(agent, true);
          return { action: "handled" };
        }

        return;
      },
    },
  };
}
