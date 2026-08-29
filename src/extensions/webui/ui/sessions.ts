/// <reference lib="dom" />
// Session list/management sidebar component.

import { sanitize, formatTime, shortId } from "./utils.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  profile?: string;
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

interface SessionsConfig {
  onCreate: () => void;
  onSwitch: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, newName: string) => void;
  /** Optional callback wired to the cancel button on working sessions */
  onCancel?: (sessionId: string) => void;
  /** Callback for listing cold session logs */
  /** Callback for continuing a cold session log in a new session */
  onContinueLog?: (logId: string) => void;
  /** Callback for viewing a cold session log (read-only, no active session) */
  onViewLog?: (logId: string) => void;
  /** Callback for deleting a cold session log file */
  onDeleteLog?: (logId: string) => void;
}

export type UpdateSessionsFn = (
  sessions: SessionInfo[],
  activeSessionId: string | null,
  workingMap?: Map<string, boolean>,
  activeLogId?: string | null,
) => void;
export type UpdateLogsFn = (
  logs: LogInfo[],
  activeLogId: string | null,
) => void;

export function initSessions({
  onCreate,
  onSwitch,
  onDelete,
  onRename,
  onCancel,
  onContinueLog,
  onViewLog,
  onDeleteLog,
}: SessionsConfig): {
  updateSessions: UpdateSessionsFn;
  updateLogs: UpdateLogsFn;
} {
  const listEl = document.getElementById("session-list") as HTMLDivElement;
  const logListEl = document.getElementById("log-list") as HTMLDivElement;
  const newBtn = document.getElementById(
    "new-session-btn",
  ) as HTMLButtonElement;

  newBtn.addEventListener("click", () => onCreate());

  let contextMenu: HTMLDivElement | null = null;
  let contextSessionId: string | null = null;
  let contextSessionProfile: string | null = null;

  function hideContextMenu(): void {
    if (contextMenu) {
      contextMenu.remove();
      contextMenu = null;
    }
    contextSessionId = null;
    contextSessionProfile = null;
  }

  function showContextMenu(
    e: MouseEvent,
    sessionId: string,
    profile: string,
  ): void {
    hideContextMenu();
    contextSessionId = sessionId;
    contextSessionProfile = profile;

    const menu = document.createElement("div");
    menu.className = "context-menu";

    const renameItem = document.createElement("div");
    renameItem.className = "context-menu-item";
    renameItem.textContent = "Rename";
    renameItem.addEventListener("click", () => {
      if (!contextSessionId) return;
      const newName = prompt("Rename session:", contextSessionProfile || "");
      if (newName !== null && newName.trim() !== "") {
        onRename(contextSessionId, newName.trim());
      }
      hideContextMenu();
    });
    menu.appendChild(renameItem);

    const deleteItem = document.createElement("div");
    deleteItem.className = "context-menu-item context-menu-item-danger";
    deleteItem.textContent = "Delete";
    deleteItem.addEventListener("click", () => {
      if (!contextSessionId) return;
      if (confirm(`Delete session ${shortId(contextSessionId)}?`)) {
        onDelete(contextSessionId);
      }
      hideContextMenu();
    });
    menu.appendChild(deleteItem);

    document.body.appendChild(menu);
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    contextMenu = menu;

    // Deferred so the menu item click fires before the outside-click handler.
    requestAnimationFrame(() => {
      const closeHandler = (ev: MouseEvent) => {
        if (!menu.contains(ev.target as Node)) {
          hideContextMenu();
          document.removeEventListener("mousedown", closeHandler);
        }
      };
      document.addEventListener("mousedown", closeHandler);
    });
  }

  let contextLogId: string | null = null;

  function showLogContextMenu(e: MouseEvent, logId: string): void {
    hideContextMenu();
    contextLogId = logId;

    const menu = document.createElement("div");
    menu.className = "context-menu";

    const deleteItem = document.createElement("div");
    deleteItem.className = "context-menu-item context-menu-item-danger";
    deleteItem.textContent = "Delete";
    deleteItem.addEventListener("click", () => {
      if (!contextLogId || !onDeleteLog) return;
      if (confirm(`Delete log ${shortId(contextLogId)}?`)) {
        onDeleteLog(contextLogId);
      }
      hideContextMenu();
    });
    menu.appendChild(deleteItem);

    document.body.appendChild(menu);
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    contextMenu = menu;

    requestAnimationFrame(() => {
      const closeHandler = (ev: MouseEvent) => {
        if (!menu.contains(ev.target as Node)) {
          hideContextMenu();
          contextLogId = null;
          document.removeEventListener("mousedown", closeHandler);
        }
      };
      document.addEventListener("mousedown", closeHandler);
    });
  }

  function getProfileDisplay(profile: string | undefined): string {
    if (!profile) return "default";
    return sanitize(profile);
  }

  function updateSessions(
    sessions: SessionInfo[],
    activeSessionId: string | null,
    workingMap?: Map<string, boolean>,
    activeLogId?: string | null,
  ): void {
    listEl.innerHTML = "";

    for (const s of sessions) {
      const item = document.createElement("div");
      item.className = "session-item";
      if (s.id === activeSessionId) {
        item.classList.add("active");
      }

      const profileDisplay = getProfileDisplay(s.profile);
      const modelDisplay = s.model ? sanitize(s.model) : "?";
      const timeDisplay = formatTime(s.createdAt);
      const clientInfo =
        s.connectedClients > 0
          ? ` · ${s.connectedClients} client${s.connectedClients > 1 ? "s" : ""}`
          : "";

      const isWorking = workingMap?.get(s.id) ?? false;

      let workingHtml = "";
      if (isWorking) {
        workingHtml = `
          <span class="session-working-indicator">
            <span class="session-spinner"></span>
            ${onCancel ? `<button class="session-cancel-btn" data-session-id="${s.id}" title="Cancel">Cancel</button>` : ""}
          </span>`;
      }

      item.innerHTML = `
        <div class="session-name">
          <span class="session-profile-badge">${profileDisplay}</span>
          ${modelDisplay}
        </div>
        <div class="session-meta">
          ${timeDisplay}${clientInfo}
        </div>
        ${workingHtml}
      `;

      item.addEventListener("click", () => {
        // Clicking the active session only matters in log view mode (switches back).
        if (s.id === activeSessionId && !activeLogId) return;
        onSwitch(s.id);
      });

      item.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        showContextMenu(e, s.id, s.profile || "default");
      });

      listEl.appendChild(item);
    }

    if (onCancel) {
      listEl
        .querySelectorAll<HTMLButtonElement>(".session-cancel-btn")
        .forEach((btn) => {
          btn.addEventListener("click", (e: Event) => {
            e.stopPropagation();
            const sid = (e.target as HTMLButtonElement).dataset.sessionId;
            if (sid) onCancel(sid);
          });
        });
    }
  }

  function updateLogs(logs: LogInfo[], activeLogId: string | null): void {
    logListEl.innerHTML = "";

    if (logs.length === 0) {
      const emptyEl = document.createElement("div");
      emptyEl.className = "log-empty";
      emptyEl.textContent = "No recent logs";
      emptyEl.style.cssText =
        "padding: 10px; font-size: 0.75rem; color: var(--text-muted); text-align: center;";
      logListEl.appendChild(emptyEl);
      return;
    }

    for (const log of logs) {
      const item = document.createElement("div");
      item.className = "log-item";
      if (log.id === activeLogId) {
        item.classList.add("active");
      }

      const idDisplay = shortId(log.id);
      const timeDisplay = formatTime(log.lastActivityAt);
      const msgCount =
        log.messageCount > 0
          ? `${log.messageCount} msg${log.messageCount > 1 ? "s" : ""}`
          : "empty";

      item.innerHTML = `
        <div class="log-name">${idDisplay}</div>
        <div class="log-meta">
          <span>${timeDisplay} · ${msgCount}</span>
          ${onContinueLog ? `<div class="log-actions"><button class="log-continue-btn" data-log-id="${log.id}" title="Continue in new session">Continue</button></div>` : ""}
        </div>
      `;

      item.addEventListener("click", (e: Event) => {
        if ((e.target as HTMLElement).closest(".log-continue-btn")) return;
        if (onViewLog) {
          onViewLog(log.id);
        }
      });

      if (onDeleteLog) {
        item.addEventListener("contextmenu", (e: MouseEvent) => {
          e.preventDefault();
          showLogContextMenu(e, log.id);
        });
      }

      if (onContinueLog) {
        const continueBtn =
          item.querySelector<HTMLButtonElement>(".log-continue-btn");
        if (continueBtn) {
          continueBtn.addEventListener("click", (e: Event) => {
            e.stopPropagation();
            const lid = (e.target as HTMLButtonElement).dataset.logId;
            if (lid) onContinueLog(lid);
          });
        }
      }

      logListEl.appendChild(item);
    }
  }

  return { updateSessions, updateLogs };
}
