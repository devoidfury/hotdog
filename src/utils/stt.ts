/**
 * Speech-to-text client for OpenAI-compatible audio transcriptions endpoints
 * (multipart/form-data POST -> { "text": "..." }), e.g. a whisper.cpp
 * llama-swap entry at http://localhost:8080/v1/audio/transcriptions.
 *
 * No config imports: callers pass resolved url/model values
 * (centralized-defaults rule). Consumed by the websocket server's
 * `transcribe` handler and (later) CLI dictation.
 */

import { hotdogFetch } from "./fetch.ts";

export interface TranscribeAudioOptions {
  /**
   * Full endpoint URL, e.g. http://localhost:8080/v1/audio/transcriptions.
   * Basic auth may ride the userinfo (`http://:KEY@host/...`): it is
   * stripped from the request URL and sent as an Authorization header.
   */
  url: string;
  /**
   * Authorization header for the endpoint (e.g. `Bearer <provider key>` from
   * the model registry). Wins over userinfo embedded in the URL.
   */
  authHeader?: string | null;
  /** Model name sent as the `model` form field; omitted when null/undefined. */
  model?: string | null;
  /** Raw audio bytes. */
  audio: Uint8Array;
  /** Upload filename; the extension helps servers sniff the container format. */
  filename?: string;
  /** Content type of the audio bytes (default application/octet-stream). */
  mimeType?: string;
}

// Container hint for the default filename: whisper-style servers key format
// detection off the file extension, so a bare "audio" upload can be rejected.
const MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/mpga": "mpga",
};

// Credentials embedded in the endpoint URL (`http://:KEY@host/v1/...`) are
// stripped from the request URL and re-sent as an HTTP Basic Authorization
// header: Bun's fetch drops userinfo silently, and llama-swap (the lab
// backend) accepts Basic. Keeps sttUrl a single self-contained config key.
function splitUrlAuth(rawUrl: string): { url: string; authHeader?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl };
  }
  if (!parsed.username && !parsed.password) return { url: rawUrl };
  const credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
  parsed.username = "";
  parsed.password = "";
  return {
    url: parsed.toString(),
    authHeader: `Basic ${Buffer.from(credentials).toString("base64")}`,
  };
}

/** Transcribe one audio clip; resolves with the recognized text. */
export async function transcribeAudio(
  opts: TranscribeAudioOptions,
): Promise<string> {
  const mimeType = opts.mimeType || "application/octet-stream";
  const filename = opts.filename || `audio.${MIME_EXTENSIONS[mimeType] ?? "bin"}`;

  const form = new FormData();
  // slice() normalizes to an ArrayBuffer-backed copy (Uint8Array<ArrayBufferLike>
  // is not a BlobPart); the copy is noise next to the upload itself.
  form.append("file", new Blob([opts.audio.slice()], { type: mimeType }), filename);
  if (opts.model) form.append("model", opts.model);

  const { url, authHeader: urlAuth } = splitUrlAuth(opts.url);
  const auth = opts.authHeader ?? urlAuth;
  const resp = await hotdogFetch(url, {
    method: "POST",
    body: form,
    ...(auth ? { headers: { Authorization: auth } } : {}),
  });
  if (!resp.ok) {
    // Body snippet keeps the failure readable (backends explain themselves).
    const body = (await resp.text().catch(() => "")).slice(0, 500).trim();
    throw new Error(
      `STT request failed: ${resp.status} ${resp.statusText}${body ? `: ${body}` : ""}`,
    );
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    throw new Error("STT response is not valid JSON");
  }
  const text = (json as Record<string, unknown> | null)?.text;
  if (typeof text !== "string") {
    throw new Error('STT response missing string "text" field');
  }
  return text;
}
