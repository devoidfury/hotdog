// Subagent task controls + question answers. The task controls are thin
// delegates onto the TaskManager primitives the task_interrupt /
// task_followup tools already use. No control logic here -- the primitives
// own queued/running/parked semantics.

import { readSessionEntries } from "@core/session/session-log.ts";
import { isTerminalStatus } from "@core/session/task-types.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import {
  S2C,
  taskActivityFromLogEntries,
  taskControlMessage,
} from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import type { RouteContext } from "./route-types.ts";

export function handleTaskInterrupt(ctx: RouteContext): void {
  const { ws, msg, registry } = ctx;
  const taskId = typeof msg.taskId === "string" ? msg.taskId : null;
  if (!taskId) return;
  const taskManager = registry.getTaskManager();
  const ok = taskManager ? taskManager.interruptTask(taskId) : false;
  SessionRegistry.sendSafe(
    ws,
    taskControlMessage(
      taskId,
      "interrupt",
      ok,
      ok ? undefined : "Task not found or no longer active",
    ),
  );
}

export function handleTaskFollowup(ctx: RouteContext): void {
  const { ws, msg, registry } = ctx;
  const taskId = typeof msg.taskId === "string" ? msg.taskId : null;
  const message = typeof msg.message === "string" ? msg.message.trim() : "";
  if (!taskId || !message) return;
  const taskManager = registry.getTaskManager();
  const ok = taskManager ? taskManager.sendFollowUp(taskId, message) : false;
  SessionRegistry.sendSafe(
    ws,
    taskControlMessage(
      taskId,
      "followup",
      ok,
      ok ? undefined : "Steering needs a running task with a live turn",
    ),
  );
}

/**
 * Reply to C2S taskActivityRequest. THE seam for the settled/live authority
 * split (doctrine: a viewed subagent is a session view; a FINISHED subagent
 * is a finished session):
 *
 *  - Unsettled task (queued/running): the in-memory relay buffer is the one
 *    and only source, byte-identical to the live feed (the ring, the reset
 *    sentinel trim, and the posture stamps all stay exactly as recorded --
 *    pinned by websocket-task-activity-history + this file's live case).
 *  - Settled task (completed/failed/cancelled): the worker's DURABLE SESSION
 *    LOG is the authority, read through the same cold-log machinery the
 *    session replay and /export ride (readSessionEntries, epoch view) and
 *    folded by taskActivityFromLogEntries. The buffer's caps (300 items /
 *    whole-task eviction / reset trim) may have silently shortened history;
 *    the log has the whole conversation.
 *  - Missing or garbage log: degrade to the buffer (honest last-known bytes,
 *    never fabricated emptiness, never silence-with-data-known).
 *  - ONE source per state, chosen HERE: the client keeps its single render
 *    path, so log and buffer can never both paint the same transcript.
 *
 * The reply is awaited (real log I/O, per the route settle contract). The
 * session gate runs FIRST and owns the whole reply: an id outside the
 * socket's session gets [] and no log path is ever derived for it.
 */
export async function handleTaskActivityRequest(ctx: RouteContext): Promise<void> {
  const { ws, msg, registry } = ctx;
  // Buffered tail for one task, requester only. Gated to the socket's own
  // session, so probing arbitrary task ids leaks nothing.
  const taskId = typeof msg.taskId === "string" ? msg.taskId : null;
  if (!taskId) return;
  const taskManager = registry.getTaskManager();
  const owner = taskManager ? taskManager.getTaskSession(taskId) : undefined;
  const allowed = owner !== undefined && owner === ws.activeSessionId;
  const info = allowed
    ? taskManager!.listTasks().find((t) => t.taskId === taskId)
    : undefined;
  if (!info || !isTerminalStatus(info.status as never)) {
    // Live/unknown/evicted: the buffer answers (empty for unknown ids, as
    // before -- nothing new rides the unsettled path).
    SessionRegistry.sendSafe(ws, {
      type: S2C.TASK_ACTIVITY_HISTORY,
      taskId,
      activity: allowed ? registry.getTaskActivityHistory(taskId) : [],
    });
    return;
  }
  let activity = registry.getTaskActivityHistory(taskId);
  if (info.agentSessionId) {
    try {
      const fromLog = taskActivityFromLogEntries(await readSessionEntries(info.agentSessionId));
      // A log that exists but folds to NOTHING (every entry bookkeeping, or
      // a mid-stream RESET with no epoch past it) is not a transcript: the
      // buffer's bytes stay the honest fallback rather than silence.
      if (fromLog.length > 0) activity = fromLog;
    } catch (err) {
      logger.warn(`[websocket] settled task log replay failed: ${formatError(err)}`);
    }
  }
  SessionRegistry.sendSafe(ws, {
    type: S2C.TASK_ACTIVITY_HISTORY,
    taskId,
    activity,
  });
}

export function handleQuestionAnswer(ctx: RouteContext): void {
  const { ws, msg, registry, bridge } = ctx;
  const sid = msg.sessionId as string | undefined;
  const answers = msg.answers;
  if (!(sid && answers && typeof answers === "object" && !Array.isArray(answers))) return;
  if (bridge.answer(sid, answers as Record<string, unknown>)) {
    // Notify all clients (multiple tabs may be showing the prompt).
    registry.broadcast({
      type: S2C.QUESTION_ANSWERED,
      sessionId: sid,
      answers,
    });
  } else {
    ws.send(
      JSON.stringify({
        type: S2C.ERROR,
        message: `No pending question for session ${sid}`,
      }),
    );
  }
}
