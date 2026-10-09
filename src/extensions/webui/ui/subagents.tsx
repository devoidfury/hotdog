/// <reference lib="dom" />
// Subagents strip + overlay panels. The strip lists every task agent the
// server has reported (id, truncated description, status, elapsed); clicking
// a chip opens an overlay streaming that task's activity. Panels stack: the
// last opened renders above earlier ones; each is dismissible, and terminal
// tasks stay openable for the rest of the session.

import type { TaskInfoWire } from "@extensions/websocket/protocol.ts";
import type { Ref } from "@utils/jsx";
import type { TaskActivityBlock } from "./chat.ts";

export function formatElapsed(info: TaskInfoWire, now: number): string {
  const start = info.startedAt ?? info.createdAt;
  const end = info.endedAt ?? now;
  const secs = Math.max(0, Math.floor((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

interface StripProps {
  tasks: TaskInfoWire[];
  now: number;
  openTaskIds: string[];
  onOpen: (taskId: string) => void;
}

export function SubagentsStrip({ tasks, now, openTaskIds, onOpen }: StripProps) {
  if (tasks.length === 0) return null;
  // Live tasks first, newest before oldest among the settled ones.
  const ordered = tasks.slice().sort((a, b) => {
    const liveA = a.status === "running" || a.status === "queued" ? 1 : 0;
    const liveB = b.status === "running" || b.status === "queued" ? 1 : 0;
    if (liveA !== liveB) return liveB - liveA;
    return b.createdAt - a.createdAt;
  });
  return (
    <div id="subagents-strip" title="Background task agents">
      <span className="subagents-label">Subagents</span>
      {ordered.map((t) => (
        <button
          type="button"
          key={t.taskId}
          className={`subagent-chip status-${t.status}${openTaskIds.includes(t.taskId) ? " open" : ""}`}
          title={`${t.taskId}: ${t.description || "(no description)"}`}
          onClick={() => onOpen(t.taskId)}
        >
          <span className="subagent-id">{t.taskId}</span>
          <span className="subagent-desc">{t.description || "(no description)"}</span>
          <span className="subagent-status">{t.status}</span>
          <span className="subagent-elapsed">{formatElapsed(t, now)}</span>
        </button>
      ))}
    </div>
  );
}

// Steering inputs are uncontrolled (the tree re-renders on every activity
// tick, and re-binding a value prop would clobber the draft). Refs are
// stable per task id so patch() does not detach them.
const followupInputs = new Map<string, HTMLInputElement>();
const followupRefs = new Map<string, Ref>();
function followupInputRef(taskId: string): Ref {
  let ref = followupRefs.get(taskId);
  if (!ref) {
    ref = (el) => {
      if (el) followupInputs.set(taskId, el as unknown as HTMLInputElement);
      else followupInputs.delete(taskId);
    };
    followupRefs.set(taskId, ref);
  }
  return ref;
}

interface PanelProps {
  task: TaskInfoWire;
  activity: TaskActivityBlock[];
  now: number;
  zBase: number;
  /** Most recent server reply for a Cancel/steer on this task, if any. */
  control: { ok: boolean; text: string } | null;
  onClose: (taskId: string) => void;
  onCancel: (taskId: string) => void;
  onFollowup: (taskId: string, message: string) => void;
}

export function TaskPanel({
  task,
  activity,
  now,
  zBase,
  control,
  onClose,
  onCancel,
  onFollowup,
}: PanelProps) {
  const steerable = task.status === "running";
  const cancellable = steerable || task.status === "queued";
  return (
    <div className="task-overlay" data-task-id={task.taskId} style={{ zIndex: String(zBase) }}>
      <div className="task-overlay-header">
        <span className="subagent-status">{task.status}</span>
        <span className="task-overlay-title" title={task.description}>
          {task.taskId}
        </span>
        <span className="task-overlay-elapsed">{formatElapsed(task, now)}</span>
        {cancellable ? (
          <button
            type="button"
            className="task-overlay-cancel"
            title="Cancel this task agent (queued or running)"
            onClick={() => onCancel(task.taskId)}
          >
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          className="task-overlay-close"
          title="Close panel"
          onClick={() => onClose(task.taskId)}
        >
          ×
        </button>
      </div>
      <div className="task-overlay-desc">{task.description || "(no description)"}</div>
      <div className="task-overlay-body">
        {activity.length === 0 ? (
          <div className="task-act task-act-empty">Waiting for activity...</div>
        ) : null}
        {activity.map((block, i) => {
          if (block.kind === "text") {
            return (
              <div key={i} className="task-act task-act-text">
                {block.text}
              </div>
            );
          }
          if (block.kind === "tool_call") {
            return (
              <div key={i} className="task-act task-act-tool">
                <span className="task-act-name">tool: {block.name}</span>
                <pre className="task-act-pre">{block.args}</pre>
              </div>
            );
          }
          return (
            <div key={i} className={`task-act task-act-result${block.error ? " error" : ""}`}>
              <span className="task-act-name">
                {block.error ? "error" : "result"}: {block.name}
              </span>
              <pre className="task-act-pre">{block.error ?? block.output}</pre>
            </div>
          );
        })}
      </div>
      <div className="task-overlay-footer">
        {control ? (
          <div className={`task-control-note${control.ok ? "" : " error"}`}>
            {control.text}
          </div>
        ) : null}
        <form
          className="task-followup-form"
          onSubmit={(e: Event) => {
            e.preventDefault();
            const input = followupInputs.get(task.taskId);
            const message = input ? input.value.trim() : "";
            if (!message) return;
            onFollowup(task.taskId, message);
            if (input) input.value = "";
          }}
        >
          <input
            type="text"
            className="task-followup-input"
            placeholder={steerable ? "Steer this task..." : "Task not running -- steering disabled"}
            disabled={!steerable}
            ref={followupInputRef(task.taskId)}
          />
          <button
            type="submit"
            className="task-followup-send"
            disabled={!steerable}
            title="Inject the message at the task's next seam"
          >
            Steer
          </button>
        </form>
      </div>
    </div>
  );
}
