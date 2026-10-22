/// <reference lib="dom" />
// Chat view: WS client + message routing; atoms expose state to the JSX app.

import { reactiveState, Atom } from "./utils.ts";
import { createMessageList, MessageListManager } from "./message-list.ts";
import type { UiImage } from "./message-list.ts";
import type { SessionInfo } from "./sessions.tsx";
import type {
  UploadFileWire,
  TaskInfoWire,
  TaskActivityWire,
  TaskControlWire,
  TranscribeRequestWire,
  TranscriptReplyWire,
} from "@extensions/websocket/protocol.ts";

export type { UploadFileWire };
export type { TaskInfoWire };

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
  body: string;
  model: string | null;
};
const profilesAtom = reactiveState<Record<string, ProfileInfo>>({});
const currentProfileAtom = reactiveState<string>("default");

// Server has an STT backend configured (mirrors the sttEnabled flag carried
// by every sessionCreated payload; drives the push-to-talk button).
const sttEnabledAtom = reactiveState<boolean>(false);

// Tool execution plane posture, carried by the same sessionCreated
// payload as sttEnabled: "worker (fence: none)", "inline (unfenced)", plus a
// degraded marker. Empty until the first attach.
const toolExecAtom = reactiveState<string>("");

// ── Subagent tasks (strip + overlay panels; see ./subagents.tsx) ───────────
// Broadcast feed (S2C taskList/taskUpdate/taskActivity), deliberately kept
// outside the chat transcript: task-agent output never enters message-list.
const tasksAtom = reactiveState<TaskInfoWire[]>([]);
// Bumped on every activity item; panel bodies read the blocks from the map
// below, so render only needs the version flip.
const activityVersionAtom = reactiveState<number>(0);
// Most recent task-control reply per task (S2C taskControl); the panel shows
// it inline so the user sees Cancel/steer outcomes, not just the status flip.
const taskControlAtom = reactiveState<
  Record<string, { ok: boolean; text: string }>
>({});

/** Accumulated display blocks: consecutive same-kind deltas merge into one block. */
export type TaskActivityBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; name: string; args: string }
  | { kind: "tool_result"; name: string; output: string; error?: string };

const MAX_ACTIVITY_BLOCKS = 200;
const MAX_TRACKED_TASKS = 50;
const taskActivity = new Map<string, TaskActivityBlock[]>();

function upsertTask(info: TaskInfoWire): void {
  const tasks = tasksAtom().slice();
  const i = tasks.findIndex((t) => t.taskId === info.taskId);
  if (i >= 0) tasks[i] = info;
  else tasks.push(info);
  tasksAtom(tasks);
}

function appendTaskActivity(taskId: string, activity: TaskActivityWire): void {
  let blocks = taskActivity.get(taskId);
  if (!blocks) {
    blocks = [];
    taskActivity.set(taskId, blocks);
    // Map is insertion-ordered: evict the oldest task's transcript so a
    // long-lived server session does not grow unbounded.
    while (taskActivity.size > MAX_TRACKED_TASKS) {
      const oldest = taskActivity.keys().next().value as string;
      taskActivity.delete(oldest);
    }
  }
  const last = blocks[blocks.length - 1];
  if (activity.kind === "text" || activity.kind === "reasoning") {
    if (last && last.kind === activity.kind) {
      // Merged in place: panels key rows by block-object identity, so the
      // row's DOM node stays alive and the diff patches just its text node.
      (last as { kind: "text" | "reasoning"; text: string }).text += activity.content;
    } else {
      blocks.push({ kind: activity.kind, text: activity.content });
    }
  } else if (activity.kind === "tool_call") {
    blocks.push({ kind: "tool_call", name: activity.name, args: activity.args });
  } else {
    blocks.push({
      kind: "tool_result",
      name: activity.name,
      output: activity.output,
      ...(activity.error !== undefined ? { error: activity.error } : {}),
    });
  }
  if (blocks.length > MAX_ACTIVITY_BLOCKS) {
    blocks.splice(0, blocks.length - MAX_ACTIVITY_BLOCKS);
  }
  activityVersionAtom(activityVersionAtom() + 1);
}

/** Seed blocks from a server replay (taskActivityHistory). Skipped when
 * anything is accumulated: a panel open across the reconnect already has its tail. */
function seedTaskActivity(taskId: string, history: TaskActivityWire[]): void {
  if (taskActivity.has(taskId)) return;
  for (const activity of history) appendTaskActivity(taskId, activity);
}

function getTaskActivity(taskId: string): TaskActivityBlock[] {
  return taskActivity.get(taskId) ?? [];
}

function clearTasks(): void {
  tasksAtom([]);
  taskActivity.clear();
  activityVersionAtom(0);
}
// Explicit session name for the active session; null = show the short id.
const sessionTitleAtom = reactiveState<string | null>(null);

// Transcript-changing events (server to client). Any arriving after an
// attach's cursor report marks the transcript dirty: the next reconnect does
// a full replay, not a delta from the stored cursor.
const CONVERSATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "userMessage",
  "assistantMessage",
  "thinking",
  "toolCall",
  "toolResult",
  "streamingChunk",
  "streamingReasoningChunk",
  "question",
  "questionAnswered",
  "compacting",
  "commandResult",
  "compactionResult",
  "systemMessage",
]);

interface SessionCreatedMessage {
  type: "sessionCreated";
  sessionId: string;
  profile?: string;
  /** Explicit session name; null = display name follows the profile. */
  title?: string | null;
  currentModel?: string;
  models?: string[];
  /** Server has an STT backend configured (drives the mic affordance). */
  sttEnabled?: boolean;
  /** Tool-exec plane posture for the status strip; "" when the server said nothing. */
  toolExec?: string;
  /** The server replayed only the delta from the client's cursor, so the
   *  client keeps its transcript (it ends exactly at that cursor). */
  replayDelta?: boolean;
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
  logs: Array<{
    id: string;
    createdAt: number;
    lastActivityAt: number;
    messageCount: number;
    /** Derived index state (idle/awaiting_question/interrupted/parked);
     *  absent when the log has no reconciled row yet. */
    state?: string;
  }>;
}

// Image payload type (UiImage) is defined in message-list.ts; the server
// sends it via wireImages (../websocket/protocol.ts): base64 without data:
// prefix; oversized images arrive as { skipped, note } instead of data.

interface LogEntry {
  source: string;
  content: string;
  images?: UiImage[];
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
  // (see routeMessage in ../websocket/message-routing.ts): "auth_required".
  code?: string;
}

interface UserMessage {
  type: "userMessage";
  content: string;
  images?: UiImage[];
  /** file-include parts of the message; rendered as collapsible boxes inline. */
  files?: Array<{ path: string; content: string }>;
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
  display?: string;
  /** Server-computed hint-driven fold (see ToolBlockState.argsSummary). */
  argsSummary?: string;
  toolCallId?: string;
}

interface ToolResultMessage {
  type: "toolResult";
  name: string;
  output?: string;
  error?: string;
  images?: UiImage[];
  toolCallId?: string;
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

interface TaskListMessage {
  type: "taskList";
  tasks: TaskInfoWire[];
}

interface TaskUpdateMessage {
  type: "taskUpdate";
  task: TaskInfoWire;
}

interface TaskActivityMessage {
  type: "taskActivity";
  taskId: string;
  activity: TaskActivityWire;
}

interface TaskActivityHistoryMessage {
  type: "taskActivityHistory";
  taskId: string;
  activity: TaskActivityWire[];
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
  // Absent for strategies with no summary (pass-the-baton, drop, trim).
  summary?: string;
  messagesCompacted: number;
}

interface SessionStateMessage {
  type: "sessionState";
  key: string;
  value: string | string[] | boolean | number;
}

interface SystemMessage {
  type: "systemMessage";
  content?: string;
}

interface ProfilesMessage {
  type: "profiles";
  profiles: Record<string, { body: string; model: string | null; whitelistTools?: string[] | null; blacklistTools?: string[] }>;
}

interface ProfileSwitchedMessage {
  type: "profileSwitched";
  sessionId: string;
  profile?: string;
  success?: boolean;
}

interface ServerErrorMessage {
  type: "error";
  message: string;
}

export interface CompletionItem {
  value: string;
  display?: string;
}

interface CompletionsMessage {
  type: "completions";
  sessionId?: string;
  requestId?: number | null;
  prefix?: string;
  options?: CompletionItem[];
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
  | TaskListMessage
  | TaskUpdateMessage
  | TaskActivityMessage
  | TaskActivityHistoryMessage
  | TaskControlWire
  | StreamingChunkMessage
  | StreamingReasoningChunkMessage
  | TaskProgressMessage
  | TokenUsageMessage
  | CompactionResultMessage
  | SessionStateMessage
  | SystemMessage
  | ProfilesMessage
  | ProfileSwitchedMessage
  | ServerErrorMessage
  | CompletionsMessage
  | TranscriptReplyWire;

interface ChatConfig {
  token: string | null;
  host?: string;
  /** The #message-list element, handed out by the JSX tree via ref. */
  getMessageListContainer: () => HTMLElement | null;
  onSessionCreated?: (data: { sessionId: string; replayDelta?: boolean }) => void;
  onSessionsUpdate?: (sessions: SessionInfo[], activeSessionId: string | null) => void;
  onLogsUpdate?: (
    logs: Array<{ id: string; createdAt: number; lastActivityAt: number; messageCount: number; state?: string }>,
  ) => void;
  onLogViewed?: (logId: string, entries: LogEntry[]) => void;
  onLogDeleted?: (logId: string) => void;
  onAuthFailure?: () => void;
  onWorkingMapChange?: () => void;
}

export interface ChatController {
  connect: () => void;
  disconnect: () => void;
  sendMessage: (content: string, files?: UploadFileWire[], steer?: boolean) => void;
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
  requestCompletions: (
    line: string,
    cursorPos: number,
    onResult: (options: CompletionItem[], prefix: string) => void,
  ) => void;
  setSession: (sessionId: string, keepTranscript?: boolean) => void;
  listProfiles: () => void;
  switchProfile: (profileName: string) => void;
  // Push-to-talk: upload a base64 recording, await the transcript text.
  transcribe: (mimeType: string, data: string) => Promise<string>;
  sttEnabledAtom: Atom<boolean>;
  /** Tool-exec plane posture for the header strip ("" until the first attach). */
  toolExecAtom: Atom<string>;
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
  // Per-session working state for the sidebar indicators.
  sessionWorkingMap: Map<string, boolean>;
  messageListAtom: () => MessageListManager | null;
  getCurrentProfile: () => string;
  // Subagent strip/panels state (broadcast feed; not tied to the active session).
  tasksAtom: Atom<TaskInfoWire[]>;
  activityVersionAtom: Atom<number>;
  taskControlAtom: Atom<Record<string, { ok: boolean; text: string }>>;
  // Task controls: thin WS delegates onto the server's TaskManager primitives.
  interruptTask: (taskId: string) => void;
  taskFollowup: (taskId: string, message: string) => void;
  requestTaskActivity: (taskId: string) => void;
  getTaskActivity: (taskId: string) => TaskActivityBlock[];
  clearTasks: () => void;
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

  // ── Reconnect identity (session durability part 3) ─────────────────────
  // The session id survives page reloads; the replay cursor (full log length
  // at the last attach -- an append-only coordinate, stable across
  // compactions) only survives this socket generation. The cursor is sent
  // only when the transcript is clean (untouched since the last attach), so
  // the server's delta replay is exactly the tail: nothing cleared, nothing
  // duplicated.
  // sessionStorage, not localStorage: the key must be per-TAB. localStorage
  // is shared across tabs of one webui, and every tab writes its active
  // session on attach -- with localStorage, tab B's attach would retarget
  // tab A's next reconnect onto B's session. sessionStorage still survives
  // in-tab reloads (the reconnect case); a fresh tab takes the default attach.
  const SESSION_STORAGE_KEY = "hotdog-active-session";
  const storage: Storage | null =
    typeof window !== "undefined" && "sessionStorage" in window
      ? (window as unknown as { sessionStorage: Storage }).sessionStorage
      : null;
  let savedSessionId: string | null = null;
  try {
    savedSessionId = storage?.getItem(SESSION_STORAGE_KEY) ?? null;
  } catch {
    savedSessionId = null;
  }
  let attachCursor: number | null = null; // full log length at last attach
  let replayPending = false; // between sessionCreated and its cursor report
  let dirtySinceAttach = false; // live events arrived after the last attach

  function saveSessionId(id: string | null): void {
    savedSessionId = id;
    if (!storage) return;
    try {
      if (id) storage.setItem(SESSION_STORAGE_KEY, id);
      else storage.removeItem(SESSION_STORAGE_KEY);
    } catch {}
  }

  /** Build the connect URL: the remembered session (and, when clean, its
   *  replay cursor) ride the upgrade so both auth flows can use them. */
  function connectUrl(): string {
    // Match the page scheme: browsers block ws:// (mixed content) on https pages.
    const base = `${window.location.protocol === "https:" ? "wss" : "ws"}://${host}/ws`;
    if (!savedSessionId) return base;
    const params = new URLSearchParams();
    params.set("session", savedSessionId);
    if (attachCursor !== null && !dirtySinceAttach && !replayPending) {
      params.set("cursor", String(attachCursor));
    }
    return `${base}?${params.toString()}`;
  }

  // One in-flight completion request at a time: each new request supersedes
  // the previous, whose (now stale) response is dropped by id mismatch.
  let completionReqId = 0;
  let completionCallback:
    | ((options: CompletionItem[], prefix: string) => void)
    | null = null;

  // In-flight transcribe requests keyed by correlation id; the transcript
  // reply resolves/rejects the matching promise (see C2S.TRANSCRIBE).
  let transcribeSeq = 0;
  const pendingTranscripts = new Map<
    string,
    { resolve: (text: string) => void; reject: (err: Error) => void }
  >();

  function rejectPendingTranscripts(reason: string): void {
    for (const { reject } of pendingTranscripts.values()) reject(new Error(reason));
    pendingTranscripts.clear();
  }

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
        sttEnabledAtom(Boolean(data.sttEnabled));
        toolExecAtom(data.toolExec ?? "");
        // Reconnect identity: remember the session for the next reconnect.
        saveSessionId(data.sessionId);
        // The replay burst follows this message (up to the cursor report);
        // those events must not mark the transcript dirty. The attach either
        // replaces the transcript (full) or keeps it clean (delta) -- clean
        // either way.
        replayPending = true;
        attachCursor = null;
        dirtySinceAttach = false;
        // On page reload the server can send working state before
        // sessionCreated, so restore it from the map here.
        const createdSid = data.sessionId;
        if (sessionWorkingMap.has(createdSid)) {
          workingAtom(sessionWorkingMap.get(createdSid) ?? false);
        }
        onSessionCreated?.({ sessionId: data.sessionId, replayDelta: data.replayDelta === true });
        return;
      case "sessionDeleted":
        if (data.sessionId === sessionIdAtom()) {
          if (messageList) messageList.clear();
          sessionIdAtom(null);
          sessionTitleAtom(null);
          currentModelAtom("");
          // The remembered session is gone: the next reconnect takes the
          // default attach, not a dead id.
          saveSessionId(null);
          attachCursor = null;
          dirtySinceAttach = false;
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
      case "completions":
        if (data.requestId === completionReqId && completionCallback) {
          const cb = completionCallback;
          completionCallback = null;
          cb(data.options || [], typeof data.prefix === "string" ? data.prefix : "");
        }
        return;
      // Subagent feed is server-global (not per active session), so it is
      // handled before the message-list/session guards below.
      case "taskList":
        tasksAtom(data.tasks.slice());
        return;
      case "taskUpdate":
        upsertTask(data.task);
        return;
      case "taskActivity":
        appendTaskActivity(data.taskId, data.activity);
        return;
      case "taskActivityHistory":
        seedTaskActivity(data.taskId, data.activity || []);
        return;
      case "taskControl": {
        const ok = data.ok;
        const text = ok
          ? data.action === "interrupt" ? "Task cancelled" : "Steering sent"
          : data.error || "Task control failed";
        const next = { ...taskControlAtom() };
        next[data.taskId] = { ok, text };
        taskControlAtom(next);
        return;
      }
      case "transcript": {
        // Correlated by id only: the reply is not session-tagged.
        const pending = pendingTranscripts.get(data.id);
        if (!pending) return;
        pendingTranscripts.delete(data.id);
        if (data.ok) pending.resolve(data.text ?? "");
        else pending.reject(new Error(data.error || "transcription failed"));
        return;
      }
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

    // A transcript that grew after the attach's cursor report can no longer
    // be reconstructed as a delta, so the next reconnect falls back to a
    // full replay. Replay-burst events (replayPending) are exempt: they
    // arrive before the cursor report and are what it was measured for.
    if (!replayPending && CONVERSATION_EVENT_TYPES.has(data.type)) {
      dirtySinceAttach = true;
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
      case "systemMessage":
        messageList.handleSystemMessage(data);
        break;
      case "sessionState":
        if (data.key === "cursor") {
          // End of the attach's replay burst: the transcript ends exactly at
          // this full-log position, a valid delta cursor for the next
          // reconnect.
          attachCursor = Number(data.value);
          replayPending = false;
        }
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
      ws = new WebSocket(connectUrl());
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
      // Nobody will ever answer in-flight transcribes over a dead socket.
      rejectPendingTranscripts("connection closed");
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

  function sendMessage(content: string, files?: UploadFileWire[], steer = false): void {
    if (!sessionIdAtom()) {
      console.warn("[chat] No active session");
      return;
    }
    workingAtom(true);
    send({
      type: "send",
      sessionId: sessionIdAtom(),
      content,
      ...(files && files.length > 0 ? { files } : {}),
      ...(steer ? { steering: true } : {}),
    });
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

  function requestCompletions(
    line: string,
    cursorPos: number,
    onResult: (options: CompletionItem[], prefix: string) => void,
  ): void {
    if (!sessionIdAtom()) return;
    completionReqId++;
    completionCallback = onResult;
    send({
      type: "complete",
      sessionId: sessionIdAtom(),
      requestId: completionReqId,
      line,
      cursorPos,
    });
  }

  /**
   * Upload one recording (base64, no data: prefix) and await the transcript.
   * Rejects with the server's readable error on any failure (see S2C.TRANSCRIPT).
   */
  function transcribe(mimeType: string, data: string): Promise<string> {
    const id = `stt-${++transcribeSeq}`;
    const req: TranscribeRequestWire = { type: "transcribe", id, mimeType, data };
    return new Promise<string>((resolve, reject) => {
      pendingTranscripts.set(id, { resolve, reject });
      send(req);
    });
  }

  function setSession(sessionId: string, keepTranscript = false): void {
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
    // A delta replay only sends the tail the transcript does not already
    // hold (it ends exactly at the attach cursor): clearing would lose the
    // prefix. Full replays always clear first.
    if (!keepTranscript) messageList.clear();
  }

  function listProfiles(): void {
    send({ type: "listProfiles" });
  }

  function switchProfile(profileName: string): void {
    const sessionId = sessionIdAtom();
    if (!sessionId) {
      console.warn("[chat] No active session for profile switch");
      return;
    }
    send({ type: "switchProfile", sessionId, profileName });
  }

  // Subagent task controls: the server delegates to the TaskManager
  // primitives (interruptTask / sendFollowUp); outcomes arrive as taskControl.
  function interruptTask(taskId: string): void {
    if (!taskId) return;
    send({ type: "taskInterrupt", taskId });
  }

  function taskFollowup(taskId: string, message: string): void {
    const text = message.trim();
    if (!taskId || !text) return;
    send({ type: "taskFollowup", taskId, message: text });
  }

  // Ask for a task's buffered activity (panel opened after a refresh; the
  // live feed only covers events from connection time on). No-op while the
  // socket is down; the next open re-requests.
  function requestTaskActivity(taskId: string): void {
    if (!taskId) return;
    send({ type: "taskActivityRequest", taskId });
  }

  function getCurrentProfile(): string {
    return currentProfileAtom();
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
    requestCompletions,
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
    sessionWorkingMap,
    messageListAtom: () => messageList,
    sttEnabledAtom,
    toolExecAtom,
    transcribe,
    tasksAtom,
    activityVersionAtom,
    taskControlAtom,
    interruptTask,
    taskFollowup,
    requestTaskActivity,
    getTaskActivity,
    clearTasks,
  };
}
