/// <reference lib="dom" />
// Session/log sidebar

import { formatTime, shortId } from "./utils.ts";
import type { Ref } from "@utils/jsx";

export interface SessionInfo {
  id: string;
  profile?: string;
  /** Explicit session name; absent/null means the display name is the profile. */
  title?: string | null;
  model?: string;
  createdAt: number;
  lastActivityAt: number;
  connectedClients: number;
}

export interface LogInfo {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
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

interface SidebarProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  workingMap: Map<string, boolean>;
  logs: LogInfo[];
  activeLogId: string | null;
  onCreate: () => void;
  onSwitch: (sessionId: string) => void;
  onCancel: (sessionId: string) => void;
  onContinueLog: (logId: string) => void;
  onViewLog: (logId: string) => void;
  onSessionMenu: (e: MouseEvent, session: SessionInfo) => void;
  onLogMenu: (e: MouseEvent, logId: string) => void;
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
          const nClients = s.connectedClients;
          return (
            <div
              key={s.id}
              className={`session-item${s.id === p.activeSessionId ? " active" : ""}`}
              onClick={() => p.onSwitch(s.id)}
              onContextMenu={(e: MouseEvent) => {
                e.preventDefault();
                p.onSessionMenu(e, s);
              }}
            >
              <div className="session-name">
                {/* An explicit title wins; otherwise the display name is the profile. */}
                <span className="session-profile-badge">{s.title || s.profile || "default"}</span>
                {s.model ?? "?"}
              </div>
              <div className="session-meta">
                {formatTime(s.createdAt)}
                {nClients > 0 ? ` · ${nClients} client${nClients > 1 ? "s" : ""}` : ""}
              </div>
              {isWorking ? (
                <span className="session-working-indicator">
                  <span className="session-spinner"></span>
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
                </span>
              ) : null}
            </div>
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
            <div
              key={log.id}
              className={`log-item${log.id === p.activeLogId ? " active" : ""}`}
              onClick={() => p.onViewLog(log.id)}
              onContextMenu={(e: MouseEvent) => {
                e.preventDefault();
                p.onLogMenu(e, log.id);
              }}
            >
              <div className="log-name">{shortId(log.id)}</div>
              <div className="log-meta">
                <span>
                  {formatTime(log.lastActivityAt)} ·{" "}
                  {log.messageCount > 0
                    ? `${log.messageCount} msg${log.messageCount > 1 ? "s" : ""}`
                    : "empty"}
                </span>
                <div className="log-actions">
                  <button
                    className="log-continue-btn"
                    title="Continue in new session"
                    onClick={(e: MouseEvent) => {
                      e.stopPropagation();
                      p.onContinueLog(log.id);
                    }}
                  >
                    Continue
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
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
