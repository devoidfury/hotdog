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
   * Get a friendly profile name for display.
   */
  function getProfileDisplay(profile) {
    if (!profile) return "default";
    return sanitize(profile);
  }

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
