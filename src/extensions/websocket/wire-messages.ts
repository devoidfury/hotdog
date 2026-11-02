// S2C wire message builders: the single byte-home for the conversation
// message shape. The live OUTPUT_EVENT mapper (websocket-channel.ts) and both
// history-replay paths (replay.ts: log entries and in-memory Messages) build
// their frames here, so the client sees one wire shape regardless of source.
// Any field-order or guard change lands once, for live and replay together.

import { OUTPUT_EVENT, type FileAttachmentView, type OutputEvent } from "@core/context/output.ts";
import { summarizeToolArgs } from "@core/extensions/tool-utils.ts";
import type { ArgDisplay } from "@core/extensions/tool-registry.ts";
import { toolContentText } from "@utils/tool-content.ts";
import { S2C, type S2CType, wireImages } from "./protocol.ts";

/** Mapper options: resolves a tool's per-parameter display hints (argDisplay). */
export interface WireMapOptions {
  argDisplay?: (toolName: string) => Record<string, ArgDisplay> | undefined;
}

/** Content-only messages (thinking, assistant text, streaming chunks, ...). */
export function s2cContent(
  type: S2CType,
  sessionId: string,
  content: string,
): Record<string, unknown> {
  return { type, sessionId, content };
}

export function s2cUserMessage(
  sessionId: string,
  o: { content: string; files?: FileAttachmentView[]; images?: unknown },
): Record<string, unknown> {
  const imgs = wireImages(o.images);
  return {
    type: S2C.USER_MESSAGE,
    sessionId,
    content: o.content,
    ...(o.files && o.files.length > 0 ? { files: o.files } : {}),
    ...(imgs ? { images: imgs } : {}),
  };
}

/**
 * A tool call frame. argsSummary is the shared hint-driven fold
 * (ToolMetadata.argDisplay): the same shape the terminal's template args slot
 * prints, ANSI-free. Empty summaries ride no field; clients fall back to
 * their own header.
 */
export function s2cToolCall(
  sessionId: string,
  o: { name: string; args: string; toolCallId?: string; argDisplay?: Record<string, ArgDisplay> },
): Record<string, unknown> {
  const summary = summarizeToolArgs(o.args, undefined, o.argDisplay);
  return {
    type: S2C.TOOL_CALL,
    sessionId,
    name: o.name,
    args: o.args,
    // The call id lets clients pair results to calls.
    ...(o.toolCallId ? { toolCallId: o.toolCallId } : {}),
    ...(summary ? { argsSummary: summary } : {}),
  };
}

export function s2cToolResult(
  sessionId: string,
  o: {
    name: string;
    content: string | Array<unknown> | null | undefined;
    toolCallId?: string | null;
    images?: unknown;
    error?: string;
  },
): Record<string, unknown> {
  const imgs = wireImages(o.images);
  return {
    type: S2C.TOOL_RESULT,
    sessionId,
    name: o.name,
    // Content parts travel as text on this transport: the browser has no
    // part renderer, so flatten the fields here (display, not a format).
    output: toolContentText(o.content),
    ...(o.toolCallId ? { toolCallId: o.toolCallId } : {}),
    ...(o.error !== undefined ? { error: o.error } : {}),
    ...(imgs ? { images: imgs } : {}),
  };
}

/** Loose source for TOKEN_USAGE: live events and raw log entries both fit. */
export interface TokenUsageWireSource {
  sessionPromptTokens?: number;
  sessionCompletionTokens?: number;
  sessionTotalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  contextWindow?: number;
}

export function s2cTokenUsage(
  sessionId: string,
  u: TokenUsageWireSource,
): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    type: S2C.TOKEN_USAGE,
    sessionId,
    sessionPromptTokens: u.sessionPromptTokens || 0,
    sessionCompletionTokens: u.sessionCompletionTokens || 0,
    sessionTotalTokens: u.sessionTotalTokens || 0,
    promptTokens: u.promptTokens || 0,
    completionTokens: u.completionTokens || 0,
    totalTokens: u.totalTokens || 0,
    cachedTokens: u.cachedTokens || 0,
  };
  if (Number.isFinite(u.contextWindow)) msg.contextWindow = u.contextWindow;
  return msg;
}

/**
 * Map a live OutputEvent onto an S2C wire message. Adding an event type here
 * IS a protocol change; returning null keeps an event off the wire.
 */
export function toS2CMessage(
  event: OutputEvent,
  sessionId: string,
  opts?: WireMapOptions,
): Record<string, unknown> | null {
  switch (event.type) {
    case OUTPUT_EVENT.USER_MESSAGE:
      return s2cUserMessage(sessionId, { content: event.content, files: event.files, images: event.images });
    case OUTPUT_EVENT.ASSISTANT_MESSAGE:
      return s2cContent(S2C.ASSISTANT_MESSAGE, sessionId, event.content);
    case OUTPUT_EVENT.STREAMING_CHUNK:
      return s2cContent(S2C.STREAMING_CHUNK, sessionId, event.content);
    case OUTPUT_EVENT.STREAMING_REASONING_CHUNK:
      return s2cContent(S2C.STREAMING_REASONING_CHUNK, sessionId, event.content);
    case OUTPUT_EVENT.THINKING:
      return s2cContent(S2C.THINKING, sessionId, event.content);
    case OUTPUT_EVENT.TOOL_CALL:
      return s2cToolCall(sessionId, {
        name: event.toolName,
        args: event.input,
        toolCallId: event.toolCallId,
        argDisplay: opts?.argDisplay?.(event.toolName),
      });
    case OUTPUT_EVENT.TOOL_RESULT:
      return s2cToolResult(sessionId, {
        name: event.toolName,
        content: event.content,
        toolCallId: event.toolCallId,
        images: event.images,
        error: event.error,
      });
    case OUTPUT_EVENT.COMPACTING:
      return { type: S2C.COMPACTING, sessionId, message: event.message };
    case OUTPUT_EVENT.COMMAND_RESULT:
      return s2cContent(S2C.COMMAND_RESULT, sessionId, event.content);
    case OUTPUT_EVENT.QUESTION:
      return { type: S2C.QUESTION, sessionId, questions: event.questions };
    case OUTPUT_EVENT.SYSTEM_MESSAGE:
      return s2cContent(S2C.SYSTEM_MESSAGE, sessionId, event.content);
    case OUTPUT_EVENT.STREAM_RESET:
      // Payload-free: { type, sessionId } is the whole instruction.
      return { type: S2C.STREAM_RESET, sessionId };
    case OUTPUT_EVENT.TASK_PROGRESS:
      return {
        type: S2C.TASK_PROGRESS,
        sessionId,
        taskId: event.taskId,
        status: event.status,
        ...(event.message !== undefined ? { message: event.message } : {}),
      };
    case OUTPUT_EVENT.TOKEN_USAGE:
      return s2cTokenUsage(sessionId, event);
    case OUTPUT_EVENT.COMPACTION_RESULT:
      return {
        type: S2C.COMPACTION_RESULT,
        sessionId,
        summary: event.summary,
        messagesCompacted: event.messagesCompacted,
      };
    case OUTPUT_EVENT.SESSION_STATE:
      return { type: S2C.SESSION_STATE, sessionId, key: event.key, value: event.value };
    default:
      // Frame-only events (QUEUE_UPDATE, TOOL_CALL_DELTA) intentionally stay
      // off the wire; write() drops what maps to null.
      return null;
  }
}
