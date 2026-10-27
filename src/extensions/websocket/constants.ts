// Shared bounds for the websocket extension, split out of server.ts: the
// transport frame cap and its derived app-level limits, the transcribe
// ceiling, and the timing constants for auth-pending reaping, idle cleanup,
// and the SIGTERM drain.

/** Activity-replay ring bounds (see SessionRegistry.recordTaskActivity). */
export const MAX_TASK_ACTIVITY_HISTORY_ITEMS = 300;
export const MAX_TASK_ACTIVITY_HISTORY_TASKS = 50;

// How long a socket that never authenticates is kept before the cleanup
// loop closes it. Comfortably longer than a legit AUTH round-trip (first
// message after open), short enough that anonymous sockets do not pile up.
export const PENDING_AUTH_TIMEOUT_MS = 30_000;

// Idle-cleanup grace: this many recently-active, client-free sessions stay
// hot past the idle timeout ("what was I doing" window); the rest go cold.
export const MAX_HOT_IDLE_SESSIONS = 3;

// SIGTERM drain bounds: 10s for a turn to reach its commit point, then
// interrupt and 2s for the unwind. Fits well inside systemd's default
// TimeoutStopSec (90s); a longer generation is cut, never half-persisted.
export const DRAIN_TIMEOUT_MS = 10_000;
export const DRAIN_POLL_MS = 100;
export const DRAIN_SETTLE_MS = 2_000;

// Cap for client-supplied completion input; nothing legit needs more.
export const MAX_COMPLETE_LINE = 10_000;

/**
 * Transport frame bound for upgraded sockets -- enforced on the `websocket:`
 * handler of the host's Bun.serve (see webui/server.ts, which applies it;
 * Bun quirk: a root-level maxPayloadLength is ignored in 1.4.2). Sized for
 * the largest legitimate single blob on one frame: a webui upload of one
 * file at the resolved uploadLimits.maxImageSize ceiling (root config;
 * legacy fileAttachment alias) riding base64 on a C2S send (~4/3 expansion)
 * plus its JSON envelope -- or a max-size transcribe recording, whose cap is
 * fixed. The bound sits just above the larger of the two so a single
 * max-size blob always reaches the app-level parsers, whatever the image
 * ceiling resolves to; at the defaults it stays under Bun's 16 MiB default
 * (a genuine tightening). Known gap: multi-file sends ride one frame too, so
 * an aggregate send larger than this bound dies at the socket instead of
 * answering "too many files" (chunked uploads are out of scope). Computed
 * from the same resolved ceiling the upload path enforces
 * (@core/config/upload-limits.ts) -- one ceiling, one home (no drift).
 */
export function wsMaxPayloadBytes(maxImageSize: number): number {
  // Audio rides the same frames as images; the bound must never undershoot
  // the transcribe cap, or an oversized recording dies at the socket instead
  // of answering with the app-level "audio too large" (the original bug).
  const biggestBlob = Math.max(maxImageSize, MAX_TRANSCRIBE_AUDIO_BYTES);
  return 4 * Math.ceil(biggestBlob / 3) + 1024 * 1024;
}

// Ceiling on one transcribe upload. It USED to mirror OpenAI's whisper 25MB
// limit -- unreachable: audio rides the same WS frames as uploads, and a
// 25 MB blob base64's past the frame bound, so the socket closed at the
// transport instead of answering with the app-level "audio too large".
// It is now a fixed 10 MiB and wsMaxPayloadBytes guarantees the frame bound
// always carries it (same ~4/3 + envelope shape as an image upload), so any
// recording the transport accepts gets the explicit app-level rejection; a
// recording so large its FRAME exceeds the bound dies at the socket like any
// oversized frame (chunked uploads are out of scope). Checked against the
// base64 string length before decoding, so an oversized blob never costs a
// decode.
export const MAX_TRANSCRIBE_AUDIO_BYTES = 10 * 1024 * 1024;
/** @internal Exposed for testing (bound-alignment pin against the frame cap). */
export const MAX_TRANSCRIBE_BASE64_CHARS = Math.ceil(MAX_TRANSCRIBE_AUDIO_BYTES / 3) * 4;
