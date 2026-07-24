// StreamProcessor tests — tests stream processing independently of Agent.

import { describe, it, expect } from "bun:test";
import {
  createStreamProcessor,
  StreamProcessor,
  type StreamCallbacks,
  type StreamResult,
} from "../../src/core/llm-client/stream-processor.ts";
import type { StreamEvent } from "../../src/core/llm-client/client.ts";

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
): Promise<StreamResult> {
  return processor.process(makeEvents(events) as unknown as AsyncIterable<StreamEvent>, callbacks);
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
  });

  describe("usage and finish", () => {
    it("should capture usage data", async () => {
      const processor = createStreamProcessor();
      const usageData = {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
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
    it("should call onChunk for content events when streaming enabled", async () => {
      const processor = createStreamProcessor({ stream: true });
      const chunks: string[] = [];

      await processEvents(processor, [
        { type: "content", content: "A" },
        { type: "content", content: "B" },
      ], {
        onChunk: (c) => chunks.push(c),
      });

      expect(chunks).toEqual(["A", "B"]);
    });

    it("should not call onChunk when streaming disabled", async () => {
      const processor = createStreamProcessor({ stream: false });
      const chunks: string[] = [];

      await processEvents(processor, [
        { type: "content", content: "A" },
      ], {
        onChunk: (c) => chunks.push(c),
      });

      expect(chunks).toEqual([]);
    });

    it("should call onReasoning for reasoning events when streaming enabled", async () => {
      const processor = createStreamProcessor({ stream: true });
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
      const usages: Record<string, unknown>[] = [];

      await processEvents(processor, [
        { type: "usage", data: { tokens: 100 } },
      ], {
        onUsage: (u) => usages.push(u),
      });

      expect(usages).toEqual([{ tokens: 100 }]);
    });

    it("should call onFinish callback", async () => {
      const processor = createStreamProcessor();
      let finishReason: string | null = null;

      await processEvents(processor, [
        { type: "finish", reason: "stop" },
      ], {
        onFinish: (r) => { finishReason = r; },
      });

      expect(finishReason as string).toBe("stop");
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
    it("should track partial content during streaming", async () => {
      const processor = createStreamProcessor({ stream: true });

      // Simulate streaming by processing events one at a time
      // In real usage, the stream is async iterable, so we can't easily
      // peek mid-stream here. Instead, verify the getter returns empty
      // after processing completes.
      const result = await processEvents(processor, [
        { type: "content", content: "Hello" },
      ]);

      // After stream completes, partial content should be cleared
      expect(processor.streamingContent).toBe("");
      expect(processor.streamingReasoning).toBe("");
      expect(result.fullText).toBe("Hello");
    });
  });

  describe("constructor options", () => {
    it("should default stream to true", async () => {
      const processor = createStreamProcessor();
      const chunks: string[] = [];

      await processEvents(processor, [
        { type: "content", content: "test" },
      ], {
        onChunk: (c) => chunks.push(c),
      });

      expect(chunks).toEqual(["test"]);
    });

    it("should respect stream: false", async () => {
      const processor = createStreamProcessor({ stream: false });
      const chunks: string[] = [];

      await processEvents(processor, [
        { type: "content", content: "test" },
      ], {
        onChunk: (c) => chunks.push(c),
      });

      expect(chunks).toEqual([]);
    });
  });
});
