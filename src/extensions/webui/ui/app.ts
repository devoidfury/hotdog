/// <reference lib="dom" />
// Wires login, chat, and sessions together; atoms coordinate the components.

import { initLogin } from "./login.ts";
import { createChat, ChatController } from "./chat.ts";
import { initSessions, UpdateSessionsFn, UpdateLogsFn } from "./sessions.ts";

let token: string | null = null;
let chat: ChatController | null = null;
let updateSessions: UpdateSessionsFn | null = null;
let updateLogs: UpdateLogsFn | null = null;
let activeLogId: string | null = null;

function showLogin(): void {
  document.getElementById("login-screen")!.classList.remove("hidden");
  document.getElementById("main-ui")!.classList.add("hidden");
}

function showMain(): void {
  document.getElementById("login-screen")!.classList.add("hidden");
  document.getElementById("main-ui")!.classList.remove("hidden");
}

/** Token invalid/expired: clear storage, drop the chat, show login. */
function handleAuthFailure(): void {
  localStorage.removeItem("hotdog-webui-token");
  token = null;
  if (chat) {
    chat.disconnect();
    chat = null;
  }
  showLogin();
}

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

function clearLogView(): void {
  activeLogId = null;
  const logViewLabel = document.getElementById("log-view-label");
  const sessionLabel = document.getElementById("session-label");
  const inputArea = document.getElementById("input-area");
  const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement | null;
  if (logViewLabel) logViewLabel.classList.add("hidden");
  if (sessionLabel) sessionLabel.style.opacity = "";
  if (inputArea) inputArea.classList.remove("read-only");
  if (chatInput) chatInput.disabled = false;
  // Remove the active-log highlight.
  chat?.listLogs();
}

async function init(): Promise<void> {
  const savedToken = localStorage.getItem("hotdog-webui-token");
  if (savedToken) {
    token = savedToken;
    const valid = await verifyToken(token);
    if (valid) {
      startChat();
      showMain();
    }
  } else {
    showLogin();
  }

  initLogin({
    onLogin: (newToken: string) => {
      token = newToken;
      localStorage.setItem("hotdog-webui-token", token);
      startChat();
      showMain();
    },
  });

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
      chat!.send({ type: "cancel", sessionId });
      chat!.sessionWorkingMap.set(sessionId, false);
      if (chat!.sessionIdAtom() === sessionId) {
        chat!.workingAtom(false);
      }
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

  const closeLogViewBtn = document.getElementById("close-log-view-btn") as HTMLButtonElement | null;
  if (closeLogViewBtn) {
    closeLogViewBtn.addEventListener("click", () => {
      clearLogView();
      // Re-switching to the same session makes the server replay history.
      const currentSessionId = chat?.sessionIdAtom();
      if (currentSessionId && chat) {
        chat.switchSession(currentSessionId);
      }
    });
  }

  document.addEventListener("keydown", (e: KeyboardEvent) => {
    // Ctrl+Shift+L logs out.
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
      chat!.listSessions();
      chat!.listProfiles();
      clearLogView();
    },
    onSessionsUpdate: (sessions, activeSessionId) => {
      if (updateSessions) {
        updateSessions(sessions, activeSessionId, chat!.sessionWorkingMap, activeLogId);
      }
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
      // Re-render both lists so the active log is highlighted and click
      // handlers capture the new activeLogId.
      chat?.listLogs();
      chat?.listSessions();
      const logViewLabel = document.getElementById("log-view-label");
      const currentLogId = document.getElementById("current-log-id");
      const sessionLabel = document.getElementById("session-label");
      const inputArea = document.getElementById("input-area");
      const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement | null;
      if (logViewLabel && currentLogId) {
        logViewLabel.classList.remove("hidden");
        currentLogId.textContent = logId.slice(0, 8);
      }
      if (sessionLabel) sessionLabel.style.opacity = "0.5";
      if (inputArea) inputArea.classList.add("read-only");
      if (chatInput) chatInput.disabled = true;
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
      chat?.listLogs();
    },
    onConnectionChange: (connected) => {
      if (connected) {
        chat?.listProfiles();
      }
    },
    onAuthFailure: handleAuthFailure,
    onWorkingMapChange: () => {
      // Re-render the sidebar's per-session working indicators.
      if (updateSessions && chat) {
        chat.listSessions();
      }
    },
  });

  // The sidebar shows per-session model info; refresh it when the model changes.
  chat.currentModelAtom.effect(() => {
    chat!.listSessions();
  });
}

init();
