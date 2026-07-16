/// <reference lib="dom" />
// Chat view component — WS client, message routing, input handling.
// Connects to the WebSocket server and routes messages to the message list.
// Uses reactiveState atoms so DOM updates happen automatically via effects.

import { reactiveState, effect, Atom } from "./utils.ts";
import { createMessageList, MessageListManager } from "./message-list.ts";
import type { SessionInfo } from "./sessions.ts";

// Browser-compatible logger — avoids importing Node.js logger which uses
// process.env and process.stdout that don't exist in browser environments.
const logger = {
  error: (msg: string, data?: unknown) => {
    console.error("[chat]", msg, data || "");
  },
  warn: (msg: string, data?: unknown) => {
    console.warn("[chat]", msg, data || "");
  },
};

// ── Server message types ────────────────────────────────────────────────────

interface SessionCreatedMessage {
  type: "sessionCreated";
  sessionId: string;
  currentModel?: string;
  models?: string[];
}

interface SessionDeletedMessage {
  type: "sessionDeleted";
  sessionId: string;
}

interface SessionsMessage {
  type: "sessions";
  sessions: unknown[];
}

interface AuthRequiredMessage {
  type: "authRequired";
}

interface AuthErrorMessage {
  type: "authError";
  message: string;
}

interface UserMessage {
  type: "userMessage";
  content: string;
}

interface AssistantMessage {
  type: "assistantMessage";
  content: string;
}

interface ThinkingMessage {
  type: "thinking";
  content: string;
}

interface ToolCallMessage {
  type: "toolCall";
  name: string;
  args: string;
}

interface ToolResultMessage {
  type: "toolResult";
  name: string;
  output?: string;
  error?: string;
}

interface CompactingMessage {
  type: "compacting";
  message: string;
}

interface CommandResultMessage {
  type: "commandResult";
  content: string;
}

interface QuestionMessage {
  type: "question";
  questions: { message?: string; prompt?: string; options?: string[] }[];
}

interface StreamingChunkMessage {
  type: "streamingChunk";
  content: string;
}

interface StreamingReasoningChunkMessage {
  type: "streamingReasoningChunk";
  content: string;
}

interface TaskProgressMessage {
  type: "taskProgress";
  taskId: string;
  status: string;
  message?: string;
}

interface TokenUsageMessage {
  type: "tokenUsage";
  lastCachedTokens: number;
  lastPromptTokens: number;
  lastCompletionTokens: number;
  lastTotalTokens: number;
}

interface CompactionResultMessage {
  type: "compactionResult";
  summary: string;
  messagesCompacted: number;
}

interface SessionStateMessage {
  type: "sessionState";
  key: string;
  value: unknown;
}

interface ServerErrorMessage {
  type: "error";
  message: string;
}

type ServerMessage =
  | SessionCreatedMessage
  | SessionDeletedMessage
  | SessionsMessage
  | AuthRequiredMessage
  | AuthErrorMessage
  | UserMessage
  | AssistantMessage
  | ThinkingMessage
  | ToolCallMessage
  | ToolResultMessage
  | CompactingMessage
  | CommandResultMessage
  | QuestionMessage
  | StreamingChunkMessage
  | StreamingReasoningChunkMessage
  | TaskProgressMessage
  | TokenUsageMessage
  | CompactionResultMessage
  | SessionStateMessage
  | ServerErrorMessage;

// ── Config & return types ───────────────────────────────────────────────────

interface ChatConfig {
  token: string | null;
  host?: string;
  onSessionCreated?: (data: { sessionId: string }) => void;
  onSessionsUpdate?: (sessions: SessionInfo[], activeSessionId: string | null) => void;
  onConnectionChange?: (connected: boolean) => void;
  onAuthFailure?: () => void;
}

export interface ChatController {
  connect: () => void;
  disconnect: () => void;
  sendMessage: (content: string) => void;
  sendSlashCommand: (command: string) => void;
  cancel: () => void;
  createSession: (opts?: Record<string, unknown>) => void;
  switchSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  listSessions: () => void;
  sendCommand: (command: string) => void;
  sendQuestionAnswer: (answers: unknown) => void;
  setSession: (sessionId: string) => void;
  ws: WebSocket | null;
  sessionIdAtom: Atom<string | null>;
  currentModelAtom: Atom<string>;
  modelsAtom: Atom<string[]>;
  connectedAtom: Atom<boolean>;
  workingAtom: Atom<boolean>;
}

/**
 * Create a chat controller for a WebSocket connection.
 * @param config - Configuration object
 * @returns Chat controller with reactive state atoms and send helpers
 */
export function createChat({
  token,
  host = window.location.host,
  onSessionCreated,
  onSessionsUpdate,
  onConnectionChange,
  onAuthFailure,
}: ChatConfig): ChatController {
  const wsUrl = `ws://${host}/ws?token=${token}`;
  let ws: WebSocket | null = null;
  let messageList: MessageListManager | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let authFailed = false;

  // ── Reactive state atoms ───────────────────────────────────────────────────
  // Every UI element that needs to update when data changes is driven by one
  // of these atoms.  Effects (registered below) handle the actual DOM writes.

  const sessionIdAtom = reactiveState<string | null>(null);
  const currentModelAtom = reactiveState<string>("");
  const modelsAtom = reactiveState<string[]>([]);
  const connectedAtom = reactiveState<boolean>(false);
  const workingAtom = reactiveState<boolean>(false);

  // ── Effects — auto-wire DOM to atoms ─────────────────────────────────────

  // Model dropdown: rebuild whenever the list of available models *or* the
  // currently selected model changes.
  effect(() => {
    const select = document.getElementById("model-select") as HTMLSelectElement | null;
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
    const el = document.getElementById("connection-status") as HTMLElement | null;
    if (!el) return;
    const connected = connectedAtom();
    el.className = connected ? "status-connected" : "status-disconnected";
    el.textContent = connected ? "Connected" : "Disconnected";
    onConnectionChange?.(connected);
  }, [connectedAtom]);

  // Working indicator (spinner + cancel button).  Cancel button is now
  // inside the indicator, so hiding the indicator hides it automatically.
  effect(() => {
    const el = document.getElementById("working-indicator") as HTMLElement | null;
    if (!el) return;
    const working = workingAtom();
    el.classList.toggle("hidden", !working);
  }, [workingAtom]);

  // Session-id label in the info bar.
  effect(() => {
    const el = document.getElementById("current-session-id") as HTMLElement | null;
    if (!el) return;
    const sid = sessionIdAtom();
    el.textContent = sid ? sid.slice(0, 8) : "";
  }, [sessionIdAtom]);

  // ── WS Message Routing ───────────────────────────────────────────────────

  function handleServerMessage(data: ServerMessage): void {
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
        onSessionsUpdate?.(data.sessions as SessionInfo[], sessionIdAtom());
        return;
      case "authRequired":
        console.warn("[chat] Auth required but not provided");
        return;
      case "authError":
        logger.error("[chat] Auth error:", data.message);
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
          workingAtom(Boolean(data.value));
        }
        // Handle model changes (e.g. after /model command or session switch)
        if (data.key === "model") {
          currentModelAtom(data.value as string);
        }
        if (data.key === "models") {
          modelsAtom(data.value as string[]);
        }
        messageList.handleSessionState(data);
        break;
      case "error":
        workingAtom(false);
        messageList.handleError(data);
        break;

      default:
        console.warn("[chat] Unknown message type:", (data as { type: string }).type);
    }
  }

  // ── WS Connection ─────────────────────────────────────────────────────────

  function connect(): void {
    if (ws) {
      ws.close();
      ws = null;
    }
    authFailed = false;

    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      logger.error("[chat] WS connection failed:", e);
      connectedAtom(false);
      verifyTokenAndReconnect();
      return;
    }

    ws.onopen = () => {
      connectedAtom(true);
    };

    ws.onmessage = (event: MessageEvent) => {
      let data: ServerMessage;
      try {
        data = JSON.parse(event.data as string);
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
  function verifyTokenAndReconnect(): void {
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

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 3000);
  }

  function disconnect(): void {
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

  function send(obj: Record<string, unknown>): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    } else {
      console.warn("[chat] WS not connected");
    }
  }

  /** Send user message to the current session. */
  function sendMessage(content: string): void {
    if (!sessionIdAtom()) {
      console.warn("[chat] No active session");
      return;
    }
    // Optimistically render the user's message immediately
    if (messageList) {
      // messageList.handleUserMessage({ content });
    }
    // Show working indicator while waiting for a response
    workingAtom(true);
    send({ type: "send", sessionId: sessionIdAtom(), content });
  }

  /** Send a slash command to the agent. */
  function sendSlashCommand(command: string): void {
    if (!sessionIdAtom()) return;
    send({ type: "command", sessionId: sessionIdAtom(), command });
  }

  /** Cancel the current run. */
  function cancel(): void {
    if (!sessionIdAtom()) return;
    send({ type: "cancel", sessionId: sessionIdAtom() });
  }

  /** Create a new session. */
  function createSession(opts: Record<string, unknown> = {}): void {
    send({ type: "createSession", ...opts });
  }

  /** Switch to a different session. */
  function switchSession(sessionId: string): void {
    send({ type: "switchSession", sessionId });
    sessionIdAtom(sessionId);
    messageList?.clear();
    workingAtom(false);
    listSessions(); // Refresh sidebar so the active session is highlighted correctly
  }

  /** Delete a session. */
  function deleteSession(sessionId: string): void {
    send({ type: "deleteSession", sessionId });
    listSessions(); // Refresh sidebar so the deleted session is removed
  }

  /** List sessions. */
  function listSessions(): void {
    send({ type: "listSessions" });
  }

  /** Send a command to the agent. */
  function sendCommand(command: string): void {
    if (!sessionIdAtom()) return;
    send({ type: "command", sessionId: sessionIdAtom(), command });
  }

  /** Send a question answer. */
  function sendQuestionAnswer(answers: unknown): void {
    if (!sessionIdAtom()) return;
    send({ type: "questionAnswer", sessionId: sessionIdAtom(), answers });
  }

  // ── Session management ────────────────────────────────────────────────────

  function setSession(sessionId: string): void {
    messageList = createMessageList(sessionId, { hideThinking: false });
    sessionIdAtom(sessionId);
    messageList.clear();
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  // Wire up chat input form — detect slash commands and route accordingly
  const chatForm = document.getElementById("chat-form") as HTMLFormElement | null;
  if (chatForm) {
    chatForm.addEventListener("submit", (e: SubmitEvent) => {
      e.preventDefault();
      const input = document.getElementById("chat-input") as HTMLInputElement;
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
  }

  const cancelBtn = document.getElementById("cancel-btn") as HTMLButtonElement | null;
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      cancel();
    });
  }

  // Model dropdown change — send /model command to switch
  const modelSelect = document.getElementById("model-select") as HTMLSelectElement | null;
  if (modelSelect) {
    modelSelect.addEventListener("change", (e: Event) => {
      const modelName = (e.target as HTMLSelectElement).value;
      if (!modelName || !sessionIdAtom()) return;
      sendSlashCommand(`/model ${modelName}`);
    });
  }

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
