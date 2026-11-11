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
  // the payload FRESH per request, and the viewer asks on EVERY open (live-
  // at-open: no cached snapshot is ever shown; there is still no push feed --
  // staleness only ends at the next open/Refresh, never mid-visit).
  // Correlated back with CONFIG_SNAPSHOT_RESULT by requestId; stale replies
  // are dropped client-side by id (the searchLogs precedent). The handler is
  // strictly read-only and answers the requesting socket only.
  CONFIG_SNAPSHOT: "configSnapshot",
  // Workspace file tree (webui workbench): { type, requestId, path? }. NO
  // path lists the configured workspace ROOTS only (no fs call); a path
  // lists that directory. Every path goes through Workspace.resolveSafe
  // BEFORE any fs touch (see handlers-files.ts -- confinement is the whole
  // ballgame). Replied with LIST_DIR_RESULT, requesting socket only.
  LIST_DIR: "listDir",
  // Read a TEXT file: { type, requestId, path, offset?, limit? }. offset is
  // lines to SKIP (0-based, the core read tool's grammar) and limit lines to
  // return; pages cut at line boundaries so consecutive slices concatenate
  // byte-identical. Binary files are refused honestly with zero content
  // bytes. Replied with READ_FILE_RESULT, requesting socket only.
  READ_FILE: "readFile",
  // Edit ONE config value (settings editor, ALL the settings): { type,
  // requestId, keyPath, value? , valueText? }. keyPath is a dotted CONFIG
  // PATH that may address array elements by index ("providers[0].url");
  // zero path components come off the wire as filesystem paths. Scalars ride
  // `value` (string|number|boolean); JSON containers and writeOnly secret
  // replaces ride `valueText` (raw text the server parses/revalidates). The
  // write is a surgical JSONC text edit of exactly that value (comments and
  // formatting outside the value are user data and survive), atomic,
  // rescue-verified with rollback. Success carries needsRestart: config
  // resolves at startup, so the server NEVER claims live effect. A secret
  // replace echoes value:null + redacted:true -- never the new value.
  // Replied with SET_CONFIG_KEY_RESULT, requesting socket only.
  SET_CONFIG_KEY: "setConfigKey",
  // LIST edit (settings editor, ONE additive pair alongside setConfigKey):
  // { type, requestId, keyPath, op, name?, index?, value? }. The frame edits
  // the ARRAY itself, never a value: op "append" carries keyPath = the array
  // path and EITHER name (only for "providers", whose elements are objects:
  // writes exactly {"name": <name>} -- no invented fields) OR value (any
  // primitive array: the typed element, validated against the items schema
  // when the schema declares one, else against the array's existing element
  // kind; object/null appends and type-mixed appends refuse). op "remove"
  // carries keyPath "<array>[<index>]" (the optional index field, when
  // present, must agree with the keyPath). Same surgical transaction as
  // setConfigKey (comments/formatting of everything else byte-identical,
  // atomic temp+rename, rescue-verify with rollback); refuses duplicate
  // provider names, out-of-range indexes, non-primitive arrays on append, a
  // present-but-not-an-array target rather than replacing user bytes, and a
  // provider the config still references (defaultProvider / provider keys, or
  // any "name/..." model string, naming the referencing keyPath). Elements
  // address by INDEX, so duplicate values are removable/editable one at a
  // time. The reply never echoes secret bytes; ok carries needsRestart like
  // every list write. Replied with EDIT_CONFIG_LIST_RESULT, requesting socket
  // only.
  EDIT_CONFIG_LIST: "editConfigList",
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
  // Reply to C2S LIST_DIR (requesting socket only), correlated by requestId.
  // Rejections ride the error field (still requestId-correlated), so the
  // tree can render the honest one-liner IN the row it belongs to.
  LIST_DIR_RESULT: "listDirResult",
  // Reply to C2S READ_FILE (requesting socket only), correlated by requestId.
  // Same error-field doctrine as LIST_DIR_RESULT.
  READ_FILE_RESULT: "readFileResult",
  // Replied to C2S SET_CONFIG_KEY (requesting socket only), correlated by
  // requestId. ok:true carries the persisted value echo + needsRestart:true
  // (the running server still uses the pre-edit value until restart);
  // ok:false carries the honest error string (rendered verbatim, stacks
  // stay server-side). See handlers-config.ts.
  SET_CONFIG_KEY_RESULT: "setConfigKeyResult",
  // Reply to C2S EDIT_CONFIG_LIST (requesting socket only), correlated by
  // requestId. The result envelope mirrors SET_CONFIG_KEY_RESULT exactly
  // (ok / error / needsRestart) so the client renders refusals verbatim the
  // same way; a list op ships no value echo (there is no scalar to echo --
  // and an append's bytes are the caller's own name/value anyway, never a
  // secret).
  EDIT_CONFIG_LIST_RESULT: "editConfigListResult",

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
/** Row and finding caps per snapshot reply (belt over the schema's own
 *  bound; MAX_TASK_ACTIVITY_CHARS idiom: count rows, honor the truncated
 *  flag). KEPT at 400 for the all-fields editor (owner ruling 2026-11-09):
 *  rows now include file-only keys, provider entries (indexed) and the
 *  children of class-A refused containers, but a full real snapshot is ~80
 *  schema leaves plus tens of extras -- 400 bounds one reply well above the
 *  real payload, and the honest `truncated` flag covers the pathological
 *  config. A bump needs a documented reason, not just headroom. */
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
 * - endsWith "secret" / "credential" / "auth" / "cert" (caCert, certPem) /
 *   "creds";
 * - endsWith "pass" / "passwd" / "password" / "pwd" (each spelling is listed:
 *   "password" does NOT end in "pass" -- db_password and DB_PASSWORD alike
 *   match on the full word);
 * - endsWith "authorization" / "bearer" (the trailing word is what names a
 *   credential: "auth" alone does not match "authorization").
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
    seg.endsWith("passwd") ||
    seg.endsWith("password") ||
    seg.endsWith("pwd") ||
    seg.endsWith("credential") ||
    seg.endsWith("creds") ||
    seg.endsWith("auth") ||
    seg.endsWith("authorization") ||
    seg.endsWith("bearer") ||
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
  /** LIST-CHROME array row (owner ruling 2026-11-11, the provider-card
   *  doctrine generalized): the row is the array field's heading. It carries
   *  NO edit stamp (a wholesale write to it is refused), and the array's
   *  elements ride as their own rows keyed `key[i]` ("workspace.deny[0]",
   *  "providers[0].models[2]"), each with its own stamp (scalar/enum/writeOnly
   *  when the array is secret-shaped -- REPLACE per element, never a byte
   *  ships). Append/remove go through editConfigList against the array path /
   *  an element path. Absent for every other row; an EMPTY primitive array
   *  ships this chrome row and zero element rows; a schema-declared list the
   *  file does not carry ships the chrome row with no elements either (append
   *  creates it). Object/mixed arrays are NOT chrome: they keep their whole-
   *  json stamp or the provider-card / class-A child posture. */
  arrayChrome?: true;
  /** Settings EDITOR affordance: present on EVERY row the write path would
   *  accept from setConfigKey (owner ruling 2026-11-09: ALL the settings --
   *  the whitelist is retired) and ABSENT only on the honest refusal classes,
   *  whose writes the SERVER refuses too (the stamp predicate is the write
   *  gate, not just the button):
   *  (1) a CONTAINER whose shipped payload is not byte-faithful (secrets were
   *  nulled, URL userinfo scrubbed, or long strings stubbed inside -- editing
   *  from the stub would overwrite the real bytes); its children ride as
   *  their own stamped rows. (Lossy SCALARS are not a third class: scalar
   *  writes replace the whole token, so they carry `seedless` below.)
   *  (2) anything the surgical locator cannot address (a duplicated key on
   *  the path, an unparseable/unaddressable file, a key the path grammar
   *  cannot spell).
   *  (3) a file value of null -- the editor takes no write shape from it
   *  (the scalar/json distinction has nothing to hold).
   *  The type/bounds ride as INPUT HINTS for the row editor; the server
   *  revalidates the incoming value on every write, so a tampered hint
   *  changes nothing but the widget. */
  edit?: ConfigKeyEditWire;
}

/** Editor descriptor stamped by the server on editable rows.
 *  - scalar kinds (number/integer/boolean/string): the schema-declared type
 *    (runtime-inferred for file-only keys); minimum/maximum are the schema's
 *    declared bounds (the exact pair the write path enforces). The value
 *    rides the `value` channel of setConfigKey.
 *  - "json": a container (object/array). The client renders a monospace JSON
 *    textarea seeded from the row's SHIPPED value; the new value rides the
 *    `valueText` channel and must JSON.parse AND keep the current shape class
 *    (object stays object, array stays array). Containers whose ship is
 *    unfaithful never carry this stamp (refusal class 1; the write path
 *    refuses their wholesale writes with the same predicate).
 *  - writeOnly:true (always type "string", always a secret-shaped path):
 *    a REPLACE box (password input, never prefilled). The current value never
 *    rides any reply and never leaves the server; the new value rides
 *    `valueText` and is echoed back only as `value: null + redacted: true`.
 *  - seedless:true (type "string"; the shipped form was truncated or the URL
 *    userinfo scrubbed): a REPLACE box with an EMPTY input -- the row's ship
 *    is a summary, not a seed, and a scalar write replaces the whole token
 *    anyway, so the user types a full replacement instead of editing a stub. */
export interface ConfigKeyEditWire {
  type: "number" | "integer" | "boolean" | "string" | "json";
  minimum?: number;
  maximum?: number;
  /** Secret-shaped leaf: the write replaces the value sight-unseen. */
  writeOnly?: true;
  /** Lossy ship (truncated / URL-scrubbed): the editor starts EMPTY. */
  seedless?: true;
  /** Schema enum: the ONLY legal values for this leaf. The panel renders a
   *  dropdown of exactly these (a shipped value outside the set rides a
   *  "(current)" option, never silently replaced); the write gate refuses
   *  anything else with the set named in the text. */
  enum?: string[];
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
  /** Epoch ms of this fresh read (the server recomputes per request; the
   *  panel re-reads on every open -- live-at-open, no push feed). */
  ts: number;
  configDir: string;
  files: ConfigFileEntryWire[];
  findings: ConfigFindingWire[];
  sections: ConfigSectionWire[];
  /** Set when a row cap cut the table (MAX_CONFIG_ROWS / MAX_CONFIG_FINDINGS). */
  truncated?: boolean;
};

// ── Config key edit (C2S setConfigKey → S2C setConfigKeyResult) ────────────
// The settings editor's write path (see ./handlers-config.ts). One value,
// one addressable keyPath, one atomic surgical edit of the resolved config
// file. The reply NEVER claims live effect: config resolves at startup, so
// success rides needsRestart:true until the process restarts.

/** What the client sends as the new value: scalars ride `value`; JSON
 *  containers and writeOnly secret replaces ride `valueText` (raw text --
 *  the server parses, validates, and re-serializes nothing it did not get).
 *  The channels are exclusive: a frame carrying BOTH is refused at the gate
 *  (and one carrying neither never reaches a write). */
export type ConfigEditPayload = { value: string | number | boolean } | { valueText: string };

export type SetConfigKeyResultWire = {
  type: "setConfigKeyResult";
  /** Echo of the C2S setConfigKey request id; stale replies drop client-side. */
  requestId?: number;
  ok: boolean;
  /** Honest one-line rejection (unaddressable path / failed schema or shape
   *  validation / ambiguous target / unparseable file / empty writeOnly
   *  replace / write or verification failure). Rendered verbatim; stacks stay
   *  server-side in the log. */
  error?: string;
  /** True on ok: the value is persisted to the config file but the RUNNING
   *  server keeps its startup-resolved value until it restarts. */
  needsRestart?: boolean;
  /** The persisted value echo on a scalar save (the client updates the row's
   *  file slot from this, never from its own input). `null` ONLY on a
   *  writeOnly secret replace, paired with `redacted: true` -- the new secret
   *  NEVER rides the reply. */
  value?: string | number | boolean | null;
  /** The persisted JSON text echo on a container (type "json") save; absent
   *  on every other save. */
  valueText?: string;
  /** Set on a successful writeOnly secret replace: the value landed, its
   *  bytes are not shippable (this is the ONLY echo such a save produces). */
  redacted?: true;
};

// ── LIST edit (C2S editConfigList → S2C editConfigListResult) ────────────────
// The settings editor's array add/remove path (see ./handlers-config.ts).
// The C2S frame is { requestId, keyPath, op, name?, index?, value? } (additive
// to the C2S union, same requestId-correlated idiom as setConfigKey): append
// targets the array path ("providers" carries name; any primitive array
// carries value); remove targets "<array>[<index>]" (optional index echo must
// agree with the keyPath). The result envelope mirrors SET_CONFIG_KEY_RESULT
// (ok / error / needsRestart) so the existing client error rendering applies
// verbatim; there is NO value echo -- a list op persists no single scalar, and
// the reply never carries config bytes of any kind. Success means the file
// changed; needsRestart follows the same rule every list write applies (config
// resolves at startup -- the running server keeps its startup values until
// restart).

export type ConfigListOp = "append" | "remove";

export type EditConfigListResultWire = {
  type: "editConfigListResult";
  /** Echo of the C2S editConfigList request id; stale replies drop client-side. */
  requestId?: number;
  ok: boolean;
  /** Honest one-line rejection (bad op/name, duplicate name, out-of-range
   *  index, still-referenced provider, unparseable file, write or
   *  verification failure). Rendered verbatim; stacks stay server-side. */
  error?: string;
  /** True on ok: the array edit is persisted; the RUNNING server keeps its
   *  startup providers until it restarts. */
  needsRestart?: boolean;
};

// ── Workspace file tree + text reader (C2S listDir/readFile → S2C replies) ─
// The webui workbench's read path (see ./handlers-files.ts). READ-ONLY: zero
// writes, zero new config keys. CONFINEMENT: every path that arrives off the
// wire passes Workspace.resolveSafe BEFORE any fs call (no pre-stat, no
// pre-read), and listings omit entries the denylist would reject -- the tree
// never offers a dead end. Rejections are honest one-line strings carried in
// the reply's `error` field (still requestId-correlated); stacks stay
// server-side (errorFrame covers the unexpected).

/** Ceiling on entries per directory listing (MAX_CONFIG_ROWS idiom: count
 *  rows, set truncated when the cap cuts). 500 covers a real source dir at
 *  a glance without turning one socket frame into a phone book. */
export const MAX_LIST_DIR_ENTRIES = 500;
/** Ceiling on characters of file content per READ_FILE reply. 256 KiB of
 *  UTF-16 chars -- a 16th of MAX_WIRE_IMAGE_BASE64_BYTES (8 MiB), so a text
 *  page can never out-flood the image path that already has its own cap.
 *  Pages cut at LINE boundaries only: consecutive slices concatenate
 *  byte-identical (Phase 7 line-addressing resumes mid-file); a single line
 *  longer than the cap is refused honestly, never sliced. */
export const MAX_FILE_READ_CHARS = 256 * 1024;
/** Lines returned when the request omits limit, and the hard clamp on a
 *  provided one (the char cap bounds bytes; this bounds line bookkeeping). */
export const READ_LINES_DEFAULT = 200;
export const MAX_READ_LINES = 5000;

/** One entry of a directory listing. `path` is absolute (the roots listing
 *  already exposes absolute spellings; the tree walks down from there). */
export interface DirEntryWire {
  name: string;
  path: string;
  isDir: boolean;
  /** True for symbolic links. Their TARGET is never resolved into the
   *  listing: the row carries the link itself. Expanding/reading one whose
   *  target escapes roots/deny is refused by resolveSafe with an honest
   *  error; a dangling final link rides resolveSafe's own probe semantics. */
  isSymlink?: boolean;
  /** Regular files only (lstat byte size). */
  size?: number;
  /** lstat mtime, epoch ms (omitted when the stat raced away). */
  mtime?: number;
}

/** One configured workspace root as a top-level tree row (name + absolute
 *  path; the no-path LIST_DIR reply is exactly this list, no fs call). */
export interface FileRootWire {
  name: string;
  path: string;
}

export type ListDirResultWire = {
  type: "listDirResult";
  /** Echo of the C2S listDir request id; stale replies drop client-side. */
  requestId?: number;
  /** The directory listed (resolved absolute). Absent on the roots reply. */
  path?: string;
  /** Set on the roots reply (no C2S path): one row per configured root. */
  roots?: FileRootWire[];
  /** Set on a directory listing: dirs first, then names, denylist omitted. */
  entries?: DirEntryWire[];
  /** Set when MAX_LIST_DIR_ENTRIES cut the listing. */
  truncated?: boolean;
  /** Honest one-line rejection (outside roots, denied, not found, not a
   *  dir, ...). When set, roots/entries/truncated ride absent. */
  error?: string;
};

export type ReadFileResultWire = {
  type: "readFileResult";
  /** Echo of the C2S readFile request id; stale replies drop client-side. */
  requestId?: number;
  /** The requested path, echoed as sent (the client keys views by it).
   *  Absent on error replies for invalid input that never named a file. */
  path?: string;
  /** Echo of the request's line-skip offset (0-based). */
  offset?: number;
  /** Exact slice of the file: the requested line window, terminators
   *  intact. Text files ONLY -- a refusal ships no content field at all. */
  content?: string;
  /** More lines exist past this window (line limit or char cap cut it). */
  truncated?: boolean;
  /** Honest one-line rejection (outside roots, denied, not found, is a
   *  directory -- use listDir, binary file (N bytes), line over the char
   *  cap). When set, content/truncated ride absent. */
  error?: string;
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
