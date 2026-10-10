// Server→client messages always include `sessionId`.

// ── Client → Server ─────────────────────────────────────────────────────────

export const C2S = {
  AUTH: "auth",
  CREATE_SESSION: "createSession",
  DELETE_SESSION: "deleteSession",
  RENAME_SESSION: "renameSession",
  LIST_SESSIONS: "listSessions",
  SWITCH_SESSION: "switchSession",
  SEND: "send",
  CANCEL: "cancel",
  QUESTION_ANSWER: "questionAnswer",
  COMMAND: "command",
  COMPLETE: "complete",
  // Voice transcription (push-to-talk / dictation)
  TRANSCRIBE: "transcribe",
  // Cold session log management
  LIST_LOGS: "listLogs",
  LOAD_LOG: "loadLog",
  VIEW_LOG: "viewLog",
  DELETE_LOG: "deleteLog",
  // Profile management
  LIST_PROFILES: "listProfiles",
  SWITCH_PROFILE: "switchProfile",
  // Subagent task control (delegates to TaskManager primitives)
  TASK_INTERRUPT: "taskInterrupt",
  TASK_FOLLOWUP: "taskFollowup",
  // Replay buffered activity for one task (reconnecting panel; see TASK_ACTIVITY_HISTORY)
  TASK_ACTIVITY_REQUEST: "taskActivityRequest",
} as const;

// ── Server → Client ─────────────────────────────────────────────────────────

export const S2C = {
  // Session management
  SESSION_CREATED: "sessionCreated",
  SESSION_DELETED: "sessionDeleted",
  SESSIONS: "sessions",
  AUTH_REQUIRED: "authRequired",
  AUTH_OK: "authOk",
  AUTH_ERROR: "authError",

  // Cold session log management
  LOGS_LISTED: "logsListed",
  LOG_VIEWED: "logViewed",
  LOG_DELETED: "logDeleted",

  // Profile management
  PROFILES: "profiles",
  PROFILE_SWITCHED: "profileSwitched",

  // OUTPUT_EVENT mappings
  USER_MESSAGE: "userMessage",
  ASSISTANT_MESSAGE: "assistantMessage",
  THINKING: "thinking",
  TOOL_CALL: "toolCall",
  TOOL_RESULT: "toolResult",
  COMPACTING: "compacting",
  COMMAND_RESULT: "commandResult",
  COMPLETIONS: "completions",
  QUESTION: "question",
  STREAMING_CHUNK: "streamingChunk",
  STREAMING_REASONING_CHUNK: "streamingReasoningChunk",
  TASK_PROGRESS: "taskProgress",
  TOKEN_USAGE: "tokenUsage",
  COMPACTION_RESULT: "compactionResult",
  SESSION_STATE: "sessionState",
  SYSTEM_MESSAGE: "systemMessage",

  // Voice transcription reply (correlated to a C2S transcribe by id)
  TRANSCRIPT: "transcript",

  // Question answers (broadcast to all clients when a question is resolved)
  QUESTION_ANSWERED: "questionAnswered",

  // Subagent task feed (broadcast; see TaskManager observer relay in server.ts)
  TASK_LIST: "taskList",
  TASK_UPDATE: "taskUpdate",
  TASK_ACTIVITY: "taskActivity",
  // Reply to C2S TASK_ACTIVITY_REQUEST: buffered tail, requesting socket only
  TASK_ACTIVITY_HISTORY: "taskActivityHistory",
  // Subagent task control reply (sent to the requesting socket only; the
  // status change itself rides the broadcast taskUpdate observer feed)
  TASK_CONTROL: "taskControl",

  // Connection management
  ERROR: "error",
} as const;

export type C2SType = (typeof C2S)[keyof typeof C2S];
export type S2CType = (typeof S2C)[keyof typeof S2C];

export interface C2SMessage {
  type: C2SType;
  [key: string]: unknown;
}

// ── File uploads on C2S SEND ────────────────────────────────────────────────

/**
 * One uploaded file riding a `send` message as base64 (no data: prefix;
 * the browser reads the File with FileReader.readAsDataURL and strips it).
 * Images become model image attachments (vision-gated); everything else
 * becomes a harness-authoritative file-include part (see server-side
 * parseUploadedFiles in ./uploads.ts).
 */
export interface UploadFileWire {
  /** Display name; becomes the file-include part's path. */
  name: string;
  mimeType?: string;
  /** Base64 payload (raw bytes, no data: prefix). */
  data: string;
}

// ── Voice transcription on C2S TRANSCRIBE ───────────────────────────────────

/**
 * One push-to-talk recording uploaded as base64 (same encoding convention as
 * UploadFileWire). The server forwards the bytes to the OpenAI-compatible
 * endpoint in config (`sttUrl`) and answers with a `transcript` message
 * carrying the same `id`.
 */
export interface TranscribeRequestWire {
  type: "transcribe";
  /** Client-generated correlation id, echoed verbatim on the transcript reply. */
  id: string;
  /** Content type of the encoded audio, e.g. "audio/webm". */
  mimeType: string;
  /** Base64 payload (raw bytes, no data: prefix). */
  data: string;
}

/**
 * Reply to a transcribe request, correlated by `id`. Failures are in-band
 * (`ok: false` + human-readable `error`): an unconfigured or broken STT
 * backend must never drop the socket.
 */
export interface TranscriptReplyWire {
  type: "transcript";
  id: string;
  ok: boolean;
  text?: string;
  error?: string;
}

// ── Images on the wire ──────────────────────────────────────────────────────

/**
 * One image in a `toolResult`/`userMessage` server→client message.
 * Payload travels as raw base64 (no data: prefix); the browser assembles the data-URL.
 * Skipped images (over the cap) arrive with `skipped: true` and a human-readable `note` instead of data.
 */
export interface WireImage {
  mimeType: string;
  data?: string;
  skipped?: boolean;
  note?: string;
}

/**
 * Hard ceiling on per-image base64 payload bytes sent over the websocket.
 * read-tool images cap out at 10MB raw (~13.7MB base64); anything larger is
 * replaced by a placeholder note rather than flooding the socket.
 */
export const MAX_WIRE_IMAGE_BASE64_BYTES = 8 * 1024 * 1024;

function stripDataUrlPrefix(value: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;,]+)?[^,]*,(.*)$/s.exec(value);
  if (!m) return null;
  return { mimeType: m[1] || "image/png", data: m[2]! };
}

/**
 * Normalize unknown image attachments (core ImageAttachment-shaped, or the
 * legacy data-URL form) into wire entries, applying MAX_WIRE_IMAGE_BASE64_BYTES.
 * Returns undefined when there is nothing to send so messages stay lean.
 */
export function wireImages(
  images: unknown,
  capBytes: number = MAX_WIRE_IMAGE_BASE64_BYTES,
): WireImage[] | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const out: WireImage[] = [];
  for (const raw of images) {
    if (!raw || typeof raw !== "object") continue;
    const img = raw as Record<string, unknown>;
    let mimeType = typeof img.mimeType === "string" ? img.mimeType : "";
    let data = typeof img.data === "string" ? img.data : "";
    if (!data && typeof img.url === "string") {
      // Legacy inlined form: { url: "data:<mime>;base64,..." }.
      const stripped = stripDataUrlPrefix(img.url);
      if (stripped) {
        mimeType = mimeType || stripped.mimeType;
        data = stripped.data;
      }
    }
    if (!data) continue;
    if (!mimeType) mimeType = "image/png";
    if (data.length > capBytes) {
      out.push({
        mimeType,
        skipped: true,
        note: `image too large to display (${(data.length / 1024 / 1024).toFixed(1)}MB base64 > ${(capBytes / 1024 / 1024).toFixed(0)}MB cap)`,
      });
    } else {
      out.push({ mimeType, data });
    }
  }
  return out.length > 0 ? out : undefined;
}

// ── Subagent task feed ──────────────────────────────────────────────────────

import { OUTPUT_EVENT, type OutputEvent } from "@core/context/output.ts";
import { toolContentText } from "@utils/tool-content.ts";

/**
 * Display snapshot of one task agent (TaskManager.TaskInfo on the wire).
 * `status` stays a string here: the browser must not need the core enum.
 */
export interface TaskInfoWire {
  taskId: string;
  description: string;
  /** The delegating session (null: no parent); webui scopes its task strip to it. */
  sessionId: string | null;
  status: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

/**
 * One task-agent activity item. Text arrives as deltas (streaming chunks and
 * final assistant messages land in the same lane; the client appends). Tool
 * inputs/outputs are summaries -- see MAX_TASK_ACTIVITY_CHARS.
 */
export type TaskActivityWire =
  | { kind: "text"; content: string }
  | { kind: "reasoning"; content: string }
  | { kind: "tool_call"; name: string; args: string }
  | { kind: "tool_result"; name: string; output: string; error?: string };

/**
 * Ceiling on relayed tool args/output per activity item. Task agents can emit
 * megabyte tool results; the panel shows a summary, and the socket should not
 * carry whole file dumps.
 */
export const MAX_TASK_ACTIVITY_CHARS = 4000;

function truncateActivity(value: string): string {
  if (value.length <= MAX_TASK_ACTIVITY_CHARS) return value;
  return `${value.slice(0, MAX_TASK_ACTIVITY_CHARS)}...[truncated]`;
}

/**
 * Serialize one task-agent OutputEvent into a wire activity payload, or null when the
 * event is not part of the panel's view (usage, session plumbing...). Reasoning
 * deltas get their own kind for separate styling.
 * The task id is NOT part of payload -- the enclosing taskActivity message has it (see taskActivityMessage).
 */
export function taskActivityFromEvent(event: OutputEvent): TaskActivityWire | null {
  switch (event.type) {
    case OUTPUT_EVENT.STREAMING_CHUNK:
    case OUTPUT_EVENT.ASSISTANT_MESSAGE:
      return event.content ? { kind: "text", content: event.content } : null;
    case OUTPUT_EVENT.STREAMING_REASONING_CHUNK:
      return event.content ? { kind: "reasoning", content: event.content } : null;
    case OUTPUT_EVENT.TOOL_CALL:
      return { kind: "tool_call", name: event.toolName, args: truncateActivity(event.input) };
    case OUTPUT_EVENT.TOOL_RESULT: {
      const wire: TaskActivityWire = {
        kind: "tool_result",
        name: event.toolName,
        output: truncateActivity(toolContentText(event.content)),
      };
      if (event.error !== undefined) wire.error = truncateActivity(event.error);
      return wire;
    }
    default:
      return null;
  }
}

/**
 * Reply to a C2S taskInterrupt/taskFollowup request, sent to the requesting
 * socket only. `action` mirrors the request so the client can word the
 * inline feedback; the authoritative state change is already on its way via
 * the broadcast taskUpdate observer feed.
 */
export interface TaskControlWire {
  type: "taskControl";
  taskId: string;
  action: "interrupt" | "followup";
  ok: boolean;
  error?: string;
}

/** The broadcast envelope: every activity message is tagged with its task id. */
export function taskActivityMessage(
  taskId: string,
  event: OutputEvent,
): { type: string; taskId: string; activity: TaskActivityWire } | null {
  const activity = taskActivityFromEvent(event);
  if (!activity) return null;
  return { type: S2C.TASK_ACTIVITY, taskId, activity };
}
