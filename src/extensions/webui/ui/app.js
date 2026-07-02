// Main application — wires login, chat, and session management together.
// Uses reactiveState atoms for cross-component coordination.

import { initLogin } from "./login.js";
import { createChat } from "./chat.js";
import { initSessions } from "./sessions.js";

// ── State ───────────────────────────────────────────────────────────────────

let token = null;
let chat = null;
let updateSessions = null;

// ── Screen Navigation ───────────────────────────────────────────────────────

function showLogin() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("main-ui").classList.add("hidden");
}

function showMain() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("main-ui").classList.remove("hidden");
}

// ── Auth Failure Handler ────────────────────────────────────────────────────

/**
 * Called when the session token is invalid or expired.
 * Clears localStorage and shows the login screen so the user can re-authenticate.
 */
function handleAuthFailure() {
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
async function verifyToken(tokenToCheck) {
  try {
    const res = await fetch(
      `/verify?token=${encodeURIComponent(tokenToCheck)}`,
    );
    if (res.status === 401) {
      handleAuthFailure();
      return false;
    }
    return true;
  } catch (e) {
    // Network error — server might be down; proceed and let chat.js retry
    return true;
  }
}

// ── Initialization ───────────────────────────────────────────────────────────

async function init() {
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
    onLogin: (newToken) => {
      token = newToken;
      localStorage.setItem("hotdog-webui-token", token);
      startChat();
      showMain();
    },
  });

  // Session sidebar — initSessions returns the update function
  updateSessions = initSessions({
    onCreate: () => {
      chat.createSession({});
    },
    onSwitch: (sessionId) => {
      chat.switchSession(sessionId);
    },
    onDelete: (sessionId) => {
      chat.deleteSession(sessionId);
    },
  });

  // Logout button (via keyboard shortcut)
  document.addEventListener("keydown", (e) => {
    // Ctrl+Shift+L → logout
    if (e.ctrlKey && e.shiftKey && (e.key === "L" || e.key === "l")) {
      handleAuthFailure();
    }
  });
}

function startChat() {
  chat = createChat({
    token,
    host: window.location.host,
    onSessionCreated: ({ sessionId }) => {
      chat.setSession(sessionId);
      chat.listSessions(); // Refresh sidebar
    },
    onSessionsUpdate: (sessions, activeSessionId) => {
      if (updateSessions) {
        updateSessions(sessions, activeSessionId);
      }
    },
    onConnectionChange: (connected) => {
      // Connection recovery is handled by chat.js internally
    },
    onAuthFailure: handleAuthFailure,
  });

  // After chat is created, wire up reactive model changes to the sidebar.
  // The sidebar displays per-session model info; when the current model
  // changes (e.g. via /model command), refresh the session list so the
  // sidebar shows the updated model.
  chat.currentModelAtom.effect(() => {
    chat.listSessions();
  });
}

// ── Start ───────────────────────────────────────────────────────────────────

init();
