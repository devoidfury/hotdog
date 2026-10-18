/// <reference lib="dom" />
// Subagents strip + overlay panels. The strip lists every task agent the
// server has reported (id, truncated description, status, elapsed); clicking
// a chip opens an overlay streaming that task's activity. Panels stack: the
// last opened renders above earlier ones; each is dismissible, and terminal
// tasks stay openable for the rest of the session.
//
// The streaming activity body is its own mounted tree per panel, kept out of
// App: the feed can emit hundreds of deltas per second, and inside App each
// one would diff the whole UI. TaskPanel's body div has no children prop --
// childless host elements have no child slots, so App re-renders never touch
// it -- and the registry's ref callback mounts an ActivityBody into it.

import type { TaskInfoWire } from "@extensions/websocket/protocol.ts";
import { mount, type DomNode, type Ref } from "@utils/jsx";
import type { TaskActivityBlock } from "./chat.ts";

/**
 * Milliseconds the chip's clock shows. Only the task's own agent-turn time
 * counts: queued tasks tick their wall-clock wait, an in-flight turn ticks
 * from its anchor on top of the banked total, and a parked RUNNING task
 * (judge running for it, waiting on a lane slot, between warm retries) sits
 * frozen at the accumulated total -- so terminal and parked tasks read the
 * same way (accumulated active time).
 */
export function formatElapsed(info: TaskInfoWire, now: number): string {
  const ms =
    info.status === "queued"
      ? Math.max(0, now - info.createdAt)
      : info.activeMs +
        (info.turnStartedAt === null ? 0 : Math.max(0, now - info.turnStartedAt));
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** RUNNING with no agent turn in flight: parked (judge/lane/retry wait). */
function isParked(info: TaskInfoWire): boolean {
  return info.status === "running" && !info.inRun;
}

/** Chips rendered before the strip collapses behind a "+N" overflow chip. */
export const MAX_STRIP_CHIPS = 8;

/**
 * Chip label: the task_id suffix after the last ':' (the step name, e.g.
 * `report-review#2`); without a ':' the first few words of the description;
 * failing everything, the raw id. The full id + description ride the title.
 */
export function chipLabel(task: TaskInfoWire): string {
  const at = task.taskId.lastIndexOf(":");
  if (at !== -1 && at < task.taskId.length - 1) return task.taskId.slice(at + 1);
  const words = (task.description || "").trim().split(/\s+/).slice(0, 5).join(" ");
  return words || task.taskId;
}

/** The run part of a task id (`<run>:<step>` convention); null when unrunned. */
function runOf(taskId: string): string | null {
  const at = taskId.lastIndexOf(":");
  return at > 0 ? taskId.slice(0, at) : null;
}

/**
 * Per-task run discriminator, present ONLY when the strip spans 2+ distinct
 * runs (one run's chips need no prefix). The shortest trailing dash-segment
 * group that no other run also ends with, so `hotdog-archeology` beats
 * reprinting `20261017-1848-hotdog-archeology`.
 */
export function runDiscriminators(tasks: TaskInfoWire[]): Map<string, string> {
  const runs = new Map<string, string[]>();
  for (const t of tasks) {
    const run = runOf(t.taskId);
    if (!run) continue;
    const ids = runs.get(run);
    if (ids) ids.push(t.taskId);
    else runs.set(run, [t.taskId]);
  }
  const out = new Map<string, string>();
  if (runs.size <= 1) return out;
  const runList = [...runs.keys()];
  runList.forEach((run, i) => {
    const segs = run.split("-");
    let disc = run;
    for (let k = 1; k < segs.length; k++) {
      const cand = segs.slice(-k).join("-");
      if (!runList.some((other, j) => j !== i && (other === cand || other.endsWith("-" + cand)))) {
        disc = cand;
        break;
      }
    }
    for (const id of runs.get(run)!) out.set(id, disc);
  });
  return out;
}

const STATUS_GLYPHS: Record<string, string> = {
  completed: "✓",
  failed: "✗",
  cancelled: "⊘",
  running: "◐",
  queued: "○",
};

/** Status as a glyph (color comes from the chip's status-* class). */
export function statusGlyph(status: string): string {
  return STATUS_GLYPHS[status] ?? "•";
}

interface StripProps {
  tasks: TaskInfoWire[];
  now: number;
  openTaskIds: string[];
  onOpen: (taskId: string) => void;
  /** Overflow revealed (the strip lists every task instead of +N behind a chip). */
  expanded?: boolean;
  onToggleExpanded?: () => void;
}

export function SubagentsStrip({
  tasks,
  now,
  openTaskIds,
  onOpen,
  expanded = false,
  onToggleExpanded,
}: StripProps) {
  if (tasks.length === 0) return null;
  // Live tasks first, newest before oldest among the settled ones.
  const ordered = tasks.slice().sort((a, b) => {
    const liveA = a.status === "running" || a.status === "queued" ? 1 : 0;
    const liveB = b.status === "running" || b.status === "queued" ? 1 : 0;
    if (liveA !== liveB) return liveB - liveA;
    return b.createdAt - a.createdAt;
  });
  const discriminators = runDiscriminators(ordered);
  const overflow = !expanded && ordered.length > MAX_STRIP_CHIPS ? ordered.length - MAX_STRIP_CHIPS : 0;
  const visible = overflow > 0 ? ordered.slice(0, MAX_STRIP_CHIPS) : ordered;
  return (
    <div
      id="subagents-strip"
      className={expanded ? "expanded" : undefined}
      title="Background task agents"
    >
      <span className="subagents-label">Subagents</span>
      {visible.map((t) => {
        const disc = discriminators.get(t.taskId);
        const parked = isParked(t);
        return (
          <button
            type="button"
            key={t.taskId}
            className={`subagent-chip status-${t.status}${parked ? " waiting" : ""}${openTaskIds.includes(t.taskId) ? " open" : ""}`}
            title={`${t.taskId}: ${t.description || "(no description)"} — ${parked ? "waiting" : t.status}`}
            onClick={() => onOpen(t.taskId)}
          >
            <span className="subagent-glyph" aria-hidden="true">
              {parked ? "\u25cc" : statusGlyph(t.status)}
            </span>
            <span className="subagent-id">{disc ? `${disc}:` : ""}{chipLabel(t)}</span>
            <span className={`subagent-elapsed${parked ? " waiting" : ""}`}>{formatElapsed(t, now)}</span>
          </button>
        );
      })}
      {overflow > 0 ? (
        <button
          type="button"
          className="subagent-chip subagent-more"
          title={`Show ${overflow} more task agent${overflow === 1 ? "" : "s"}`}
          onClick={onToggleExpanded}
        >
          +{overflow}
        </button>
      ) : null}
      {expanded && ordered.length > MAX_STRIP_CHIPS ? (
        <button
          type="button"
          className="subagent-chip subagent-more"
          title="Collapse the strip"
          onClick={onToggleExpanded}
        >
          −
        </button>
      ) : null}
    </div>
  );
}

// Steering inputs are uncontrolled (the App tree re-renders on status/tick
// updates, and re-binding a value prop would clobber the draft). Refs are
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
  now: number;
  zBase: number;
  /** Most recent server reply for a Cancel/steer on this task, if any. */
  control: { ok: boolean; text: string } | null;
  /** Ref onto the activity body div; its content is owned by the per-panel
   * ActivityBody mount (see createActivityRegistry). */
  bodyRef: Ref;
  onClose: (taskId: string) => void;
  onCancel: (taskId: string) => void;
  onFollowup: (taskId: string, message: string) => void;
}

export function TaskPanel({
  task,
  now,
  zBase,
  control,
  bodyRef,
  onClose,
  onCancel,
  onFollowup,
}: PanelProps) {
  const steerable = task.status === "running";
  const cancellable = steerable || task.status === "queued";
  const parked = isParked(task);
  return (
    <div className="task-overlay" data-task-id={task.taskId} style={{ zIndex: String(zBase) }}>
      <div className="task-overlay-header">
        <span className="subagent-status">{parked ? "waiting" : task.status}</span>
        <span className="task-overlay-title" title={task.description}>
          {task.taskId}
        </span>
        <span className={`task-overlay-elapsed${parked ? " waiting" : ""}`}>{formatElapsed(task, now)}</span>
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
      <div className="task-overlay-body" ref={bodyRef}></div>
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

// ── Per-panel activity body mount ──────────────────────────────────────────
// Rows are keyed by block-object identity (chat.ts merges deltas into the
// same object), so the keyed diff alone handles appends, merged-tail text
// patches, and eviction at the MAX_ACTIVITY_BLOCKS cap.

type GetBlocks = (taskId: string) => TaskActivityBlock[];

interface BodyProps {
  taskId: string;
  getBlocks: GetBlocks;
  /** Stable row ids per block object (per panel; dies with the mount). */
  keys: WeakMap<TaskActivityBlock, number>;
  seq: { next: number };
}

function ActivityBody({ taskId, getBlocks, keys, seq }: BodyProps) {
  const blocks = getBlocks(taskId);
  if (blocks.length === 0)
    return <div className="task-act task-act-empty">Waiting for activity...</div>;
  return blocks.map((block) => {
    let key = keys.get(block);
    if (key === undefined) {
      key = ++seq.next;
      keys.set(block, key);
    }
    if (block.kind === "text" || block.kind === "reasoning") {
      return (
        <div key={key} className={`task-act task-act-${block.kind}`}>
          {block.text}
        </div>
      );
    }
    if (block.kind === "tool_call") {
      return (
        <div key={key} className="task-act task-act-tool">
          <span className="task-act-name">{`tool: ${block.name}`}</span>
          <pre className="task-act-pre">{block.args}</pre>
        </div>
      );
    }
    return (
      <div key={key} className={`task-act task-act-result${block.error ? " error" : ""}`}>
        <span className="task-act-name">{`${block.error ? "error" : "result"}: ${block.name}`}</span>
        <pre className="task-act-pre">{block.error ?? block.output}</pre>
      </div>
    );
  });
}

interface ActivityPanel {
  render: () => void;
  destroy: () => void;
}

export interface ActivityRegistry {
  /** Stable callback ref per task id (patch() must not detach it between App
   * renders): set mounts the panel's body, null unmounts and forgets it. */
  ref: (taskId: string) => Ref;
  /** Re-render every live panel body. Wire to a coalescer + activityVersionAtom. */
  renderAll: () => void;
}

export function createActivityRegistry(getBlocks: GetBlocks): ActivityRegistry {
  const panels = new Map<string, ActivityPanel>();
  const refs = new Map<string, Ref>();
  return {
    ref(taskId) {
      let ref = refs.get(taskId);
      if (!ref) {
        ref = (el) => {
          if (el) {
            // A set without a preceding null (rebind) must not orphan the
            // previous mount: drop it first so nothing renders or leaks there.
            panels.get(taskId)?.destroy();
            const keys = new WeakMap<TaskActivityBlock, number>();
            const seq = { next: 0 };
            const body = () => <ActivityBody taskId={taskId} getBlocks={getBlocks} keys={keys} seq={seq} />;
            const mounted = mount(body(), el as unknown as DomNode);
            panels.set(taskId, { render: () => mounted.render(body()), destroy: () => mounted.unmount() });
          } else {
            panels.get(taskId)?.destroy();
            panels.delete(taskId);
          }
        };
        refs.set(taskId, ref);
      }
      return ref;
    },
    renderAll() {
      for (const panel of panels.values()) panel.render();
    },
  };
}
