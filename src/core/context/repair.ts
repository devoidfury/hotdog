import { Message } from "./message.ts";

/**
 * Synthesized tool-result content for interrupted calls. Pinned verbatim: the
 * point is that the model KNOWS the call may have partially executed --
 * wording matters for non-idempotent commands.
 */
export const INTERRUPTED_TOOL_RESULT = "[Tool execution was interrupted]";

export interface ToolCallRepair {
  /** New message array; the input is never mutated. */
  messages: Message[];
  /** Call ids that were given a synthesized result. */
  repaired: string[];
  /** Orphan/duplicate results that were dropped (call id, or "(missing id)"). */
  dropped: string[];
}

/**
 * Enforce the wire invariant: every assistant tool_call gets exactly one
 * tool result before the next assistant message (end-of-list counts).
 *
 * Two ways a log/context breaks it:
 *  - interrupt or crash leaves calls with no result (guaranteed 400 on
 *    strict OpenAI-compatible backends, llama.cpp enforces it too)
 *  - a tool result whose call vanished (orphan) is itself a 400
 *
 * Missing results are synthesized as harness-origin tool messages
 * (exempt from marker mangling; a real tool never emits this string).
 * Orphan and duplicate results are dropped. Everything else passes through
 * in order. Pure: healthy inputs come back untouched (same instances).
 */
export function repairToolCalls(messages: Message[]): ToolCallRepair {
  const out: Message[] = [];
  const repaired: string[] = [];
  const dropped: string[] = [];

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    const calls =
      msg.role === "assistant" && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0
        ? msg.toolCalls
        : null;

    if (!calls) {
      if (msg.role === "tool") {
        // A tool result with no immediately preceding assistant-with-calls:
        // its call vanished (or never existed). It can match nothing.
        dropped.push(toolResultLabel(msg.toolCallId));
      } else {
        out.push(msg);
      }
      i++;
      continue;
    }

    out.push(msg);

    const expected = new Set<string>();
    for (const tc of calls) {
      if (tc && typeof tc.id === "string" && tc.id !== "") expected.add(tc.id);
    }

    // Scan the block: messages up to the next assistant message.
    const matched = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role !== "assistant") {
      const m = messages[j]!;
      if (m.role !== "tool") {
        // Non-tool messages inside the block are not part of this invariant;
        // keep them in place.
        out.push(m);
      } else if (
        typeof m.toolCallId === "string" &&
        m.toolCallId !== "" &&
        expected.has(m.toolCallId) &&
        !matched.has(m.toolCallId)
      ) {
        matched.add(m.toolCallId);
        out.push(m);
      } else {
        // Orphan (id matches no call of this assistant) or duplicate (a
        // result for an already-satisfied call). Exactly one result per id.
        dropped.push(toolResultLabel(m.toolCallId));
      }
      j++;
    }

    // Synthesize the missing results, appended at the end of the block so
    // real results keep their chronological position.
    const synthesized = new Set<string>();
    for (const tc of calls) {
      const id = tc?.id;
      if (typeof id !== "string" || id === "" || matched.has(id) || synthesized.has(id)) continue;
      synthesized.add(id);
      out.push(
        new Message({
          role: "tool",
          content: INTERRUPTED_TOOL_RESULT,
          toolCallId: id,
          source: "harness",
        }),
      );
      repaired.push(id);
    }

    i = j;
  }

  return { messages: out, repaired, dropped };
}

function toolResultLabel(toolCallId: string | null): string {
  return toolCallId && toolCallId !== "" ? toolCallId : "(missing id)";
}
