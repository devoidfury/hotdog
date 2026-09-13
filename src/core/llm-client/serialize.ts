// Wire serialization: converts internal Messages to the OpenAI-compatible
// chat-completion wire shape.
//
// Two per-model decisions meet here, both pluggable and both resolved by the
// LlmClient into the ProtocolContext:
//   - RoleMapping: how an internal role maps to a wire role. Role "harness"
//     is internal-only (no wire backend has it), so a mapping decides where
//     harness text rides -- "user" (llama.cpp / Ollama chat templates) or
//     "developer" (OpenAI style). There is no core default to fall back to:
//     serializing without a mapping is an error, like rendering a wrapper
//     without a WireFormat.
//   - WireFormat (extensions/wire-format.ts): the markup shape of harness
//     wrapper parts. Wrapper rendering lives in context/wrappers.ts.
//
// Escape (marker mangling) happens HERE, at the wire boundary,
// provenance-based:
//   - source "system" and "harness" content is trusted and never mangled --
//     system defines the real marker names;
//   - `untrusted` content parts are mangled unconditionally (this is how
//     harness messages embed model-generated payloads: raw in context and
//     logs, mangled only on the wire);
//   - wrapper parts render via context/wrappers.ts: the wrapper framing comes
//     from the session's WireFormat, and the fields mangle per the type's
//     trust spec (file-include: its file data; tool-result: everything the
//     tool produced; system-notice: verbatim). Wrapper parts are
//     harness-generated only (see wrappers.ts); meeting a wrapper with no
//     WireFormat active throws.
//   - source "user", "model", "tool" (and legacy messages with no source)
//     are untrusted and always mangled.
//
// Wire messages are plain snake_case objects; field order per message is
// pinned (role, content, reasoning_content?, tool_calls?, tool_call_id?) to
// keep prompt-cache prefixes byte-stable. The internal `images` array is
// NOT a wire field -- image parts live inside `content`.

import type { Message, ToolCall } from "../context/message.ts";
import { isWrapperPart, renderWrapperForWire } from "../context/wrappers.ts";
import type { WireFormat } from "../extensions/wire-format.ts";
import type { RoleMapping } from "../extensions/role-mapping.ts";
import type { MarkerMangler } from "../marker-mangler.ts";
import { LlmError } from "../error.ts";

export interface WireMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
  reasoning_content?: string;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
}

function manglePart(
  part: Record<string, unknown>,
  mangler: MarkerMangler | null,
  trusted: boolean,
  wireFormat: WireFormat | null,
): Record<string, unknown> {
  if (part.type === "untrusted") {
    // Untrusted payload marked at generation time. Mangled here and nowhere
    // else; emitted as a plain "text" part on the wire.
    const text = typeof part.text === "string" ? part.text : "";
    return { type: "text", text: mangler ? (mangler.escape(text) ?? text) : text };
  }
  if (isWrapperPart(part)) {
    // Framing from the session's WireFormat, fields per the type's trust
    // spec (wrappers.ts); emitted as a plain "text" part on the wire.
    return { type: "text", text: renderWrapperForWire(part, mangler, wireFormat) };
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
  wireFormat: WireFormat | null,
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    if (trusted || !mangler) return content;
    return mangler.escape(content) ?? content;
  }
  // Always map: a trusted message can still carry untrusted parts.
  return content.map((part) => manglePart(part, mangler, trusted, wireFormat));
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

function serializeMessage(
  msg: Message,
  mangler: MarkerMangler | null,
  wireFormat: WireFormat | null,
  roleMapping: RoleMapping,
): WireMessage {
  const role = msg.role ?? "";
  // Provenance decides trust: only system and harness content is exempt.
  // (Legacy messages without a source are untrusted and get mangled.)
  const trusted = msg.source === "system" || msg.source === "harness";
  const wireRole = roleMapping.wireRole(role);

  const wire: WireMessage = {
    role: wireRole,
    content: mangleContent(
      msg._buildContent() as string | Array<Record<string, unknown>>,
      mangler,
      trusted,
      wireFormat,
    ),
  };
  if (msg.reasoningContent) wire.reasoning_content = msg.reasoningContent;
  const toolCalls = mangleToolCalls(msg.toolCalls, trusted ? null : mangler);
  if (toolCalls) wire.tool_calls = toolCalls;
  if (msg.toolCallId) wire.tool_call_id = msg.toolCallId;
  return wire;
}

/**
 * Serialize internal messages to wire messages. `wireFormat` may be null
 * until a wrapper part actually needs it (which then throws inside
 * renderWrapperForWire); `roleMapping` is REQUIRED: the chain
 * (model -> provider -> global, default layer core.config.json) must resolve
 * one, and an unresolved mapping is a config error thrown here, never a
 * silently invented convention.
 */
export function serializeMessages(
  messages: readonly Message[],
  mangler: MarkerMangler | null,
  wireFormat: WireFormat | null,
  roleMapping: RoleMapping | null,
): WireMessage[] {
  // An empty request needs no mapping: there is no role to map.
  if (messages.length === 0) return [];
  if (!roleMapping) {
    // A config error, not a bug: classified so formatError() shows the
    // actionable message without a stack (isExpectedError in error.ts).
    throw new LlmError(
      `No role mapping is active, so messages cannot be serialized for the model. ` +
        `Set "modelRoleMapping" or enable a role-mapping extension (built-in: role-mapping-default).`,
      "config",
    );
  }
  return messages.map((m) => serializeMessage(m, mangler, wireFormat, roleMapping));
}
