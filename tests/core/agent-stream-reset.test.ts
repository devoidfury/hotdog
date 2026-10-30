// Agent-level display seam for the mid-stream retry reset (finding H-3): the
// StreamProcessor's `reset` event must reach every sink as a STREAM_RESET
// OutputEvent, ordered strictly between the dead attempt's chunks and the
// retry's, and the turn that lands in context must carry no fragment of the
// failed attempt. Processor-level ordering/purity is pinned in
// stream-processor.test.ts; this pins the AGENT wiring (the one production
// StreamCallbacks construction site) that every display surface hangs off.

import { describe, it, expect } from "bun:test";
import { OUTPUT_EVENT, type OutputEvent } from "@core/context/output.ts";
import { createFixture, MockLLMClient } from "../helpers.ts";

describe("Agent stream-reset display seam", () => {
  it("emits stream_reset between the dead chunks and the retry's; the assembled turn carries no dead fragment", async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [[
        { type: "reasoning", content: "DEAD-THINK" },
        { type: "content", content: "DEAD" },
        { type: "reset" },
        { type: "content", content: "clean " },
        { type: "content", content: "answer" },
        { type: "usage", data: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
      ]],
    });
    const events: OutputEvent[] = [];
    const { agent } = createFixture({ mockLLM, sink: { emit: (e: OutputEvent) => events.push(e) } });

    const result = await agent.run("hi");

    // The user-visible completion is the retry's text, whole.
    expect((result as { content?: string }).content).toBe("clean answer");

    // The assistant message persisted to context is clean too (the storage
    // half of the guarantee: nothing dead is ever replayed later).
    const assistant = agent.context
      .getMessages()
      .filter((m) => m.role === "assistant")
      .at(-1)!;
    expect(assistant.content).toBe("clean answer");
    expect(JSON.stringify(assistant)).not.toContain("DEAD");

    // Sink order is the display contract: dead fragments, the reset, then
    // the retry -- a surface that clears on STREAM_RESET sees the retry's
    // deltas AFTER its clear, never before.
    const streamEvents = events
      .filter(
        (e) =>
          e.type === OUTPUT_EVENT.STREAMING_CHUNK ||
          e.type === OUTPUT_EVENT.STREAMING_REASONING_CHUNK ||
          e.type === OUTPUT_EVENT.STREAM_RESET,
      )
      .map((e) =>
        e.type === OUTPUT_EVENT.STREAM_RESET
          ? "reset"
          : `${e.type === OUTPUT_EVENT.STREAMING_CHUNK ? "text" : "reasoning"}:${(e as { content: string }).content}`,
      );
    expect(streamEvents).toEqual([
      "reasoning:DEAD-THINK",
      "text:DEAD",
      "reset",
      "text:clean ",
      "text:answer",
    ]);
  });

  it("a run without a mid-stream retry emits no stream_reset", async () => {
    const mockLLM = new MockLLMClient({
      responseSequences: [[
        { type: "content", content: "fine" },
        { type: "usage", data: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ]],
    });
    const events: OutputEvent[] = [];
    const { agent } = createFixture({ mockLLM, sink: { emit: (e: OutputEvent) => events.push(e) } });

    await agent.run("hi");
    expect(events.some((e) => e.type === OUTPUT_EVENT.STREAM_RESET)).toBe(false);
  });
});
