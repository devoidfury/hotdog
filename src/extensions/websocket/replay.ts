// History replay, split out of server.ts: log-slice replay (the reconnect
// cursor's coordinate space), in-memory message replay for forks, and the
// pending-question re-send after attach.

import type { AgentLike } from "@core/session/index.ts";
import { conversationContent, LOG_SOURCE, type LogEntry } from "@core/session/session-log.ts";
import type { Agent } from "@core/agent.ts";
import { safeCallDisplay, type ToolRegistry } from "@core/extensions/tool-registry.ts";
import { summarizeToolArgs } from "@core/extensions/tool-utils.ts";
import type { WebSocketQuestionBridge } from "./question-input.ts";
import { S2C, wireImages } from "./protocol.ts";
import { splitFileIncludes, toolContentText, wrapperContentText } from "@utils/tool-content.ts";
import { SessionRegistry } from "./session-registry.ts";
import type { HotdogServerSocket } from "./socket.ts";

/**
 * Hint-driven args fold for TOOL_CALL messages: the same
 * ToolMetadata.argDisplay summary the terminal sink prints (ANSI-free).
 * Empty summaries ride no field; clients fall back to their own header.
 */
function argsSummaryField(
  registry: ToolRegistry | undefined,
  name: string,
  args: string,
): Record<string, string> {
  const summary = summarizeToolArgs(args, undefined, registry?.getMetadata?.(name)?.argDisplay);
  return summary ? { argsSummary: summary } : {};
}

/**
 * Replay a slice of a session's FULL log as S2C messages. `startIdx` is the
 * client's replay cursor: a position in the full log (append-only -- a RESET
 * never moves an earlier entry), so the slice is exactly the tail the
 * client does not hold. Full replays pass the epoch's start as `startIdx`.
 * Only conversation entries are sent; bookkeeping records never surface.
 * Tool-result names resolve across the WHOLE log, so a result whose call
 * predates the slice (even across a RESET) carries the right name.
 */
export function replayLogSlice(
  ws: HotdogServerSocket<unknown>,
  sessionId: string,
  entries: LogEntry[],
  startIdx: number,
  toolRegistry?: ToolRegistry,
): void {
  const callNames = new Map<string, string>();
  for (const e of entries) {
    if (e.source !== LOG_SOURCE.LLM || !Array.isArray(e.tool_calls)) continue;
    for (const tc of e.tool_calls as Array<{ id?: string; function?: { name?: string } }>) {
      if (tc?.id && tc.function?.name) callNames.set(tc.id, tc.function.name);
    }
  }

  for (let i = startIdx; i < entries.length; i++) {
    const e = entries[i]!;
    // Conversation sources only hold text or content parts (see the helper).
    const content = conversationContent(e);
    switch (e.source) {
      case LOG_SOURCE.INPUT:
      case LOG_SOURCE.PROMPT: {
        const userImgs = wireImages(e.images);
        const display = splitFileIncludes(content);
        ws.send(
          JSON.stringify({
            type: S2C.USER_MESSAGE,
            sessionId,
            content: display.text,
            ...(display.files.length > 0 ? { files: display.files } : {}),
            ...(userImgs ? { images: userImgs } : {}),
          }),
        );
        break;
      }
      case LOG_SOURCE.LLM: {
        if (e.reasoning_content) {
          ws.send(
            JSON.stringify({ type: S2C.THINKING, sessionId, content: e.reasoning_content }),
          );
        }
        const toolCalls = Array.isArray(e.tool_calls)
          ? (e.tool_calls as Array<{ id: string; function?: { name?: string; arguments?: string } }>)
          : undefined;
        if (toolCalls && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            const name = tc.function?.name || "unknown";
            const args = tc.function?.arguments || "{}";
            // Replay has no live tool object: resolve the display header from
            // the registry by name (undefined when the tool is unknown now).
            const display = safeCallDisplay(toolRegistry?.get(name), args);
            ws.send(
              JSON.stringify({
                type: S2C.TOOL_CALL,
                sessionId,
                name,
                args,
                ...(tc.id ? { toolCallId: tc.id } : {}),
                ...(display !== undefined ? { display } : {}),
                ...argsSummaryField(toolRegistry, name, args),
              }),
            );
          }
        }
        const text = wrapperContentText(content);
        if (text) {
          ws.send(JSON.stringify({ type: S2C.ASSISTANT_MESSAGE, sessionId, content: text }));
        }
        break;
      }
      case LOG_SOURCE.TOOL_RESULT: {
        const toolImgs = wireImages(e.images);
        const callId = typeof e.tool_call_id === "string" ? e.tool_call_id : undefined;
        ws.send(
          JSON.stringify({
            type: S2C.TOOL_RESULT,
            sessionId,
            name: (callId ? callNames.get(callId) : undefined) || "unknown",
            output: toolContentText(content ?? ""),
            ...(callId ? { toolCallId: callId } : {}),
            ...(toolImgs ? { images: toolImgs } : {}),
          }),
        );
        break;
      }
      default:
        break; // bookkeeping records never replay as conversation
    }
  }
}

// Re-emit a session's history as S2C messages so the frontend can reconstruct the chat.
export function replaySessionHistory(
  sessionId: string,
  agent: AgentLike,
  ws: HotdogServerSocket<unknown>,
): void {
  const messages = agent.getMessages();

  try {
    let pendingToolCalls: Array<{
      id: string;
      function?: { name?: string; arguments?: string };
    }> = [];

    for (const msg of messages) {
      switch (msg.role) {
        case "user": {
          const userImgs = wireImages((msg as { images?: unknown }).images);
          // Attachments in `files`; the text excludes file-include parts.
          const display = splitFileIncludes(msg.content);
          ws.send(
            JSON.stringify({
              type: S2C.USER_MESSAGE,
              sessionId,
              content: display.text,
              ...(display.files.length > 0 ? { files: display.files } : {}),
              ...(userImgs ? { images: userImgs } : {}),
            }),
          );
          break;
        }

        case "assistant": {
          if (msg.reasoningContent) {
            ws.send(
              JSON.stringify({
                type: S2C.THINKING,
                sessionId,
                content: msg.reasoningContent,
              }),
            );
          }

          const toolCalls = msg.toolCalls as
            | Array<{
                id: string;
                function?: { name?: string; arguments?: string };
              }>
            | undefined;
          if (toolCalls && toolCalls.length > 0) {
            pendingToolCalls = toolCalls;
            for (const tc of toolCalls) {
              const name = tc.function?.name || "unknown";
              const args = tc.function?.arguments || "{}";
              const display = safeCallDisplay((agent as Agent).toolRegistry?.get(name), args);
              ws.send(
                JSON.stringify({
                  type: S2C.TOOL_CALL,
                  sessionId,
                  name,
                  args,
                  ...(tc.id ? { toolCallId: tc.id } : {}),
                  ...(display !== undefined ? { display } : {}),
                  ...argsSummaryField((agent as Agent).toolRegistry, name, args),
                }),
              );
            }
          }
          const textContent =
            typeof msg.getTextContent === "function"
              ? msg.getTextContent()
              : msg.content || "";
          if (textContent) {
            ws.send(
              JSON.stringify({
                type: S2C.ASSISTANT_MESSAGE,
                sessionId,
                content: textContent,
              }),
            );
          }
          break;
        }

        case "tool": {
          const matchedCall = pendingToolCalls.find(
            (tc) => tc.id === msg.toolCallId,
          );
          const toolImgs = wireImages((msg as { images?: unknown }).images);
          ws.send(
            JSON.stringify({
              type: S2C.TOOL_RESULT,
              sessionId,
              name: matchedCall?.function?.name || "unknown",
              // Parts (tool-result) flatten for this string-only transport;
              // legacy entries are already plain text.
              output: toolContentText(msg.content ?? ""),
              ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
              ...(toolImgs ? { images: toolImgs } : {}),
            }),
          );
          break;
        }

        default:
          break;
      }
    }

    // Flush in-flight chunks that haven't reached the message log yet.
    const agentImpl = agent as Agent;
    const partialReasoning = agentImpl.currentStreamingReasoning;
    const partialContent = agentImpl.currentStreamingContent;
    if (partialReasoning) {
      ws.send(
        JSON.stringify({
          type: S2C.STREAMING_REASONING_CHUNK,
          sessionId,
          content: partialReasoning,
        }),
      );
    }
    if (partialContent) {
      ws.send(
        JSON.stringify({
          type: S2C.STREAMING_CHUNK,
          sessionId,
          content: partialContent,
        }),
      );
    }
  } catch {
    // Connection dropped mid-replay -- nothing to do.
  }
}

/** A blocked question outlives the socket that was showing it (tab
 *  refresh, session switch). Re-send after attach so the client
 *  renders the card again. */
export function replayPendingQuestion(
  bridge: WebSocketQuestionBridge,
  sessionId: string,
  ws: HotdogServerSocket<unknown>,
): void {
  const questions = bridge.peek(sessionId);
  if (!questions) return;
  SessionRegistry.sendSafe(ws, {
    type: S2C.QUESTION,
    sessionId,
    questions,
  });
}
