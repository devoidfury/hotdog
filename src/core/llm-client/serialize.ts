// Wire serialization: converts internal Messages to the OpenAI-compatible
// chat-completion wire shape.
//
// Two formats exist because chat templates are per-model, even on the same
// backend:
//   - system-first (llama.cpp / Ollama style): only the first message(s) may
//     be system; harness-injected user messages ride role:"user".
//   - developer (OpenAI style): harness-injected user messages are sent as
//     role:"developer".
//
// Wire role: internal role maps to the wire role, except role "harness"
// (internal-only; no wire backend has a harness role), which rides
// "developer" in developer format and "user" in system-first format.
//
// Escape (marker mangling) happens HERE, at the wire boundary,
// provenance-based:
//   - source "system" and "harness" content is trusted and never mangled --
//     system defines the real marker names;
//   - `untrusted` content parts are mangled unconditionally (this is how
//     harness messages embed model-generated payloads: raw in context and
//     logs, mangled only on the wire);
//   - source "user", "model", "tool" (and legacy messages with no source)
//     are untrusted and always mangled.
//
// Wire messages are plain snake_case objects; field order per message is
// pinned (role, content, reasoning_content?, tool_calls?, tool_call_id?) to
// keep prompt-cache prefixes byte-stable. The internal `images` array is
// NOT a wire field -- image parts live inside `content`.

import type { Message, ToolCall } from "../context/message.ts";
import type { MarkerMangler } from "../marker-mangler.ts";
import type { WireFormatKind } from "../config/providers.ts";

export interface WireMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
  reasoning_content?: string;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
}

export interface WireFormat {
  serialize(messages: readonly Message[], mangler: MarkerMangler | null): WireMessage[];
}

function manglePart(
  part: Record<string, unknown>,
  mangler: MarkerMangler | null,
  trusted: boolean,
): Record<string, unknown> {
  if (part.type === "untrusted") {
    // Untrusted payload marked at generation time. Mangled here and nowhere
    // else; emitted as a plain "text" part on the wire.
    const text = typeof part.text === "string" ? part.text : "";
    return { type: "text", text: mangler ? (mangler.escape(text) ?? text) : text };
  }
  if (part.type === "text" && typeof part.text === "string") {
    if (trusted || !mangler) return part;
    return { ...part, text: mangler.escape(part.text) ?? part.text };
  }
  return part;
}

function mangleContent(
  content: string | Array<Record<string, unknown>>,
  mangler: MarkerMangler | null,
  trusted: boolean,
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    if (trusted || !mangler) return content;
    return mangler.escape(content) ?? content;
  }
  // Always map: a trusted message can still carry untrusted parts.
  return content.map((part) => manglePart(part, mangler, trusted));
}

function mangleToolCalls(
  toolCalls: ToolCall[] | null,
  mangler: MarkerMangler | null,
): Array<Record<string, unknown>> | undefined {
  if (!toolCalls) return undefined;
  if (!mangler) return toolCalls as unknown as Array<Record<string, unknown>>;
  return toolCalls.map((tc) => {
    const fn: Record<string, unknown> = { ...tc.function };
    if (typeof fn.name === "string") fn.name = mangler.escape(fn.name);
    if (typeof fn.arguments === "string") fn.arguments = mangler.escape(fn.arguments);
    return { ...tc, function: fn };
  });
}

function serializeMessage(msg: Message, mangler: MarkerMangler | null, developer: boolean): WireMessage {
  const role = msg.role ?? "";
  // Provenance decides trust: only system and harness content is exempt.
  // (Legacy messages without a source are untrusted and get mangled.)
  const trusted = msg.source === "system" || msg.source === "harness";
  // Role mapping: role "harness" has no wire equivalent; developer format
  // (OpenAI style) sends it as "developer", system-first as "user".
  const wireRole = role === "harness" ? (developer ? "developer" : "user") : role;

  const wire: WireMessage = {
    role: wireRole,
    content: mangleContent(msg._buildContent() as string | Array<Record<string, unknown>>, mangler, trusted),
  };
  if (msg.reasoningContent) wire.reasoning_content = msg.reasoningContent;
  const toolCalls = mangleToolCalls(msg.toolCalls, trusted ? null : mangler);
  if (toolCalls) wire.tool_calls = toolCalls;
  if (msg.toolCallId) wire.tool_call_id = msg.toolCallId;
  return wire;
}

const systemFirstFormat: WireFormat = {
  serialize(messages, mangler) {
    return messages.map((m) => serializeMessage(m, mangler, false));
  },
};

const developerFormat: WireFormat = {
  serialize(messages, mangler) {
    return messages.map((m) => serializeMessage(m, mangler, true));
  },
};

export function wireFormatFor(modelConfig: { wireFormat?: WireFormatKind }): WireFormat {
  return modelConfig.wireFormat === "developer" ? developerFormat : systemFirstFormat;
}
