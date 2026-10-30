// StreamProcessor tests — tests stream processing independently of Agent.

import { describe, it, expect } from "bun:test";
import {
  createStreamProcessor,
  StreamProcessor,
  type StreamCallbacks,
  type StreamResult,
} from "@core/llm-client/stream-processor.ts";
import type { StreamEvent } from "@core/llm-client/client.ts";
import { MarkerMangler } from "@core/marker-mangler.ts";
import { Message } from "@core/context/message.ts";
import { repairToolCalls } from "@core/context/repair.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function* makeEvents(
  events: StreamEvent[],
): Generator<StreamEvent, void, unknown> {
  for (const e of events) {
    yield e;
  }
}

async function processEvents(
  processor: StreamProcessor,
  events: StreamEvent[],
  callbacks: StreamCallbacks = {},
  mangler?: MarkerMangler | null,
): Promise<StreamResult> {
  return processor.process(
    makeEvents(events) as unknown as AsyncIterable<StreamEvent>,
    callbacks,
    mangler,
  );
}

/**
 * Escape a protected marker, split the mangled form right through the middle
 * of the alias (the way a tokenizer can split it across two deltas), and
 * return the halves plus the real marker. The marker is built from bare
 * words so only the tag form is mangled and the parts stay literal-safe.
 */
function makeSplitAlias(): {
  mangler: MarkerMangler;
  head: string;
  tail: string;
  original: string;
} {
  const mangler = new MarkerMangler();
  const marker = "<" + "tool-call" + ">";
  const wire = mangler.escape(`pre ${marker} post`) ?? "";
  // wire === `pre <m_XXXXXXXXXXXXXXXX> post`
  const aliasStart = wire.indexOf("m_");
  const aliasEnd = wire.indexOf(">", aliasStart);
  const mid = aliasStart + Math.floor((aliasEnd - aliasStart) / 2);
  return {
    mangler,
    head: wire.slice(0, mid),
    tail: wire.slice(mid),
    original: `pre ${marker} post`,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("StreamProcessor", () => {
  describe("basic content accumulation", () => {
    it("should accumulate content chunks", async () => {
      const processor = createStreamProcessor();
      const result = await processEvents(processor, [
        { type: "content", content: "Hello " },
        { type: "content", content: "world" },
      ]);

      expect(result.fullText).toBe("Hello world");
      expect(result.fullReasoning).toBeNull();
      expect(result.finalToolCalls).toBeNull();
      expect(result.usage).toBeNull();
      expect(result.finishReason).toBeNull();
    });

    it("should handle empty stream", async () => {
      const processor = createStreamProcessor();
      const result = await processEvents(processor, []);

      expect(result.fullText).toBe("");
      expect(result.fullReasoning).toBeNull();
      expect(result.finalToolCalls).toBeNull();
    });
  });

  describe("reasoning content", () => {
    it("should accumulate reasoning chunks", async () => {
      const processor = createStreamProcessor();
      const result = await processEvents(processor, [
        { type: "reasoning", content: "Let me think... " },
        { type: "reasoning", content: "Okay, I have it." },
        { type: "content", content: "The answer is 42." },
      ]);

      expect(result.fullText).toBe("The answer is 42.");
      expect(result.fullReasoning).toBe("Let me think... Okay, I have it.");
    });

    it("should return null reasoning when no reasoning events", async () => {
      const processor = createStreamProcessor();
      const result = await processEvents(processor, [
        { type: "content", content: "Hello" },
      ]);

      expect(result.fullReasoning).toBeNull();
    });
  });

  describe("tool calls", () => {
    it("should build tool calls from toolName and toolArgument events", async () => {
      const processor = createStreamProcessor();
      const result = await processEvents(processor, [
        { type: "toolName", index: 0, name: "read_file", toolCallId: "call-abc" },
        { type: "toolArgument", index: 0, arguments: '{"path": "/test.txt"}' },
      ]);

      expect(result.finalToolCalls).toEqual([
        {
          id: "call-abc",
          type: "function",
          function: {
            name: "read_file",
            arguments: '{"path": "/test.txt"}',
          },
        },
      ]);
    });

    it("should generate UUID for tool calls without id", async () => {
      const processor = createStreamProcessor();
      const result = await processEvents(processor, [
        { type: "toolName", index: 0, name: "bash", toolCallId: "" },
        { type: "toolArgument", index: 0, arguments: '{"cmd": "ls"}' },
      ]);

      expect(result.finalToolCalls).toEqual([
        {
          id: expect.any(String),
          type: "function",
          function: {
            name: "bash",
            arguments: '{"cmd": "ls"}',
          },
        },
      ]);
      expect(result.finalToolCalls![0]!.id).toHaveLength(36); // UUID format
    });

    it("should handle multiple tool calls", async () => {
      const processor = createStreamProcessor();
      const result = await processEvents(processor, [
        { type: "toolName", index: 0, name: "read", toolCallId: "call-1" },
        { type: "toolArgument", index: 0, arguments: '{"path": "a.txt"}' },
        { type: "toolName", index: 1, name: "overwrite", toolCallId: "call-2" },
        { type: "toolArgument", index: 1, arguments: '{"path": "b.txt", "content": "hi"}' },
      ]);

      expect(result.finalToolCalls).toHaveLength(2);
      expect(result.finalToolCalls![0]!.function.name).toBe("read");
      expect(result.finalToolCalls![1]!.function.name).toBe("overwrite");
    });

    it("should return null tool calls when none present", async () => {
      const processor = createStreamProcessor();
      const result = await processEvents(processor, [
        { type: "content", content: "No tools needed." },
      ]);

      expect(result.finalToolCalls).toBeNull();
    });

    it("should preserve args and id when a backend resends the name after args streamed", async () => {
      // llama.cpp-family backends emit the name on every delta (id only on
      // the first). The resend must not clobber accumulated args or the id.
      const processor = createStreamProcessor();
      const result = await processEvents(processor, [
        { type: "toolName", index: 0, name: "read", toolCallId: "call-1" },
        { type: "toolArgument", index: 0, arguments: '{"path":' },
        { type: "toolName", index: 0, name: "read", toolCallId: "" },
        { type: "toolArgument", index: 0, arguments: '"a.txt"}' },
        { type: "toolName", index: 0, name: "read", toolCallId: "" },
      ]);

      expect(result.finalToolCalls).toEqual([
        {
          id: "call-1",
          type: "function",
          function: { name: "read", arguments: '{"path":"a.txt"}' },
        },
      ]);
    });

    it("should fill name and id when toolName arrives after toolArgument", async () => {
      // Some backends stream arguments before the name/id event; merging
      // keeps the early argument fragment.
      const processor = createStreamProcessor();
      const result = await processEvents(processor, [
        { type: "toolArgument", index: 0, arguments: '{"cmd": "ls"}' },
        { type: "toolName", index: 0, name: "bash", toolCallId: "call-9" },
      ]);

      expect(result.finalToolCalls).toEqual([
        {
          id: "call-9",
          type: "function",
          function: { name: "bash", arguments: '{"cmd": "ls"}' },
        },
      ]);
    });

    it("should replace non-string and empty ids with fresh uuids, keep valid strings", async () => {
      // repair.ts's sanitizeToolCalls drops non-string ids on resume, so the
      // live wire must never carry one: numeric/empty ids become uuids.
      const processor = createStreamProcessor();
      const result = await processEvents(processor, [
        { type: "toolName", index: 0, name: "a", toolCallId: 42 as unknown as string },
        { type: "toolArgument", index: 0, arguments: "{}" },
        { type: "toolName", index: 1, name: "b", toolCallId: "" },
        { type: "toolArgument", index: 1, arguments: "{}" },
        { type: "toolName", index: 2, name: "c", toolCallId: "call-keep" },
        { type: "toolArgument", index: 2, arguments: "{}" },
      ]);

      const ids = result.finalToolCalls!.map((tc) => tc.id);
      expect(ids[2]).toBe("call-keep"); // valid string preserved verbatim
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      expect(ids[0]).toMatch(uuid); // numeric id -> fresh uuid
      expect(ids[1]).toMatch(uuid); // empty id -> fresh uuid
    });

    it("assembled tool calls survive sanitizeToolCalls on a replay round-trip", async () => {
      // The whole point of the id coercion: repair's sanitizer treats a
      // non-string id as an illegal-wire call and drops the call entirely.
      const processor = createStreamProcessor();
      const result = await processEvents(processor, [
        { type: "toolName", index: 0, name: "bash", toolCallId: 42 as unknown as string },
        { type: "toolArgument", index: 0, arguments: '{"cmd": "ls"}' },
      ]);
      const assistant = new Message({
        role: "assistant",
        content: "",
        toolCalls: result.finalToolCalls,
      });
      const { messages } = repairToolCalls([assistant]);
      expect(messages[0]!.toolCalls).toEqual(result.finalToolCalls); // nothing dropped
    });
  });

  describe("usage and finish", () => {
    it("should capture usage data", async () => {
      const processor = createStreamProcessor();
      const usageData = {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      };
      const result = await processEvents(processor, [
        { type: "content", content: "Hi" },
        { type: "usage", data: usageData },
      ]);

      expect(result.usage).toEqual(usageData);
    });

    it("should capture finish reason", async () => {
      const processor = createStreamProcessor();
      const result = await processEvents(processor, [
        { type: "content", content: "Done" },
        { type: "finish", reason: "stop" },
      ]);

      expect(result.finishReason).toBe("stop");
    });
  });

  describe("streaming callbacks", () => {
    it("should call onChunk for content events", async () => {
      const processor = createStreamProcessor();
      const chunks: string[] = [];

      await processEvents(processor, [
        { type: "content", content: "A" },
        { type: "content", content: "B" },
      ], {
        onChunk: (c) => chunks.push(c),
      });

      expect(chunks).toEqual(["A", "B"]);
    });

    it("should call onReasoning for reasoning events", async () => {
      const processor = createStreamProcessor();
      const reasoningChunks: string[] = [];

      await processEvents(processor, [
        { type: "reasoning", content: "Thinking..." },
      ], {
        onReasoning: (c) => reasoningChunks.push(c),
      });

      expect(reasoningChunks).toEqual(["Thinking..."]);
    });

    it("should call onUsage callback", async () => {
      const processor = createStreamProcessor();
      const usages: Array<{ prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }> = [];

      await processEvents(processor, [
        { type: "usage", data: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
      ], {
        onUsage: (u) => usages.push(u),
      });

      expect(usages).toEqual([{ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }]);
    });

    it("should call onFinish callback", async () => {
      const processor = createStreamProcessor();
      let finishReason: string | null = null;

      await processEvents(processor, [
        { type: "finish", reason: "stop" },
      ], {
        onFinish: (r) => { finishReason = r; },
      });

      expect(finishReason as string | null).toBe("stop");
    });

    it("should call onToolCalls callback with final tool calls", async () => {
      const processor = createStreamProcessor();
      let receivedToolCalls: unknown = null;

      await processEvents(processor, [
        { type: "toolName", index: 0, name: "test", toolCallId: "call-1" },
        { type: "toolArgument", index: 0, arguments: "{}" },
      ], {
        onToolCalls: (tc) => { receivedToolCalls = tc; },
      });

      expect(receivedToolCalls).toEqual([
        {
          id: "call-1",
          type: "function",
          function: { name: "test", arguments: "{}" },
        },
      ]);
    });
  });

  describe("cancellation", () => {
    it("should throw Cancelled error when shouldCancel returns true", async () => {
      const processor = createStreamProcessor();
      let cancelAfter = 0;

      await expect(
        processEvents(processor, [
          { type: "content", content: "A" },
          { type: "content", content: "B" },
          { type: "content", content: "C" },
        ], {
          shouldCancel: () => {
            cancelAfter++;
            return cancelAfter > 1; // Cancel after first chunk
          },
        }),
      ).rejects.toThrow("Stream cancelled");
    });

    it("should process events before cancellation takes effect", async () => {
      const processor = createStreamProcessor();
      let cancelAfter = 0;
      const chunks: string[] = [];

      try {
        await processEvents(processor, [
          { type: "content", content: "A" },
          { type: "content", content: "B" },
          { type: "content", content: "C" },
        ], {
          onChunk: (c) => chunks.push(c),
          shouldCancel: () => {
            cancelAfter++;
            return cancelAfter > 1; // Cancel after first chunk
          },
        });
      } catch {
        // Expected to throw
      }

      // First chunk should have been processed before cancellation
      expect(chunks).toEqual(["A"]);
    });

    it("should throw LlmError.Cancelled", async () => {
      const processor = createStreamProcessor();

      await expect(
        processEvents(processor, [
          { type: "content", content: "A" },
        ], {
          shouldCancel: () => true,
        }),
      ).rejects.toThrow("Stream cancelled");
    });
  });

  describe("partial streaming content tracking", () => {
    it("should clear partial content after processing completes", async () => {
      const processor = createStreamProcessor();
      const result = await processEvents(processor, [
        { type: "content", content: "Hello" },
      ]);

      expect(processor.streamingContent).toBe("");
      expect(processor.streamingReasoning).toBe("");
      expect(result.fullText).toBe("Hello");
    });
  });

  // Regression: a mangler alias split across two deltas must be recovered in
  // the assembled result (per-chunk unescaping would fossilize it). Runtime
  // analog of the source-hygiene scan in mangler-alias-fossil.test.ts.
  describe("mangler unescaping on assembled strings", () => {
    it("recovers a content alias split across two chunks", async () => {
      const { mangler, head, tail, original } = makeSplitAlias();
      const processor = createStreamProcessor();
      const result = await processEvents(
        processor,
        [
          { type: "content", content: head },
          { type: "content", content: tail },
        ],
        {},
        mangler,
      );

      expect(result.fullText).toBe(original);
      expect(result.fullText).not.toContain("m_");
    });

    it("recovers a reasoning alias split across two chunks", async () => {
      const { mangler, head, tail, original } = makeSplitAlias();
      const processor = createStreamProcessor();
      const result = await processEvents(
        processor,
        [
          { type: "reasoning", content: head },
          { type: "reasoning", content: tail },
        ],
        {},
        mangler,
      );

      expect(result.fullReasoning).toBe(original);
      expect(result.fullText).toBe("");
    });

    it("recovers an alias split across tool argument chunks", async () => {
      const mangler = new MarkerMangler();
      const marker = "<" + "tool-call" + ">";
      // JSON argument payload carrying the protected marker in tag form.
      const wireArgs = JSON.stringify({ note: `<${marker}>` });
      const escapedArgs = mangler.escape(wireArgs) ?? "";
      const aliasStart = escapedArgs.indexOf("m_");
      const aliasEnd = escapedArgs.indexOf(">", aliasStart);
      const mid = aliasStart + Math.floor((aliasEnd - aliasStart) / 2);

      const processor = createStreamProcessor();
      const result = await processEvents(
        processor,
        [
          { type: "toolName", index: 0, name: "write_file", toolCallId: "call-1" },
          { type: "toolArgument", index: 0, arguments: escapedArgs.slice(0, mid) },
          { type: "toolArgument", index: 0, arguments: escapedArgs.slice(mid) },
        ],
        {},
        mangler,
      );

      expect(result.finalToolCalls).toHaveLength(1);
      expect(result.finalToolCalls![0]!.function.name).toBe("write_file");
      expect(result.finalToolCalls![0]!.function.arguments).toBe(wireArgs);
      expect(result.finalToolCalls![0]!.function.arguments).not.toContain("m_");
    });

    it("passes a normal (non-marker) tool name through unchanged", async () => {
      const { mangler } = makeSplitAlias();
      const processor = createStreamProcessor();
      const result = await processEvents(
        processor,
        [
          { type: "toolName", index: 0, name: "bash", toolCallId: "call-1" },
          { type: "toolArgument", index: 0, arguments: "{}" },
        ],
        {},
        mangler,
      );

      // Tool names are bare identifiers, never tag-form markers, so the
      // mangler leaves them untouched (unescape is a defensive no-op here).
      expect(result.finalToolCalls![0]!.function.name).toBe("bash");
    });

    it("display callbacks get per-chunk unescaping (complete alias in one chunk)", async () => {
      const mangler = new MarkerMangler();
      const marker = "<" + "tool-call" + ">";
      const wire = mangler.escape(`pre ${marker} post`) ?? "";
      const real = `pre ${marker} post`;

      const chunks: string[] = [];
      const processor = createStreamProcessor();
      const result = await processEvents(
        processor,
        [{ type: "content", content: wire }],
        { onChunk: (c) => chunks.push(c) },
        mangler,
      );

      // A complete alias in a single chunk is unescaped for display...
      expect(chunks).toEqual([real]);
      // ...and the assembled result matches.
      expect(result.fullText).toBe(real);
    });

    it("display of a split alias shows raw fragments (accepted transient)", async () => {
      const { mangler, head, tail } = makeSplitAlias();
      const chunks: string[] = [];
      const processor = createStreamProcessor();
      await processEvents(
        processor,
        [
          { type: "content", content: head },
          { type: "content", content: tail },
        ],
        { onChunk: (c) => chunks.push(c) },
        mangler,
      );

      // Neither half holds a complete alias, so per-chunk display unescaping
      // cannot recover it -- the fragments pass through raw. The stored
      // result is still correct (see the split-chunk test above).
      expect(chunks).toEqual([head, tail]);
    });

    it("is a no-op without a mangler", async () => {
      const { head, tail } = makeSplitAlias();
      const processor = createStreamProcessor();
      const result = await processEvents(
        processor,
        [
          { type: "content", content: head },
          { type: "content", content: tail },
        ],
      );

      expect(result.fullText).toBe(head + tail);
    });
  });

  describe("reset (mid-stream retry)", () => {
    it("discards the failed attempt's partial output and replay state", async () => {
      const processor = createStreamProcessor();
      const chunks: string[] = [];

      async function* stream(): AsyncGenerator<StreamEvent> {
        yield { type: "content", content: "old " };
        yield { type: "reasoning", content: "old-reasoning" };
        yield { type: "toolName", index: 0, name: "old-tool", toolCallId: "c1" };
        yield { type: "reset" };
        // By the time the producer resumes after the reset, the processor
        // must have discarded everything from the failed attempt, including
        // the replay buffers a reconnecting client would read.
        expect(processor.streamingContent).toBe("");
        expect(processor.streamingReasoning).toBe("");
        yield { type: "content", content: "fresh" };
      }

      const result = await processor.process(stream(), {
        onChunk: (c) => chunks.push(c),
      });

      // Only the successful attempt's text is assembled (display keeps the
      // already-shown chunks; a terminal cannot be rewound).
      expect(result.fullText).toBe("fresh");
      expect(result.fullReasoning).toBeNull();
      expect(result.finalToolCalls).toBeNull();
      expect(chunks).toEqual(["old ", "fresh"]);
    });

    it("assembles normally when no reset arrives", async () => {
      const processor = createStreamProcessor();
      const result = await processEvents(processor, [
        { type: "content", content: "a" },
        { type: "content", content: "b" },
      ]);
      expect(result.fullText).toBe("ab");
    });
  });

  describe("onToolCallDelta (in-flight tool calls)", () => {
    it("carries the accumulated name and args per index", async () => {
      const processor = createStreamProcessor();
      const deltas: Array<{ index: number; name: string; args: string }> = [];
      await processEvents(
        processor,
        [
          { type: "toolName", index: 0, name: "bash", toolCallId: "c1" },
          { type: "toolArgument", index: 0, arguments: '{"comm' },
          { type: "toolArgument", index: 0, arguments: 'and":"ls"}' },
        ],
        { onToolCallDelta: (tc) => deltas.push(tc) },
      );

      expect(deltas).toEqual([
        { index: 0, name: "bash", args: "" },
        { index: 0, name: "bash", args: '{"comm' },
        { index: 0, name: "bash", args: '{"command":"ls"}' },
      ]);
    });

    it("keeps parallel call indexes independent", async () => {
      const processor = createStreamProcessor();
      const deltas: Array<{ index: number; name: string; args: string }> = [];
      await processEvents(
        processor,
        [
          { type: "toolName", index: 0, name: "read", toolCallId: "c1" },
          { type: "toolArgument", index: 0, arguments: '{"path"' },
          { type: "toolName", index: 1, name: "bash", toolCallId: "c2" },
          { type: "toolArgument", index: 1, arguments: '{"command"' },
          { type: "toolArgument", index: 0, arguments: ':"a.ts"}' },
        ],
        { onToolCallDelta: (tc) => deltas.push(tc) },
      );

      // Each delta reports only ITS index's accumulated args, mid-stream.
      expect(deltas[1]).toEqual({ index: 0, name: "read", args: '{"path"' });
      expect(deltas[2]).toEqual({ index: 1, name: "bash", args: "" });
      expect(deltas[4]).toEqual({ index: 0, name: "read", args: '{"path":"a.ts"}' });
    });

    it("resurrects buffered args on a resent name delta (merge, never replace)", async () => {
      const processor = createStreamProcessor();
      const deltas: Array<{ index: number; name: string; args: string }> = [];
      await processEvents(
        processor,
        [
          { type: "toolName", index: 0, name: "read", toolCallId: "c1" },
          { type: "toolArgument", index: 0, arguments: '{"path"' },
          // llama.cpp-family resend: name again, no id, no args.
          { type: "toolName", index: 0, name: "read", toolCallId: "" },
        ],
        { onToolCallDelta: (tc) => deltas.push(tc) },
      );

      expect(deltas[2]).toEqual({ index: 0, name: "read", args: '{"path"' });
    });

    it("display-unescapes the whole accumulated args, self-healing a split alias", async () => {
      const mangler = new MarkerMangler();
      const marker = "<" + "tool-call" + ">";
      const wireArgs = mangler.escape(JSON.stringify({ note: `<${marker}>` })) ?? "";
      const aliasStart = wireArgs.indexOf("m_");
      const aliasEnd = wireArgs.indexOf(">", aliasStart);
      const mid = aliasStart + Math.floor((aliasEnd - aliasStart) / 2);

      const processor = createStreamProcessor();
      const deltas: Array<{ index: number; name: string; args: string }> = [];
      await processEvents(
        processor,
        [
          { type: "toolName", index: 0, name: "write", toolCallId: "c1" },
          { type: "toolArgument", index: 0, arguments: wireArgs.slice(0, mid) },
          { type: "toolArgument", index: 0, arguments: wireArgs.slice(mid) },
        ],
        { onToolCallDelta: (tc) => deltas.push(tc) },
        mangler,
      );

      // The complete args land unescaped; the split partial may briefly show
      // an alias fragment (accepted transient, same doctrine as onChunk).
      expect(deltas[2]!.args).toBe(JSON.stringify({ note: `<${marker}>` }));
      // The final (longest) delta never carries a raw alias.
      expect(deltas[2]!.args).not.toContain("m_");
    });

    it("fires for toolName-only calls (no arguments ever streamed)", async () => {
      const processor = createStreamProcessor();
      const deltas: Array<{ index: number; name: string; args: string }> = [];
      await processEvents(
        processor,
        [{ type: "toolName", index: 0, name: "now", toolCallId: "c1" }],
        { onToolCallDelta: (tc) => deltas.push(tc) },
      );

      expect(deltas).toEqual([{ index: 0, name: "now", args: "" }]);
    });
  });
});
