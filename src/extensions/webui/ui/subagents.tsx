/// <reference lib="dom" />
// Subagents sidebar section: a collapsible "Subagents" list nested directly
// under the manager session card that delegated the tasks (Recent Logs'
// disclosure idiom: label + chevron, aria-expanded/aria-controls). One row
// per task agent -- status glyph, step label, elapsed clock -- clicking a row
// opens that task's transcript in the FULL main view (chat.viewSubagent feeds
// the transcript from the same task feed; there is no second render path).
//
// App re-renders never carry task streaming: activity frames go straight from
// chat.ts into the MessageListManager (the main transcript's imperative DOM
// path), so the App tree repaints only when tasksAtom flips (per taskUpdate)
// or the once-per-second elapsed tick lands.

import type { TaskInfoWire } from "@extensions/websocket/protocol.ts";
import { IconChevron, IconKebab, SubagentStatusGlyph } from "./icons.tsx";

/**
 * Milliseconds the row's clock shows. Only the task's own agent-turn time
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

/**
 * Row label: the task_id suffix after the last ':' (the step name, e.g.
 * `chrome#2`); without a ':' the first few words of the description; failing
 * everything, the raw id. The full id + description ride the title. Only the
 * two display fields are read, so the header can label an evicted task from
 * its bare id too.
 */
export function chipLabel(task: Pick<TaskInfoWire, "taskId" | "description">): string {
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
 * Per-task run discriminator, present ONLY when the list spans 2+ distinct
 * runs (one run's rows need no prefix). The shortest trailing dash-segment
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

interface SectionProps {
  /** The section's manager session (ids are keys/aria anchors, never text). */
  sid: string;
  /** This manager's tasks (the Sidebar scopes the global feed per row). */
  tasks: TaskInfoWire[];
  now: number;
  collapsed: boolean;
  /** Task whose transcript is on screen in the main view (row highlight). */
  viewedTaskId: string | null;
  onToggle: () => void;
  onOpenTask: (taskId: string) => void;
  /** The row's context menu: right-click, the row's visible kebab trigger,
   *  and the keyboard twins all route here (the app runs the shared
   *  ContextMenu machinery; rowEl anchors/receives focus back). */
  onTaskMenu: (e: MouseEvent | KeyboardEvent, task: TaskInfoWire, rowEl: HTMLElement) => void;
}

/**
 * The collapsible section. Hidden with the section rather than unmounted:
 * the disclosure keeps its slot (the `#sidebar.logs-collapsed` idiom one
 * list down) and the rows' state (scroll, focus) survives a fold.
 */
export function SubagentsSection(p: SectionProps) {
  // Live tasks first, newest before oldest among the settled ones.
  const ordered = p.tasks.slice().sort((a, b) => {
    const liveA = a.status === "running" || a.status === "queued" ? 1 : 0;
    const liveB = b.status === "running" || b.status === "queued" ? 1 : 0;
    if (liveA !== liveB) return liveB - liveA;
    return b.createdAt - a.createdAt;
  });
  const discriminators = runDiscriminators(ordered);
  const listId = `subagent-list-${p.sid}`;
  return (
    <div className={`subagents-section${p.collapsed ? " collapsed" : ""}`} role="listitem">
      <div className="subagents-header">
        <span className="subagents-label">Subagents</span>
        {/* Chevron idiom, #logs-toggle grammar: the flip rides a rotation
            class on the same svg, the label names the next click. */}
        <button
          id="subagents-toggle"
          type="button"
          className="subagents-toggle"
          aria-expanded={p.collapsed ? "false" : "true"}
          aria-controls={listId}
          aria-label={p.collapsed ? "Expand subagents" : "Collapse subagents"}
          title={p.collapsed ? "Expand subagents" : "Collapse subagents"}
          onClick={p.onToggle}
        >
          <IconChevron
            className={
              p.collapsed
                ? "subagents-toggle-glyph subagents-toggle-glyph-up"
                : "subagents-toggle-glyph"
            }
          />
        </button>
      </div>
      <div id={listId} className="subagent-list" role="list">
        {ordered.map((t) => {
          const disc = discriminators.get(t.taskId);
          const parked = isParked(t);
          // Callback-ref handle to the mounted row (house escape hatch,
          // SidebarRow idiom): the kebab's click resolves its owning row
          // from the DOM, not from the event's currentTarget.
          let rowEl: HTMLElement | null = null;
          return (
            // The row shares the session/log row grammar (not a <button>:
            // the kebab trigger nests inside it): a focusable list item
            // with click-to-open, Enter/Space twins, and the right-click
            // plus Menu/Shift+F10 route to the same task context menu.
            <div
              key={t.taskId}
              data-task-id={t.taskId}
              className={`subagent-row status-${t.status}${parked ? " waiting" : ""}${t.taskId === p.viewedTaskId ? " active" : ""}`}
              title={`${t.taskId}: ${t.description || "(no description)"} — ${parked ? "waiting" : t.status}`}
              aria-current={t.taskId === p.viewedTaskId ? "true" : undefined}
              role="listitem"
              tabindex="0"
              ref={(el) => {
                if (el) rowEl = el as unknown as HTMLElement;
              }}
              onClick={() => p.onOpenTask(t.taskId)}
              onKeydown={(e: KeyboardEvent) => {
                // Direct presses on the row only; keys landing on the
                // kebab belong to the kebab (SidebarRow guard idiom).
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault(); // Space must not page-scroll while focused
                  p.onOpenTask(t.taskId);
                } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                  e.preventDefault();
                  p.onTaskMenu(e, t, e.currentTarget as HTMLElement);
                }
              }}
              onContextMenu={(e: MouseEvent) => {
                e.preventDefault();
                p.onTaskMenu(e, t, e.currentTarget as HTMLElement);
              }}
            >
              <SubagentStatusGlyph status={t.status} parked={parked} />
              <span className="subagent-row-label">{disc ? `${disc}:` : ""}{chipLabel(t)}</span>
              <span className={`subagent-row-elapsed${parked ? " waiting" : ""}`}>{formatElapsed(t, p.now)}</span>
              {/* The visible twin of the right-click (session/log rows'
                  anchor idiom: same .row-menu-btn class, same kebab, same
                  hover/focus reveal; native button = Enter/Space free, and
                  the click never leaks into row-to-open). */}
              <button
                className="row-menu-btn"
                type="button"
                aria-label="Subagent actions"
                title="Subagent actions"
                onClick={(e: MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const row = rowEl ?? (e.currentTarget as HTMLElement | null)?.parentElement ?? null;
                  if (row) p.onTaskMenu(e, t, row);
                }}
              >
                <IconKebab />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
