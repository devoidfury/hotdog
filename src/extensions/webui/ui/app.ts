/// <reference lib="dom" />
// Main application — wires login, chat, and session management together.
// Uses reactiveState atoms for cross-component coordination.

import { initLogin } from "./login.ts";
import { createChat, ChatController } from "./chat.ts";
import { initSessions, UpdateSessionsFn, UpdateLogsFn } from "./sessions.ts";

// ── State ───────────────────────────────────────────────────────────────────

let token: string | null = null;
let chat: ChatController | null = null;
let updateSessions: UpdateSessionsFn | null = null;
let updateLogs: UpdateLogsFn | null = null;
let activeLogId: string | null = null;

// ── Screen Navigation ───────────────────────────────────────────────────────

function showLogin(): void {
  document.getElementById("login-screen")!.classList.remove("hidden");
  document.getElementById("main-ui")!.classList.add("hidden");
}

function showMain(): void {
  document.getElementById("login-screen")!.classList.add("hidden");
  document.getElementById("main-ui")!.classList.remove("hidden");
}

// ── Auth Failure Handler ────────────────────────────────────────────────────

/**
 * Called when the session token is invalid or expired.
 * Clears localStorage and shows the login screen so the user can re-authenticate.
 */
function handleAuthFailure(): void {
  localStorage.removeItem("hotdog-webui-token");
  token = null;
  if (chat) {
    chat.disconnect();
    chat = null;
  }
  showLogin();
}

// ── Token Verification (startup) ────────────────────────────────────────────

/**
 * Verify the saved token before starting the chat connection.
 * If the token is invalid, clear it and show login immediately.
 */
async function verifyToken(tokenToCheck: string): Promise<boolean> {
  try {
    const res = await fetch(
      `/verify?token=${encodeURIComponent(tokenToCheck)}`,
    );
    if (res.status === 401) {
      handleAuthFailure();
      return false;
    }
    return true;
  } catch {
    // Network error — server might be down; proceed and let chat.js retry
    return true;
  }
}

// ── Log View Helpers ─────────────────────────────────────────────────────────

/**
 * Clear the log view UI state and restore normal session view.
 */
function clearLogView(): void {
  const previousLogId = activeLogId;
  activeLogId = null;
  const logViewLabel = document.getElementById("log-view-label");
  const sessionLabel = document.getElementById("session-label");
  const modelSelector = document.getElementById("model-selector");
  const inputArea = document.getElementById("input-area");
  const chatInput = document.getElementById("chat-input") as HTMLInputElement | null;
  // Hide log view indicator
  if (logViewLabel) logViewLabel.classList.add("hidden");
  // Restore session label and model selector
  if (sessionLabel) sessionLabel.style.opacity = "";
  if (modelSelector) modelSelector.style.opacity = "";
  // Re-enable input area
  if (inputArea) inputArea.classList.remove("read-only");
  if (chatInput) chatInput.disabled = false;
  // Refresh logs list to remove highlight
  chat?.listLogs();
}

// ── Initialization ───────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Check for existing token in localStorage
  const savedToken = localStorage.getItem("hotdog-webui-token");
  if (savedToken) {
    token = savedToken;
    // Verify the token before starting the chat connection
    const valid = await verifyToken(token);
    if (valid) {
      startChat();
      showMain();
    }
    // If invalid, verifyToken calls handleAuthFailure() which shows login
  } else {
    showLogin();
  }

  // Login screen
  initLogin({
    onLogin: (newToken: string) => {
      token = newToken;
      localStorage.setItem("hotdog-webui-token", token);
      startChat();
      showMain();
    },
  });

  // Session sidebar — initSessions returns both update functions
  const sessionInit = initSessions({
    onCreate: () => {
      chat!.createSession({});
    },
    onSwitch: (sessionId: string) => {
      chat!.switchSession(sessionId);
    },
    onDelete: (sessionId: string) => {
      chat!.deleteSession(sessionId);
    },
    onRename: (sessionId: string, newName: string) => {
      chat!.renameSession(sessionId, newName);
    },
    onCancel: (sessionId: string) => {
      // Cancel a session by ID — even if it's not the active one
      chat!.send({ type: "cancel", sessionId });
      chat!.sessionWorkingMap.set(sessionId, false);
      // If the cancelled session is the active one, update workingAtom too
      if (chat!.sessionIdAtom() === sessionId) {
        chat!.workingAtom(false);
      }
    },
    onListLogs: () => {
      chat?.listLogs();
    },
    onContinueLog: (logId: string) => {
      chat!.loadLog(logId);
    },
    onViewLog: (logId: string) => {
      chat!.viewLog(logId);
    },
    onDeleteLog: (logId: string) => {
      chat!.deleteLog(logId);
    },
  });
  updateSessions = sessionInit.updateSessions;
  updateLogs = sessionInit.updateLogs;

  // Close log view button — exit log view and reload current session's messages
  const closeLogViewBtn = document.getElementById("close-log-view-btn") as HTMLButtonElement | null;
  if (closeLogViewBtn) {
    closeLogViewBtn.addEventListener("click", () => {
      clearLogView();
      // Reload current session's messages by switching to it (server replays history)
      const currentSessionId = chat?.sessionIdAtom();
      if (currentSessionId && chat) {
        chat.switchSession(currentSessionId);
      }
    });
  }

  // Logout button (via keyboard shortcut)
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    // Ctrl+Shift+L → logout
    if (e.ctrlKey && e.shiftKey && (e.key === "L" || e.key === "l")) {
      handleAuthFailure();
    }
  });
}

function startChat(): void {
  chat = createChat({
    token,
    host: window.location.host,
    onSessionCreated: ({ sessionId }) => {
      chat!.setSession(sessionId);
      chat!.listSessions(); // Refresh sidebar
      // Clear any active log view when switching to a new session
      clearLogView();
    },
    onSessionsUpdate: (sessions, activeSessionId) => {
      if (updateSessions) {
        updateSessions(sessions, activeSessionId, chat!.sessionWorkingMap, activeLogId);
      }
      // Clear active log view when switching sessions
      if (activeSessionId && activeLogId) {
        clearLogView();
      }
    },
    onLogsUpdate: (logs) => {
      if (updateLogs) {
        updateLogs(logs, activeLogId);
      }
    },
    onLogViewed: (logId, entries) => {
      activeLogId = logId;
      // Refresh logs list to highlight the active log
      chat?.listLogs();
      // Refresh session list so click handlers capture the current activeLogId
      chat?.listSessions();
      // Show log view indicator
      const logViewLabel = document.getElementById("log-view-label");
      const currentLogId = document.getElementById("current-log-id");
      const sessionLabel = document.getElementById("session-label");
      const modelSelector = document.getElementById("model-selector");
      const inputArea = document.getElementById("input-area");
      const chatInput = document.getElementById("chat-input") as HTMLInputElement | null;
      if (logViewLabel && currentLogId) {
        logViewLabel.classList.remove("hidden");
        currentLogId.textContent = logId.slice(0, 8);
      }
      // Dim session label and model selector
      if (sessionLabel) sessionLabel.style.opacity = "0.5";
      if (modelSelector) modelSelector.style.opacity = "0.5";
      // Disable input area
      if (inputArea) inputArea.classList.add("read-only");
      if (chatInput) chatInput.disabled = true;
      // Render entries in the message area
      const messageList = chat?.messageListAtom();
      if (messageList) {
        messageList.clear();
        messageList.renderLogEntries(entries);
      }
    },
    onLogDeleted: (logId) => {
      if (activeLogId === logId) {
        clearLogView();
      }
      // Refresh the logs list
      chat?.listLogs();
    },
    onConnectionChange: (_connected) => {
      // Connection recovery is handled by chat.js internally
    },
    onAuthFailure: handleAuthFailure,
    onWorkingMapChange: () => {
      // Refresh sidebar to show/hide per-session working indicators
      if (updateSessions && chat) {
        chat.listSessions();
      }
    },
  });

  // After chat is created, wire up reactive model changes to the sidebar.
  // The sidebar displays per-session model info; when the current model
  // changes (e.g. via /model command), refresh the session list so the
  // sidebar shows the updated model.
  chat.currentModelAtom.effect(() => {
    chat!.listSessions();
  });
}

// ── Start ───────────────────────────────────────────────────────────────────

init();
