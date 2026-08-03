/// <reference lib="dom" />
// Chat view component — WS client, message routing, input handling.
// Connects to the WebSocket server and routes messages to the message list.
// Uses reactiveState atoms so DOM updates happen automatically via effects.

import { reactiveState, effect, Atom } from "./utils.ts";
import { createMessageList, MessageListManager } from "./message-list.ts";
import type { SessionInfo } from "./sessions.ts";
import { sanitize } from "./utils.ts";

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

// Profile state - matches SwitchProfile from backend
type ProfileInfo = {
  role: string;
  body: string;
  model: string | null;
};
const profilesAtom = reactiveState<Record<string, ProfileInfo>>({});
let currentProfile = "default";
// Track user message count for confirmation logic
let userMessageCount = 0;

// ── Server message types ────────────────────────────────────────────────────

interface SessionCreatedMessage {
  type: "sessionCreated";
  sessionId: string;
  profile?: string;
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

interface LogsListedMessage {
  type: "logsListed";
  logs: Array<{ id: string; createdAt: number; lastActivityAt: number; messageCount: number }>;
}

interface LogViewedMessage {
  type: "logViewed";
  logId: string;
  entries: Array<{
    source: string;
    content: string;
    images?: unknown[];
    reasoning_content?: string | null;
    tool_calls?: unknown[] | null;
    tool_call_id?: string | null;
  }>;
}

interface LogDeletedMessage {
  type: "logDeleted";
  logId: string;
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
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
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

interface ProfilesMessage {
  type: "profiles";
  profiles: Record<string, { role: string; body: string; model: string | null; whitelistTools?: string[] | null; blacklistTools?: string[] }>;
}

interface ProfileSwitchedMessage {
  type: "profileSwitched";
  sessionId: string;
  profile?: string;
  success?: boolean;
  requiresConfirmation?: boolean;
}

interface ServerErrorMessage {
  type: "error";
  message: string;
}

type ServerMessage =
  | SessionCreatedMessage
  | SessionDeletedMessage
  | SessionsMessage
  | LogsListedMessage
  | LogViewedMessage
  | LogDeletedMessage
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
  | ProfilesMessage
  | ProfileSwitchedMessage
  | ServerErrorMessage;

// ── Config & return types ───────────────────────────────────────────────────

interface ChatConfig {
  token: string | null;
  host?: string;
  onSessionCreated?: (data: { sessionId: string }) => void;
  onSessionsUpdate?: (sessions: SessionInfo[], activeSessionId: string | null) => void;
  onLogsUpdate?: (logs: Array<{ id: string; createdAt: number; lastActivityAt: number; messageCount: number }>) => void;
  onLogViewed?: (logId: string, entries: Array<{ source: string; content: string; images?: unknown[]; reasoning_content?: string | null; tool_calls?: unknown[] | null; tool_call_id?: string | null }>) => void;
  onLogDeleted?: (logId: string) => void;
  onConnectionChange?: (connected: boolean) => void;
  onAuthFailure?: () => void;
  onWorkingMapChange?: () => void;
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
  renameSession: (sessionId: string, newName: string) => void;
  listSessions: () => void;
  /** List cold session logs from disk */
  listLogs: () => void;
  /** Load a cold session log into a new active session */
  loadLog: (logId: string) => void;
  /** View a cold session log without creating an active session */
  viewLog: (logId: string) => void;
  /** Delete a cold session log file */
  deleteLog: (logId: string) => void;
  sendCommand: (command: string) => void;
  sendQuestionAnswer: (answers: unknown) => void;
  setSession: (sessionId: string) => void;
  /** List available profiles */
  listProfiles: () => void;
  /** Switch to a different profile */
  switchProfile: (profileName: string, force?: boolean) => void;
  /** Send a raw WS message (used for canceling non-active sessions from sidebar) */
  send: (obj: Record<string, unknown>) => void;
  ws: WebSocket | null;
  sessionIdAtom: Atom<string | null>;
  currentModelAtom: Atom<string>;
  modelsAtom: Atom<string[]>;
  connectedAtom: Atom<boolean>;
  workingAtom: Atom<boolean>;
  /** Per-session working state map — sessionId → isWorking */
  sessionWorkingMap: Map<string, boolean>;
  /** Accessor for the current message list manager */
  messageListAtom: () => MessageListManager | null;
  /** Get current profile */
  getCurrentProfile: () => string;
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
  onLogsUpdate,
  onLogViewed,
  onLogDeleted,
  onConnectionChange,
  onAuthFailure,
  onWorkingMapChange,
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

  // Per-session working state map — tracks which sessions have active agents.
  // This allows the UI to show working indicators on individual sessions
  // even when viewing a different session.
  const sessionWorkingMap = new Map<string, boolean>();

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

  // Profile selector: rebuild whenever the list of available profiles changes.
  effect(() => {
    const select = document.getElementById("profile-select") as HTMLSelectElement | null;
    if (!select) return;
    const profiles = profilesAtom();
    const current = currentProfile;
    select.innerHTML = "";
    for (const name of Object.keys(profiles)) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === current) opt.selected = true;
      select.appendChild(opt);
    }
  }, [profilesAtom]);

  // Profile selector change handler - wire up after DOM is ready
  effect(() => {
    const profiles = profilesAtom(); // Trigger on profiles change
    const select = document.getElementById("profile-select") as HTMLSelectElement | null;
    if (!select) return;
    
    // Remove old listener if exists (by cloning)
    const newSelect = select.cloneNode(true) as HTMLSelectElement;
    select.parentNode?.replaceChild(newSelect, select);
    
    newSelect.addEventListener("change", (e) => {
      const target = e.target as HTMLSelectElement;
      const profileName = target.value;
      
      // Only ask for confirmation if session has user messages
      if (userMessageCount > 0 && !confirm("Switching profile will clear session context and all messages. Continue?")) {
        target.value = currentProfile;
        return;
      }
      
      // Send with force=true since UI already confirmed (or no confirmation needed)
      switchProfile(profileName, true);
    });
  }, [profilesAtom]);

  // ── WS Message Routing ───────────────────────────────────────────────────

  function handleServerMessage(data: ServerMessage): void {
    // ── Session management messages — handled even before messageList is ready ──
    switch (data.type) {
      case "sessionCreated":
        sessionIdAtom(data.sessionId);
        currentModelAtom(data.currentModel || "");
        // Set current profile from sessionCreated so the dropdown is correct
        // before profiles are loaded
        if (data.profile) {
          currentProfile = data.profile;
        }
        if (data.models && data.models.length > 0) {
          modelsAtom(data.models);
        }
        // Sync workingAtom with the session's working state from the map.
        // This handles page reload: if the server already sent the working
        // state before sessionCreated, the map has it and we restore it here.
        const createdSid = data.sessionId;
        if (sessionWorkingMap.has(createdSid)) {
          workingAtom(sessionWorkingMap.get(createdSid) ?? false);
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
      case "sessions": {
        // Update profile selector when sessions change
        const sessions = data.sessions as Array<{ id: string; profile?: string; userMessageCount?: number }>;
        const activeSession = sessions.find(s => s.id === sessionIdAtom());
        if (activeSession && activeSession.profile) {
          currentProfile = activeSession.profile;
          // Update profile selector
          const select = document.getElementById("profile-select") as HTMLSelectElement | null;
          if (select) select.value = currentProfile;
        }
        // Track user message count for confirmation logic
        userMessageCount = activeSession?.userMessageCount || 0;
        onSessionsUpdate?.(data.sessions as SessionInfo[], sessionIdAtom());
        return;
      }
      case "profiles":
        profilesAtom(data.profiles as Record<string, ProfileInfo>);
        return;
      case "profileSwitched":
        if (data.success) {
          currentProfile = data.profile || "default";
          // Update the selector to reflect the change
          const select = document.getElementById("profile-select") as HTMLSelectElement | null;
          if (select) select.value = currentProfile;
          // Show success message as a system-style notification
          if (messageList) {
            const msgEl = document.createElement("div");
            msgEl.className = "message system-message";
            msgEl.innerHTML = `<span class="message-role system-label">System</span><div class="message-content"><p>Switched to profile: ${sanitize(data.profile || "default")}</p></div>`;
            const msgList = document.getElementById("message-list");
            if (msgList) msgList.appendChild(msgEl);
          }
        }
        // Note: requiresConfirmation should never happen since UI always sends force=true
        return;
      case "logsListed":
        onLogsUpdate?.(data.logs);
        return;
      case "logViewed":
        onLogViewed?.(data.logId, data.entries);
        return;
      case "logDeleted":
        onLogDeleted?.(data.logId);
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

    // Filter: only process content events for the currently active session.
    // This is a defense-in-depth guard — the server should only send events
    // for the active session, but if orphaned channels leak events, this
    // prevents them from corrupting the UI.
    // Exception: sessionState messages (e.g., working indicators) are
    // broadcast for all sessions so the sidebar can show them.
    if (data.type !== "sessionState") {
      const msgSessionId = (data as { sessionId?: string }).sessionId;
      if (msgSessionId && msgSessionId !== sessionIdAtom()) {
        return;
      }
    }

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
        // Handle working state signals from the server.
        // Track per-session working state using the sessionId from the message.
        if (data.key === "working") {
          const sid = (data as { sessionId?: string }).sessionId;
          if (sid) {
            sessionWorkingMap.set(sid, Boolean(data.value));
            // Update workingAtom if this is the currently active session.
            // This ensures the cancel button reflects the correct state even
            // after page reload or session switching.
            if (sid === sessionIdAtom()) {
              workingAtom(Boolean(data.value));
            }
          }
          // Notify so the sidebar can refresh its working indicators
          onWorkingMapChange?.();
        }
        // Handle model changes (e.g. after /model command or session switch)
        if (data.key === "model") {
          currentModelAtom(data.value as string);
        }
        if (data.key === "models") {
          modelsAtom(data.value as string[]);
        }
        // Handle profile changes (e.g. after profile switch or session switch)
        if (data.key === "profile") {
          currentProfile = data.value as string;
          // Update the selector to reflect the change
          const select = document.getElementById("profile-select") as HTMLSelectElement | null;
          if (select) select.value = currentProfile;
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
      // Request logs list on initial connect and after reconnects
      listLogs();
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
    // Optimistically clear working state for this session
    const sid = sessionIdAtom();
    if (sid) sessionWorkingMap.set(sid, false);
    workingAtom(false);
  }

  /** Create a new session. */
  function createSession(opts: Record<string, unknown> = {}): void {
    // Use the currently selected profile if not explicitly set
    const profile = (opts.profile as string | undefined) || currentProfile;
    send({ type: "createSession", ...opts, profile });
  }

  /** Switch to a different session. */
  function switchSession(sessionId: string): void {
    send({ type: "switchSession", sessionId });
    sessionIdAtom(sessionId);
    messageList?.clear();
    // Restore working state from the per-session map
    workingAtom(sessionWorkingMap.get(sessionId) ?? false);
    listSessions(); // Refresh sidebar so the active session is highlighted correctly
  }

  /** Delete a session. */
  function deleteSession(sessionId: string): void {
    send({ type: "deleteSession", sessionId });
    // Clean up per-session working state
    sessionWorkingMap.delete(sessionId);
    listSessions(); // Refresh sidebar so the deleted session is removed
  }

  /** Rename a session (update its profile label). */
  function renameSession(sessionId: string, newName: string): void {
    send({ type: "renameSession", sessionId, newName });
    listSessions(); // Refresh sidebar so the renamed session shows new name
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

  /** List available profiles. */
  function listProfiles(): void {
    send({ type: "listProfiles" });
  }

  /** Switch to a different profile. */
  function switchProfile(profileName: string, force: boolean = false): void {
    const sessionId = sessionIdAtom();
    if (!sessionId) {
      console.warn("[chat] No active session for profile switch");
      return;
    }
    send({ type: "switchProfile", sessionId, profileName, force });
  }

  /** Get current profile. */
  function getCurrentProfile(): string {
    return currentProfile;
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

  // ── Cold session log management ───────────────────────────────────────────

  function listLogs(): void {
    send({ type: "listLogs" });
  }

  function loadLog(logId: string): void {
    send({ type: "loadLog", logId });
  }

  function viewLog(logId: string): void {
    send({ type: "viewLog", logId });
  }

  function deleteLog(logId: string): void {
    send({ type: "deleteLog", logId });
  }

  return {
    connect,
    disconnect,
    sendMessage,
    sendSlashCommand,
    cancel,
    createSession,
    switchSession,
    deleteSession,
    renameSession,
    listSessions,
    listLogs,
    loadLog,
    viewLog,
    deleteLog,
    sendCommand,
    sendQuestionAnswer,
    setSession,
    listProfiles,
    switchProfile,
    getCurrentProfile,
    send,
    ws,
    // Expose atoms for external reactive coordination
    sessionIdAtom,
    currentModelAtom,
    modelsAtom,
    connectedAtom,
    workingAtom,
    sessionWorkingMap,
    // Expose messageList for external manipulation (e.g., rendering log entries)
    messageListAtom: () => messageList,
  };
}
