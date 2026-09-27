// Webui upload parsing: base64 files arriving on a C2S `send` message turn
// into content parts and image attachments. Chosen over multipart HTTP: the
// websocket already carries JSON, auth is settled, and one message means
// one atomic send (text + files) with no upload-id state on the server.
//
// Provenance note: the CALLER (websocket server) enqueues the resulting
// parts with source "harness". The MessageBus queue boundary flattens any
// parts array lacking harness provenance, so only this server-side parse --
// never client JSON directly -- may produce file-include parts.

import type { ImageAttachment } from "@core/context/message.ts";
import type { UploadFileWire } from "./protocol.ts";

export interface UploadLimits {
  /** Per-file byte ceiling (after base64 decode). */
  maxFileSize: number;
  /** Max files per message. */
  maxFiles: number;
  /** Whether the session's current model accepts image input. */
  vision: boolean;
}

export interface ParsedUploads {
  /** file-include parts for non-image files, in arrival order. */
  parts: Array<Record<string, unknown>>;
  /** Image attachments (Message.images shape) for image files. */
  images: ImageAttachment[];
  /** Human-readable rejections; non-empty means the whole send is refused. */
  errors: string[];
}

/**
 * Parse and validate uploaded files. Any entry that fails validation adds
 * an error and produces no part -- the caller refuses the entire message so
 * nothing is silently dropped (the client shows the errors).
 */
export function parseUploadedFiles(
  files: unknown,
  { maxFileSize, maxFiles, vision }: UploadLimits,
): ParsedUploads {
  const parts: Array<Record<string, unknown>> = [];
  const images: ImageAttachment[] = [];
  const errors: string[] = [];
  if (!Array.isArray(files) || files.length === 0) return { parts, images, errors };

  if (files.length > maxFiles) {
    errors.push(`${files.length} files exceeds the ${maxFiles}-file limit`);
    return { parts, images, errors };
  }

  for (const raw of files) {
    const file = raw as Partial<UploadFileWire> | null | undefined;
    const rawName = file?.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const data = typeof file?.data === "string" ? file.data : "";
    if (!name || !data) {
      errors.push("each upload needs a name and base64 data");
      continue;
    }
    // Cheap ceiling on the base64 TEXT length before decoding, so an
    // oversized blob never pays (or amplifies) a decode.
    if (data.length > 4 * Math.ceil(maxFileSize / 3)) {
      errors.push(`'${name}' is too large (${estimateBytes(data.length)} bytes > ${maxFileSize} limit)`);
      continue;
    }
    const buf = Buffer.from(data, "base64");
    if (buf.byteLength === 0) {
      errors.push(`'${name}' is not valid base64`);
      continue;
    }
    if (buf.byteLength > maxFileSize) {
      errors.push(`'${name}' is too large (${buf.byteLength} bytes > ${maxFileSize} limit)`);
      continue;
    }
    const rawMime = file?.mimeType;
    const mimeType =
      typeof rawMime === "string" && rawMime ? rawMime : "application/octet-stream";
    if (mimeType.startsWith("image/")) {
      // Vision gate mirrors file-attachment: a non-vision model never gets image bytes.
      if (!vision) {
        errors.push(`'${name}' is an image but the current model does not accept image input`);
        continue;
      }
      images.push({ type: "image_url", mimeType, data });
    } else {
      parts.push({ type: "file-include", path: name, content: buf.toString("utf-8") });
    }
  }

  return { parts, images, errors };
}

/** Bytes represented by n base64 characters (upper bound, padding ignored). */
function estimateBytes(b64Length: number): number {
  return Math.floor((b64Length * 3) / 4);
}
