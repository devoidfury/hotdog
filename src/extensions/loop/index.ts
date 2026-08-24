import { HOOKS } from "@core/hooks.ts";
import { ACTIONS } from "@core/commands.ts";
import { formatError } from "@core/error.ts";
import { getExtensionConfig, type CoreContext, type ExtensionInstance } from "@core/extensions/types.ts";
import type { Agent } from "@core/agent.ts";

interface LoopState {
  prompt: string;
  count: number;
  startTime: number;
  active: boolean;
}

export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<{ enabled: boolean; maxLoops: number }>(core, "loop");

  if (config.enabled === false) {
    return {};
  }

  const maxLoops = config.maxLoops;

  // Loop state keyed by agent session id. A shared tool/hook instance is
  // used across all sessions, so per-session state must be namespaced.
  const loops = new Map<string, LoopState>();

  function emit(agent: Agent, content: string): void {
    agent.emitOutput("command_result", { content });
  }

  function stopLoop(agent: Agent, cancelled: boolean): void {
    const loop = loops.get(agent.sessionId);
    if (!loop) return;
    loop.active = false;
    const elapsed = ((Date.now() - loop.startTime) / 1000).toFixed(1);
    const reason = cancelled ? " (cancelled by user)" : "";
    emit(agent, `Loop ended: ${loop.count} iteration(s) in ${elapsed}s${reason}`);
    loop.prompt = "";
    loops.delete(agent.sessionId);
  }

  return {
    hooks: {
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

            // Re-running /loop on an active session restarts it (fresh count and timer).
            loops.set(agent.sessionId, {
              prompt,
              count: 0,
              startTime: Date.now(),
              active: true,
            });

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

      [HOOKS.TURN_END]: async ({ stopped, cancelled, agent, reason }) => {
        if (!stopped || !agent) return;

        const loop = loops.get(agent.sessionId);
        if (!loop || !loop.active) return;

        if (cancelled || agent.cancelled) {
          stopLoop(agent, true);
          return;
        }

        // Errors and iteration-cap blowouts are not completed turns — stop
        // without re-enqueuing so we don't loop on a broken run.
        if (reason === "error" || reason === "max_iterations") {
          stopLoop(agent, false);
          return;
        }

        if (maxLoops > 0 && loop.count >= maxLoops) {
          emit(agent, `Max loops (${maxLoops}) reached.`);
          loop.active = false;
          loop.prompt = "";
          loops.delete(agent.sessionId);
          return;
        }

        loop.count++;
        emit(agent, `==== Loop ${loop.count} ====`);

        try {
          await agent.clearContext();
        } catch (e: unknown) {
          emit(agent, `Warning: failed to clear context — ${formatError(e)}`);
          stopLoop(agent, false);
          return;
        }

        emit(agent, `Loop ${loop.count} complete.`);

        agent.enqueue(loop.prompt);
      },

      [HOOKS.INPUT]: ({ text, agent }) => {
        if (!text || !agent) return;

        const loop = loops.get(agent.sessionId);
        if (!loop || !loop.active) return;

        const cmd = text.trim().toLowerCase();
        if (cmd === "/quit" || cmd === "/exit") {
          stopLoop(agent, true);
          return { action: "handled" };
        }
      },
    },
  };
}
