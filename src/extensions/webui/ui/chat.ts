/// <reference lib="dom" />
// Chat view: WS client + message routing; atoms expose state to the JSX app.

import { reactiveState, Atom } from "./utils.ts";
import { createMessageList, MessageListManager } from "./message-list.ts";
import { loadHideThinking, saveHideThinking } from "./thinking-pref.ts";
import type { UiImage } from "./message-list.ts";
import type { CtxUsage } from "@utils/session-turns.ts";
import type { LogInfo, SessionInfo } from "./sessions.tsx";
import type {
  UploadFileWire,
  TaskInfoWire,
  TaskControlWire,
  TranscribeRequestWire,
  TranscriptReplyWire,
  SearchHitWire,
  ToolDisplayWire,
  ConfigEditPayload,
  ConfigListOp,
  ConfigSnapshotResultWire,
  SetConfigKeyResultWire,
  EditConfigListResultWire,
  ListDirResultWire,
  ReadFileResultWire,
  FileOpResultWire,
} from "@extensions/websocket/protocol.ts";

export type { UploadFileWire };
export type { TaskInfoWire };
export type { SearchHitWire };
export type { ConfigSnapshotResultWire };
export type { SetConfigKeyResultWire };
export type { ConfigListOp };
export type { EditConfigListResultWire };
export type { ListDirResultWire };
export type { ReadFileResultWire };
export type { FileOpResultWire };

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

// ── Subagent ticker (sidebar rows; see ./subagents.tsx) ───────────────────
// Broadcast feed (S2C taskList/taskUpdate), deliberately kept outside the
// App tree: tasksAtom alone feeds the sidebar rows. The transcript is a
// plain SESSION view since B4: a live worker row opens via switchSession,
// a settled/durable one via viewLog -- no second transcript surface, no
// relay buffer. The kind/parent atoms below are the chrome's only signal.
const tasksAtom = reactiveState<TaskInfoWire[]>([]);
// The ATTACHED view's kind ("subagent" on a worker-row attach; null for an
// interactive session) and its delegating manager, both from the
// sessionCreated payload (B3's additive fields). Every attach rewrites them;
// the app reads them for the header label, the chrome hide-outs, the steer
// posture, and the leave affordance.
const sessionKindAtom = reactiveState<string | null>(null);
const sessionParentAtom = reactiveState<string | null>(null);

function upsertTask(info: TaskInfoWire): void {
  const tasks = tasksAtom().slice();
  const i = tasks.findIndex((t) => t.taskId === info.taskId);
  if (i >= 0) tasks[i] = info;
  else tasks.push(info);
  tasksAtom(tasks);
}

/** Drop the ticker: the module-global feed must not outlive the socket. */
function clearTasks(): void {
  tasksAtom([]);
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

// Stand-in manager while the cold-log browse mode is on: every live-session
// transcript write is dropped. The socket stays attached to its live session,
// and live events must not append beneath the browsed window (see
// viewedLogId in createChat). Explicit (not a Proxy) so the compiler catches
// any MessageListManager method added without a no-op here.
const LOG_VIEW_SINK: MessageListManager = {
  handleUserMessage: () => {},
  handleAssistantMessage: () => {},
  handleStreamingChunk: () => {},
  handleStreamingReasoningChunk: () => {},
  handleStreamingToolCall: () => {},
  setRequestPending: () => {},
  handleStreamReset: () => {},
  handleThinking: () => {},
  handleToolCall: () => {},
  handleToolResult: () => {},
  handleCompacting: () => {},
  handleCommandResult: () => {},
  handleQuestion: () => {},
  setQuestionReadOnly: () => {},
  handleQuestionAnswered: () => {},
  handleTaskProgress: () => {},
  handleTokenUsage: () => {},
  handleCompactionResult: () => {},
  handleSessionState: () => {},
  setHideThinking: () => {},
  handleError: () => {},
  finalizeAssistant: () => {},
  noteWorking: () => {},
  clear: () => {},
  addSystemMessage: () => {},
  handleSystemMessage: () => {},
  destroy: () => {},
  renderLogEntries: () => {},
  renderOlderEntries: () => {},
  setHasOlder: () => {},
};

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
  /** Lazy history (full replay only, see attach.ts): the replay shipped the
   *  trailing window of conversation messages; older history lives below
   *  `oldestIndex` (an epoch-log index -- hand it to loadOlder) inside the
   *  epoch attested by `epochToken` (echo it back; the server refuses a
   *  moved epoch with code "epoch_moved" rather than paging garbage).
   *  Absent = the transcript holds everything the log attests. */
  hasOlder?: boolean;
  oldestIndex?: number;
  epochToken?: number;
  /** View kind (additive, B3): "subagent" on a worker-row attach; the
   *  delegating manager's id rides beside it. Drives the webui chrome. */
  kind?: string;
  parentSessionId?: string | null;
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
    /** Live-row record count from the session-log writer (same rule the cold
     *  LOGS_LISTED rows use); omitted when the server cannot attest it. */
    messageCount?: number;
    /** Last token_usage snapshot cached server-side (sidebar ctx segment). */
    ctxUsed?: number;
    ctxTotal?: number;
    /** Server-persisted pin flag (pin-store.ts); the client's pin marks
     *  hydrate from these. */
    pinned?: boolean;
    /** Absolute JSONL log path; omitted when the server withheld it. */
    logPath?: string;
  }>;
}

interface LogsListedMessage {
  type: "logsListed";
  logs: LogInfo[];
}

interface SearchResultsMessage {
  type: "searchResults";
  /** Echo of the C2S searchLogs request id; stale replies are dropped client-side. */
  requestId?: number;
  query: string;
  results: SearchHitWire[];
}

// Image payload type (UiImage) is defined in message-list.ts; the server
// sends it via wireImages (../websocket/protocol.ts): base64 without data:
// prefix; oversized images arrive as { skipped, note } instead of data.

interface LogEntry {
  source: string;
  /** Entry timestamp (ISO) as stored in the log; legacy entries may lack it. */
  ts?: string;
  content: string;
  images?: UiImage[];
  reasoning_content?: string | null;
  /** Each tool_call may carry the registry-resolved display parts the server
   *  annotated onto the raw entry (additive field; same ToolDisplayWire shape
   *  the live TOOL_CALL frame sends). */
  tool_calls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    display?: ToolDisplayWire[];
  }> | null;
  tool_call_id?: string | null;
}

interface LogViewedMessage {
  type: "logViewed";
  logId: string;
  entries: LogEntry[];
  /** Lazy history (see handlers-logs.ts handleViewLog): present ONLY when
   *  older history exists -- oldestIndex is the epoch-log index of the
   *  oldest shipped entry (loadOlder's `olderThan`), epochToken the epoch
   *  those indexes live in (loadOlder's staleness echo). */
  hasOlder?: boolean;
  oldestIndex?: number;
  epochToken?: number;
}

/**
 * Reply to C2S loadOlder (correlated by requestId, the searchLogs
 * precedent). Refusals carry requestId + error only (LIST_DIR_RESULT
 * posture); the client frees its in-flight slot and lets the next
 * scroll-up edge retry -- no invented retry loop. The stale-epoch class
 * (code "epoch_moved": a mid-socket /rewind, /undo, or /clear re-pointed
 * the log) is NOT retryable on the held index -- it CLOSES the seam until the
 * next attach/navigation re-attests the window.
 */
interface LoadOlderResultMessage {
  type: "loadOlderResult";
  requestId?: number;
  logId?: string;
  entries?: LogEntry[];
  oldestIndex?: number;
  hasOlder?: boolean;
  epochToken?: number;
  code?: string;
  error?: string;
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
  /** Replay-only (see s2cAssistantMessage in ../websocket/wire-messages.ts):
   *  completion ts (epoch ms), the bracketing turn's duration, and the ctx
   *  usage attested at this message's commit, all from the session log.
   *  Absent when the source attests neither. */
  ts?: number;
  durationMs?: number;
  ctx?: CtxUsage;
}

interface ThinkingMessage {
  type: "thinking";
  content: string;
}

interface ToolCallMessage {
  type: "toolCall";
  name: string;
  args: string;
  /** Server-computed hint-driven fold (see ToolBlockState.argsSummary). */
  argsSummary?: string;
  /** Declared display parts forwarded as declared (see ToolDisplayWire). */
  display?: ToolDisplayWire[];
  toolCallId?: string;
}

interface ToolResultMessage {
  type: "toolResult";
  name: string;
  output?: string;
  error?: string;
  images?: UiImage[];
  toolCallId?: string;
  /** Where the edit landed (server-extracted from the result's meta);
   *  numbers the diff gutters with real file lines. */
  startLine?: number;
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

interface StreamingChunkMessage {
  type: "streamingChunk";
  content: string;
}

interface StreamingReasoningChunkMessage {
  type: "streamingReasoningChunk";
  content: string;
}

/**
 * Live-only in-flight tool call (S2C streamingToolCall, built by
 * s2cStreamingToolCall): the wire's tool-call slot `index` plus the name and
 * the ACCUMULATED argument text so far, so every frame replaces the client's
 * preview. Deliberately NOT in CONVERSATION_EVENT_TYPES: it is transient
 * render state that appends nothing to the transcript (the committed `toolCall`
 * frame is the durable row, and it marks the cursor dirty itself), and it is
 * never replayed -- a client that joins mid-stream just waits for the next
 * delta.
 */
interface StreamingToolCallMessage {
  type: "streamingToolCall";
  sessionId: string;
  index: number;
  name: string;
  args: string;
}

/**
 * Mid-stream provider-failure retry (S2C streamReset): the in-flight
 * assistant text/thinking accumulation must be dropped before the retry's
 * deltas arrive. Carries no payload beyond sessionId. Deliberately NOT in
 * CONVERSATION_EVENT_TYPES: it discards live-only render state and appends
 * nothing to the session transcript, so it must not dirty the replay cursor.
 */
interface StreamResetMessage {
  type: "streamReset";
}

interface TaskProgressMessage {
  type: "taskProgress";
  taskId: string;
  status: string;
  message?: string;
}

/**
 * TOKEN_USAGE frame (s2cTokenUsage): per-call numbers plus the additive
 * gauge pair ctxUsed/ctxTotal. No transcript bubble anymore -- message-list
 * folds the numbers into the footer's ctx segment.
 */
interface TokenUsageMessage {
  type: "tokenUsage";
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow?: number;
  ctxUsed?: number;
  ctxTotal?: number;
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
  | LoadOlderResultMessage
  | SearchResultsMessage
  | ConfigSnapshotResultWire
  | SetConfigKeyResultWire
  | EditConfigListResultWire
  | ListDirResultWire
  | ReadFileResultWire
  | FileOpResultWire
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
  | TaskControlWire
  | StreamingChunkMessage
  | StreamingReasoningChunkMessage
  | StreamingToolCallMessage
  | StreamResetMessage
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
  /** Host for the jump-to-bottom button (the #input-area seam). Resolved
   *  once, when setSession first builds the manager. */
  getJumpHost?: () => HTMLElement | null;
  onSessionCreated?: (data: { sessionId: string; replayDelta?: boolean }) => void;
  onSessionsUpdate?: (sessions: SessionInfo[], activeSessionId: string | null) => void;
  onLogsUpdate?: (logs: LogInfo[]) => void;
  onLogViewed?: (logId: string, entries: LogEntry[]) => void;
  onLogDeleted?: (logId: string) => void;
  /** Reply to searchLogs; the app drops it when the request id is stale. */
  onSearchResults?: (requestId: number | undefined, query: string, results: SearchHitWire[]) => void;
  /** Reply to configSnapshot (settings viewer); the app drops it when the
   *  request id is stale (same doctrine as onSearchResults). */
  onConfigSnapshot?: (requestId: number | undefined, snapshot: ConfigSnapshotResultWire) => void;
  /** Reply to setConfigKey (settings editor); the app drops it when the
   *  write-request id is stale (the save sequence is its own counter, so a
   *  snapshot refresh cannot collide with it). */
  onSetConfigKey?: (requestId: number | undefined, result: SetConfigKeyResultWire) => void;
  /** Reply to editConfigList (provider add/remove); the app drops it when
   *  the list-request id is stale (its own sequence, same doctrine). */
  onEditConfigList?: (requestId: number | undefined, result: EditConfigListResultWire) => void;
  /** Reply to listDir (workbench file tree); the tree state drops stale ids
   *  by its own pending map (the settings-viewer precedent). */
  onListDir?: (requestId: number | undefined, result: ListDirResultWire) => void;
  /** Reply to readFile (workbench file viewer); same stale-drop doctrine. */
  onReadFile?: (requestId: number | undefined, result: ReadFileResultWire) => void;
  /** Reply to the write family (createFile/createDir/renamePath/deletePath/
   *  saveFile); one envelope, the request id names the op. The app matches
   *  replies against its own op sequence (the settings-editor precedent). */
  onFileOp?: (requestId: number | undefined, result: FileOpResultWire) => void;
  /** Broadcast notice that a session died (the app drops its stale pin). */
  onSessionDeleted?: (sessionId: string) => void;
  onAuthFailure?: () => void;
  onWorkingMapChange?: () => void;
  /** The server's error frame landed (case "error"). Fired BEFORE the working
   *  flip so the app's aria-live off-edge can read the terminal signal and
   *  say "Run failed" instead of claiming a completion (the doctrine of
   *  message-list.ts handleError: an errored turn is neither completed nor
   *  stopped). UI-layer notice only -- the frame itself is untouched. */
  onRunError?: () => void;
  /** Requester-only taskControl reply landed (steer/interrupt outcome).
   *  The app toasts refusals; acceptances need no notice (the change rides
   *  taskUpdate, and a live steer's echo rides the worker's own stream). */
  onTaskControl?: (r: TaskControlWire) => void;
}

export interface ChatController {
  connect: () => void;
  disconnect: () => void;
  sendMessage: (content: string, files?: UploadFileWire[], steer?: boolean) => void;
  sendSlashCommand: (command: string) => void;
  cancel: () => void;
  /** Flip the attached session's exec-fence policy (header strip toggle). */
  setExecFencePolicy: (policy: "off" | "probe") => void;
  createSession: (opts?: Record<string, unknown>) => void;
  switchSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  /** Tear down an idle live session; the log survives and the row demotes to Recent Logs. */
  dismissSession: (sessionId: string) => void;
  renameSession: (sessionId: string, newName: string) => void;
  /** Flip a row's server-persisted pin (id may name a live session or a cold log). */
  setPinned: (sessionId: string, pinned: boolean) => void;
  listSessions: () => void;
  listLogs: () => void;
  loadLog: (logId: string) => void;
  viewLog: (logId: string) => void;
  deleteLog: (logId: string) => void;
  /** Full-text search across all session logs; results arrive via onSearchResults. */
  searchLogs: (query: string, requestId: number) => void;
  /** Ask for a config snapshot (settings viewer); arrives via onConfigSnapshot. */
  requestConfigSnapshot: (requestId: number) => void;
  /** Persist one config value (settings editor; ALL the settings): scalars
   *  ride { value }, JSON containers and writeOnly secret replaces ride
   *  { valueText }. Arrives via onSetConfigKey with the same id. The server
   *  revalidates and says needsRestart -- the client never claims live effect. */
  setConfigKey: (requestId: number, keyPath: string, payload: ConfigEditPayload) => void;
  /** Append/remove through the additive editConfigList pair (array-of-
   *  primitives AND providers alike). `append` targets the array path:
   *  a primitive list carries the typed `value`, providers carry `name` (their
   *  elements are objects). `remove` targets "<array>[<index>]" -- the index
   *  rides IN the keyPath (the optional `index` echo, when set, must agree).
   *  Arrives via onEditConfigList with the same id; the reply carries no
   *  value echo (the rows refresh from a re-read snapshot, never from this). */
  editConfigList: (
    requestId: number,
    keyPath: string,
    op: ConfigListOp,
    name?: string,
    index?: number,
    value?: string | number | boolean,
  ) => void;
  /** List a workspace dir (workbench tree); arrives via onListDir. No path = the roots. */
  listDir: (requestId: number, path?: string) => void;
  /** Read a line-window page of a text file (workbench viewer); arrives via onReadFile. */
  readFile: (requestId: number, path: string, offset?: number, limit?: number) => void;
  /** Create an EMPTY file (no clobber, no invented parents); arrives via onFileOp. */
  createFile: (requestId: number, path: string) => void;
  /** Create a directory (no clobber, no invented parents); arrives via onFileOp. */
  createDir: (requestId: number, path: string) => void;
  /** Rename/move within the workspace (both sides resolveSafe'd, no clobber);
   *  arrives via onFileOp. */
  renamePath: (requestId: number, oldPath: string, newPath: string) => void;
  /** Delete a file/symlink/dir (dirs recursively -- the UI confirms first);
   *  arrives via onFileOp. */
  deletePath: (requestId: number, path: string) => void;
  /** Write a text file atomically (workbench save seam). `baseMtimeMs` is the
   *  readFile stamp the buffer was built from; a mismatch answers
   *  conflict:true on onFileOp and writes nothing. Omit/0 for a create. */
  saveFile: (requestId: number, path: string, content: string, baseMtimeMs?: number) => void;
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
  /**
   * Reasoning visibility: the per-browser view preference behind the header
   * chip (thinking-pref.ts). Independent of the CLI's /thinking session state.
   */
  hideThinkingAtom: Atom<boolean>;
  /** Flip the preference, persist it, and repaint both transcript sinks. */
  toggleHideThinking: () => void;
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
  // Subagent ticker (broadcast feed; not tied to the active session):
  // tasksAtom drives the per-manager sidebar rows. The transcript is a plain
  // session view (open = switchSession / viewLog), so what the pane needs is
  // the ATTACHED view's kind -- "subagent" on a worker-row attach -- and its
  // delegating manager (the leave affordance's landing), both from the
  // sessionCreated payload.
  tasksAtom: Atom<TaskInfoWire[]>;
  sessionKindAtom: Atom<string | null>;
  sessionParentAtom: Atom<string | null>;
  /** Steer the worker task whose session is on screen (C2S taskFollowup --
   *  the existing, validated steering route onto TaskManager.sendFollowUp).
   *  Text-only on the wire; NO client echo: the drained steer re-enters the
   *  worker's stream as its USER_MESSAGE event and reaches the watcher
   *  through the session grammar exactly once. Refusals land via the
   *  requester-only taskControl reply (the app toasts). */
  taskFollowup: (taskId: string, message: string) => void;
  /**
   * Stop/cancel a task (C2S taskInterrupt, the task_interrupt tool's own
   * primitive). Its real semantics are TERMINAL, not turn-only: a queued or
   * parked-idle task goes straight to cancelled, and a running one aborts the
   * in-flight turn -- which finalizes the TASK as cancelled, because the
   * entry's AbortController spans the task, not one turn
   * (TaskManager#interruptEntry -> TaskExecution.finalizeTurn). The composer's
   * Stop therefore rides the same primitive as the row menu's "Cancel
   * subagent"; a session's Stop (turn-only, run stays steerable) has no task
   * equivalent on the wire. The authoritative change rides the taskUpdate
   * broadcast; a refusal lands as the taskControl reply.
   */
  interruptTask: (taskId: string) => void;
  clearTasks: () => void;
}

export function createChat({
  token,
  host = window.location.host,
  getMessageListContainer,
  getJumpHost,
  onSessionCreated,
  onSessionsUpdate,
  onLogsUpdate,
  onLogViewed,
  onLogDeleted,
  onSearchResults,
  onConfigSnapshot,
  onSetConfigKey,
  onEditConfigList,
  onListDir,
  onReadFile,
  onFileOp,
  onSessionDeleted,
  onAuthFailure,
  onWorkingMapChange,
  onRunError,
  onTaskControl,
}: ChatConfig): ChatController {
  let ws: WebSocket | null = null;
  let messageList: MessageListManager | null = null;
  // R3 read-only intent, held across manager (re)construction: a worker
  // attach landing before the app builds the manager must still land
  // read-only on the manager it builds.
  let questionReadOnlyWanted = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let authFailed = false;

  const sessionIdAtom = reactiveState<string | null>(null);
  const currentModelAtom = reactiveState<string>("");
  const modelsAtom = reactiveState<string[]>([]);
  const connectedAtom = reactiveState<boolean>(false);
  const workingAtom = reactiveState<boolean>(false);

  // Per-session working state; kept across switches so the sidebar stays accurate.
  const sessionWorkingMap = new Map<string, boolean>();

  // ── Reasoning visibility (per-browser view preference) ───────────────────
  // Owner ruling 2026-11-05: whether reasoning shows is THIS browser's view
  // setting (localStorage via thinking-pref.ts, survives reload), applied to
  // whatever transcript is on screen -- the live one or a browsed cold log.
  // The server's /thinking session state (agent.hideThinking, broadcast on the
  // sessionState channel) stays independent: see the sessionState case in
  // handleMessage, which deliberately drops that key.
  const hideThinkingAtom = reactiveState<boolean>(loadHideThinking());

  /**
   * Push the preference into every transcript sink. The live list is the one
   * that paints -- a cold log renders into it too (app.tsx onLogViewed calls
   * messageList.renderLogEntries), so one sweep covers both views; the call on
   * LOG_VIEW_SINK exists so the manager stays the single seam (that stand-in
   * swallows everything, including this).
   */
  function applyHideThinking(hide: boolean): void {
    messageList?.setHideThinking(hide);
    LOG_VIEW_SINK.setHideThinking(hide);
  }

  /**
   * Header-chip driver: flip -> persist -> repaint now -> relabel the chip.
   * Persisting before the repaint means a reload lands on the new view even if
   * the tab dies right after the click; a blocked localStorage is swallowed in
   * the store and still repaints this page.
   */
  function toggleHideThinking(): void {
    const hide = !hideThinkingAtom();
    saveHideThinking(hide);
    applyHideThinking(hide);
    hideThinkingAtom(hide);
  }

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

  // Log-view mode: the cold log on screen, or null in live mode. The socket
  // stays attached to its live session while a log is browsed (viewLog only
  // reads entries; it never detaches), so live transcript events keep
  // arriving and must not append into the log window (LOG_VIEW_SINK). The
  // cursor bookkeeping is deliberately untouched for suppressed events --
  // they rendered nowhere, so the transcript the attach cursor describes is
  // still exactly replayable, and the next delta attach re-delivers the
  // suppressed tail once (no duplicates, no gaps).
  let viewedLogId: string | null = null;

  // Lazy history window (see websocket/history-window.ts): the id of the
  // transcript currently on screen whose head the server attested as
  // non-durable (a cold log id OR the live session id), the epoch-log index
  // of its oldest shipped entry, and the epochToken those indexes live in
  // (the full-log epochStartIndex at attestation time -- echoed on every
  // loadOlder; a mid-socket RESET moves the epoch, and the server's
  // "epoch_moved" refusal then closes this seam rather than paging a stale
  // index). null = the transcript holds everything. Lives in this closure
  // like the replay cursor: it survives reconnects (a delta keeps the held
  // window head honest) and dies with a page reload, where the next full
  // replay re-attests it from the fields on its own sessionCreated /
  // logViewed frames.
  let historyWindow: { id: string; oldestIndex: number; epochToken: number | null } | null = null;
  // One older page in flight per pane (the once-per-gap guard: scroll events
  // fire continuously; the server round-trip is the pacing). No retry loop:
  // a refusal frees the slot and the next scroll-up edge is the retry, and
  // reconnect re-attests the window (the existing doctrine).
  let olderReqSeq = 0;
  let olderInFlight: number | null = null;

  // Browse modes are mutually exclusive: a log on screen ends the subagent
  // session view (the viewed worker's stream stops painting into the log
  // window), and opening a subagent ends the log view (chat-side now; the
  // app clears its activeLogId mirror in the same click handler).

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
        // An attach (switch-back, resume, or reconnect) replaces the visible
        // context; log view ends with it (app.onSessionCreated clears its
        // mirror of this state). The view's KIND rides the payload: a
        // worker-row attach IS the subagent view (the session surface IS the
        // pane), so the chrome and the question surface follow from here.
        viewedLogId = null;
        const viewKind = data.kind === "subagent" ? "subagent" : null;
        sessionKindAtom(viewKind);
        sessionParentAtom(typeof data.parentSessionId === "string" ? data.parentSessionId : null);
        // R3: a watcher sees a worker's question but can never answer it --
        // the card renders read-only, awaiting the delegating manager. The
        // flag also lands on the manager the app's onSessionCreated callback
        // builds AFTER this frame (setSession below re-applies it), so the
        // order of the two never hands a worker an interactive card.
        questionReadOnlyWanted = viewKind === "subagent";
        messageList?.setQuestionReadOnly(questionReadOnlyWanted);
        // On page reload the server can send working state before
        // sessionCreated, so restore it from the map here. The chat-log tell
        // needs no restore of its own: the attach burst ends by re-posting
        // this session's working value (attach.ts), which noteWorking sees
        // once setSession below has built the manager -- and it re-derives
        // the row from what the view holds UNCOMMITTED (the running call's
        // flushed partial, if any; committed rows are earlier calls).
        const createdSid = data.sessionId;
        if (sessionWorkingMap.has(createdSid)) {
          workingAtom(sessionWorkingMap.get(createdSid) ?? false);
        }
        onSessionCreated?.({ sessionId: data.sessionId, replayDelta: data.replayDelta === true });
        // Lazy history: a windowed FULL replay says so on its own frame; a
        // delta for the SAME session keeps the window head the transcript
        // still holds (its oldest entry is unchanged); any other attach
        // starts with nothing older until its frames attest otherwise.
        // AFTER onSessionCreated because that call builds/clears the
        // manager the flag lands on.
        if (data.replayDelta === true && historyWindow && historyWindow.id === createdSid) {
          // keep as-is
        } else if (data.hasOlder === true && typeof data.oldestIndex === "number") {
          historyWindow = {
            id: createdSid,
            oldestIndex: data.oldestIndex,
            epochToken: typeof data.epochToken === "number" ? data.epochToken : null,
          };
        } else {
          historyWindow = null;
        }
        olderInFlight = null;
        messageList?.setHasOlder(historyWindow !== null);
        return;
      case "sessionDeleted":
        // Any tab's delete lands here: the app drops the dead row's stale
        // pin mark (the server store is already pruned by the handler).
        onSessionDeleted?.(data.sessionId);
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
          // The confirm bubble is a transcript write; it stays out of the
          // log window while one is open (atoms still update either way).
          if (viewedLogId === null) messageList?.addSystemMessage(switched);
        }
        return;
      case "logsListed":
        onLogsUpdate?.(data.logs);
        return;
      case "logViewed":
        // Enter log-view mode: from here, live-session transcript events are
        // dropped (LOG_VIEW_SINK) until the next attach or the log's death.
        // A subagent transcript on screen ends here too -- the viewed
        // worker's stream must not keep painting into the log window
        // (browse modes are exclusive).
        viewedLogId = data.logId;
        onLogViewed?.(data.logId, data.entries);
        // Lazy history (after the app clear+render, which resets the
        // manager's trigger state): the window head and its epoch token are
        // the server's, not a client guess.
        historyWindow =
          data.hasOlder === true && typeof data.oldestIndex === "number"
            ? {
                id: data.logId,
                oldestIndex: data.oldestIndex,
                epochToken: typeof data.epochToken === "number" ? data.epochToken : null,
              }
            : null;
        olderInFlight = null;
        messageList?.setHasOlder(historyWindow !== null);
        return;
      case "loadOlderResult": {
        // Older-page reply, correlated by requestId (the searchLogs
        // doctrine). Stale/duplicate ids drop; a page for a transcript the
        // pane left mid-flight drops by id too. Prepend happens through the
        // manager's anchoring seam (renderOlderEntries) -- never through the
        // live-event sink, and never dirties the replay cursor (the tail the
        // cursor describes is untouched).
        if (data.requestId !== olderInFlight) return;
        olderInFlight = null;
        const held = historyWindow;
        if (!held || (typeof data.logId === "string" && data.logId !== held.id)) return;
        if (data.error !== undefined || !Array.isArray(data.entries)) {
          if (data.code === "epoch_moved") {
            // The epoch moved under the held window (a mid-socket /rewind,
            // /undo, or /clear appended a RESET without any attach): the
            // held index means a DIFFERENT entry now. Never re-hit it --
            // close the seam; the next attach/navigation re-attests.
            logger.warn("[chat] loadOlder epoch moved; seam closed:", data.error);
            historyWindow = null;
            messageList?.setHasOlder(false);
            return;
          }
          // Honest refusal (bad index / dead log): the window stands, the
          // in-flight slot is free, and the next scroll-up edge retries.
          logger.warn("[chat] loadOlder refused:", data.error ?? "malformed reply");
          return;
        }
        if (data.entries.length > 0) messageList?.renderOlderEntries(data.entries);
        historyWindow =
          data.hasOlder === true && typeof data.oldestIndex === "number"
            ? {
                id: held.id,
                oldestIndex: data.oldestIndex,
                epochToken: typeof data.epochToken === "number" ? data.epochToken : held.epochToken,
              }
            : null;
        messageList?.setHasOlder(historyWindow !== null);
        return;
      }
      case "logDeleted":
        if (data.logId === viewedLogId) viewedLogId = null;
        onLogDeleted?.(data.logId);
        return;
      case "searchResults":
        // Not session-scoped (a whole-dir scan); correlated purely by the
        // request id the app echoes back. No transcript side effects.
        onSearchResults?.(data.requestId, data.query, data.results);
        return;
      case "configSnapshotResult":
        // The settings viewer's snapshot reply (not session-scoped); the app
        // drops stale ids. No transcript side effects.
        onConfigSnapshot?.(data.requestId, data);
        return;
      case "setConfigKeyResult":
        // The settings editor's write reply (not session-scoped); the app
        // drops stale ids against its own save sequence. No transcript side
        // effects -- rejections ride the payload's error field, correlated.
        onSetConfigKey?.(data.requestId, data);
        return;
      case "editConfigListResult":
        // The provider add/remove reply (not session-scoped); the app drops
        // stale ids against its own list sequence. No transcript side
        // effects -- rejections ride the payload's error field, correlated.
        onEditConfigList?.(data.requestId, data);
        return;
      case "listDirResult":
        // The workbench file tree's listing reply (not session-scoped); the
        // tree state drops stale ids by its pending map. No transcript side
        // effects -- rejections ride the payload's error field, correlated.
        onListDir?.(data.requestId, data);
        return;
      case "readFileResult":
        // The workbench file viewer's page reply; same doctrine.
        onReadFile?.(data.requestId, data);
        return;
      case "fileOpResult":
        // The write family's reply (create/rename/delete/save); the app
        // matches it by its own op id. No transcript side effects --
        // rejections ride the payload's error field, correlated.
        onFileOp?.(data.requestId, data);
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
      // handled before the message-list/session guards below. The viewed
      // task's deltas additionally ride straight into the main transcript's
      // MessageListManager (imperative DOM path -- no App repaint, see the
      // feed state block above).
      case "taskList":
        tasksAtom(data.tasks.slice());
        return;
      case "taskUpdate":
        upsertTask(data.task);
        return;
      case "taskControl": {
        // Requester-only reply to our taskFollowup/taskInterrupt. A refusal
        // must not pass silently: it lands as the app's honest toast. The
        // buffer retract dance is gone with the relay -- a refused steer
        // never entered the worker's context and the transcript never painted
        // it, so there is nothing to take back. "Stop" is the composer's own
        // word for the interrupt action (the sidebar row's "Cancel subagent"
        // rides the same taskInterrupt, so one wording covers both).
        onTaskControl?.(data);
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
    // Cold-log browse suppression is exempt too: the events rendered
    // nowhere, so the cursor still describes the live transcript exactly,
    // and the next delta attach re-delivers the suppressed tail once (no
    // duplicates, no gaps). The sidebar spinner (sessionState/working) and
    // the header atoms keep flowing while suppressed -- only transcript
    // rendering stops.
    const browseViewActive = viewedLogId !== null;
    if (!replayPending && !browseViewActive && CONVERSATION_EVENT_TYPES.has(data.type)) {
      dirtySinceAttach = true;
    }
    // Transcript writes go to the sink while a cold log is on screen. The
    // remaining work in the cases below (working/title/cursor atoms, the
    // error's optimistic working flip) is live-session state, not the
    // visible transcript, and runs either way.
    const list = browseViewActive ? LOG_VIEW_SINK : messageList;

    switch (data.type) {
      case "userMessage":
        list.handleUserMessage(data);
        break;
      case "assistantMessage":
        list.handleAssistantMessage(data);
        break;
      case "thinking":
        list.handleThinking(data);
        break;
      case "toolCall":
        list.handleToolCall(data);
        break;
      case "toolResult":
        list.handleToolResult(data);
        break;
      case "compacting":
        list.handleCompacting(data);
        break;
      case "commandResult":
        list.handleCommandResult(data);
        break;
      case "question":
        list.handleQuestion(data);
        break;
      case "questionAnswered":
        if (!data.sessionId || data.sessionId === sessionIdAtom()) {
          list.handleQuestionAnswered(data);
        }
        break;
      case "streamingChunk":
        list.handleStreamingChunk(data);
        break;
      case "streamingReasoningChunk":
        list.handleStreamingReasoningChunk(data);
        break;
      case "streamingToolCall":
        // Live in-flight tool preview: dropped by the browse-mode sink like
        // every other live-session transcript write.
        list.handleStreamingToolCall(data);
        break;
      case "streamReset":
        // Drop the dead attempt's in-flight text/thinking before the
        // retry's deltas stream in (see message-list.handleStreamReset).
        list.handleStreamReset();
        break;
      case "taskProgress":
        list.handleTaskProgress(data);
        break;
      case "tokenUsage":
        list.handleTokenUsage(data);
        break;
      case "compactionResult":
        list.handleCompactionResult(data);
        break;
      case "systemMessage":
        list.handleSystemMessage(data);
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
              // Turn boundary for the message footer: false commits the
              // in-flight row with its timestamp/duration footer (message-list
              // owns the turn clock; other sessions' flips never touch it).
              list.noteWorking(Boolean(data.value));
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
        if (data.key === "sttEnabled") {
          // The mic affordance follows the server's live STT target: the
          // sessionCreated payload seeds it, and a sttUrl/sttModel write pushes
          // the flip here (the flag is server-wide, so every panel takes it --
          // unlike toolExec there is no per-session variant to re-target).
          sttEnabledAtom(Boolean(data.value));
        }
        if (data.key === "toolExec") {
          // Per-session posture push after a webui fence flip. sessionState
          // is delivered cross-session (sidebar working indicators), so
          // rebind explicitly: only the client attached to the pushed
          // session repaints its header strip.
          const pushSid = (data as { sessionId?: string }).sessionId;
          if (pushSid && pushSid === sessionIdAtom()) {
            toolExecAtom(typeof data.value === "string" ? data.value : "");
          }
        }
        // hideThinking is deliberately NOT forwarded: reasoning visibility is
        // this browser's view preference (owner ruling 2026-11-05), so a CLI
        // /thinking toggle must not repaint the webui transcript. The CLI's own
        // notice still arrives as a commandResult row, and message-list's
        // hideThinking engine (handleSessionState/setHideThinking) is intact --
        // the header chip drives it now, not the server.
        if (data.key !== "hideThinking") list.handleSessionState(data);
        break;
      case "error":
        // Terminal marker first, flip second: the working-effect that rides
        // the flip must see WHY the turn ended (aria-live, see app.tsx).
        onRunError?.();
        workingAtom(false);
        list.handleError(data);
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
    // The Thinking row answers the click, not the round trip (the wire's
    // working frame re-attests the same posture when it lands).
    messageList?.setRequestPending(true);
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
    // ...and the chat-log tell with it, on the same click (the Stop edge; the
    // wire's working:false frame that follows is a no-op here).
    messageList?.setRequestPending(false);
  }

  /**
   * Flip the ATTACHED session's runtime exec-fence policy (the header strip's
   * toggle). Deliberately NOT optimistic like cancel(): the strip repaints
   * only from the server's sessionState(key:"toolExec") push, so a refused
   * toggle (inline plane, dead session) can never leave a lying posture.
   */
  function setExecFencePolicy(policy: "off" | "probe"): void {
    if (!sessionIdAtom()) return;
    send({ type: "execFence", sessionId: sessionIdAtom(), policy });
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

  // Dismiss: idle-only teardown whose log and pin survive (server-side
  // handleDismissSession). No follow-up list unlike deleteSession -- the
  // handler's SESSIONS/LOGS_LISTED broadcast is the reconcile and covers
  // both sidebar halves, so a re-list here would only race it.
  function dismissSession(sessionId: string): void {
    send({ type: "dismissSession", sessionId });
    sessionWorkingMap.delete(sessionId);
  }

  function renameSession(sessionId: string, newName: string): void {
    send({ type: "renameSession", sessionId, newName });
    listSessions();
  }

  // Server-side pin flip (pin-store.ts). Deliberately no follow-up list:
  // the handler's SESSIONS/LOGS_LISTED broadcast is the reconcile, and it
  // covers the cold half too -- a re-list here would race it needlessly.
  function setPinned(sessionId: string, pinned: boolean): void {
    send({ type: "setPinned", sessionId, pinned });
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
      // Seed from this browser's preference: a fresh list (first attach, or a
      // list rebuilt by a later app boot) starts in the state the user left it.
      hideThinking: hideThinkingAtom(),
      onQuestionAnswer: (answers) => sendQuestionAnswer(answers),
      // Lazy history: scrolling near the top pages older entries through the
      // loadOlder seam (see requestOlderHistory + message-list's TOP_TRIGGER_PX).
      onNearTop: () => requestOlderHistory(),
      // Jump-to-bottom rides the composer seam (#input-area, via ref); the
      // manager hides it while the view follows the bottom. No host: no button.
      jumpHost: getJumpHost?.() ?? undefined,
    });
    // The R3 read-only intent survives this construction (the worker attach
    // may have landed before the manager existed).
    messageList.setQuestionReadOnly(questionReadOnlyWanted);
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

  /**
   * Steer the worker task whose session is on screen through the EXISTING
   * validated route (C2S taskFollowup -> handleTaskFollowup ->
   * TaskManager.sendFollowUp: running task with a live turn, or the
   * follow-up is eaten as a pending question's answer). No client echo and
   * no pending-echo ledger: the drained steer rides the worker's own
   * USER_MESSAGE event through the live-tail producer, so the watcher sees
   * it exactly once live (settled views read the log's origin:"user" lane
   * -- the existing rule), and a refusal has nothing to retract because it
   * never painted a row. Refusals land on taskControl (see onTaskControl).
   */
  function taskFollowup(taskId: string, message: string): void {
    const text = message.trim();
    if (!taskId || !text) return;
    send({ type: "taskFollowup", taskId, message: text });
  }

  /** Cancel a live task (C2S taskInterrupt -> TaskManager.interruptTask). */
  function interruptTask(taskId: string): void {
    if (!taskId) return;
    send({ type: "taskInterrupt", taskId });
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

  /**
   * Lazy history: the scroll-up trigger (the manager's top-zone edge). Fires
   * the ONE loadOlder page the pane may have in flight (once-per-gap guard).
   * No window / a page already open / a closed socket: silence. A refusal frees the slot and the next
   * edge retries; a disconnect re-attests the window through the attach
   * burst -- the existing reconnect doctrine, no invented retry loop.
   */
  function requestOlderHistory(): void {
    const win = historyWindow;
    if (!win || olderInFlight !== null) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    olderReqSeq++;
    olderInFlight = olderReqSeq;
    send({
      type: "loadOlder",
      requestId: olderReqSeq,
      logId: win.id,
      olderThan: win.oldestIndex,
      ...(win.epochToken !== null ? { epochToken: win.epochToken } : {}),
    });
  }

  function deleteLog(logId: string): void {
    send({ type: "deleteLog", logId });
  }

  function searchLogs(query: string, requestId: number): void {
    const q = query.trim();
    if (q === "") return;
    send({ type: "searchLogs", query: q, requestId });
  }

  /** Ask the server for a live config snapshot (settings viewer). The reply
   *  rides onConfigSnapshot with the same id; stale replies drop client-side. */
  function requestConfigSnapshot(requestId: number): void {
    send({ type: "configSnapshot", requestId });
  }

  /** Persist one config value (settings editor). Scalars ride { value },
   *  JSON containers / writeOnly secret replaces ride { valueText }. The
   *  reply rides onSetConfigKey with the same id; stale replies drop
   *  client-side. */
  function setConfigKey(requestId: number, keyPath: string, payload: ConfigEditPayload): void {
    send({ type: "setConfigKey", requestId, keyPath, ...payload });
  }

  /** Append/remove on the additive editConfigList pair (generic arrays AND
   *  providers). append: the array path + the typed `value` (a primitive
   *  list) or `name` (providers -- their elements are objects); remove:
   *  "<array>[<index>]" with the index riding IN the keyPath (the optional
   *  echo must agree). Each field rides ONLY when defined -- a provider
   *  frame carries no value key, a primitive frame no name key. The reply
   *  rides onEditConfigList with the same id; stale replies drop client-side.
   *  No value bytes ride this frame in either direction -- an append's only
   *  payload is the caller's own name/scalar, never a secret. */
  function editConfigList(
    requestId: number,
    keyPath: string,
    op: ConfigListOp,
    name?: string,
    index?: number,
    value?: string | number | boolean,
  ): void {
    send({
      type: "editConfigList",
      requestId,
      keyPath,
      op,
      ...(name !== undefined ? { name } : {}),
      ...(index !== undefined ? { index } : {}),
      ...(value !== undefined ? { value } : {}),
    });
  }

  /** List a workspace directory (workbench file tree); omit path for the
   *  roots. The reply rides onListDir with the same id. */
  function listDir(requestId: number, path?: string): void {
    send(path !== undefined ? { type: "listDir", requestId, path } : { type: "listDir", requestId });
  }

  /** Read a line-window page of a text file (workbench file viewer). The
   *  reply rides onReadFile with the same id; offset is 0-based lines-to-skip. */
  function readFile(requestId: number, path: string, offset?: number, limit?: number): void {
    send({
      type: "readFile",
      requestId,
      path,
      ...(offset !== undefined ? { offset } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  // Write family (workbench file ops): one additive frame per op, all
  // answered by fileOpResult with the same id. Optional fields ride spread,
  // absent-not-null (the readFile idiom).
  function createFile(requestId: number, path: string): void {
    send({ type: "createFile", requestId, path });
  }

  function createDir(requestId: number, path: string): void {
    send({ type: "createDir", requestId, path });
  }

  function renamePath(requestId: number, oldPath: string, newPath: string): void {
    send({ type: "renamePath", requestId, oldPath, newPath });
  }

  function deletePath(requestId: number, path: string): void {
    send({ type: "deletePath", requestId, path });
  }

  function saveFile(requestId: number, path: string, content: string, baseMtimeMs?: number): void {
    send({
      type: "saveFile",
      requestId,
      path,
      content,
      ...(baseMtimeMs !== undefined ? { baseMtimeMs } : {}),
    });
  }

  return {
    connect,
    disconnect,
    sendMessage,
    sendSlashCommand,
    cancel,
    setExecFencePolicy,
    createSession,
    switchSession,
    deleteSession,
    dismissSession,
    renameSession,
    setPinned,
    listSessions,
    listLogs,
    loadLog,
    viewLog,
    deleteLog,
    searchLogs,
    requestConfigSnapshot,
    setConfigKey,
    editConfigList,
    listDir,
    readFile,
    createFile,
    createDir,
    renamePath,
    deletePath,
    saveFile,
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
    hideThinkingAtom,
    toggleHideThinking,
    transcribe,
    tasksAtom,
    sessionKindAtom,
    sessionParentAtom,
    taskFollowup,
    interruptTask,
    clearTasks,
  };
}
