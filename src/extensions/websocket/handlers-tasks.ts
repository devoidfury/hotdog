// Subagent panel controls + question answers. The task controls are thin
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

export function handleTaskActivityRequest(ctx: RouteContext): void {
  const { ws, msg, registry } = ctx;
  // Buffered tail for one task, requester only. Gated to the socket's own
  // session, so probing arbitrary task ids leaks nothing.
  const taskId = typeof msg.taskId === "string" ? msg.taskId : null;
  if (!taskId) return;
  const taskManager = registry.getTaskManager();
  const owner = taskManager ? taskManager.getTaskSession(taskId) : undefined;
  const allowed = owner !== undefined && owner === ws.activeSessionId;
  SessionRegistry.sendSafe(ws, {
    type: S2C.TASK_ACTIVITY_HISTORY,
    taskId,
    activity: allowed ? registry.getTaskActivityHistory(taskId) : [],
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
