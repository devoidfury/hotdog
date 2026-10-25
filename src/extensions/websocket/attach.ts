// Attach flows, split out of server.ts: live attach (channel + full-log
// replay + cursor), resume attach (live or cold adoption, with the fallback
// chain), and the default most-recent/fresh attach.

import {
  collectDurabilityFacts,
  epochEntries,
  epochStartIndex,
  LOG_SOURCE,
  MAX_CONSECUTIVE_AUTO_RESUMES,
  readSessionEntries,
  sessionExists,
  sessionPath,
  type LogEntry,
} from "@core/session/session-log.ts";
import type { Agent } from "@core/agent.ts";
import type { QuestionDef } from "@core/context/input.ts";
import type { WebSocketQuestionBridge } from "./question-input.ts";
import { S2C } from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import { replayLogSlice, replayPendingQuestion } from "./replay.ts";
import { adoptSessionLog, createAndAttachSession, seedResumedQuestions } from "./resume.ts";
import type { HotdogServerSocket } from "./socket.ts";

/**
 * Attach a socket to a LIVE session: channel, sessionCreated, history
 * replay from the log at `cursor`, in-flight partial-stream flush, and the
 * new replay cursor (FULL log length). The log -- not the in-memory
 * messages -- is replayed, so the cursor the client persists is exactly a
 * full-log index it can hand back on the next reconnect.
 *
 * The cursor lives in the full log's append-only coordinate space: an
 * epoch-length cursor is only valid while no RESET has moved the index
 * space, and a RESET that shrinks the epoch below the cursor and regrows
 * it past it would silently replay the wrong slice. The full log only ever
 * grows, so a valid cursor stays valid across compactions.
 *
 * `cursor > 0` means the client asked for a delta (it only sends one when
 * its transcript ends exactly at that position: the slice is the exact
 * tail, nothing to clear or duplicate). The client skips its transcript
 * clear when it sees `replayDelta: true` on sessionCreated. Two cases
 * clamp to a full replay instead: a cursor beyond the full length (the log
 * shrank under it -- truncation/corruption; a RESET only appends), and a
 * slice that CROSSES a RESET (a rewind re-appends its kept messages below
 * the marker, so the tail would replay copies the client already holds).
 * Compaction writes no RESET (replaceContext), so common-case cursors are
 * unaffected.
 */
/** The sessionCreated payload for a live session (attach + broadcast share it). */
function sessionCreatedPayload(
  registry: SessionRegistry,
  sessionId: string,
): Record<string, unknown> {
  const session = registry.get(sessionId);
  const agent = (session?.agent as Agent) || null;
  const meta = session?.metadata;
  return {
    type: S2C.SESSION_CREATED,
    sessionId,
    profile: agent?.profileName || meta?.profile || "default",
    title: meta?.title ?? null,
    currentModel: agent?.model || meta?.model || "?",
    models: Object.keys(agent?.modelRegistry || {}),
    sttEnabled: registry.sttEnabled,
    toolExec: registry.toolExecLabel,
  };
}

export async function attachLiveSession(
  ws: HotdogServerSocket<unknown>,
  registry: SessionRegistry,
  bridge: WebSocketQuestionBridge,
  sessionId: string,
  cursor = 0,
  fullOverride?: LogEntry[],
): Promise<boolean> {
  const session = registry.get(sessionId);
  if (!session) return false;
  if (ws.activeSessionId && ws.activeChannel) {
    registry.removeChannel(ws.activeSessionId, ws.activeChannel);
  }
  const channel = registry.createChannel(sessionId, ws);
  if (!channel) return false;
  ws.activeSessionId = sessionId;
  ws.activeChannel = channel;

  const agent = session.agent as Agent;

  // Cold adoption passes the PRE-adoption full log (the log has since grown
  // by bookkeeping records); live attaches read the current one.
  const full = fullOverride ?? (await readSessionEntries(sessionId, { full: true }));
  // A cursor beyond the full length means the log shrank under it
  // (truncation/corruption): the retained transcript is stale, so a full
  // replay (the epoch -- the context's view) instead of a delta that would
  // keep the stale head. A delta sends the exact full-log tail past it.
  const epochStart = epochStartIndex(full);
  const c = Number.isFinite(cursor) && cursor > 0 ? Math.trunc(cursor) : 0;
  // A slice crossing a RESET is not the exact tail of the client's
  // transcript: full replay, not a duplicate-laden delta.
  const replayDelta =
    c > 0 && c <= full.length && !full.slice(c).some((e) => e.source === LOG_SOURCE.RESET);
  const start = replayDelta ? c : epochStart;

  SessionRegistry.sendSafe(ws, {
    ...sessionCreatedPayload(registry, sessionId),
    ...(replayDelta ? { replayDelta: true } : {}),
  });

  replayLogSlice(ws, sessionId, full, start, agent?.toolRegistry);

  // Flush in-flight chunks that haven't reached the log yet (their LLM
  // entry lands when the response completes).
  const partialReasoning = agent.currentStreamingReasoning;
  const partialContent = agent.currentStreamingContent;
  if (partialReasoning) {
    SessionRegistry.sendSafe(ws, {
      type: S2C.STREAMING_REASONING_CHUNK,
      sessionId,
      content: partialReasoning,
    });
  }
  if (partialContent) {
    SessionRegistry.sendSafe(ws, { type: S2C.STREAMING_CHUNK, sessionId, content: partialContent });
  }

  // The client's new replay position for the next reconnect (full log
  // length: the append-only coordinate the cursor lives in). 0 when a
  // partial was flushed above: the transcript then holds content the log
  // lacks at that position, so the next reconnect must full-replay instead
  // of a delta that could replay the finished response on top of the
  // partial.
  SessionRegistry.sendSafe(ws, {
    type: S2C.SESSION_STATE,
    sessionId,
    key: "cursor",
    value: partialReasoning || partialContent ? 0 : full.length,
  });
  const isRunning = registry.getSessionManager().isSessionRunning(sessionId);
  SessionRegistry.sendSafe(ws, { type: S2C.SESSION_STATE, sessionId, key: "working", value: isRunning });
  replayPendingQuestion(bridge, sessionId, ws);
  registry.sendTaskSnapshot(ws);
  return true;
}

/**
 * Attach a socket to the session it was last on (reconnect identity): the
 * session id survives the disconnect; the cursor (optional) lets the client
 * keep its transcript and take only the delta. Live: attach directly. Cold:
 * adopt the log under its own id, with the livelock cap enforced for AUTO
 * resumes only (manual resumes always pass). Unknown or parked sessions
 * fall back to the most recent, with an honest error after the fallback
 * lands (so it survives the client's transcript clear).
 */
export async function attachResumedSession(
  ws: HotdogServerSocket<unknown>,
  registry: SessionRegistry,
  bridge: WebSocketQuestionBridge,
  sessionId: string,
  cursor = 0,
  auto: boolean,
): Promise<void> {
  const fallBack = (reason: string): Promise<void> =>
    fallbackAttach(ws, registry, bridge, reason);

  try {
    sessionPath(sessionId); // invalid id (traversal, separators) = unknown
  } catch {
    return fallBack(`Session ${JSON.stringify(String(sessionId).slice(0, 80))} is not a valid id.`);
  }

  if (registry.get(sessionId)) {
    // The live session can go cold between the get and the attach; fall
    // back instead of stranding the socket.
    if (!(await attachLiveSession(ws, registry, bridge, sessionId, cursor))) {
      return fallBack(`Session ${sessionId} could not be attached.`);
    }
    return;
  }

  if (!(await sessionExists(sessionId))) {
    return fallBack(`Session ${sessionId} no longer exists (no log found).`);
  }

  // One full-log read serves both consumers: the cap's counter (an audit
  // trail a RESET must not recharge) and the pre-adoption full log (the
  // cursor's coordinate space) come from the same array.
  const fullEntries = await readSessionEntries(sessionId, { full: true });
  if (epochEntries(fullEntries).length === 0) {
    return fallBack(`Session ${sessionId}'s log is empty.`);
  }

  if (auto) {
    const { consecutiveAutoResumes } = collectDurabilityFacts(fullEntries);
    if (consecutiveAutoResumes >= MAX_CONSECUTIVE_AUTO_RESUMES) {
      return fallBack(
        `Session ${sessionId} is parked after ${consecutiveAutoResumes} consecutive auto-resumes ` +
          `without progress. Open it from Recent Logs and pick Continue to resume it manually.`,
      );
    }
  }

  const { pendingQuestions, openTurn, adopted, modelWarning } = await adoptSessionLog(
    sessionId,
    registry,
    auto,
    fullEntries,
  );
  // Replay the PRE-adoption full log: the log now also holds the adoption's
  // session_start/resume_attempt records (bookkeeping, never sent), and the
  // client's cursor indexes the pre-adoption positions.
  const attached = await attachLiveSession(ws, registry, bridge, sessionId, cursor, fullEntries);
  if (!attached) return fallBack(`Session ${sessionId} could not be resumed.`);

  // The adopt-time model warning, delivered where it can be seen: the socket
  // only subscribes during attach and output events are never replayed, so
  // this rides the attach burst right after the cursor (like the held
  // questions below), before any continuation turn starts.
  if (modelWarning) {
    SessionRegistry.sendSafe(ws, {
      type: S2C.SYSTEM_MESSAGE,
      sessionId,
      content: modelWarning,
    });
  }

  if (adopted) {
    // Newly live session: other tabs' sidebars learn it moved from Recent
    // Logs as a SIDEBAR REFRESH, not a sessionCreated -- that event is an
    // attach command on the client (re-targets the socket, clears the
    // transcript), so broadcasting it would yank tabs working on other
    // sessions. The adopting socket is excluded (it refreshed itself).
    registry.broadcastExcept(ws, { type: S2C.SESSIONS, sessions: registry.list() });
  }

  // Held questions (the log died mid-question): the adopting client re-presents
  // them; later attachers get them via replayPendingQuestion on the bridge.
  if (adopted && pendingQuestions.length > 0) {
    seedResumedQuestions(bridge, registry, sessionId, pendingQuestions);
    SessionRegistry.sendSafe(ws, {
      type: S2C.QUESTION,
      sessionId,
      questions: pendingQuestions[0]!.questions as QuestionDef[],
    });
  }

  // Interrupted turn (v2: turn_started with no turn_end): restart the agent
  // loop so it continues from the repaired context (interrupted tool results
  // ride along as outcome-unknown). Held questions win: a turn must not
  // start on a dangling question call (400 on strict backends); the
  // question's ANSWER enqueues the continuation instead. Only the adopting
  // client triggers it (concurrent adopters dedupe); no double-start.
  if (adopted && openTurn && pendingQuestions.length === 0) {
    registry.getSessionManager().getBus(sessionId)?.enqueue("", { continuation: true });
  }
}

/** Fallback attach (saved session unknown/parked): most recent session, or a
 *  fresh one when the server holds none. The reason is sent AFTER the
 *  fallback's sessionCreated: the client clears its transcript on attach, so
 *  an earlier error would never render. */
export async function fallbackAttach(
  ws: HotdogServerSocket<unknown>,
  registry: SessionRegistry,
  bridge: WebSocketQuestionBridge,
  reason: string,
): Promise<void> {
  if (registry.size > 0) {
    await attachToMostRecentSession(ws, registry, bridge);
  } else {
    await createAndAttachSession(ws, registry);
  }
  SessionRegistry.sendSafe(ws, { type: S2C.ERROR, message: reason });
}

export async function attachToMostRecentSession(
  ws: HotdogServerSocket<unknown>,
  registry: SessionRegistry,
  bridge: WebSocketQuestionBridge,
): Promise<void> {
  const sessions = registry.list();
  let mostRecent: { id: string; lastActivityAt: number } | null = null;
  let mostRecentTime = 0;
  for (const s of sessions) {
    if (s.lastActivityAt > mostRecentTime) {
      mostRecent = s;
      mostRecentTime = s.lastActivityAt;
    }
  }

  if (!mostRecent) {
    // Awaited: a caller that settles this chain (fallbackAttach) must see
    // the sessionCreated burst before it appends anything of its own.
    await createAndAttachSession(ws, registry);
    return;
  }

  const attached = await attachLiveSession(ws, registry, bridge, mostRecent.id);
  if (!attached) await createAndAttachSession(ws, registry);
}
