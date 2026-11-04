// History replay, split out of server.ts: log-slice replay (the reconnect
// cursor's coordinate space), in-memory message replay for forks, and the
// pending-question re-send after attach.
//
// Both replay paths normalize their source (log entries / live Messages) and
// emit through the shared builders in wire-messages.ts -- the same ones the
// live websocket-channel uses -- so replayed frames cannot drift from live
// ones as the protocol evolves.

import type { AgentLike } from "@core/session/index.ts";
import { conversationContent, LOG_SOURCE, type LogEntry } from "@core/session/session-log.ts";
import type { Agent } from "@core/agent.ts";
import type { ToolRegistry } from "@core/extensions/tool-registry.ts";
import type { WebSocketQuestionBridge } from "./question-input.ts";
import { S2C } from "./protocol.ts";
import {
  s2cAssistantMessage,
  s2cContent,
  s2cTokenUsage,
  s2cToolCall,
  s2cToolResult,
  s2cUserMessage,
  type TokenUsageWireSource,
} from "./wire-messages.ts";
import { splitFileIncludes, wrapperContentText } from "@utils/tool-content.ts";
import { ctxByIndex, deriveCallDurationsByIndex, parseEntryTs, turnDurationsByIndex } from "@utils/session-turns.ts";
import { SessionRegistry } from "./session-registry.ts";
import type { HotdogServerSocket } from "./socket.ts";

type ToolCallWire = { id?: string; function?: { name?: string; arguments?: string } };

/** Per-tool arg-display hints resolved from the tool registry (replay's only
 * metadata source; live calls carry their own summary from the channel). */
function registryArgDisplay(registry: ToolRegistry | undefined) {
  return (name: string) => registry?.getMetadata?.(name)?.argDisplay;
}

/**
 * Replay a slice of a session's FULL log as S2C messages. `startIdx` is the
 * client's replay cursor: a position in the full log (append-only -- a RESET
 * never moves an earlier entry), so the slice is exactly the tail the
 * client does not hold. Full replays pass the epoch's start as `startIdx`.
 * Only conversation entries are sent, plus token_usage snapshots (usage
 * bubbles); pure bookkeeping records never surface.
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
  const argDisplay = registryArgDisplay(toolRegistry);
  const send = (msg: Record<string, unknown>): void => {
    ws.send(JSON.stringify(msg));
  };

  const callNames = new Map<string, string>();
  for (const e of entries) {
    if (e.source !== LOG_SOURCE.LLM || !Array.isArray(e.tool_calls)) continue;
    for (const tc of e.tool_calls as Array<{ id?: string; function?: { name?: string } }>) {
      if (tc?.id && tc.function?.name) callNames.set(tc.id, tc.function.name);
    }
  }

  // Message-footer meta: each entry's own completion ts, the wall-clock
  // duration of the v2 turn bracketing it (undefined outside a closed
  // bracket -- an unknown duration rides no field, the client omits it),
  // and the ctx usage attested at the message's commit -- the token_usage
  // record written for that LLM response (undefined when the log has none:
  // the footer gauge segment is then omitted, never borrowed from a
  // neighbouring call). The call's own wall time (callMs) is the recorded
  // durationMs on that usage record first, else the strict-adjacency log-gap
  // derivation (deriveCallDurationsByIndex); callDerived says which it was,
  // so the footer tooltip never dresses a derived number as recorded.
  const turnDurations = turnDurationsByIndex(entries);
  const ctxs = ctxByIndex(entries);
  const derivedCalls = deriveCallDurationsByIndex(entries);

  for (let i = startIdx; i < entries.length; i++) {
    const e = entries[i]!;
    // Conversation sources only hold text or content parts (see the helper).
    const content = conversationContent(e);
    switch (e.source) {
      case LOG_SOURCE.INPUT:
      case LOG_SOURCE.PROMPT: {
        const display = splitFileIncludes(content);
        send(s2cUserMessage(sessionId, { content: display.text, files: display.files, images: e.images }));
        break;
      }
      case LOG_SOURCE.LLM: {
        if (e.reasoning_content) {
          send(s2cContent(S2C.THINKING, sessionId, e.reasoning_content));
        }
        const toolCalls = Array.isArray(e.tool_calls) ? (e.tool_calls as ToolCallWire[]) : undefined;
        for (const tc of toolCalls ?? []) {
          // Replay has no live tool object; the wire carries name, args and
          // the registry-resolved argsSummary fold.
          const name = tc.function?.name || "unknown";
          send(
            s2cToolCall(sessionId, {
              name,
              args: tc.function?.arguments || "{}",
              toolCallId: tc.id,
              argDisplay: argDisplay(name),
            }),
          );
        }
        const text = wrapperContentText(content);
        if (text) {
          // Per-call duration: recorded (the usage record's own durationMs,
          // ctxByIndex posture) beats derived (strict-adjacency log gap);
          // neither present means the segment rides no field.
          const recordedCall = ctxs[i]?.callMs;
          const derivedCall = recordedCall === undefined ? derivedCalls[i] : undefined;
          send(
            s2cAssistantMessage(sessionId, text, {
              ts: parseEntryTs(e.ts),
              durationMs: turnDurations[i],
              ctx: ctxs[i],
              callMs: recordedCall ?? derivedCall,
              ...(derivedCall !== undefined ? { callDerived: true } : {}),
            }),
          );
        }
        break;
      }
      case LOG_SOURCE.TOOL_RESULT: {
        const callId = typeof e.tool_call_id === "string" ? e.tool_call_id : undefined;
        send(
          s2cToolResult(sessionId, {
            name: (callId ? callNames.get(callId) : undefined) || "unknown",
            content,
            toolCallId: callId,
            images: e.images,
          }),
        );
        break;
      }
      case LOG_SOURCE.TOKEN_USAGE: {
        // Not bookkeeping: the record still replays as a TOKEN_USAGE event
        // (other consumers read the frame, and the webui holds its ctx pair),
        // mapped by the same builder as the live websocket-channel event.
        // It renders no bubble of its own: the numbers ride the assistant
        // footer's ctx segment via the ctx meta on the s2cAssistantMessage
        // frame it belongs to (ctxByIndex above).
        send(s2cTokenUsage(sessionId, e as unknown as TokenUsageWireSource));
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

  const argDisplay = registryArgDisplay((agent as Agent).toolRegistry);
  const send = (msg: Record<string, unknown>): void => {
    ws.send(JSON.stringify(msg));
  };

  try {
    let pendingToolCalls: ToolCallWire[] = [];

    for (const msg of messages) {
      switch (msg.role) {
        case "user": {
          // Attachments in `files`; the text excludes file-include parts.
          const display = splitFileIncludes(msg.content);
          send(
            s2cUserMessage(sessionId, {
              content: display.text,
              files: display.files,
              images: (msg as { images?: unknown }).images,
            }),
          );
          break;
        }

        case "assistant": {
          if (msg.reasoningContent) {
            send(s2cContent(S2C.THINKING, sessionId, msg.reasoningContent));
          }

          const toolCalls = msg.toolCalls as ToolCallWire[] | undefined;
          if (toolCalls && toolCalls.length > 0) {
            pendingToolCalls = toolCalls;
            for (const tc of toolCalls) {
              const name = tc.function?.name || "unknown";
              send(
                s2cToolCall(sessionId, {
                  name,
                  args: tc.function?.arguments || "{}",
                  toolCallId: tc.id,
                  argDisplay: argDisplay(name),
                }),
              );
            }
          }
          const textContent =
            typeof msg.getTextContent === "function" ? msg.getTextContent() : ((msg.content || "") as string);
          if (textContent) {
            send(s2cContent(S2C.ASSISTANT_MESSAGE, sessionId, textContent));
          }
          break;
        }

        case "tool": {
          const matchedCall = pendingToolCalls.find((tc) => tc.id === msg.toolCallId);
          send(
            s2cToolResult(sessionId, {
              name: matchedCall?.function?.name || "unknown",
              content: msg.content ?? "",
              toolCallId: msg.toolCallId,
              images: (msg as { images?: unknown }).images,
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
      send(s2cContent(S2C.STREAMING_REASONING_CHUNK, sessionId, partialReasoning));
    }
    if (partialContent) {
      send(s2cContent(S2C.STREAMING_CHUNK, sessionId, partialContent));
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
