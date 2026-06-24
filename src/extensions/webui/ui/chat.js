// Chat view component — WS client, message routing, input handling.
// Connects to the WebSocket server and routes messages to the message list.

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
  let currentSessionId = null;
  let messageList = null;
  let reconnectTimer = null;
  let authFailed = false;

  /** Update connection status indicator. */
  function setConnected(connected) {
    const el = document.getElementById("connection-status");
    el.className = connected ? "status-connected" : "status-disconnected";
    el.textContent = connected ? "Connected" : "Disconnected";
    onConnectionChange?.(connected);
  }

  /** Show/hide the "Model is working..." spinner indicator. */
  function setWorking(working) {
    const el = document.getElementById("working-indicator");
    if (!el) return;
    el.classList.toggle("hidden", !working);
  }

  // ── WS Message Routing ───────────────────────────────────────────────────

  function handleServerMessage(data) {
    // ── Session management messages — handled even before messageList is ready ──
    switch (data.type) {
      case "sessionCreated":
        currentSessionId = data.sessionId;
        document.getElementById("current-session-id").textContent =
          data.sessionId.slice(0, 8);
        onSessionCreated?.({ sessionId: data.sessionId });
        return; // messageList will be created by onSessionCreated → setSession
      case "sessionDeleted":
        if (data.sessionId === currentSessionId) {
          if (messageList) messageList.clear();
          currentSessionId = null;
          document.getElementById("current-session-id").textContent = "";
        }
        return;
      case "sessions":
        onSessionsUpdate?.(data.sessions, currentSessionId);
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

    // Hide working indicator when any response event arrives
    switch (data.type) {
      case "userMessage":
        messageList.handleUserMessage(data);
        break;
      case "assistantMessage":
        setWorking(false);
        messageList.handleAssistantMessage(data);
        break;
      case "thinking":
        setWorking(false);
        messageList.handleThinking(data);
        break;
      case "toolCall":
        setWorking(false);
        messageList.handleToolCall(data);
        break;
      case "toolResult":
        messageList.handleToolResult(data);
        break;
      case "compacting":
        setWorking(false);
        messageList.handleCompacting(data);
        break;
      case "commandResult":
        setWorking(false);
        messageList.handleCommandResult(data);
        break;
      case "question":
        setWorking(false);
        messageList.handleQuestion(data);
        break;
      case "streamingChunk":
        setWorking(false);
        messageList.handleStreamingChunk(data);
        break;
      case "streamingReasoningChunk":
        setWorking(false);
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
        messageList.handleSessionState(data);
        break;
      case "error":
        setWorking(false);
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
      setConnected(false);
      verifyTokenAndReconnect();
      return;
    }

    ws.onopen = () => {
      setConnected(true);
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
      setConnected(false);
      setWorking(false);
      ws = null;
      verifyTokenAndReconnect();
    };

    ws.onerror = () => {
      setConnected(false);
      setWorking(false);
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
    setConnected(false);
    setWorking(false);
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
    if (!currentSessionId) {
      console.warn("[chat] No active session");
      return;
    }
    // Optimistically render the user's message immediately
    if (messageList) {
      messageList.handleUserMessage({ content });
    }
    // Show working indicator while waiting for a response
    setWorking(true);
    send({ type: "send", sessionId: currentSessionId, content });
  }

  /** Cancel the current run. */
  function cancel() {
    if (!currentSessionId) return;
    send({ type: "cancel", sessionId: currentSessionId });
  }

  /** Create a new session. */
  function createSession(opts = {}) {
    send({ type: "createSession", ...opts });
  }

  /** Switch to a different session. */
  function switchSession(sessionId) {
    send({ type: "switchSession", sessionId });
    currentSessionId = sessionId;
    document.getElementById("current-session-id").textContent = sessionId.slice(
      0,
      8,
    );
    messageList.clear();
    setWorking(false);
  }

  /** Delete a session. */
  function deleteSession(sessionId) {
    send({ type: "deleteSession", sessionId });
  }

  /** List sessions. */
  function listSessions() {
    send({ type: "listSessions" });
  }

  /** Send a command to the agent. */
  function sendCommand(command) {
    if (!currentSessionId) return;
    send({ type: "command", sessionId: currentSessionId, command });
  }

  /** Send a question answer. */
  function sendQuestionAnswer(answers) {
    if (!currentSessionId) return;
    send({ type: "questionAnswer", sessionId: currentSessionId, answers });
  }

  // ── Session management ────────────────────────────────────────────────────

  function setSession(sessionId) {
    messageList = createMessageList(sessionId, { hideThinking: false });
    currentSessionId = sessionId;
    document.getElementById("current-session-id").textContent = sessionId.slice(
      0,
      8,
    );
    messageList.clear();
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  // Wire up chat input form
  document.getElementById("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    sendMessage(text);
  });

  document.getElementById("cancel-btn").addEventListener("click", () => {
    cancel();
  });

  // Wire up session buttons
  document.getElementById("new-session-btn").addEventListener("click", () => {
    createSession({});
  });

  // Connect
  connect();

  return {
    connect,
    disconnect,
    sendMessage,
    cancel,
    createSession,
    switchSession,
    deleteSession,
    listSessions,
    sendCommand,
    sendQuestionAnswer,
    setSession,
    ws,
  };
}
