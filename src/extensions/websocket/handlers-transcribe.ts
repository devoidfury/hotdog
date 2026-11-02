// Voice transcription (push-to-talk / dictation).

import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { transcribeAudio } from "@utils/stt.ts";
import {
  C2S,
  S2C,
  errorText,
  type C2SMessage,
  type TranscribeRequestWire,
  type TranscriptReplyWire,
} from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import { MAX_TRANSCRIBE_AUDIO_BYTES, MAX_TRANSCRIBE_BASE64_CHARS } from "./constants.ts";
import type { RouteContext } from "./route-types.ts";

/**
 * Parses (never casts) one `transcribe` off an untrusted socket into
 * TranscribeRequestWire. This is the only place its fields are checked, so
 * everything downstream reads typed values; a rejected payload comes back as the
 * in-band error text. `id` comes from the caller: a reply needs the correlation
 * key even when the rest of the request is junk.
 */
function parseTranscribeRequest(
  msg: C2SMessage,
  id: string,
): TranscribeRequestWire | { error: string } {
  if (typeof msg.data !== "string" || msg.data.length === 0) {
    return { error: "transcribe: missing audio data" };
  }
  if (msg.data.length > MAX_TRANSCRIBE_BASE64_CHARS) {
    return {
      error: `transcribe: audio too large (limit ${MAX_TRANSCRIBE_AUDIO_BYTES / 1024 / 1024}MB)`,
    };
  }
  return {
    type: C2S.TRANSCRIBE,
    id,
    mimeType: typeof msg.mimeType === "string" ? msg.mimeType : undefined,
    data: msg.data,
  };
}

/**
 * Push-to-talk transcription: decode the base64 audio, forward it to the
 * OpenAI-compatible endpoint resolved from config (`sttUrl`/`sttModel`), and
 * answer with a `transcript` message correlated by the client's request id.
 * All failures land in-band ({ ok:false, error }): a missing or broken STT
 * backend must never drop the socket.
 */
export async function handleTranscribe(ctx: RouteContext): Promise<void> {
  const { ws, msg, registry } = ctx;
  const stt = registry.sttTarget;
  const id = typeof msg.id === "string" ? msg.id : "";
  const reply = (payload: { ok: boolean; text?: string; error?: string }) => {
    const wire: TranscriptReplyWire = { type: S2C.TRANSCRIPT, id, ...payload };
    SessionRegistry.sendSafe(ws, wire);
  };

  const req = parseTranscribeRequest(msg, id);
  if ("error" in req) {
    reply({ ok: false, error: req.error });
    return;
  }
  if (!stt) {
    reply({
      ok: false,
      error:
        "Speech-to-text is not configured (no audio-capable model in the registry; set sttUrl to override)",
    });
    return;
  }

  try {
    const audio = new Uint8Array(Buffer.from(req.data, "base64"));
    const text = await transcribeAudio({
      url: stt.url,
      model: stt.model,
      authHeader: stt.authHeader,
      audio,
      mimeType: req.mimeType,
    });
    reply({ ok: true, text });
  } catch (err: unknown) {
    logger.error(`[websocket] transcribe failed: ${formatError(err)}`);
    reply({ ok: false, error: errorText(err) });
  }
}
