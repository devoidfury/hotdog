// codemode caps: v1 constants, not config keys. Every knob has one default;
// per-call tuning happens through the envelope params (timeout_ms,
// max_output_chars), which may tighten a limit but never loosen it (values
// over the ceilings are clamped down in tool.ts).

/** Wall-clock deadline for a script run when timeout_ms is absent. */
export const WALL_DEFAULT_MS = 60_000;

/** Wall-time ceiling: timeout_ms above this is clamped down, never honored. */
export const WALL_CEILING_MS = 300_000;

/** Inner tool calls per script; not parameter-tunable. */
export const MAX_INNER_CALLS = 64;

/** Script-output characters kept (head + tail keep); max_output_chars can
 *  only lower it -- default and ceiling coincide. */
export const OUTPUT_KEEP_CHARS = 40_000;

/** Total streamed output the host tolerates before killing the child. */
export const OUTPUT_STREAM_CAP_BYTES = 16 * 1024 * 1024;

/** Streamed out-frame count cap: the CHILD must enforce it -- the host keeps
 *  all output until the script ends, so a chatty script dies from inside, not
 *  from a host that stopped reading. */
export const OUTPUT_STREAM_MAX_ITEMS = 100_000;

/** NDJSON frame cap, both directions: a quarter of the exec-wire bound
 *  MAX_FRAME_BYTES (4_000_000, src/core/tool-exec-protocol.ts). */
export const FRAME_MAX_BYTES = 1024 * 1024;

/** Concurrent fenced children; the third waits FIFO, then errors. */
export const MAX_LIVE_CHILDREN = 2;

/** How long a child waits for an admission slot before "all runners busy". */
export const ADMISSION_WAIT_MS = 60_000;

/** store()/load() quotas: JSON only, per-value and total. The entry
 *  bytes a run commits are key + JSON value; the count cap bounds the
 *  per-line framing (runId/ts/framing) so store.jsonl growth, the pending
 *  overlay's RAM, and each fold's re-parse stay bounded even at tiny values. */
export const STORE_VALUE_MAX_BYTES = 256 * 1024;
export const STORE_TOTAL_MAX_BYTES = 1024 * 1024;
export const STORE_KEY_MAX_BYTES = 1024;
export const STORE_MAX_ENTRIES = 4096;

/** Per-script in-flight inner dispatch clamp: keeps the gate queue sane --
 *  overlap is allowed, a 64-way fan-out at the gate is not. */
export const INNER_CALL_CONCURRENCY = 4;

/** searchTools default result count: a result list feeds a script, not a
 *  scroll. Explicit limits below 1 or non-finite fall back to this. */
export const SEARCH_TOOLS_DEFAULT_LIMIT = 8;

/** Bounded-window chunk + total scan cap for head/tail: the cap is
 *  what keeps a newline-starved file (single-line bundle, \r-only log) from
 *  walking the whole thing into host memory -- head/tail run local. */
export const WINDOW_CHUNK_BYTES = 64 * 1024;
export const WINDOW_SCAN_CAP_BYTES = 8 * 1024 * 1024;

/** Digest budgets: the digest is capped separately from the script-output
 *  budget. */
export const DIGEST_MAX_ROWS = 256;
export const DIGEST_ARGS_MAX_CHARS = 8192;
export const DIGEST_ARGS_TOTAL_MAX_CHARS = 32768;
export const DIGEST_ERROR_MAX_CHARS = 500;
