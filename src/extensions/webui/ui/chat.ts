/// <reference lib="dom" />
// Chat view: WS client + message routing. Atoms drive the DOM via effects.

import { reactiveState, effect, Atom } from "./utils.ts";
import { createMessageList, MessageListManager } from "./message-list.ts";
import type { SessionInfo } from "./sessions.ts";
import { sanitize } from "./utils.ts";

// The core logger touches process.*, which doesn't exist in the browser.
const logger = {
  error: (msg: string, data?: unknown) => {
    console.error("[chat]", msg, data || "");
  },
  warn: (msg: string, data?: unknown) => {
    console.warn("[chat]", msg, data || "");
  },
};

type ProfileInfo = {
  role: string;
  body: string;
  model: string | null;
};
const profilesAtom = reactiveState<Record<string, ProfileInfo>>({});
let currentProfile = "default";
// Drives the profile-switch confirmation prompt.
let userMessageCount = 0;

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
  sessions: Array<{ id: string; profile?: string; userMessageCount?: number }>;
}

interface LogsListedMessage {
  type: "logsListed";
  logs: Array<{ id: string; createdAt: number; lastActivityAt: number; messageCount: number }>;
}

interface LogEntry {
  source: string;
  content: string;
  images?: Array<{ url: string }>;
  reasoning_content?: string | null;
  tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> | null;
  tool_call_id?: string | null;
}

interface LogViewedMessage {
  type: "logViewed";
  logId: string;
  entries: LogEntry[];
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
  value: string | string[] | boolean | number;
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

interface ChatConfig {
  token: string | null;
  host?: string;
  onSessionCreated?: (data: { sessionId: string }) => void;
  onSessionsUpdate?: (sessions: SessionInfo[], activeSessionId: string | null) => void;
  onLogsUpdate?: (logs: Array<{ id: string; createdAt: number; lastActivityAt: number; messageCount: number }>) => void;
  onLogViewed?: (logId: string, entries: LogEntry[]) => void;
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
  // Cold session logs (persisted on disk).
  listLogs: () => void;
  loadLog: (logId: string) => void;
  viewLog: (logId: string) => void;
  deleteLog: (logId: string) => void;
  sendCommand: (command: string) => void;
  sendQuestionAnswer: (answers: Record<string, string>) => void;
  setSession: (sessionId: string) => void;
  listProfiles: () => void;
  switchProfile: (profileName: string, force?: boolean) => void;
  // Raw WS message -- needed to cancel non-active sessions from the sidebar.
  send: (obj: Record<string, unknown>) => void;
  ws: WebSocket | null;
  sessionIdAtom: Atom<string | null>;
  currentModelAtom: Atom<string>;
  modelsAtom: Atom<string[]>;
  connectedAtom: Atom<boolean>;
  workingAtom: Atom<boolean>;
  // sessionId -> isWorking, so the sidebar can show per-session indicators.
  sessionWorkingMap: Map<string, boolean>;
  messageListAtom: () => MessageListManager | null;
  getCurrentProfile: () => string;
}

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

  const sessionIdAtom = reactiveState<string | null>(null);
  const currentModelAtom = reactiveState<string>("");
  const modelsAtom = reactiveState<string[]>([]);
  const connectedAtom = reactiveState<boolean>(false);
  const workingAtom = reactiveState<boolean>(false);

  // Tracks which sessions have active agents, so indicators survive session switches.
  const sessionWorkingMap = new Map<string, boolean>();

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

  effect(() => {
    const el = document.getElementById("connection-status") as HTMLElement | null;
    if (!el) return;
    const connected = connectedAtom();
    el.className = connected ? "status-connected" : "status-disconnected";
    el.textContent = connected ? "Connected" : "Disconnected";
    onConnectionChange?.(connected);
  }, [connectedAtom]);

  // Cancel button lives inside the indicator, so hiding it hides the button too.
  effect(() => {
    const el = document.getElementById("working-indicator") as HTMLElement | null;
    if (!el) return;
    const working = workingAtom();
    el.classList.toggle("hidden", !working);
  }, [workingAtom]);

  effect(() => {
    const el = document.getElementById("current-session-id") as HTMLElement | null;
    if (!el) return;
    const sid = sessionIdAtom();
    el.textContent = sid ? sid.slice(0, 8) : "";
  }, [sessionIdAtom]);

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

  // Re-clone the select on every profiles change to drop stale listeners.
  effect(() => {
    const profiles = profilesAtom();
    const select = document.getElementById("profile-select") as HTMLSelectElement | null;
    if (!select) return;

    const newSelect = select.cloneNode(true) as HTMLSelectElement;
    select.parentNode?.replaceChild(newSelect, select);

    newSelect.addEventListener("change", (e) => {
      const target = e.target as HTMLSelectElement;
      const profileName = target.value;

      if (userMessageCount > 0 && !confirm("Switching profile will clear session context and all messages. Continue?")) {
        target.value = currentProfile;
        return;
      }

      // force=true: the UI already confirmed (or no confirmation was needed).
      switchProfile(profileName, true);
    });
  }, [profilesAtom]);

  function handleServerMessage(data: ServerMessage): void {
    // Session-management messages are handled even before messageList is ready.
    switch (data.type) {
      case "sessionCreated":
        sessionIdAtom(data.sessionId);
        currentModelAtom(data.currentModel || "");
        // Set before profiles load so the dropdown is correct immediately.
        if (data.profile) {
          currentProfile = data.profile;
        }
        if (data.models && data.models.length > 0) {
          modelsAtom(data.models);
        }
        // Page reload: the server may have sent working state before
        // sessionCreated, so restore it from the map here.
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
        const sessions = data.sessions;
        const activeSession = sessions.find(s => s.id === sessionIdAtom());
        if (activeSession && activeSession.profile) {
          currentProfile = activeSession.profile;
          const select = document.getElementById("profile-select") as HTMLSelectElement | null;
          if (select) select.value = currentProfile;
        }
        userMessageCount = activeSession?.userMessageCount || 0;
        onSessionsUpdate?.(data.sessions as SessionInfo[], sessionIdAtom());
        return;
      }
      case "profiles":
        profilesAtom(data.profiles);
        return;
      case "profileSwitched":
        if (data.success) {
          currentProfile = data.profile || "default";
          const select = document.getElementById("profile-select") as HTMLSelectElement | null;
          if (select) select.value = currentProfile;
          if (messageList) {
            const msgEl = document.createElement("div");
            msgEl.className = "message system-message";
            msgEl.innerHTML = `<span class="message-role system-label">System</span><div class="message-content"><p>Switched to profile: ${sanitize(data.profile || "default")}</p></div>`;
            const msgList = document.getElementById("message-list");
            if (msgList) msgList.appendChild(msgEl);
          }
        }
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

    if (!messageList) return;

    // Defense in depth: the server should only send content events for the
    // active session, but a leaked orphaned channel must not corrupt the UI.
    // sessionState is an exception -- it's broadcast for all sessions so the
    // sidebar can show per-session working indicators.
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
        if (data.key === "working") {
          const sid = (data as { sessionId?: string }).sessionId;
          if (sid) {
            sessionWorkingMap.set(sid, Boolean(data.value));
            // Keep the cancel button in sync for the active session.
            if (sid === sessionIdAtom()) {
              workingAtom(Boolean(data.value));
            }
          }
          onWorkingMapChange?.();
        }
        if (data.key === "model") {
          currentModelAtom(data.value as string);
        }
        if (data.key === "models") {
          modelsAtom(data.value as string[]);
        }
        if (data.key === "profile") {
          currentProfile = data.value as string;
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

  // Verify the token over HTTP; stop reconnecting on 401, otherwise (including
  // network errors -- server may just be down) keep trying.
  function verifyTokenAndReconnect(): void {
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
          scheduleReconnect();
        }
      })
      .catch(() => scheduleReconnect());
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

  function send(obj: Record<string, unknown>): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    } else {
      console.warn("[chat] WS not connected");
    }
  }

  function sendMessage(content: string): void {
    if (!sessionIdAtom()) {
      console.warn("[chat] No active session");
      return;
    }
    workingAtom(true);
    send({ type: "send", sessionId: sessionIdAtom(), content });
  }

  function sendSlashCommand(command: string): void {
    if (!sessionIdAtom()) return;
    send({ type: "command", sessionId: sessionIdAtom(), command });
  }

  function cancel(): void {
    if (!sessionIdAtom()) return;
    send({ type: "cancel", sessionId: sessionIdAtom() });
    // Clear working state optimistically so the UI doesn't spin.
    const sid = sessionIdAtom();
    if (sid) sessionWorkingMap.set(sid, false);
    workingAtom(false);
  }

  function createSession(opts: Record<string, unknown> = {}): void {
    const profile = (opts.profile as string | undefined) || currentProfile;
    send({ type: "createSession", ...opts, profile });
  }

  function switchSession(sessionId: string): void {
    send({ type: "switchSession", sessionId });
    sessionIdAtom(sessionId);
    messageList?.clear();
    workingAtom(sessionWorkingMap.get(sessionId) ?? false);
    listSessions(); // Refresh sidebar highlight
  }

  function deleteSession(sessionId: string): void {
    send({ type: "deleteSession", sessionId });
    sessionWorkingMap.delete(sessionId);
    listSessions();
  }

  function renameSession(sessionId: string, newName: string): void {
    send({ type: "renameSession", sessionId, newName });
    listSessions();
  }

  function listSessions(): void {
    send({ type: "listSessions" });
  }

  function sendCommand(command: string): void {
    if (!sessionIdAtom()) return;
    send({ type: "command", sessionId: sessionIdAtom(), command });
  }

  function sendQuestionAnswer(answers: Record<string, string>): void {
    if (!sessionIdAtom()) return;
    send({ type: "questionAnswer", sessionId: sessionIdAtom(), answers });
  }

  function setSession(sessionId: string): void {
    messageList = createMessageList(sessionId, { hideThinking: false });
    sessionIdAtom(sessionId);
    messageList.clear();
  }

  function listProfiles(): void {
    send({ type: "listProfiles" });
  }

  function switchProfile(profileName: string, force: boolean = false): void {
    const sessionId = sessionIdAtom();
    if (!sessionId) {
      console.warn("[chat] No active session for profile switch");
      return;
    }
    send({ type: "switchProfile", sessionId, profileName, force });
  }

  function getCurrentProfile(): string {
    return currentProfile;
  }

  const chatForm = document.getElementById("chat-form") as HTMLFormElement | null;
  if (chatForm) {
    chatForm.addEventListener("submit", (e: SubmitEvent) => {
      e.preventDefault();
      const input = document.getElementById("chat-input") as HTMLInputElement;
      const text = input.value.trim();
      if (!text) return;
      input.value = "";

      if (text.startsWith("/")) {
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

  const modelSelect = document.getElementById("model-select") as HTMLSelectElement | null;
  if (modelSelect) {
    modelSelect.addEventListener("change", (e: Event) => {
      const modelName = (e.target as HTMLSelectElement).value;
      if (!modelName || !sessionIdAtom()) return;
      sendSlashCommand(`/model ${modelName}`);
    });
  }

  connect();

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
    sessionIdAtom,
    currentModelAtom,
    modelsAtom,
    connectedAtom,
    workingAtom,
    sessionWorkingMap,
    messageListAtom: () => messageList,
  };
}
