/// <reference lib="dom" />
// Subagents sidebar section: a collapsible "Subagents" list nested directly
// under the manager session card that delegated the tasks (Recent Logs'
// disclosure idiom: label + chevron, aria-expanded/aria-controls). One row
// per task agent -- status glyph, step label, elapsed clock, question badge
// carrier (questionPending rides taskWire) -- clicking a row opens the
// WORKER'S OWN session view (live rows attach via switchSession,
// settled/durable rows open the durable log via viewLog -- openTargetFor
// decides; the transcript is the standard session surface, no second path).
//
// App re-renders never carry task streaming: the ticker updates the rows
// when tasksAtom flips (per taskUpdate), and the transcript streams through
// the session view's own imperative DOM path.

import type { TaskInfoWire } from "@extensions/websocket/protocol.ts";
import { IconChevron, IconKebab, SubagentStatusGlyph } from "./icons.tsx";

/**
 * Milliseconds the row's clock shows. Only the task's own agent-turn time
 * counts: queued tasks tick their wall-clock wait, an in-flight turn ticks
 * from its anchor on top of the banked total, and a parked RUNNING task
 * (judge running for it, waiting on a lane slot, between warm retries) sits
 * frozen at the accumulated total -- so terminal and parked tasks read the
 * same way (accumulated active time).
 *
 * adoptedLive: no turn anchor exists (the in-flight turn started in a dead
 * lifetime, turnStartedAt stays null) -- tick the wall clock since spawn.
 */
export function formatElapsed(info: TaskInfoWire, now: number): string {
  const ms =
    info.adoptedLive === true
      ? Math.max(0, now - info.createdAt)
      : info.status === "queued"
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
  /** The session on screen in the main view: a row highlights when its
   *  worker session IS the pane (the transcript is a session view). */
  viewedSessionId: string | null;
  onToggle: () => void;
  /** Row press. The row itself rides along (additive second arg) so the app
   *  can route it through openTargetFor without a lookup. */
  onOpenTask: (taskId: string, task: TaskInfoWire) => void;
  /** The row's context menu: right-click, the row's visible kebab trigger,
   *  and the keyboard twins all route here (the app runs the shared
   *  ContextMenu machinery; rowEl anchors/receives focus back). */
  onTaskMenu: (e: MouseEvent | KeyboardEvent, task: TaskInfoWire, rowEl: HTMLElement) => void;
}

/**
 * Where a row press lands: the session view. A LIVE
 * row (running/queued with a worker session built) opens that session
 * through the STANDARD attach (switchSession -- the pane becomes the
 * worker's session view, watcher-scoped, with windowed replay + live tail).
 * A SETTLED row (terminal task) and a DURABLE restart-survivor row both
 * open the worker's OWN durable log through the existing cold-log machinery
 * (viewLog / LOG_VIEWED): a finished subagent is a finished session. A row
 * whose worker key was never recorded (pre-join sidecar record, or a task
 * that died before its agent was built) has nothing honest to open: it
 * stays informational (the menu still copies the id) -- never a dead click
 * pretending otherwise.
 *
 * The adoptedLive durable row is the overlay's exception: its worker session
 * is live here, so it opens the live tail (switchSession), not the cold log.
 */
export function openTargetFor(
  t: TaskInfoWire,
): { sessionId: string } | { logId: string } | null {
  if (t.agentSessionId === undefined) return null;
  if (t.adoptedLive === true) return { sessionId: t.agentSessionId };
  const live = t.durable !== true && (t.status === "running" || t.status === "queued");
  return live ? { sessionId: t.agentSessionId } : { logId: t.agentSessionId };
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
  // Per-section ids: the sidebar renders this section once per manager (live
  // cards AND cold lineage rows), so a static toggle id would duplicate it.
  const toggleId = `subagents-toggle-${p.sid}`;
  return (
    <div className={`subagents-section${p.collapsed ? " collapsed" : ""}`} role="listitem">
      <div className="subagents-header">
        <span className="subagents-label">Subagents</span>
        {/* Chevron idiom, the .logs-toggle grammar: the flip rides a rotation
            class on the same svg, the label names the next click. */}
        <button
          id={toggleId}
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
          // Durable rows without a recorded worker key have nothing to open
          // (see openTargetFor): the press affordances drop, the row stays
          // readable and its menu stays available.
          const target = openTargetFor(t);
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
              className={`subagent-row status-${t.status}${parked ? " waiting" : ""}${t.agentSessionId !== undefined && t.agentSessionId === p.viewedSessionId ? " active" : ""}`}
              title={`${t.taskId}: ${t.description || "(no description)"} — ${parked ? "waiting" : t.status}${target === null ? " (transcript not on record)" : ""}`}
              aria-current={
                t.agentSessionId !== undefined && t.agentSessionId === p.viewedSessionId
                  ? "true"
                  : undefined
              }
              role="listitem"
              tabindex="0"
              ref={(el) => {
                if (el) rowEl = el as unknown as HTMLElement;
              }}
              onClick={() => {
                if (target) p.onOpenTask(t.taskId, t);
              }}
              onKeydown={(e: KeyboardEvent) => {
                // Direct presses on the row only; keys landing on the
                // kebab belong to the kebab (SidebarRow guard idiom).
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault(); // Space must not page-scroll while focused
                  if (target) p.onOpenTask(t.taskId, t);
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
