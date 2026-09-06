/// <reference lib="dom" />
// Chat view: WS client + message routing; atoms expose state to the JSX app.

import { reactiveState, Atom } from "./utils.ts";
import { createMessageList, MessageListManager } from "./message-list.ts";
import type { SessionInfo } from "./sessions.tsx";

// The core logger touches process.*, which doesn't exist in the browser.
const logger = {
  error: (msg: string, data?: unknown) => {
    console.error("[chat]", msg, data || "");
  },
  warn: (msg: string, data?: unknown) => {
    console.warn("[chat]", msg, data || "");
  },
};

export type ProfileInfo = {
  role: string;
  body: string;
  model: string | null;
};
const profilesAtom = reactiveState<Record<string, ProfileInfo>>({});
const currentProfileAtom = reactiveState<string>("default");
// Explicit session name for the active session; null = show the short id.
const sessionTitleAtom = reactiveState<string | null>(null);
// >0 means switching profiles will clear context, so confirm first.
let userMessageCount = 0;

interface SessionCreatedMessage {
  type: "sessionCreated";
  sessionId: string;
  profile?: string;
  /** Explicit session name; null = display name follows the profile. */
  title?: string | null;
  currentModel?: string;
  models?: string[];
}

interface SessionDeletedMessage {
  type: "sessionDeleted";
  sessionId: string;
}

interface SessionsMessage {
  type: "sessions";
  sessions: Array<{
    id: string;
    profile?: string;
    title?: string | null;
    userMessageCount?: number;
  }>;
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

interface AuthOkMessage {
  type: "authOk";
}

interface AuthErrorMessage {
  type: "authError";
  message: string;
  // Machine-readable discriminator on the server's pre-auth gate rejection
  // (see routeMessage in ../websocket/server.ts): "auth_required".
  code?: string;
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
  questions: {
    key?: string;
    message?: string;
    prompt?: string;
    options?: string[];
    default?: string;
    required?: boolean;
    allowOther?: boolean;
  }[];
}

interface QuestionAnsweredMessage {
  type: "questionAnswered";
  sessionId?: string;
  answers: Record<string, string>;
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
  | AuthOkMessage
  | AuthErrorMessage
  | UserMessage
  | AssistantMessage
  | ThinkingMessage
  | ToolCallMessage
  | ToolResultMessage
  | CompactingMessage
  | CommandResultMessage
  | QuestionMessage
  | QuestionAnsweredMessage
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
  /** The #message-list element, handed out by the JSX tree via ref. */
  getMessageListContainer: () => HTMLElement | null;
  onSessionCreated?: (data: { sessionId: string }) => void;
  onSessionsUpdate?: (sessions: SessionInfo[], activeSessionId: string | null) => void;
  onLogsUpdate?: (logs: Array<{ id: string; createdAt: number; lastActivityAt: number; messageCount: number }>) => void;
  onLogViewed?: (logId: string, entries: LogEntry[]) => void;
  onLogDeleted?: (logId: string) => void;
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
  listLogs: () => void;
  loadLog: (logId: string) => void;
  viewLog: (logId: string) => void;
  deleteLog: (logId: string) => void;
  sendCommand: (command: string) => void;
  sendQuestionAnswer: (answers: Record<string, string>) => void;
  setSession: (sessionId: string) => void;
  listProfiles: () => void;
  switchProfile: (profileName: string, force?: boolean) => void;
  // Raw WS message; the sidebar uses it to cancel non-active sessions.
  send: (obj: Record<string, unknown>) => void;
  ws: WebSocket | null;
  sessionIdAtom: Atom<string | null>;
  sessionTitleAtom: Atom<string | null>;
  currentModelAtom: Atom<string>;
  modelsAtom: Atom<string[]>;
  profilesAtom: Atom<Record<string, ProfileInfo>>;
  currentProfileAtom: Atom<string>;
  connectedAtom: Atom<boolean>;
  workingAtom: Atom<boolean>;
  // User messages in the active session; >0 means profile switches clear context.
  getUserMessageCount: () => number;
  // Per-session working state for the sidebar indicators.
  sessionWorkingMap: Map<string, boolean>;
  messageListAtom: () => MessageListManager | null;
  getCurrentProfile: () => string;
}

export function createChat({
  token,
  host = window.location.host,
  getMessageListContainer,
  onSessionCreated,
  onSessionsUpdate,
  onLogsUpdate,
  onLogViewed,
  onLogDeleted,
  onAuthFailure,
  onWorkingMapChange,
}: ChatConfig): ChatController {
  const wsUrl = `ws://${host}/ws`;
  let ws: WebSocket | null = null;
  let messageList: MessageListManager | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let authFailed = false;

  const sessionIdAtom = reactiveState<string | null>(null);
  const currentModelAtom = reactiveState<string>("");
  const modelsAtom = reactiveState<string[]>([]);
  const connectedAtom = reactiveState<boolean>(false);
  const workingAtom = reactiveState<boolean>(false);

  // Per-session working state; kept across switches so the sidebar stays accurate.
  const sessionWorkingMap = new Map<string, boolean>();

  function handleServerMessage(data: ServerMessage): void {
    // Session-management messages are handled even before messageList is ready.
    switch (data.type) {
      case "sessionCreated":
        sessionIdAtom(data.sessionId);
        sessionTitleAtom(data.title ?? null);
        currentModelAtom(data.currentModel || "");
        if (data.profile) {
          currentProfileAtom(data.profile);
        }
        if (data.models && data.models.length > 0) {
          modelsAtom(data.models);
        }
        // On page reload the server can send working state before
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
          sessionTitleAtom(null);
          currentModelAtom("");
        }
        return;
      case "sessions": {
        const sessions = data.sessions;
        const activeSession = sessions.find(s => s.id === sessionIdAtom());
        if (activeSession) {
          if (activeSession.profile) {
            currentProfileAtom(activeSession.profile);
          }
          // The list is authoritative for the active session's title
          // (e.g. after a rename from this or another tab).
          sessionTitleAtom(activeSession.title ?? null);
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
          const switched = data.profile || "default";
          currentProfileAtom(switched);
          messageList?.addSystemMessage(switched);
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
        // Expected: the upgrade carries no token, so the server holds the
        // socket open until our AUTH message validates.
        return;
      case "authError":
        if (data.code === "auth_required") {
          // A message raced ahead of the AUTH handshake; the handshake
          // itself decides the outcome, so this is not a token failure.
          console.warn("[chat] Message sent before auth completed, ignored");
          return;
        }
        logger.error("[chat] Auth error:", data.message);
        authFailed = true;
        onAuthFailure?.();
        return;
      case "authOk":
        // Handshake done. Flip connected last: the effects it triggers
        // (listProfiles, listSessions) are only legal after AUTH. The
        // server may already be attaching a session; sessionCreated
        // drives the rest.
        connectedAtom(true);
        listLogs();
        return;
    }

    if (!messageList) return;

    // Defense in depth: content events should only arrive for the active
    // session, but a leaked orphaned channel must not corrupt the UI.
    // sessionState is broadcast for all sessions (sidebar indicators).
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
      case "questionAnswered":
        if (!data.sessionId || data.sessionId === sessionIdAtom()) {
          messageList.handleQuestionAnswered(data);
        }
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
          currentProfileAtom(data.value as string);
        }
        if (data.key === "title") {
          sessionTitleAtom(typeof data.value === "string" ? data.value : null);
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
      if (!token) {
        // Nothing to auth with; verifyTokenAndReconnect routes to onAuthFailure.
        verifyTokenAndReconnect();
        return;
      }
      // The token rides the first WS message, not the upgrade URL. Nothing
      // else may be sent before it: the server gates all non-AUTH traffic.
      // connectedAtom flips on authOk, so no connected effects (listProfiles
      // etc.) can race ahead of the handshake.
      send({ type: "auth", token });
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

    fetch(`/verify`, {
      headers: { "x-hotdog-token": token },
    })
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
    // Clear working state optimistically so the spinner stops immediately.
    const sid = sessionIdAtom();
    if (sid) sessionWorkingMap.set(sid, false);
    workingAtom(false);
  }

  function createSession(opts: Record<string, unknown> = {}): void {
    const profile = (opts.profile as string | undefined) || currentProfileAtom();
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
    const container = getMessageListContainer();
    if (!container) {
      console.warn("[chat] message list container not mounted");
      return;
    }
    // Reuse the manager across sessions: it is session-agnostic (the
    // question-answer callback reads sessionIdAtom() at call time and
    // clear() resets all its state), and recreating it would re-attach the
    // container's scroll listener on every switch.
    messageList ??= createMessageList(container, {
      hideThinking: false,
      onQuestionAnswer: (answers) => sendQuestionAnswer(answers),
    });
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
    return currentProfileAtom();
  }

  function getUserMessageCount(): number {
    return userMessageCount;
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
    sessionTitleAtom,
    currentModelAtom,
    modelsAtom,
    profilesAtom,
    currentProfileAtom,
    connectedAtom,
    workingAtom,
    getUserMessageCount,
    sessionWorkingMap,
    messageListAtom: () => messageList,
  };
}
