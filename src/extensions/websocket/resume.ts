// Resume machinery, split out of server.ts: cold-log adoption (the
// pendingAdoptions dedupe map + adoptSessionLog), the resumed-question hold
// (resumedHeldQuestions + seed/dismiss + resumedToolResult), reconnect
// param parsing, and fresh-session create-and-attach. Each piece of
// module-level state lives here with its only accessors, so lifetime
// semantics are unchanged; the map is exported for the one wiring touch
// createWsServer's onSessionDeleted callback makes (clear the hold before
// dropping the session's bridge entry).

import { getSessionRow } from "@core/session/session-index.ts";
import {
  restoreSessionIntoAgent,
  type AgentForRestore,
  type LogEntry,
  type PendingQuestion,
} from "@core/session/session-log.ts";
import { Message } from "@core/context/message.ts";
import { formatToolResult } from "@core/extensions/tool-utils.ts";
import type { QuestionDef } from "@core/context/input.ts";
import { logger } from "@utils/logger.ts";
import type { WebSocketQuestionBridge } from "./question-input.ts";
import { S2C } from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import type { HotdogServerSocket } from "./socket.ts";

/**
 * Cold-log adoption: build a fresh agent that ADOPTS the log's own session
 * id and replay the log into it (restoreSessionIntoAgent: fsyncs the
 * resume_attempt record, classifies dangling calls, reports held questions).
 * The session keeps its identity across restarts, and the cap's counter
 * lands in the log it counts. The same id is never adopted twice: concurrent
 * adoptions (two tabs reconnecting to one cold session) would fork two
 * writers onto one JSONL file.
 */
const pendingAdoptions = new Map<
  string,
  Promise<{ pendingQuestions: PendingQuestion[]; openTurn: boolean; modelWarning: string | null }>
>();

export async function adoptSessionLog(
  sessionId: string,
  registry: SessionRegistry,
  auto: boolean,
  /** The FULL log read before adoption: reused for the metadata overlay so
   *  the log is not re-read for a session this call is about to grow. */
  preAdoptionEntries: LogEntry[],
): Promise<{ pendingQuestions: PendingQuestion[]; openTurn: boolean; adopted: boolean; modelWarning: string | null }> {
  const inFlight = pendingAdoptions.get(sessionId);
  if (inFlight) {
    const result = await inFlight;
    return { ...result, adopted: false };
  }
  // Late joiner: an adoption already settled (the map clears on settle)
  // while this caller's pre-adoption log read was still queued, so the
  // attach flow's live-session check went stale. The session is live under
  // this id; adopting again would fork a second writer onto one JSONL and
  // double-fire the open-turn continuation. The caller attaches live instead.
  if (registry.get(sessionId)) {
    return { pendingQuestions: [], openTurn: false, adopted: false, modelWarning: null };
  }
  const attempt = (async () => {
    // Restore persisted model and profile so the resumed session runs with
    // the tool set it ended on. The index is the source of truth for cold
    // loads; metadata is in-memory-only and lost on restart. registry.create
    // takes `profile` (it maps to the buildAgent config's `profileName`).
    const row = getSessionRow(sessionId);
    const { agent } = await registry.create({
      ...(row?.model ? { model: row.model } : {}),
      ...(row?.profile ? { profile: row.profile } : {}),
      sessionId,
    });
    // Model fidelity, loud half: with no log-attested model (legacy log or a
    // rebuild from one), the session resumes on the host default -- that is
    // a model swap the user must never discover from a transcript that
    // "looks fine", so it is announced, not assumed. The chat-visible half
    // must NOT ride the sink here: output events are neither persisted nor
    // replayed, and the resuming socket only subscribes during attach, so a
    // pre-attach emit reaches no one (the one flow that needs it). The text
    // rides back to attachResumedSession and is sent after attach lands.
    let modelWarning: string | null = null;
    if (!row?.model) {
      modelWarning =
        `Resuming ${sessionId} with no model attested in the session log ` +
        "(legacy log or an index rebuilt from one): continuing on the host default model. " +
        "Set the model explicitly (/model or the selector) if that is wrong.";
      logger.error(`[session-index] ${modelWarning}`);
    }
    // The agent adopted the id (registry.create hands it through), so this
    // replays the log into the same log and writes the resume_attempt record.
    // Real agents always carry the restore surface; AgentLike is looser.
    const { pendingQuestions, profile, openTurn } = await restoreSessionIntoAgent(
      agent as unknown as AgentForRestore,
      sessionId,
      { auto },
    );
    const meta = registry.get(sessionId)?.metadata;
    // The log may have a PROFILE_SWITCH the index row hasn't mirrored yet.
    // Overlay it.
    if (profile && profile !== agent.profileName) {
      const p = registry.listProfiles()[profile];
      if (p) {
        agent.applyProfile(profile, p);
        if (meta) meta.profile = profile;
      }
    }
    // Restore UI metadata from the log's own timeline so the sidebar agrees
    // with what the user sees.
    if (meta) {
      meta.userMessageCount = agent
        .getMessages()
        .filter((m) => m.role === "user").length;
      let createdAt = 0;
      let lastActivityAt = 0;
      for (const e of preAdoptionEntries) {
        const t = Date.parse(e.ts);
        if (!(t > 0)) continue;
        if (createdAt === 0 || t < createdAt) createdAt = t;
        if (t > lastActivityAt) lastActivityAt = t;
      }
      if (createdAt > 0) meta.createdAt = createdAt;
      if (lastActivityAt > 0) meta.lastActivityAt = lastActivityAt;
    }
    return { pendingQuestions, openTurn, modelWarning };
  })();
  pendingAdoptions.set(sessionId, attempt);
  try {
    const result = await attempt;
    return { ...result, adopted: true };
  } finally {
    pendingAdoptions.delete(sessionId);
  }
}

/** Held resumed questions per session (cold log with unanswered questions):
 *  each answer lands as its held call's tool result, the next question
 *  chains, the last queues a continuation turn. A new prompt dismisses
 *  whatever is still held (honest error results) -- no turn may start on a
 *  dangling call (guaranteed 400 on strict backends). */
export const resumedHeldQuestions = new Map<string, PendingQuestion[]>();

function resumedToolResult(content: string, toolCallId: string, success: boolean): Message {
  return new Message({
    role: "tool",
    content: [formatToolResult(content, "question", success)],
    toolCallId,
    source: "tool",
  });
}

export function seedResumedQuestions(
  bridge: WebSocketQuestionBridge,
  registry: SessionRegistry,
  sessionId: string,
  pending: PendingQuestion[],
): void {
  if (pending.length === 0) return;
  resumedHeldQuestions.set(sessionId, pending.slice());
  const injectNext = (queue: PendingQuestion[]): void => {
    const q = queue[0];
    if (!q) {
      resumedHeldQuestions.delete(sessionId);
      return;
    }
    bridge.inject(sessionId, q.questions as QuestionDef[], (answers, cancelled) => {
      // The hold was dismissed (new prompt) or the session deleted since the
      // inject: never write tool results for calls we no longer hold.
      if (!resumedHeldQuestions.has(sessionId)) return;
      // Resolve the agent fresh: /model or a profile switch may have replaced
      // it between load and answer; the result must land on the live one.
      const agent = registry.get(sessionId)?.agent;
      if (!agent) return; // session gone with the hold: nothing to answer
      agent.addMessage(
        cancelled
          ? resumedToolResult(
              "Question unanswered: it was dismissed without an answer (cancel resolves with defaults, and defaults are not the user's reply).",
              q.toolCallId,
              false,
            )
          : resumedToolResult(JSON.stringify(answers, null, 2), q.toolCallId, true),
      );
      const rest = queue.slice(1);
      if (rest.length > 0) {
        resumedHeldQuestions.set(sessionId, rest);
        injectNext(rest);
        registry.broadcast({ type: S2C.QUESTION, sessionId, questions: rest[0]!.questions });
        return;
      }
      // All held calls answered: drop the hold BEFORE the continuation, so a
      // following prompt's dismiss cannot re-answer calls already resolved.
      resumedHeldQuestions.delete(sessionId);
      registry.getSessionManager().getBus(sessionId)?.enqueue("", { continuation: true });
    });
  };
  injectNext(pending);
}

/**
 * A new prompt abandons any still-held resumed questions: each unanswered
 * call gets an honest error tool result so the context stays wire-valid.
 * (Live questions are untouched -- they belong to a running turn, and their
 * messages simply queue behind it.)
 */
export function dismissResumedQuestions(
  bridge: WebSocketQuestionBridge,
  registry: SessionRegistry,
  sessionId: string,
): void {
  const held = resumedHeldQuestions.get(sessionId);
  if (!held || held.length === 0) return;
  const agent = registry.get(sessionId)?.agent;
  resumedHeldQuestions.delete(sessionId);
  bridge.remove(sessionId); // the queued resolve would write a duplicate answer
  // Clear any question card still on clients -- answering a stale one would
  // get "No pending question" back. Same event as the live answer path,
  // flagged dismissed with empty answers.
  registry.broadcast({
    type: S2C.QUESTION_ANSWERED,
    sessionId,
    answers: {},
    dismissed: true,
  });
  if (!agent) return;
  for (const q of held) {
    agent.addMessage(
      resumedToolResult(
        "Question unanswered: a new message arrived before an answer; the question was dismissed.",
        q.toolCallId,
        false,
      ),
    );
  }
}

/**
 * Reconnect identity from the upgrade URL: `?session=<id>[&cursor=<n>]`.
 * The id survives page reloads; the cursor (replay position) only the socket
 * generation. Invalid shapes fall back to the default attach.
 */
export function parseResumeParams(url: URL): { sessionId: string; cursor: number } | null {
  const sessionId = url.searchParams.get("session");
  if (!sessionId) return null;
  const cursorRaw = url.searchParams.get("cursor");
  const cursor =
    cursorRaw !== null && /^\d+$/.test(cursorRaw) ? Number(cursorRaw) : 0;
  return { sessionId, cursor };
}

export function createAndAttachSession(
  ws: HotdogServerSocket<unknown>,
  registry: SessionRegistry,
): Promise<void> {
  // The chain is returned (not fire-and-forget) so callers like
  // fallbackAttach can await the sessionCreated burst: with a real agent
  // build the create is slow, and an unawaited reason error would race
  // AHEAD of the sessionCreated the client needs first.
  return registry
    .create({})
    .then(({ sessionId, agent }) => {
      const channel = registry.createChannel(sessionId, ws);
      ws.activeSessionId = sessionId;
      ws.activeChannel = channel;

      SessionRegistry.sendSafe(ws, {
        type: S2C.SESSION_CREATED,
        sessionId,
        profile: agent.profileName || "default",
        // Fresh session: no explicit title yet, display follows profile.
        title: null,
        currentModel: agent.model,
        models: Object.keys(agent.modelRegistry || {}),
        sttEnabled: registry.sttEnabled,
        toolExec: registry.toolExecLabel,
      });
      // The replay position for the next reconnect (0 = full replay), closing
      // the client's attach bookkeeping like every other attach path.
      SessionRegistry.sendSafe(ws, {
        type: S2C.SESSION_STATE,
        sessionId,
        key: "cursor",
        value: 0,
      });
      // Always empty here, but every attach path sends its snapshot.
      registry.sendTaskSnapshot(ws);
    })
    .catch((err: unknown) => {
      SessionRegistry.sendSafe(ws, {
        type: S2C.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      try {
        ws.close(4003, "Failed to create session");
      } catch {}
    });
}
