// Loop detector -- catches stuck tool-call spins, the classic local-model failure.
//
// Observes every tool result (the TOOL_RESULT seam), reducing each call to a
// signature of (tool name, canonicalized arguments). When the tail of the
// session's signature history shows k consecutive identical calls or strict
// two-call ping-pong, escalation follows the streak:
//
//   streak >= t    -> inject a system-notice nudge before the next request
//   streak >= 2t   -> a stronger notice (the first nudge was ignored)
//   streak >= 3t   -> cancel the run with a user-visible explanation
//
// Nudges are deferred to the CONTEXT hook, never added mid-tool-execution:
// a message between an assistant(tool_calls) and its tool results 400s strict
// backends. Detection itself stays at the TOOL_RESULT seam so the streak is
// exact. Every escalation fires the core LOOP_DETECTED hook.
//
// State is per session (one shared hook instance serves all sessions) and is
// dropped on context replacement (compaction, rewind, /clear) and session end
// -- after a replacement the old history is gone and repeating a call can be
// legitimate again.

import { HOOKS } from "@core/hooks.ts";
import { Message } from "@core/context/message.ts";
import { getExtensionConfig, type CoreContext, type ExtensionInstance } from "@core/extensions/types.ts";
import {
  callSignature,
  detectLoop,
  describeLoop,
  escalationLevel,
  type LoopKind,
} from "./detector.ts";

interface LoopDetectConfig {
  enabled: boolean;
  repeatThreshold: number;
  pingPongThreshold: number;
}

interface PendingNotice {
  level: 1 | 2;
  kind: LoopKind;
  toolName: string;
  streak: number;
}

interface SessionState {
  /** Ring of call signatures, newest last; capped at 3 * the stop threshold. */
  history: string[];
  /** Highest level already fired for the current episode (reset when the tail stops looping). */
  fired: 0 | 1 | 2;
  /** Nudge waiting for the next CONTEXT pass; consumed (injected) exactly once. */
  pending: PendingNotice | null;
}

function noticeText(p: PendingNotice): string {
  const desc = describeLoop(p.kind, p.streak, p.toolName);
  if (p.level === 1) {
    return (
      `Loop detected: ${desc}. ` +
      `Do not repeat that call unchanged -- change the arguments, take a different approach, ` +
      `or tell the user what is blocking you.`
    );
  }
  return (
    `Loop warning: ${desc}, despite an earlier warning. ` +
    `Repeating the same call is not making progress and must not happen again. ` +
    `Take a materially different action now, or stop and explain the blocker to the user.`
  );
}

export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<LoopDetectConfig>(core, "loopDetect");

  if (config.enabled === false) {
    return {};
  }

  // Schema defaults mirrored here so a bare config (tests, standalone hosts) behaves.
  const repeatThreshold = config.repeatThreshold ?? 3;
  const pingPongThreshold = config.pingPongThreshold ?? 4;
  // Streaks longer than the stop band (3t) are all level 3; no need to remember more.
  const window = 3 * Math.max(repeatThreshold, pingPongThreshold);

  const sessions = new Map<string, SessionState>();

  const getState = (sessionId: string): SessionState => {
    let st = sessions.get(sessionId);
    if (!st) {
      st = { history: [], fired: 0, pending: null };
      sessions.set(sessionId, st);
    }
    return st;
  };

  return {
    hooks: {
      [HOOKS.TOOL_RESULT]: ({ toolName, input, agent }) => {
        if (!agent || agent.isRestoring) return;

        const st = getState(agent.sessionId);
        st.history.push(callSignature(toolName, input));
        if (st.history.length > window) st.history.shift();

        const verdict = detectLoop(st.history, { repeatThreshold, pingPongThreshold });
        if (!verdict) {
          // The tail stopped looping -- the episode is over; a fresh spin
          // starts the ladder from the first nudge again.
          st.fired = 0;
          return;
        }

        const level = escalationLevel(verdict);
        if (level <= st.fired) return; // already nudged at this band

        core.hooks.notifyHooks(HOOKS.LOOP_DETECTED, {
          agent,
          toolName,
          kind: verdict.kind,
          streak: verdict.streak,
          level,
        });

        if (level === 3) {
          // The streak held through both nudges: end the run the way a user
          // cancel would (the current tool batch finishes; the next iteration
          // boundary throws Cancelled). Reset the episode so a user who
          // re-prompts gets the full nudge ladder again instead of an instant stop.
          st.history.length = 0;
          st.fired = 0;
          st.pending = null;
          agent.emitOutput("command_result", {
            content:
              `Loop detector: ${describeLoop(verdict.kind, verdict.streak, toolName)} with no progress. Run stopped. ` +
              `Tune or disable via the "loopDetect" config block.`,
          });
          agent.cancel();
          return;
        }

        st.fired = level;
        st.pending = { level, kind: verdict.kind, toolName, streak: verdict.streak };
      },

      [HOOKS.CONTEXT]: ({ messages, agent }) => {
        if (!agent) return;
        const st = sessions.get(agent.sessionId);
        if (!st?.pending) return;

        const pending = st.pending;
        st.pending = null;

        const notice = new Message({
          role: "harness",
          source: "harness",
          content: [{ type: "system-notice", text: noticeText(pending) }],
        });
        // Persist so the notice rides all later requests and lands in the session log via CONTEXT_MESSAGE.
        agent.addMessage(notice);
        return { messages: [...messages, notice] };
      },

      // Compaction, rewind, and /clear all replace the context; the history
      // the streak was measured against is gone.
      [HOOKS.CONTEXT_REPLACED]: ({ agent }) => {
        if (agent) sessions.delete(agent.sessionId);
      },

      [HOOKS.SESSION_END]: ({ sessionId }) => {
        sessions.delete(sessionId);
      },
    },
  };
}
