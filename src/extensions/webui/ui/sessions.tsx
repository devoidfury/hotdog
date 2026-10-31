/// <reference lib="dom" />
// Session/log sidebar. Both lists share one row grammar:
//
//   provider/model      [status]            [action]
//   profile  (ctx used / ctx total) . (msg count) . (connected client?)
//   start date & time . session id
//
// No literal parens anywhere: status renders as a text badge, profile as
// quiet muted text. Missing segments are omitted outright, never rendered
// empty; " . " is the segment separator between the slots the example
// dot-joins. The line-1 action pins right (margin-left:auto), no sep.

import { formatTokenCount, SIDEBAR_MIN_WIDTH } from "./utils.ts";
import type { JsxChild, Ref } from "@utils/jsx";

export interface SessionInfo {
  id: string;
  profile?: string;
  /** Explicit session name; absent/null means the display name is the profile. */
  title?: string | null;
  model?: string;
  createdAt: number;
  lastActivityAt: number;
  connectedClients: number;
  /** Sidebar row slots: user-message tally and the last token_usage snapshot. */
  userMessageCount?: number;
  ctxUsed?: number;
  ctxTotal?: number;
}

export interface LogInfo {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  /** Derived index state (idle/awaiting_question/interrupted/parked);
   *  absent when the log has no reconciled row yet. */
  state?: string;
  /** Index-attested model/profile + ctx; absent on legacy logs (segments omitted). */
  model?: string;
  profile?: string;
  ctxUsed?: number;
  ctxTotal?: number;
}

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** Local "YYYY-MM-DD HH:MM" -- the sidebar line-3 stamp. */
export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface SidebarProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  workingMap: Map<string, boolean>;
  logs: LogInfo[];
  activeLogId: string | null;
  sidebarWidth: number;
  sidebarMax: number;
  onCreate: () => void;
  onSwitch: (sessionId: string) => void;
  onCancel: (sessionId: string) => void;
  onContinueLog: (logId: string) => void;
  onViewLog: (logId: string) => void;
  onSessionMenu: (e: MouseEvent, session: SessionInfo) => void;
  onLogMenu: (e: MouseEvent, logId: string) => void;
  onResizeStart: (e: PointerEvent) => void;
  onResizeMove: (e: PointerEvent) => void;
  onResizeEnd: (e: PointerEvent) => void;
  onResizeKey: (e: KeyboardEvent) => void;
  onResizeReset: (e: MouseEvent) => void;
}

interface SidebarRowProps {
  /** Slab styling: "session-item" (live) or "log-item" (cold). */
  kindClass: string;
  active: boolean;
  id: string;
  model?: string | null;
  /** Line-2 profile tag: display name (title wins), omitted when neither set. */
  displayName?: string | null;
  /** Line-1 status badge text, rendered as-is; null/empty omits the segment. */
  status?: string | null;
  /** Optional color modifier for the status slot (cold-log derived states). */
  statusClass?: string;
  spinner?: boolean;
  ctxUsed?: number;
  ctxTotal?: number;
  messageCount?: number;
  /** Live rows only; absent on cold logs (structurally 0 clients). */
  connectedClients?: number;
  createdAt: number;
  /** Line-1 trailing action node (Cancel / Continue); null omits the slot. */
  action?: JsxChild;
  onSelect: () => void;
  onContextMenu?: (e: MouseEvent) => void;
}

function rowClass(kindClass: string, active: boolean): string {
  return active ? `${kindClass} active` : kindClass;
}

/** One sidebar row in the shared grammar; the callers decide which slots exist. */
export function SidebarRow(p: SidebarRowProps) {
  const line1: JsxChild[] = [];
  if (p.model) line1.push(<span className="row-model">{p.model}</span>);
  if (p.status) {
    line1.push(
      <span className={p.statusClass ? `row-status ${p.statusClass}` : "row-status"}>
        {p.spinner ? <span className="session-spinner"></span> : null}
        {p.status}
      </span>,
    );
  }
  if (p.action) line1.push(<span className="row-action row-action-right">{p.action}</span>);

  // Profile tag leads; the metric slots dot-join among themselves.
  const line2: JsxChild[] = [];
  if (p.displayName) line2.push(<span className="row-profile">{p.displayName}</span>);
  const ctx =
    p.ctxUsed != null
      ? `${formatTokenCount(p.ctxUsed)}${p.ctxTotal != null && Number.isFinite(p.ctxTotal) ? `/${formatTokenCount(p.ctxTotal)}` : ""}`
      : null;
  const msgs =
    p.messageCount != null && p.messageCount > 0
      ? `${p.messageCount} msg${p.messageCount > 1 ? "s" : ""}`
      : null;
  const clients =
    p.connectedClients != null && p.connectedClients > 0
      ? `${p.connectedClients} client${p.connectedClients > 1 ? "s" : ""}`
      : null;
  let metrics = 0;
  for (const part of [ctx, msgs, clients]) {
    if (!part) continue;
    if (metrics > 0) line2.push(<span className="row-sep">.</span>);
    line2.push(<span className="row-metric">{part}</span>);
    metrics++;
  }

  const line3: JsxChild[] = [
    <span className="row-date">{formatDateTime(p.createdAt)}</span>,
    <span className="row-sep">.</span>,
    <span className="row-id">{p.id}</span>,
  ];

  return (
    <div
      className={rowClass(p.kindClass, p.active)}
      onClick={p.onSelect}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        p.onContextMenu?.(e);
      }}
    >
      <div className="row-l1">{line1}</div>
      {line2.length > 0 ? <div className="row-l2">{line2}</div> : null}
      <div className="row-l3">{line3}</div>
    </div>
  );
}

export function Sidebar(p: SidebarProps) {
  return (
    <aside id="sidebar">
      <div className="sidebar-header">
        <h2>Sessions</h2>
        <button id="new-session-btn" title="New session" onClick={p.onCreate}>+</button>
      </div>
      <div id="session-list">
        {p.sessions.map((s) => {
          const isWorking = p.workingMap.get(s.id) ?? false;
          return (
            <SidebarRow
              key={s.id}
              kindClass="session-item"
              active={s.id === p.activeSessionId}
              id={s.id}
              model={s.model}
              displayName={s.title || s.profile}
              status={isWorking ? "working" : "idle"}
              spinner={isWorking}
              ctxUsed={s.ctxUsed}
              ctxTotal={s.ctxTotal}
              messageCount={s.userMessageCount}
              connectedClients={s.connectedClients}
              createdAt={s.createdAt}
              action={
                isWorking ? (
                  <button
                    className="session-cancel-btn"
                    title="Cancel"
                    onClick={(e: MouseEvent) => {
                      e.stopPropagation();
                      p.onCancel(s.id);
                    }}
                  >
                    Cancel
                  </button>
                ) : null
              }
              onSelect={() => p.onSwitch(s.id)}
              onContextMenu={(e) => p.onSessionMenu(e, s)}
            />
          );
        })}
      </div>

      <div className="sidebar-header sidebar-header-secondary">
        <h2>Recent Logs</h2>
      </div>
      <div id="log-list">
        {p.logs.length === 0 ? (
          <div
            className="log-empty"
            style={{ padding: "10px", "font-size": "0.75rem", color: "var(--text-muted)", "text-align": "center" }}
          >
            No recent logs
          </div>
        ) : (
          p.logs.map((log) => (
            <SidebarRow
              key={log.id}
              kindClass="log-item"
              active={log.id === p.activeLogId}
              id={log.id}
              model={log.model}
              displayName={log.profile}
              // Derived index state badges the row (idle stays unbadged).
              status={log.state && log.state !== "idle" ? log.state.replace(/_/g, " ") : null}
              statusClass={log.state ? `log-state-${log.state}` : undefined}
              ctxUsed={log.ctxUsed}
              ctxTotal={log.ctxTotal}
              messageCount={log.messageCount}
              createdAt={log.createdAt}
              action={
                <button
                  className="log-continue-btn"
                  title="Continue this session (keeps its session id)"
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    p.onContinueLog(log.id);
                  }}
                >
                  Continue
                </button>
              }
              onSelect={() => p.onViewLog(log.id)}
              onContextMenu={(e) => p.onLogMenu(e, log.id)}
            />
          ))
        )}
      </div>

      {/* Drag/keyboard resize handle straddling the right border. The logic
          lives in app.tsx; hidden by CSS in the mobile drawer media query. */}
      <div
        id="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={p.sidebarWidth}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={p.sidebarMax}
        tabindex="0"
        onPointerdown={p.onResizeStart}
        onPointermove={p.onResizeMove}
        onPointerup={p.onResizeEnd}
        onPointercancel={p.onResizeEnd}
        onKeydown={p.onResizeKey}
        onDblclick={p.onResizeReset}
      />
    </aside>
  );
}

export function ContextMenu(props: {
  menu: ContextMenuState;
  rootRef: Ref;
}) {
  return (
    <div
      className="context-menu"
      ref={props.rootRef}
      style={{ left: `${props.menu.x}px`, top: `${props.menu.y}px` }}
    >
      {props.menu.items.map((it, i) => (
        <div
          key={i}
          className={`context-menu-item${it.danger ? " context-menu-item-danger" : ""}`}
          onClick={it.onSelect}
        >
          {it.label}
        </div>
      ))}
    </div>
  );
}
