// Session list/management sidebar component.

import { sanitize, formatTime, shortId } from "./utils.ts";

// ── Types ───────────────────────────────────────────────────────────────────

interface SessionInfo {
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
}

export type UpdateSessionsFn = (sessions: SessionInfo[], activeSessionId: string | null) => void;

/**
 * Initialize the session sidebar.
 * @param config - Configuration with create/switch/delete callbacks
 * @returns Function to update the session list display
 */
export function initSessions({ onCreate, onSwitch, onDelete }: SessionsConfig): UpdateSessionsFn {
  const listEl = document.getElementById("session-list") as HTMLDivElement;
  const newBtn = document.getElementById("new-session-btn") as HTMLButtonElement;

  newBtn.addEventListener("click", () => onCreate());

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
   */
  return function updateSessions(sessions: SessionInfo[], activeSessionId: string | null): void {
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

      item.innerHTML = `
        <div class="session-name">${profileDisplay}</div>
        <div class="session-meta">
          ${modelDisplay} · ${timeDisplay}${clientInfo}
        </div>
      `;

      item.addEventListener("click", () => {
        if (s.id === activeSessionId) return;
        onSwitch(s.id);
      });

      // Right-click to delete (simple UX)
      item.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        if (confirm(`Delete session ${shortId(s.id)}?`)) {
          onDelete(s.id);
        }
      });

      listEl.appendChild(item);
    }
  };
}
