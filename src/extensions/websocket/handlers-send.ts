// Prompt delivery (text + webui uploads) and turn cancellation.

import { modelAcceptsImages } from "@core/config/providers.ts";
import { uploadLimits } from "@core/config/upload-limits.ts";
import { parseUploadedFiles } from "./uploads.ts";
import { S2C } from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import { dismissResumedQuestions } from "./resume.ts";
import type { RouteContext } from "./route-types.ts";

export function handleSend(ctx: RouteContext): void {
  const { ws, msg, registry, bridge, core } = ctx;
  const sessionManager = registry.getSessionManager();
  const sid = msg.sessionId as string | undefined;
  const text = typeof msg.content === "string" ? msg.content : "";
  const files = msg.files;
  if (!sid) return;

  // A new prompt supersedes any resumed question still on hold.
  dismissResumedQuestions(bridge, registry, sid);

  if (Array.isArray(files) && files.length > 0) {
    // Webui upload: base64 files on the send message.
    // Validation is all-or-nothing so nothing is ever silently dropped.
    // Provenance: the parse happened server-side, so this enqueue is harness-authoritative --
    // the only way file-include parts survive the bus queue boundary (sanitizeQueuedContent).
    const agent = sessionManager.getAgentBySessionId(sid);
    const limits = uploadLimits(core);
    const parsed = parseUploadedFiles(files, {
      ...limits,
      vision: modelAcceptsImages(agent?.model, (agent as { modelRegistry?: Record<string, never> } | undefined)?.modelRegistry),
    });
    if (parsed.errors.length > 0) {
      SessionRegistry.sendSafe(ws, {
        type: S2C.ERROR,
        message: `Upload rejected: ${parsed.errors.join("; ")}`,
      });
      return;
    }
    const content: Array<Record<string, unknown>> = [];
    if (text) content.push({ type: "untrusted", text });
    content.push(...parsed.parts);
    if (content.length === 0 && parsed.images.length === 0) return;
    registry.touch(sid);
    registry.incrementUserMessageCount(sid);
    sessionManager.enqueue(sid, content, {
      source: "harness",
      ...(parsed.images.length > 0 ? { images: parsed.images } : {}),
    });
    return;
  }

  if (text) {
    registry.touch(sid);
    registry.incrementUserMessageCount(sid);
    sessionManager.enqueue(
      sid,
      text,
      msg.steering === true ? { steering: true } : undefined,
    );
  }
}

export function handleCancel(ctx: RouteContext): void {
  const { msg, registry, bridge } = ctx;
  if (!msg.sessionId) return;
  // interrupt() keeps the bus alive for follow-ups; cancel() would abort it.
  registry.getSessionManager().interrupt(msg.sessionId as string);
  // Unblock a pending question-tool call so it can't hang.
  bridge.cancel(msg.sessionId as string);
}
