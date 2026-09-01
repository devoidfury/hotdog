// OpenAI chat-completions protocol — the built-in default LlmProtocol.
//
// Lives in core (not in an extension) because it is the zero-config default:
// every request goes through it unless a different protocol is selected.
// The registry and config-name selection are still exercisable from
// extensions; this is just the reference implementation.
//
// Wire shape: POST {url}/v1/chat/completions, Bearer auth, `data:` SSE
// streaming. Message serialization uses the WireFormat layer (serialize.ts)
// with the session mangler so mangling happens at the wire boundary.

import type { LlmProtocol } from "./protocol.ts";
import type { StreamEvent } from "./client.ts";
import { parseSse } from "../../utils/sse-parser.ts";
import { wireFormatFor } from "./serialize.ts";
import { LlmError } from "../error.ts";

import pkg from "@package.json" with { type: "json" };

export const openaiProtocol: LlmProtocol = {
  id: "openai",

  buildRequest(messages, modelConfig, toolDefs, stream, ctx) {
    const modelName = modelConfig.name.split("/").pop() || modelConfig.name;
    const wireMessages = wireFormatFor(modelConfig).serialize(messages, ctx.mangler);

    const body: Record<string, unknown> = {
      model: modelName,
      messages: wireMessages,
      stream: stream,
    };

    if (modelConfig.temperature != null) {
      body.temperature = modelConfig.temperature;
    }

    if (toolDefs && toolDefs.length > 0) {
      body.tools = toolDefs;
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
    }

    if (modelConfig.reasoningEffort != null) {
      body.reasoning_effort = modelConfig.reasoningEffort;
    }
    if (stream) {
      body.stream_options = { include_usage: true };
    }

    return { path: "/v1/chat/completions", body };
  },

  buildHeaders(ctx) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": `hotdog/${pkg.version}`,
    };
    if (ctx.apiKey) headers["Authorization"] = `Bearer ${ctx.apiKey}`;
    if (ctx.sessionId) headers["x-session-affinity"] = ctx.sessionId;
    headers["Connection"] = "keep-alive";
    return headers;
  },

  // NOTE: the LlmProtocol interface still passes ctx (mangler, base URL, key,
  // session) to parseStream for other protocols; the openai parser needs none
  // of it (events are raw wire content, see parseStreamData below).
  async *parseStream(response) {
    const contentType =
      typeof response.headers?.get === "function" ? response.headers.get("content-type") || "" : "";
    const isSse =
      contentType.includes("text/event-stream") || contentType.includes("text/plain") || contentType === "";

    if (!isSse) {
      try {
        const data = (await response.json()) as Record<string, unknown>;
        yield* parseStreamData(data);
        return;
      } catch {
        throw LlmError.InvalidResponse(`Unexpected Content-Type: ${contentType}`);
      }
    }

    if (!response.body) {
      throw LlmError.InvalidResponse("Response body is null");
    }
    for await (const data of parseSse(response.body)) {
      yield* parseStreamData(data as Record<string, unknown>);
    }
  },
};

/**
 * Emits RAW wire content: no mangler unescaping here. A mangler alias
 * (`<m_...>`) can be split across two SSE deltas, so unescaping per chunk
 * would fossilize the alias in whatever gets assembled from these events.
 * Consumers unescape once on the ASSEMBLED string (StreamProcessor.process
 * for the agent, the compaction extension for summaries).
 */
function* parseStreamData(
  data: Record<string, unknown>,
): Generator<StreamEvent> {
  const events: StreamEvent[] = [];
  const choices = (data.choices as Array<Record<string, unknown>>) || [];
  const usage = data.usage as Record<string, unknown> | undefined;

  for (const choice of choices) {
    const delta = (choice.delta as Record<string, unknown>) || {};

    const reasoningContent = delta.reasoning_content as string | null | undefined;
    if (reasoningContent) {
      events.push({ type: "reasoning", content: reasoningContent });
    }

    const contentVal = delta.content as string | null | undefined;
    if (contentVal) {
      events.push({ type: "content", content: contentVal });
    }

    const toolCalls = (delta.tool_calls as Array<Record<string, unknown>>) || [];
    for (const tc of toolCalls) {
      if (tc.function) {
        const fn = tc.function as Record<string, unknown>;
        const name = fn.name as string | null | undefined;
        const args = fn.arguments as string | null | undefined;
        if (name) {
          events.push({ type: "toolName", index: Number(tc.index) || 0, name, toolCallId: (tc.id as string) || "" });
        }
        if (args) {
          events.push({ type: "toolArgument", index: Number(tc.index) || 0, arguments: args });
        }
      }
    }

    const finishReason = choice.finish_reason as string | undefined;
    if (finishReason) {
      events.push({ type: "finish", reason: finishReason });
    }
  }

  if (usage) {
    events.push({ type: "usage", data: usage });
  }

  yield* events;
}
