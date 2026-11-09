// Whole-message payloads are type aliases, not interfaces: they are handed to
// sendSafe/send as JSON bodies, and an interface has no implicit index signature
// (so it would not satisfy Record<string, unknown>). Nested value objects
// (UploadFileWire, WireImage) stay interfaces.

// Server→client messages always include `sessionId`.

// ── Client → Server ─────────────────────────────────────────────────────────

export const C2S = {
  AUTH: "auth",
  CREATE_SESSION: "createSession",
  DELETE_SESSION: "deleteSession",
  // Sidebar "Dismiss" on an IDLE session row: tear the live session down
  // but keep its log and its pin -- the row demotes to the cold Recent
  // Logs list. The server refuses a running session (busy guard) and
  // answers with the refreshed SESSIONS + LOGS_LISTED payloads so every
  // tab demotes the row without a manual refresh.
  DISMISS_SESSION: "dismissSession",
  RENAME_SESSION: "renameSession",
  // Sidebar pin flip: { type, sessionId, pinned: boolean }. The id may name
  // a live session OR a cold log (pins span both sidebar sections). The
  // server persists it (pin-store.ts), then broadcasts refreshed SESSIONS
  // and LOGS_LISTED payloads so every tab's sidebar updates.
  SET_PINNED: "setPinned",
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
  // Full-text search across all session logs (live + cold):
  // { type, requestId, query }. Case-insensitive substring match on the
  // human-readable entry text (never base64 image payloads). Correlated
  // back with SEARCH_RESULTS; stale replies are dropped client-side by id.
  SEARCH_LOGS: "searchLogs",
  // Profile management
  LIST_PROFILES: "listProfiles",
  SWITCH_PROFILE: "switchProfile",
  // Subagent task control (delegates to TaskManager primitives)
  TASK_INTERRUPT: "taskInterrupt",
  TASK_FOLLOWUP: "taskFollowup",
  // Replay buffered activity for one task (reconnecting panel; see TASK_ACTIVITY_HISTORY)
  TASK_ACTIVITY_REQUEST: "taskActivityRequest",
  // Per-session exec-fence flip from the webui header strip:
  // { type, sessionId, policy: "off" | "probe" }. The server answers with a
  // sessionState frame (key "toolExec") scoped to that session's clients.
  EXEC_FENCE: "execFence",
  // Settings-viewer config snapshot: { type, requestId }. The server computes
  // the payload FRESH per request (the config may have changed on disk since
  // startup; the viewer's honest framing is snapshot-at-open, never live).
  // Correlated back with CONFIG_SNAPSHOT_RESULT by requestId; stale replies
  // are dropped client-side by id (the searchLogs precedent). The handler is
  // strictly read-only and answers the requesting socket only.
  CONFIG_SNAPSHOT: "configSnapshot",
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
  // Reply to C2S SEARCH_LOGS (requesting socket only), correlated by requestId.
  SEARCH_RESULTS: "searchResults",
  // Reply to C2S CONFIG_SNAPSHOT (requesting socket only), correlated by
  // requestId. See the Config snapshot section below and handlers-config.ts.
  CONFIG_SNAPSHOT_RESULT: "configSnapshotResult",

  // Profile management
  PROFILES: "profiles",
  PROFILE_SWITCHED: "profileSwitched",

  // OUTPUT_EVENT mappings
  USER_MESSAGE: "userMessage",
  // Replay-only additive fields ride this frame: ts (the log entry's
  // completion timestamp, epoch ms), durationMs (the bracketing turn's
  // wall-clock span) and ctx (the token usage attested at the message's
  // commit) -- see s2cAssistantMessage in wire-messages.ts.
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
  // Mid-stream provider failure being retried: drop the in-flight assistant
  // text/thinking accumulation (the retry re-streams from scratch). Additive;
  // no fields beyond type + sessionId.
  STREAM_RESET: "streamReset",
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

/**
 * Wire-safe error text: message only. Deliberately NOT `formatError()` --
 * unexpected-error stacks stay server-side (log them there); they must never
 * ride a frame to the client.
 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build an S2C.ERROR frame from a caught value. */
export function errorFrame(err: unknown): { type: string; message: string } {
  return { type: S2C.ERROR, message: errorText(err) };
}


export interface C2SMessage {
  type: C2SType;
  [key: string]: unknown;
}

// ── Tool call display parts (S2C TOOL_CALL) ─────────────────────────────────

/**
 * One declared display part on a `toolCall` frame, mirroring
 * ToolDisplaySpec (ToolMetadata.display, the call-level sibling of the
 * argDisplay hints). The server forwards the tool's declared spec AS
 * DECLARED, in array order -- unknown kinds are not filtered server-side
 * (forward-compat: current sinks skip them) -- and a tool declaring
 * nothing (or an empty array) sends no field (no null-noise, no empty
 * array). Values are ARG PARAMETER NAMES, never values -- the args JSON
 * is already on the frame, so a sink reads e.g.
 * `JSON.parse(args)[part.oldArg]` to build the view. Sinks render the
 * kinds they know and fall back to their generic posture when nothing
 * renderable remains. The cold `logViewed` payload carries the very same
 * parts per tool_call of its (otherwise raw) entries, so a browsed log and
 * the live feed cannot drift; that per-call field is additive -- clients
 * that predate it ignore it.
 */
export interface ToolDisplayWire {
  /** Open vocabulary kind (see ToolDisplaySpec): "file", "diff", "prose",
   * "code", or anything a future tool declares. */
  kind: string;
  /** Bytes this part renders: "result" (default), "error", "args". kind
   * "file" and kind "diff" follow it too: "args" renders the written
   * content on the call (append/overwrite, every line as an add when the
   * kind is "diff"), "result" renders the returned text (read). */
  source?: "args" | "result" | "error";
  /** source: "args" -- the arg key holding this part's text. */
  arg?: string;
  /** kind: "diff" -- arg keys of the old/new strings. */
  oldArg?: string;
  newArg?: string;
  /** kind: "diff" + source: "args" -- first new-side line number of the add
   * rail (positive integer, see ToolDisplaySpec.addStart); absent leaves the
   * rail blank (append: unknown existing content above it). */
  addStart?: number;
  /** kind: "file" -- arg key naming the file; optional line-range args. */
  pathArg?: string;
  offsetArg?: string;
  limitArg?: string;
  /** kind: "prose" -- sink-owned icon name; unknown names render no icon. */
  icon?: string;
  /** Syntax language for highlighting; sinks without that tokenizer
   * render plain text. */
  lang?: string;
}

// ── Full-text log search (C2S searchLogs → S2C searchResults) ───────────────

/**
 * One session log that matched the search query. `logId` is the selection
 * key the client hands to viewLog/loadLog/switchSession; `snippets` are
 * short human-readable excerpts centered on the matches (never base64).
 */
export interface SearchHitWire {
  logId: string;
  /** Last activity (epoch ms) -- the sidebar row grammar's stamp. */
  lastActivityAt: number;
  /** Total matches in the log (may exceed the returned snippets). */
  matchCount: number;
  profile?: string;
  model?: string;
  /** Whether this id is a live session (vs a cold log). */
  live: boolean;
  /** Excerpt lines, capped per log; each rides the matching text. */
  snippets: string[];
}

/** Caps on a single search reply (see searchLogs in ./handlers-logs.ts). */
export const MAX_SEARCH_HITS = 50;
export const MAX_SEARCH_SNIPPETS_PER_LOG = 3;
/** Characters of context kept on each side of a match in a snippet. */
export const SEARCH_SNIPPET_CONTEXT = 48;

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
 *
 * Both ends compile against this: the webui builds it in chat.ts transcribe(),
 * the server parses the untrusted socket into it (parseTranscribeRequest in
 * ./message-routing.ts), so a field change breaks the build instead of the
 * first malformed message.
 */
export type TranscribeRequestWire = {
  type: "transcribe";
  /** Client-generated correlation id, echoed verbatim on the transcript reply. */
  id: string;
  /** Content type of the encoded audio, e.g. "audio/webm". Absent: the backend sniffs the container. */
  mimeType?: string;
  /** Base64 payload (raw bytes, no data: prefix). */
  data: string;
};

/**
 * Reply to a transcribe request, correlated by `id`. Failures are in-band
 * (`ok: false` + human-readable `error`): an unconfigured or broken STT
 * backend must never drop the socket.
 */
export type TranscriptReplyWire = {
  type: "transcript";
  id: string;
  ok: boolean;
  text?: string;
  error?: string;
};

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

// ── Config snapshot (C2S configSnapshot → S2C configSnapshotResult) ────────
// The settings viewer's read path (see ./handlers-config.ts). Diagnostics
// ONLY: FileReport.rawText and parse-error excerpts never serialize -- file
// bytes are not a viewer deliverable. Secret-shaped values are nulled at the
// wire boundary (isSecretConfigPath), so a snapshot reply can never carry an
// API key, token, or password even if the config file holds one.

/** Ceiling on a serialized slot value; longer strings cut with the
 *  "[truncated]" marker (MAX_TASK_ACTIVITY_CHARS precedent). The schema
 *  bounds the row set, this bounds the fat values. */
export const MAX_CONFIG_VALUE_CHARS = 2000;
/** Row and finding caps per snapshot reply (belt over the schema's own bound). */
export const MAX_CONFIG_ROWS = 400;
export const MAX_CONFIG_FINDINGS = 100;

/**
 * Redaction boundary test: TRUE when the LAST segment of a dotted config key
 * path names a credential. Matching is on the lowercased segment with "_" and
 * "-" stripped (so API_KEY / api-key / apiKey normalize alike):
 * - endsWith "key" (apiKey, braveApiKey, tavilyApiKey, privateKey, and any
 *   providers.*.apiKey) or equals "key";
 * - endsWith "token" (singular; accessToken, GH_TOKEN -- "reserveTokens"/
 *   "tokens" budget knobs and sessionTokenTtlMin do NOT match);
 * - endsWith "secret" / "pass" (which covers password and passwd) /
 *   "credential" / "auth" (authorization) / "cert" (caCert, certPem) /
 *   "creds".
 * Over-redaction is the safe failure; under-redaction is the bug. Keys it
 * catches in the current schemas: apiKey (+ env HOTDOG_API_KEY/AI_API_KEY),
 * providers.*.apiKey (config-passthrough block), webui.apiKey (+ env
 * HOTDOG_WEBUI_API_KEY), webSearch.braveApiKey (+ env BRAVE_API_KEY),
 * webSearch.tavilyApiKey (+ env TAVILY_API_KEY).
 */
export function isSecretConfigPath(keyPath: string): boolean {
  const seg = (keyPath.split(".").pop() ?? "").toLowerCase().replace(/[_-]/g, "");
  if (!seg) return false;
  if (
    seg.endsWith("key") ||
    seg.endsWith("token") ||
    seg.endsWith("secret") ||
    seg.endsWith("pass") ||
    seg.endsWith("credential") ||
    seg.endsWith("creds") ||
    seg.endsWith("auth") ||
    seg.endsWith("cert")
  ) {
    return true;
  }
  return seg === "certificate";
}

/** Per-config-file verdict (subset of rescue's FileReport -- no rawText, no
 *  error excerpt/offset; the parse message and JSONC issue kinds/lines only). */
export interface ConfigFileEntryWire {
  path: string;
  inUse: boolean;
  status: "missing" | "ok" | "broken";
  /** JSONC issue kinds with their line numbers (grouped by kind). */
  jsoncIssues?: Array<{ kind: string; lines: number[] }>;
  /** True when `hotdog rescue fix` can repair this file. */
  fixable?: boolean;
  /** JSON.parse error message (broken files only). */
  parseError?: string;
}

/** One key-level diagnostic (unknown / duplicate / removed). Carries the key,
 *  its line, and did-you-mean suggestions -- never the key's value. */
export interface ConfigFindingWire {
  type: "unknown-key" | "duplicate-key" | "removed-key";
  key: string;
  line: number;
  /** duplicate-key: the line of the first occurrence (the later value wins). */
  firstLine?: number;
  /** unknown-key: near-miss schema keys. */
  didYouMean?: string[];
  /** removed-key: tombstone text naming the replacement. */
  message?: string;
}

/**
 * One leaf config key with its per-layer slots. A slot that the server cannot
 * attest rides OMITTED (never a fabricated default or a lying "unset"):
 * the UI renders source badges only for the slots present. `redacted: true`
 * means every value on this row was replaced with null by the secret rule
 * (the row itself may still show description/default presence and the
 * set/unset distinction for env).
 */
export interface ConfigKeyEntryWire {
  /** Full dotted leaf path ("webui.port"). */
  key: string;
  description?: string;
  /** Schema literal default (absent when the default is computed or none exists). */
  default?: unknown;
  /** Raw config-file value where the in-use file (or the explicit --config) sets it. */
  file?: unknown;
  /** env layer: present only when the schema declares an env source for the key. */
  env?: { set: boolean; source?: string; value?: unknown };
  /** cli layer: present only when the key declares a cliFlag AND the server
   *  process was launched with it (attested from the live argv + the registry's flag table). */
  cli?: { flag: string; value?: unknown };
  /** Resolved value the running server uses (core.resolved, falling back to the
   *  merged config for extension keys). */
  resolved?: unknown;
  /** The key path's own final segment is secret-shaped (isSecretConfigPath):
   *  every slot value on this row ships null, and slot PRESENCE is what the
   *  UI reads -- `redacted: true` renders "set (redacted)", its absence with
   *  nothing set renders "unset". */
  leafSecret?: boolean;
  /** Redaction fired on this row: leaf-secret, or a secret-shaped entry
   *  nulled inside a container value (bashTool.env, mcpServers[].env). */
  redacted?: boolean;
}

/** Key table section: "core" first, then one section per loaded extension. */
export interface ConfigSectionWire {
  name: string;
  rows: ConfigKeyEntryWire[];
}

export type ConfigSnapshotResultWire = {
  type: "configSnapshotResult";
  /** Echo of the C2S configSnapshot request id; stale replies drop client-side. */
  requestId?: number;
  /** Epoch ms of the snapshot (the "snapshot-at-open" stamp; not a live feed). */
  ts: number;
  configDir: string;
  files: ConfigFileEntryWire[];
  findings: ConfigFindingWire[];
  sections: ConfigSectionWire[];
  /** Set when a row cap cut the table (MAX_CONFIG_ROWS / MAX_CONFIG_FINDINGS). */
  truncated?: boolean;
};

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
  /** Accumulated milliseconds the task's own agent turns ran (banked at turn ends). */
  activeMs: number;
  /** True while an agent turn is in flight; RUNNING && !inRun means parked (judge/lane/retry wait). */
  inRun: boolean;
  /** Wall start of the in-flight turn, null when none; live display adds (now - turnStartedAt). */
  turnStartedAt: number | null;
}

/**
 * One task-agent activity item. Text arrives as deltas (streaming chunks and
 * final assistant messages land in the same lane; the client appends). Tool
 * inputs/outputs are summaries -- see MAX_TASK_ACTIVITY_CHARS.
 *
 * `reset` is the STREAM_RESET sentinel (mid-stream provider failure being
 * retried): live-only, payload-free. The client drops the dead attempt's
 * trailing streamed blocks on receiving it, and the server buffer consumes it
 * as a trim instead of storing it (see SessionRegistry.recordTaskActivity),
 * so a replayed taskActivityHistory can never carry one and can never clear
 * a rebuilt panel view.
 */
export type TaskActivityWire =
  | { kind: "text"; content: string }
  | { kind: "reasoning"; content: string }
  | { kind: "tool_call"; name: string; args: string }
  | { kind: "tool_result"; name: string; output: string; error?: string }
  | { kind: "reset" };

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
    case OUTPUT_EVENT.STREAM_RESET:
      // The relay's counterpart of the main-chat streamReset S2C: the dead
      // attempt's streamed fragments must retract in the task panel too.
      return { kind: "reset" };
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
export type TaskControlWire = {
  type: "taskControl";
  taskId: string;
  action: "interrupt" | "followup";
  ok: boolean;
  error?: string;
};

/**
 * One taskControl reply. Built here so the message the server sends is the
 * declaration above, checked at compile time; `error` rides only on failure
 * because the client words the success itself.
 */
export function taskControlMessage(
  taskId: string,
  action: TaskControlWire["action"],
  ok: boolean,
  error?: string,
): TaskControlWire {
  const wire: TaskControlWire = { type: S2C.TASK_CONTROL, taskId, action, ok };
  if (error !== undefined) wire.error = error;
  return wire;
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
