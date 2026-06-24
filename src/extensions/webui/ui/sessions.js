// Session list/management sidebar component.

import { sanitize, formatTime, shortId } from "./utils.js";

/**
 * Initialize the session sidebar.
 * @param {Object} config
 * @param {Function} config.onCreate - Called to create a new session
 * @param {Function} config.onSwitch - Called with sessionId to switch to
 * @param {Function} config.onDelete - Called with sessionId to delete
 */
export function initSessions({ onCreate, onSwitch, onDelete }) {
  const listEl = document.getElementById("session-list");
  const newBtn = document.getElementById("new-session-btn");

  newBtn.addEventListener("click", () => onCreate());

  /**
   * Update the session list display.
   * @param {Array<{id: string, profile: string, model: string, createdAt: number, lastActivityAt: number, connectedClients: number}>} sessions
   * @param {string|null} activeSessionId
   */
  return function updateSessions(sessions, activeSessionId) {
    listEl.innerHTML = "";

    for (const s of sessions) {
      const item = document.createElement("div");
      item.className = "session-item";
      if (s.id === activeSessionId) {
        item.classList.add("active");
      }

      item.innerHTML = `
        <div class="session-name">${sanitize(s.profile || "default")}</div>
        <div class="session-meta">
          ${sanitize(s.model || "?")} · ${formatTime(s.createdAt)}
          ${s.connectedClients > 0 ? ` · ${s.connectedClients} client(s)` : ""}
        </div>
      `;

      item.addEventListener("click", () => {
        if (s.id === activeSessionId) return;
        onSwitch(s.id);
      });

      // Right-click / long-press to delete (simple UX)
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (confirm(`Delete session ${shortId(s.id)}?`)) {
          onDelete(s.id);
        }
      });

      listEl.appendChild(item);
    }
  };
}
