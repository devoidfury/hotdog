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
  // answers with the refreshed SESSIONS payload plus a targeted
  // logRowAdded frame carrying the single demoted row (never a rebuilt
  // LOGS_LISTED window), so every tab demotes the row without a manual
  // refresh.
  DISMISS_SESSION: "dismissSession",
  RENAME_SESSION: "renameSession",
  // Sidebar pin flip: { type, sessionId, pinned: boolean }. The id may name
  // a live session OR a cold log (pins span both sidebar sections). The
  // server persists it (pin-store.ts), then broadcasts the refreshed
  // SESSIONS payload plus a logPins frame carrying the COMPLETE current
  // pinned-id set (pins ride their own frame; no list payload, no scan),
  // so every tab's marks re-derive.
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
  // { type, since? { lastActivityAt, id } }. Absent `since`: the windowed
  // FULL head frame (the re-attestation posture). Present
  // (validated like loadOlderLogs' olderCursor; garbage refuses on an error
  // frame to this socket only): the reply is a DELTA LOGS_LISTED frame --
  // rows strictly NEWER than the cursor in the same descending order,
  // `full: false`, pinnedLogs as always, and NO olderCursor/hasOlder (the
  // client keeps its held paging seam). If more than LOG_LIST_WINDOW rows
  // are newer, the reply falls back to the full head frame (a partial
  // merge would lie about covering the gap).
  LIST_LOGS: "listLogs",
  LOAD_LOG: "loadLog",
  VIEW_LOG: "viewLog",
  DELETE_LOG: "deleteLog",
  // Older RECENT LOGS rows (the cold sidebar list, not the transcript):
  // { type, requestId, olderThan: { lastActivityAt, id }, size? }. The
  // cursor is the `olderCursor` a LOGS_LISTED / loadOlderLogsResult frame
  // shipped; the server answers the page of unpinned cold rows STRICTLY
  // older than it in the list's DESCENDING order (strictly: older ts, or
  // equal ts with id < cursor id), re-applying the live/worker exclusion
  // before the cut. `size` is a row count, clamped server-side
  // (MAX_LOG_LIST_PAGE; default = the LOG_LIST_WINDOW the head shipped).
  // Correlated back with LOAD_OLDER_LOGS_RESULT by requestId (the
  // searchLogs precedent); a garbage cursor refuses on the reply's `error`
  // field, still correlated -- never an uncorrelated guess.
  LOAD_OLDER_LOGS: "loadOlderLogs",
  // Full-text search across all session logs (live + cold):
  // { type, requestId, query }. Case-insensitive substring match on the
  // human-readable entry text (never base64 image payloads). Correlated
  // back with SEARCH_RESULTS; stale replies are dropped client-side by id.
  SEARCH_LOGS: "searchLogs",
  // Lazy history page (see history-window.ts): { type, requestId,
  // logId | sessionId, olderThan, pageSize?, epochToken? }. Requests the
  // page of conversation messages immediately OLDER than `olderThan` (the
  // oldestIndex a windowed LOG_VIEWED / sessionCreated shipped), cut by
  // the same message-count grammar. `pageSize` is a message count, clamped
  // server-side (MAX_HISTORY_PAGE_MESSAGES). `epochToken` echoes the token
  // the attestation carried (the full-log epochStartIndex the window was
  // cut at): a mismatch refuses with code "epoch_moved" (a mid-socket RESET
  // moved the epoch under the window; the client closes its seam on that
  // class). An absent token skips the check (pre-token clients). The id may
  // name a cold log OR a live session (both read the durable epoch view).
  // Correlated back with LOAD_OLDER_RESULT by requestId (the searchLogs
  // precedent); refusals (bad index, unknown log) ride the reply's `error`
  // field, still correlated -- never an uncorrelated guess.
  LOAD_OLDER: "loadOlder",
  // One omitted history image on demand: { type, requestId,
  // logId | sessionId, entryIndex, imageIndex }. Stands in for a history
  // frame's image STUB (see WireImageStub below): the server RE-READS the
  // durable log and answers FETCH_IMAGE_RESULT with exactly ONE image,
  // correlated by requestId. COORDINATES ONLY -- `entryIndex` is the
  // FULL-log entry index (the same append-only space the reconnect cursor
  // lives in, stable across appends and RESETs) and `imageIndex` the slot in
  // that entry's raw images array; no path ever comes off the wire. The id
  // names a cold log OR a live session (loadOlder's id space).
  FETCH_IMAGE: "fetchImage",
  // Profile management
  LIST_PROFILES: "listProfiles",
  SWITCH_PROFILE: "switchProfile",
  // Subagent task control (delegates to TaskManager primitives)
  TASK_INTERRUPT: "taskInterrupt",
  TASK_FOLLOWUP: "taskFollowup",
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
  // Create an EMPTY file: { type, requestId, path }. Refuses if the target
  // exists (file, dir or symlink -- nothing is clobbered) and if the parent
  // directory does not already exist (NO mkdir -p); the parent dir passes
  // resolveSafe like every other path. Replied with FILE_OP_RESULT.
  CREATE_FILE: "createFile",
  // Create a directory: { type, requestId, path }. Same gates as createFile
  // (no parents invented). Replied with FILE_OP_RESULT.
  CREATE_DIR: "createDir",
  // Rename/move within the workspace: { type, requestId, oldPath, newPath }.
  // BOTH paths pass resolveSafe; refuses a missing source, an existing
  // target (nothing is clobbered), and renaming a workspace ROOT itself.
  // Renaming a directory carries its subtree: resolveSafe runs on the target,
  // so descendants land wherever roots/deny say the NEW spelling does (a move
  // whose destination is denylisted/outside is refused before anything moves).
  // Replied with FILE_OP_RESULT.
  RENAME_PATH: "renamePath",
  // Delete a file, symlink or directory: { type, requestId, path }.
  // resolveSafe'd; refuses the workspace root. Directories are deleted
  // RECURSIVELY (the UI confirms with honest copy first; the server just
  // deletes). Symlinked entries are unlinked, never followed into their
  // target. Replied with FILE_OP_RESULT.
  DELETE_PATH: "deletePath",
  // Write a text file (the editor's save seam): { type, requestId, path,
  // content, baseMtimeMs? }. resolveSafe'd; refuses directories and symlink
  // targets at the path itself (O_NOFOLLOW posture -- never write THROUGH a
  // link). The content is capped (see MAX_FILE_WRITE_BYTES) and written
  // ATOMICALLY (per-op temp + rename in the same directory; the temp is
  // removed on failure). Same-path saves are SERIALIZED server-side (whole
  // gate+write+rename section), so two racing writers sharing one base get
  // exactly ONE ok and ONE conflict -- never two oks over a lost write.
  // Conflict gate: when the file exists and its current
  // mtimeMs differs from baseMtimeMs (a create-then-save flow sends 0 or
  // omits it), the reply carries conflict:true + the CURRENT mtimeMs and
  // NOTHING is written -- the editor offers overwrite (resend with the fresh
  // mtime) or reload. Success carries the new mtimeMs. Replied with
  // FILE_OP_RESULT.
  SAVE_FILE: "saveFile",
  // Edit ONE config value (settings editor, every setting the CONFIG FILE can
  // affect): { type, requestId, keyPath, value?, valueText? }. keyPath is a
  // dotted CONFIG PATH that may address array elements by index
  // ("providers[0].url"); zero path components come off the wire as filesystem
  // paths. Scalars ride `value` (string|number|boolean); JSON containers and
  // writeOnly secret replaces ride `valueText` (raw text the server
  // parses/revalidates). The write is a surgical JSONC text edit of exactly that
  // value (comments and formatting outside the value are user data and survive),
  // atomic, rescue-verified with rollback. Success carries needsRestart: config
  // resolves at startup, so the server NEVER claims live effect -- and it only
  // ever answers keys the file can resolve at all: a schema key whose declared
  // layers never read the settings file (a CLI-flag-only or default-only key)
  // is refused with zero bytes written, since no restart makes such an entry
  // mean anything. A secret replace echoes value:null + redacted:true -- never
  // the new value.
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
  // The RECENT LOGS frame, in two postures sharing one type (see
  // handlers-logs.ts coldLogsPayload / handleListLogs). FULL (no `full`
  // flag; the reply to a `since`-less listLogs, and the reply a delta
  // request falls back to when >LOG_LIST_WINDOW rows are newer): `logs` is
  // the NEWEST head of the filtered+sorted cold list (history-window.ts
  // LOG_LIST_WINDOW; DESCENDING lastActivityAt, id DESC tie-break -- NOT
  // the whole store) plus the seam attestation `hasOlder` (bool, always
  // present) and `olderCursor` ({ lastActivityAt, id } of the head's last
  // row; present ONLY while hasOlder) -- hand both to C2S loadOlderLogs to
  // page toward the bottom. DELTA (`full: false`; the reply to listLogs
  // WITH `since`): `logs` carries the rows strictly NEWER than the client's
  // cursor in the same descending order, at most LOG_LIST_WINDOW (more new
  // rows -> the full head frame instead, never a silent partial merge).
  // Doctrine: on a full:false frame the client PREPENDS and keeps its
  // paging seam, so a delta ships NO olderCursor/hasOlder (the held seam
  // stands; a stale one re-attests through gen). Both postures carry
  // `pinnedLogs` (present when non-empty): EVERY pinned cold row, in or
  // out of the head/new set -- row flags are per-row truth; the client
  // merges by id and dedupes. Both postures stamp `gen`: the membership
  // watermark (boot token + counter, list-gen.ts) the client compares
  // against its last-applied gen -- any frame continuing it at +0 (a plain
  // reply) or +1 (the frame IS the transition) is trustworthy; a gap means
  // the client missed a membership change it cannot patch locally, and it
  // re-attests with a `since`-less listLogs. Per-row fields are unchanged
  // from the pre-window wire.
  LOGS_LISTED: "logsListed",
  // Targeted RECENT LOGS membership push: ONE demoted row entered the cold
  // list (dismissSession). `row` is the exact LOGS_LISTED row grammar
  // (same coldLogRows path, single-row); `gen` is the post-bump watermark
  // (this frame IS the transition: +1). The client INSERTS by the shared
  // descending comparator (an idle session's last activity lands mid-list,
  // never assumed at the head) and dedupes by id.
  LOG_ROW_ADDED: "logRowAdded",
  // Targeted RECENT LOGS membership push: a row left the cold list (a cold
  // Continue/adoption makes the id live). `gen` again rides +1; the client
  // prunes the id from its list AND its held older pages, seam untouched
  // (olderCursor is value-based, so a removed row inside the seam cannot
  // strand the walk).
  LOG_ROW_REMOVED: "logRowRemoved",
  // Pin attestation broadcast (setPinned): `pinnedIds` is the COMPLETE
  // current pin-store set (live + cold ids). Pins are not a membership
  // change: no gen, no watermark movement. The client re-derives every
  // mark from the set wholesale (marks for rows it cannot see -- held
  // older pages, un-paged history -- drop with it).
  LOG_PINS: "logPins",
  // Windowed by default (history-window.ts): the reply carries the TRAILING
  // window of conversation messages; image payloads ride honest STUBS
  // ({ omitted, mimeType, bytes, entryIndex, imageIndex }), never
  // base64: one image comes back through C2S fetchImage by its coordinate.
  // Additive fields, present ONLY when older history exists: `oldestIndex`
  // (the epoch-log index of the oldest shipped entry -- hand it back as
  // loadOlder's `olderThan`), `hasOlder: true`, and `epochToken` (the
  // full-log epochStartIndex the window was cut at -- echo it on loadOlder;
  // a mid-socket RESET changes it and the server refuses the stale page with
  // code "epoch_moved"). A session that fits the window ships everything with
  // NONE of these fields; text fields are byte-identical to the
  // pre-windowing wire (image entries ship as stubs).
  LOG_VIEWED: "logViewed",
  // Notice that a cold log was deleted (and every client's row must prune):
  // the pre-existing targeted removal frame -- logRowRemoved carries rows
  // that merely LEFT the list; this one names a DEAD log (the client also
  // drops the pin and tears down a view of it). Stamps `gen` like every
  // membership transition (+1); the client's prune is idempotent, so it
  // applies regardless, and a watermark mismatch on this frame still
  // triggers the full re-attest.
  LOG_DELETED: "logDeleted",
  // Reply to C2S SEARCH_LOGS (requesting socket only), correlated by requestId.
  SEARCH_RESULTS: "searchResults",
  // Reply to C2S LOAD_OLDER (requesting socket only), correlated by
  // requestId. `entries` are capped exactly like LOG_VIEWED's (same seam);
  // `oldestIndex`/`hasOlder` re-attest the window head for the next page and
  // `epochToken` echoes the epoch the page was cut from (the client adopts
  // it). Refusals carry requestId + `error` and nothing else (the
  // LIST_DIR_RESULT posture); the stale-epoch refusal additionally carries
  // code:"epoch_moved" -- a machine-readable class the client CLOSES its
  // seam on (a mid-socket RESET moved the epoch; the held index means a
  // different entry). See handlers-logs.ts / history-window.ts.
  LOAD_OLDER_RESULT: "loadOlderResult",
  // Reply to C2S LOAD_OLDER_LOGS (requesting socket only), correlated by
  // requestId. `logs` are rows in the exact LOGS_LISTED row grammar (same
  // enrichment seam), DESCENDING, strictly older than the echoed cursor;
  // pinned rows NEVER ride pages (they ship on the base frame's pinnedLogs
  // and the client dedupes by id). `hasOlder` (bool) + `olderCursor`
  // (present while hasOlder) re-attest the seam for the next page.
  // Refusals (garbage cursor, dead store) carry requestId + `error` and
  // nothing else (the LIST_DIR_RESULT posture).
  LOAD_OLDER_LOGS_RESULT: "loadOlderLogsResult",
  // Reply to C2S FETCH_IMAGE (requesting socket only), correlated by
  // requestId. Success: `image` is the ONE WireImage re-read from the entry
  // (inline data, or the skipped+note posture over the cap). Refusals carry
  // requestId + `error` and nothing else (the LIST_DIR_RESULT posture). The
  // echoed `logId`/`entryIndex`/`imageIndex` let the client settle the exact
  // placeholder the reply belongs to. See handleFetchImage in handlers-logs.ts.
  FETCH_IMAGE_RESULT: "fetchImageResult",
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
  // Reply to C2S createFile / createDir / renamePath / deletePath / saveFile
  // (requesting socket only), correlated by requestId. One envelope for the
  // whole write family: the id already says which op it answers, and every
  // refusal is the same honest one-liner in `error` (see FileOpResultWire).
  FILE_OP_RESULT: "fileOpResult",
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
  // Live-only in-flight tool call (see s2cStreamingToolCall in wire-messages.ts):
  // additive, frame-only, never persisted and never replayed.
  STREAMING_TOOL_CALL: "streamingToolCall",
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

  // Subagent task ticker (broadcast; see the TaskManager observer branch
  // in server.ts; transcripts ride the worker's own session view)
  TASK_LIST: "taskList",
  TASK_UPDATE: "taskUpdate",
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
  /** B5 additive: the delegation task description when this id is an
   *  attested subagent log (Recent Logs hides it; the search row labels
   *  it). Omitted on interactive hits -- their bytes are unchanged. */
  subagentOf?: string;
  /** Whether this id is a live session (vs a cold log). */
  live: boolean;
  /** Excerpt lines, capped per log; each rides the matching text. */
  snippets: string[];
}

/** Caps on a single search reply (see searchLogs in ./handlers-logs.ts). */
export const MAX_SEARCH_HITS = 50;
export const MAX_SEARCH_SNIPPETS_PER_LOG = 3;

// ── RECENT LOGS list window (S2C logsListed / loadOlderLogsResult) ─────────

/**
 * The exclusive walk cursor over the DESCENDING cold-log list: the
 * [lastActivityAt, id] of the oldest row a frame shipped. The id is the
 * total-order tie-break (rows with equal lastActivityAt order by id
 * DESCENDING after the timestamp), so "strictly older than this cursor"
 * means `ts < cursor.ts || (ts == cursor.ts && id < cursor.id)` and a page
 * walk can never skip or repeat a row. Echoed back verbatim on C2S
 * loadOlderLogs. The SAME shape answers C2S listLogs' `since` (a newest-
 * held cursor): "strictly newer" is the negation riding the same total
 * order -- compareLogRowsDesc(row, cursor) < 0.
 */
export interface LogListCursorWire {
  lastActivityAt: number;
  id: string;
}

/**
 * The RECENT LOGS walk order: newest lastActivityAt first; equal
 * timestamps order by id DESCENDING, so an exclusive cursor selects
 * exactly the rows that come AFTER it in this order (and strictly-newer
 * selects exactly those BEFORE). id is never equal between two rows, so
 * the order is total and a page walk (or a client-side insert of a pushed
 * row) cannot skip or repeat a row across rebuilds. ONE definition for
 * server and client (the webui inserts logRowAdded pushes through here):
 * the delta order and the client order are literally the same comparator,
 * no drift. handlers-logs re-exports it for server-side consumers.
 */
export function compareLogRowsDesc(
  a: { lastActivityAt: number; id: string },
  b: { lastActivityAt: number; id: string },
): number {
  return b.lastActivityAt - a.lastActivityAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

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
 * A BYTE-HONEST STAND-IN for an image omitted from a HISTORY frame
 * (cold LOG_VIEWED, loadOlder pages, the windowed FULL attach replay; fresh
 * LIVE frames keep inline payloads). The page ships no base64; it attests
 * what was omitted (media type + payload size in bytes) plus the fetch
 * coordinate: `entryIndex` is the FULL-LOG entry index (append-only, the
 * cursor's own space -- a RESET only appends, so a coordinate stays valid
 * even after the epoch moves), `imageIndex` the slot in that entry's raw
 * images array. ONE C2S fetchImage trades the coordinate for the single
 * WireImage, capped by the same MAX_WIRE_IMAGE_BASE64_BYTES.
 *
 * Versioning: wire-additive, nothing removed. The webui is live-served and
 * moves with the server, so there is no old-client window to negotiate, and
 * a stale cached client cannot misrender a stub: with no `data` it lands in
 * every existing image sink's "no data, render the note" branch.
 */
export interface WireImageStub {
  mimeType: string;
  omitted: true;
  /** Base64 payload length the inline form would have carried (bytes). */
  bytes: number;
  entryIndex: number;
  imageIndex: number;
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
 * Normalize unknown image attachments (core ImageAttachment-shaped, the
 * legacy data-URL form, or an already-formed WireImageStub) into wire
 * entries, applying MAX_WIRE_IMAGE_BASE64_BYTES. Returns undefined when
 * there is nothing to send so messages stay lean.
 *
 * Stub pass-through: a well-formed stub ({ omitted: true } + non-negative
 * integer bytes/entryIndex/imageIndex) travels untouched -- this is how the
 * pre-stubbed FULL attach replay (attach.ts) carries placeholders through
 * the shared s2c builders without a second serializer. A MALFORMED stub is
 * dropped like any other junk entry (no invented coordinates).
 */
export function wireImages(
  images: unknown,
  capBytes: number = MAX_WIRE_IMAGE_BASE64_BYTES,
): Array<WireImage | WireImageStub> | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const out: Array<WireImage | WireImageStub> = [];
  for (const raw of images) {
    if (!raw || typeof raw !== "object") continue;
    const img = raw as Record<string, unknown>;
    if (img.omitted === true) {
      const bytes = typeof img.bytes === "number" && Number.isSafeInteger(img.bytes) && img.bytes >= 0 ? img.bytes : undefined;
      const entryIndex = typeof img.entryIndex === "number" && Number.isSafeInteger(img.entryIndex) && img.entryIndex >= 0 ? img.entryIndex : undefined;
      const imageIndex = typeof img.imageIndex === "number" && Number.isSafeInteger(img.imageIndex) && img.imageIndex >= 0 ? img.imageIndex : undefined;
      if (bytes === undefined || entryIndex === undefined || imageIndex === undefined) continue;
      out.push({
        mimeType: typeof img.mimeType === "string" && img.mimeType ? img.mimeType : "image/png",
        omitted: true,
        bytes,
        entryIndex,
        imageIndex,
      });
      continue;
    }
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

/**
 * The HISTORY-page image form: the SAME normalization as
 * wireImages (legacy data-URL stripping, mimeType default), but the payload
 * is replaced by an honest stub attesting the base64 size plus the fetch
 * coordinate (entryIndex = the FULL-log index of the entry these images
 * came from; imageIndex = the slot in the RAW array, junk entries included,
 * so the server's re-read of full[entryIndex].images[imageIndex] lands on
 * the very payload the client sees a box for). An already-stubbed entry
 * rides untouched. Undefined when nothing renderable exists (same posture
 * as wireImages).
 */
export function wireImageStubs(
  images: unknown,
  entryIndex: number,
): WireImageStub[] | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const out: WireImageStub[] = [];
  for (let imageIndex = 0; imageIndex < images.length; imageIndex++) {
    const raw = images[imageIndex];
    if (!raw || typeof raw !== "object") continue;
    const img = raw as Record<string, unknown>;
    if (img.omitted === true) {
      // Pre-stubbed upstream: only a well-formed stub survives (same gate
      // as the wireImages pass-through).
      const bytes = typeof img.bytes === "number" && Number.isSafeInteger(img.bytes) && img.bytes >= 0 ? img.bytes : undefined;
      const ei = typeof img.entryIndex === "number" && Number.isSafeInteger(img.entryIndex) && img.entryIndex >= 0 ? img.entryIndex : undefined;
      const ii = typeof img.imageIndex === "number" && Number.isSafeInteger(img.imageIndex) && img.imageIndex >= 0 ? img.imageIndex : undefined;
      if (bytes === undefined || ei === undefined || ii === undefined) continue;
      out.push({
        mimeType: typeof img.mimeType === "string" && img.mimeType ? img.mimeType : "image/png",
        omitted: true,
        bytes,
        entryIndex: ei,
        imageIndex: ii,
      });
      continue;
    }
    let mimeType = typeof img.mimeType === "string" ? img.mimeType : "";
    let data = typeof img.data === "string" ? img.data : "";
    if (!data && typeof img.url === "string") {
      const stripped = stripDataUrlPrefix(img.url);
      if (stripped) {
        mimeType = mimeType || stripped.mimeType;
        data = stripped.data;
      }
    }
    if (!data) continue;
    if (!mimeType) mimeType = "image/png";
    out.push({ mimeType, omitted: true, bytes: data.length, entryIndex, imageIndex });
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
 *  "[truncated]" marker. The schema bounds the row set, this bounds the fat
 *  values. */
export const MAX_CONFIG_VALUE_CHARS = 2000;
/** Row and finding caps per snapshot reply (belt over the schema's own
 *  bound: count rows, honor the truncated flag). KEPT at 400 for the all-fields editor (owner ruling 2026-11-09):
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
 * One leaf config key with its per-layer slots. ONE ROW PER LEAF THE CONFIG
 * FILE CAN AFFECT: a leaf whose declared layers include no `source: "config"`
 * layer (a CLI-flag-only key, or a schema-default-only key) is unreachable from
 * settings.json -- resolveKey walks only the declared chain, so a file entry is
 * dead bytes -- and such keys are OMITTED AT THE SOURCE: no row, in core or in
 * any extension section, whatever the server's argv holds. Keys declaring no
 * layers of their own stay (they resolve through their section's config layer).
 * A slot that the server cannot attest rides OMITTED (never a fabricated
 * default or a lying "unset"): the UI renders source badges only for the slots
 * present. `redacted: true`
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
   *  accept from setConfigKey (owner ruling 2026-11-09, read whole: EVERY
   *  SETTING THE CONFIG FILE CAN AFFECT -- the whitelist is retired, and a key
   *  the file cannot resolve ships no row at all, so its absence here is an
   *  omitted row rather than a missing stamp) and ABSENT only on the honest
   *  refusal classes,
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
// file. The reply attests the IN-PROCESS outcome, hook by hook (design §7.1):
// `applied` names the class the value actually landed in ("live" only when a
// migrated live path honored it), `needsRestart` is the legacy shim the
// server DERIVES (true iff applied === "restart-required"), and success with
// no migrated live path still says "restart-required" truthfully.

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
  /** LEGACY shim, kept: true iff applied === "restart-required". Clients read
   *  `applied` first and fall back to this (old client / new server, new
   *  client / old server -- both degrade honestly). DERIVED server-side,
   *  never maintained by hand. */
  needsRestart?: boolean;
  /** What actually happened in this process for THIS write:
   *  "live"            -- store swapped, effect observable now (hooks ok or none needed)
   *  "rebind"          -- store swapped + socket/listen-level rebind performed (notice says the cost)
   *  "next-session"    -- store swapped; new sessions/builds honor it; running artifacts keep theirs
   *  "restart-required"-- value persisted only (pre-C7 posture; also every
   *                       still-unruled §5 row, prepare-refusals, and last-good §2.3 outcomes) */
  applied?: "live" | "rebind" | "next-session" | "restart-required";
  /** Human one-liners, rendered verbatim under the row: downtime warnings,
   *  "new pool entries only", "keeps current values because re-resolution
   *  failed", in-flight semantics. formatError text where an error is cited
   *  (the §2.3 last-good error rides HERE -- §7.1's type is the wire
   *  contract and carries no separate liveApplyError field; see b4-notes). */
  appliedNotices?: string[];
  /** Per-hook ledger for this batch (§3): the truth of the side effects. */
  applyHooks?: Array<{ keyPath: string; phase: "prepare" | "apply";
                      status: "applied" | "degraded" | "refused"; error?: string }>;
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

// ── Workspace file tree, text reader, and file ops (C2S listDir/readFile/
//    createFile/createDir/renamePath/deletePath/saveFile → S2C replies) ──────
// The webui workbench's file path (see ./handlers-files.ts). Reads are pure;
// the write family (create/rename/delete/save) is confined the same way and
// never invents parents or clobbers targets. Zero new config keys.
// CONFINEMENT: every path that arrives off the wire passes
// Workspace.resolveSafe BEFORE any fs call (no pre-stat, no pre-read), and
// listings omit entries the denylist would reject -- the tree never offers a
// dead end. Rejections are honest one-line strings carried in the reply's
// `error` field (still requestId-correlated); stacks stay server-side
// (errorFrame covers the unexpected).

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
 *  provided one (the char cap bounds bytes; this bounds line bookkeeping).
 *  2000 so an ordinary source file lands complete in ONE read (the char cap
 *  still cuts the page honestly on wide/long-line files). */
export const READ_LINES_DEFAULT = 2000;
export const MAX_READ_LINES = 5000;
/** Ceiling on the UTF-8 byte length of one saveFile content. DERIVED from
 *  the read cap, at its SAME numeric ceiling measured in BYTES: the read cap
 *  counts 256 KiB of UTF-16 chars, and UTF-8 expands a char to at most 4
 *  bytes, so bytes are the tighter, honest unit to gate a write with -- any
 *  content that passes 262144 BYTES is also under the char cap for reading
 *  back (ASCII equality, multibyte strictly under). One number on the seam:
 *  MAX_FILE_WRITE_BYTES === MAX_FILE_READ_CHARS, pinned in tests. */
export const MAX_FILE_WRITE_BYTES = MAX_FILE_READ_CHARS;

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
  /** The file's mtime at read time, epoch ms (rounded, same rounding as the
   *  saveFile conflict gate). The editor records it as the buffer's BASE:
   *  a later saveFile carries it back, and a mismatch is the conflict.
   *  Additive: absent on error replies (there is no file to timestamp). */
  mtimeMs?: number;
  /** Honest one-line rejection (outside roots, denied, not found, is a
   *  directory -- use listDir, binary file (N bytes), line over the char
   *  cap). When set, content/truncated ride absent. */
  error?: string;
};

export type FileOpResultWire = {
  type: "fileOpResult";
  /** Echo of the C2S request id -- the id already names WHICH op answered. */
  requestId?: number;
  /** Success only: the op's primary path, resolved absolute (for renamePath
   *  the NEW path). */
  path?: string;
  /** Success on saveFile: the file's NEW mtime, epoch ms (rounded) -- the
   *  editor's new base. Conflict refusal: the CURRENT on-disk mtime, so an
   *  overwrite can be re-sent with it WITHOUT a reload round-trip. */
  mtimeMs?: number;
  /** saveFile refusal because the on-disk mtime moved past the caller's
   *  baseMtimeMs (or the file appeared while it sent 0/absent). Set means
   *  NOTHING was written and `mtimeMs` holds the fresh value; the editor
   *  offers overwrite (resend with that mtime) or reload. A plain `error`
   *  string rides alongside, so a client that ignores conflict still says
   *  something honest. */
  conflict?: boolean;
  /** Honest one-line rejection (escape, denied, exists, parent missing,
   *  root refused, over the write cap, ...). When set, path/mtimeMs ride
   *  absent EXCEPT on conflict (which carries the fresh mtimeMs). */
  error?: string;
};

// ── Subagent task feed ──────────────────────────────────────────────────────

/**
 * Display snapshot of one task agent (TaskManager.TaskInfo on the wire).
 * `status` stays a string here: the browser must not need the core enum.
 */
export interface TaskInfoWire {
  taskId: string;
  description: string;
  /** The delegating session (null: no parent); webui scopes its task strip to it. */
  sessionId: string | null;
  /**
   * Status token: running/queued/completed/failed/cancelled for live rows,
   * plus "interrupted" on durable rows (taskLineageWire): an open sidecar
   * record whose writer died. Additive token -- old clients render it with
   * the unknown-glyph fallback, never as a running task.
   */
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
  /**
   * True while the worker is blocked in a question-tool wait awaiting its
   * delegating manager (B2, rides from core's TaskInfo via the taskWire
   * spread). Additive: old clients ignore it; the nested subagent row badges
   * it. Live rows only -- durable (sidecar) rows never carry it.
   */
  questionPending?: boolean;
  /**
   * The worker agent's own session id -- the key of its durable session log
   * (a finished subagent is a finished session). Additive: old clients ignore
   * it; the row menu uses it for Export/Copy-path, and settled rows open
   * the transcript through it (viewLog / the session view).
   */
  agentSessionId?: string;
  /**
   * Server-derived display field (taskWire): the absolute log FILE path of
   * the worker's session, present iff agentSessionId rides and the core
   * path helper accepts it -- the cold rows' logPath grammar, feeding the
   * row menu's "Copy log file path" (hidden when omitted, never dead).
   */
  agentLogPath?: string;
  /**
   * Absolute workflow run dir (engine spawns only), straight from the
   * spawn-time metadata. Absent for delegate-style tasks -- which is what
   * makes the webui's Reveal-run-dir item honest-by-construction (no dir, no
   * item; never a clickable dead entry).
   */
  runDir?: string;
  /**
   * Row rebuilt from the durable spawn sidecar (taskLineageWire): a restart
   * survivor, NOT a task this process runs. The clock is frozen sidecar wall
   * time and the status is the recorded outcome or "interrupted". The webui
   * routes Open to the worker's durable log (agentSessionId -> viewLog /
   * LOG_VIEWED) -- the in-memory feed has no bytes for a past lifetime.
   * Additive: old clients render the row with the unknown-
   * glyph fallback and an inert transcript click.
   */
  durable?: boolean;
  /** This DURABLE card's worker session is live in this process
   *  (restart-adopted, not yet settled). Only overlayAdoptedLive emits it:
   *  status runs "running", inRun the exact bus fact, turnStartedAt stays
   *  null so the client ticks wall-since-spawn, and the click routes to
   *  the live attach. Absence is authoritative for "not live here". */
  adoptedLive?: true;
}

/**
 * Preview ceiling on a `streamingToolCall` frame (see s2cStreamingToolCall):
 * the ASSEMBLED preview never shows more than this, whichever posture rides.
 * Uncapped, a 200 KB write body streamed in 1 KB deltas would push tens of
 * megabytes of preview the transcript can never show. Beyond the cap the
 * client sees the head plus the `...[truncated]` marker (cumulative posture
 * caps the repeated frame; delta posture caps the sum of increments, ships
 * the marker once, then stops the slot). The final `toolCall` frame carries
 * the complete args either way.
 */
export const MAX_STREAMING_TOOL_CALL_ARGS_CHARS = 2000;

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
