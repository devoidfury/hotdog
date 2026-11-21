// Subagent task controls + question answers. The task controls are thin
// delegates onto the TaskManager primitives the task_interrupt /
// task_followup tools already use. No control logic here -- the primitives
// own queued/running/parked semantics.

import { S2C, taskControlMessage } from "./protocol.ts";
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

export function handleQuestionAnswer(ctx: RouteContext): void {
  const { ws, msg, registry, bridge } = ctx;
  const sid = msg.sessionId as string | undefined;
  const answers = msg.answers;
  if (!(sid && answers && typeof answers === "object" && !Array.isArray(answers))) return;
  // R3: a worker-row question has exactly ONE respondent -- the delegating
  // manager, through task_followup -> sendFollowUp -> the question eats the
  // text. A direct answer here is refused with an honest error: the pending
  // stays untouched, the manager wake stays armed, and no QUESTION_ANSWERED
  // broadcast fires. (Interactive sids answer byte-identically below; the
  // rest of the kind-table refusals are B3's.)
  if (registry.getRow(sid)?.kind === "worker") {
    // Direct-send seam: this ERROR commits the client's in-flight row
    // (handleError -> finalizeAssistant), so the socket's own buffered
    // stream tail (worker-tail frames ride the batched publish path) must
    // ship first or it renders as a stray post-commit row.
    registry.flushSocket(ws);
    ws.send(
      JSON.stringify({
        type: S2C.ERROR,
        message:
          "Subagent questions are answered by their delegating manager (via task_followup).",
      }),
    );
    return;
  }
  if (bridge.answer(sid, answers as Record<string, unknown>)) {
    // Notify all clients (multiple tabs may be showing the prompt).
    registry.broadcast({
      type: S2C.QUESTION_ANSWERED,
      sessionId: sid,
      answers,
    });
  } else {
    // Direct-send seam (stale multi-tab answer): the ERROR commits the row,
    // so drain this socket's batches before it lands mid-window.
    registry.flushSocket(ws);
    ws.send(
      JSON.stringify({
        type: S2C.ERROR,
        message: `No pending question for session ${sid}`,
      }),
    );
  }
}
