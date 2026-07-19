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

interface SessionsConfig {
  onCreate: () => void;
  onSwitch: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, newName: string) => void;
  /** Optional callback wired to the cancel button on working sessions */
  onCancel?: (sessionId: string) => void;
}

export type UpdateSessionsFn = (sessions: SessionInfo[], activeSessionId: string | null, workingMap?: Map<string, boolean>) => void;

/**
 * Initialize the session sidebar.
 * @param config - Configuration with create/switch/delete callbacks
 * @returns Function to update the session list display
 */
export function initSessions({ onCreate, onSwitch, onDelete, onRename, onCancel }: SessionsConfig): UpdateSessionsFn {
  const listEl = document.getElementById("session-list") as HTMLDivElement;
  const newBtn = document.getElementById("new-session-btn") as HTMLButtonElement;

  newBtn.addEventListener("click", () => onCreate());

  // ── Custom Context Menu ───────────────────────────────────────────────────

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

  function showContextMenu(e: MouseEvent, sessionId: string, profile: string): void {
    hideContextMenu();
    contextSessionId = sessionId;
    contextSessionProfile = profile;

    const menu = document.createElement("div");
    menu.className = "context-menu";

    // Rename item
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

    // Delete item
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

    // Position the menu at the cursor
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    contextMenu = menu;

    // Close on click outside
    const closeHandler = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        hideContextMenu();
        document.removeEventListener("mousedown", closeHandler);
      }
    };
    // Use a slight delay so the menu item click fires first
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", closeHandler);
    });
  }

  /**
   * Get a friendly profile name for display.
   */
  function getProfileDisplay(profile: string | undefined): string {
    if (!profile) return "default";
    return sanitize(profile);
  }

  /**
   * Update the session list display.
   * @param sessions - Array of session info objects
   * @param activeSessionId - Currently active session ID
   * @param workingMap - Optional per-session working state map
   */
  return function updateSessions(sessions: SessionInfo[], activeSessionId: string | null, workingMap?: Map<string, boolean>): void {
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
      const clientInfo = s.connectedClients > 0
        ? ` · ${s.connectedClients} client${s.connectedClients > 1 ? "s" : ""}`
        : "";

      // Check if this session's agent is currently working
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
        <div class="session-name">${profileDisplay}</div>
        <div class="session-meta">
          ${modelDisplay} · ${timeDisplay}${clientInfo}
        </div>
        ${workingHtml}
      `;

      item.addEventListener("click", () => {
        if (s.id === activeSessionId) return;
        onSwitch(s.id);
      });

      // Right-click to show context menu
      item.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        showContextMenu(e, s.id, s.profile || "default");
      });

      listEl.appendChild(item);
    }

    // Wire up cancel buttons for working sessions
    if (onCancel) {
      listEl.querySelectorAll<HTMLButtonElement>(".session-cancel-btn").forEach((btn) => {
        btn.addEventListener("click", (e: Event) => {
          e.stopPropagation();
          const sid = (e.target as HTMLButtonElement).dataset.sessionId;
          if (sid) onCancel(sid);
        });
      });
    }
  };
}
