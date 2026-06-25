// Chat view component — WS client, message routing, input handling.
// Connects to the WebSocket server and routes messages to the message list.
// Uses reactiveState atoms so DOM updates happen automatically via effects.

import { reativeState, effect } from "./utils.js";
import { createMessageList } from "./message-list.js";

/**
 * Create a chat controller for a WebSocket connection.
 *
 * @param {Object} config
 * @param {string} config.token - Auth token
 * @param {string} config.host - Server host (default: window.location.host)
 * @param {Function} config.onSessionCreated - Called with { sessionId }
 * @param {Function} config.onSessionsUpdate - Called with sessions array
 * @param {Function} config.onConnectionChange - Called with connected status
 * @param {Function} config.onAuthFailure - Called when token is invalid/expired
 * @returns {Object} Chat controller
 */
export function createChat({
  token,
  host = window.location.host,
  onSessionCreated,
  onSessionsUpdate,
  onConnectionChange,
  onAuthFailure,
}) {
  const wsUrl = `ws://${host}/ws?token=${token}`;
  let ws = null;
  let messageList = null;
  let reconnectTimer = null;
  let authFailed = false;

  // ── Reactive state atoms ───────────────────────────────────────────────────
  // Every UI element that needs to update when data changes is driven by one
  // of these atoms.  Effects (registered below) handle the actual DOM writes.

  const sessionIdAtom = reativeState(null);
  const currentModelAtom = reativeState("");
  const modelsAtom = reativeState([]);
  const connectedAtom = reativeState(false);
  const workingAtom = reativeState(false);

  // ── Effects — auto-wire DOM to atoms ─────────────────────────────────────

  // Model dropdown: rebuild whenever the list of available models *or* the
  // currently selected model changes.
  effect(() => {
    const select = document.getElementById("model-select");
    if (!select) return;
    const models = modelsAtom();
    const current = currentModelAtom();
    select.innerHTML = "";
    for (const name of models) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === current) opt.selected = true;
      select.appendChild(opt);
    }
  }, [modelsAtom, currentModelAtom]);

  // Connection-status badge.
  effect(() => {
    const el = document.getElementById("connection-status");
    if (!el) return;
    const connected = connectedAtom();
    el.className = connected ? "status-connected" : "status-disconnected";
    el.textContent = connected ? "Connected" : "Disconnected";
    onConnectionChange?.(connected);
  }, [connectedAtom]);

  // Working indicator (spinner + cancel button).  Cancel button is now
  // inside the indicator, so hiding the indicator hides it automatically.
  effect(() => {
    const el = document.getElementById("working-indicator");
    if (!el) return;
    const working = workingAtom();
    el.classList.toggle("hidden", !working);
  }, [workingAtom]);

  // Session-id label in the info bar.
  effect(() => {
    const el = document.getElementById("current-session-id");
    if (!el) return;
    const sid = sessionIdAtom();
    el.textContent = sid ? sid.slice(0, 8) : "";
  }, [sessionIdAtom]);

  // ── WS Message Routing ───────────────────────────────────────────────────

  function handleServerMessage(data) {
    // ── Session management messages — handled even before messageList is ready ──
    switch (data.type) {
      case "sessionCreated":
        sessionIdAtom(data.sessionId);
        currentModelAtom(data.currentModel || "");
        if (data.models && data.models.length > 0) {
          modelsAtom(data.models);
        }
        onSessionCreated?.({ sessionId: data.sessionId });
        return;
      case "sessionDeleted":
        if (data.sessionId === sessionIdAtom()) {
          if (messageList) messageList.clear();
          sessionIdAtom(null);
          currentModelAtom("");
        }
        return;
      case "sessions":
        onSessionsUpdate?.(data.sessions, sessionIdAtom());
        return;
      case "authRequired":
        console.warn("[chat] Auth required but not provided");
        return;
      case "authError":
        console.error("[chat] Auth error:", data.message);
        return;
    }

    // ── OUTPUT_EVENT mappings — require messageList ──
    if (!messageList) return;

    switch (data.type) {
      case "userMessage":
        messageList.handleUserMessage(data);
        break;
      case "assistantMessage":
        messageList.handleAssistantMessage(data);
        break;
      case "thinking":
        messageList.handleThinking(data);
        break;
      case "toolCall":
        messageList.handleToolCall(data);
        break;
      case "toolResult":
        messageList.handleToolResult(data);
        break;
      case "compacting":
        messageList.handleCompacting(data);
        break;
      case "commandResult":
        messageList.handleCommandResult(data);
        break;
      case "question":
        messageList.handleQuestion(data);
        break;
      case "streamingChunk":
        messageList.handleStreamingChunk(data);
        break;
      case "streamingReasoningChunk":
        messageList.handleStreamingReasoningChunk(data);
        break;
      case "taskProgress":
        messageList.handleTaskProgress(data);
        break;
      case "tokenUsage":
        messageList.handleTokenUsage(data);
        break;
      case "compactionResult":
        messageList.handleCompactionResult(data);
        break;
      case "sessionState":
        // Handle working state signals from the server
        if (data.key === "working") {
          workingAtom(data.value);
        }
        // Handle model changes (e.g. after /model command or session switch)
        if (data.key === "model") {
          currentModelAtom(data.value);
        }
        if (data.key === "models") {
          modelsAtom(data.value);
        }
        messageList.handleSessionState(data);
        break;
      case "error":
        workingAtom(false);
        messageList.handleError(data);
        break;

      default:
        console.warn("[chat] Unknown message type:", data.type);
    }
  }

  // ── WS Connection ─────────────────────────────────────────────────────────

  function connect() {
    if (ws) {
      ws.close();
      ws = null;
    }
    authFailed = false;

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error("[chat] WS connection failed:", e);
      connectedAtom(false);
      verifyTokenAndReconnect();
      return;
    }

    ws.onopen = () => {
      connectedAtom(true);
    };

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        console.warn("[chat] Invalid JSON received");
        return;
      }
      handleServerMessage(data);
    };

    ws.onclose = () => {
      connectedAtom(false);
      workingAtom(false);
      ws = null;
      verifyTokenAndReconnect();
    };

    ws.onerror = () => {
      connectedAtom(false);
      workingAtom(false);
    };
  }

  /**
   * Check token validity via HTTP GET /verify.
   * If the token is invalid, call onAuthFailure and stop reconnecting.
   * If the token is valid (or the server is unreachable), schedule a reconnect.
   */
  function verifyTokenAndReconnect() {
    // Auth already failed — don't attempt to reconnect
    if (authFailed) return;

    if (!token) {
      authFailed = true;
      onAuthFailure?.();
      return;
    }

    fetch(`/verify?token=${encodeURIComponent(token)}`)
      .then((res) => {
        if (res.status === 401) {
          authFailed = true;
          onAuthFailure?.();
        } else {
          // Token is valid — schedule a reconnect
          scheduleReconnect();
        }
      })
      .catch(() => {
        // Network error — server might be down, retry later
        scheduleReconnect();
      });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 3000);
  }

  function disconnect() {
    authFailed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    connectedAtom(false);
    workingAtom(false);
  }

  // ── Send helpers ──────────────────────────────────────────────────────────

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    } else {
      console.warn("[chat] WS not connected");
    }
  }

  /** Send user message to the current session. */
  function sendMessage(content) {
    if (!sessionIdAtom()) {
      console.warn("[chat] No active session");
      return;
    }
    // Optimistically render the user's message immediately
    if (messageList) {
      // messageList.ShandleUserMessage({ content });
    }
    // Show working indicator while waiting for a response
    workingAtom(true);
    send({ type: "send", sessionId: sessionIdAtom(), content });
  }

  /** Send a slash command to the agent. */
  function sendSlashCommand(command) {
    if (!sessionIdAtom()) return;
    send({ type: "command", sessionId: sessionIdAtom(), command });
  }

  /** Cancel the current run. */
  function cancel() {
    if (!sessionIdAtom()) return;
    send({ type: "cancel", sessionId: sessionIdAtom() });
  }

  /** Create a new session. */
  function createSession(opts = {}) {
    send({ type: "createSession", ...opts });
  }

  /** Switch to a different session. */
  function switchSession(sessionId) {
    send({ type: "switchSession", sessionId });
    sessionIdAtom(sessionId);
    messageList.clear();
    workingAtom(false);
    listSessions(); // Refresh sidebar so the active session is highlighted correctly
  }

  /** Delete a session. */
  function deleteSession(sessionId) {
    send({ type: "deleteSession", sessionId });
    listSessions(); // Refresh sidebar so the deleted session is removed
  }

  /** List sessions. */
  function listSessions() {
    send({ type: "listSessions" });
  }

  /** Send a command to the agent. */
  function sendCommand(command) {
    if (!sessionIdAtom()) return;
    send({ type: "command", sessionId: sessionIdAtom(), command });
  }

  /** Send a question answer. */
  function sendQuestionAnswer(answers) {
    if (!sessionIdAtom()) return;
    send({ type: "questionAnswer", sessionId: sessionIdAtom(), answers });
  }

  // ── Session management ────────────────────────────────────────────────────

  function setSession(sessionId) {
    messageList = createMessageList(sessionId, { hideThinking: false });
    sessionIdAtom(sessionId);
    messageList.clear();
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  // Wire up chat input form — detect slash commands and route accordingly
  document.getElementById("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";

    if (text.startsWith("/")) {
      // Slash command — send as command, not user message
      sendSlashCommand(text);
    } else {
      sendMessage(text);
    }
  });

  document.getElementById("cancel-btn").addEventListener("click", () => {
    cancel();
  });

  // Wire up session buttons
  document.getElementById("new-session-btn").addEventListener("click", () => {
    createSession({});
  });

  // Model dropdown change — send /model command to switch
  document.getElementById("model-select").addEventListener("change", (e) => {
    const modelName = e.target.value;
    if (!modelName || !sessionIdAtom()) return;
    sendSlashCommand(`/model ${modelName}`);
  });

  // Connect
  connect();

  return {
    connect,
    disconnect,
    sendMessage,
    sendSlashCommand,
    cancel,
    createSession,
    switchSession,
    deleteSession,
    listSessions,
    sendCommand,
    sendQuestionAnswer,
    setSession,
    ws,
    // Expose atoms for external reactive coordination
    sessionIdAtom,
    currentModelAtom,
    modelsAtom,
    connectedAtom,
    workingAtom,
  };
}
