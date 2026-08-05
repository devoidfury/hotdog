import { describe, it, expect } from "bun:test";
import { SseParser, parseSse, type SseParserOptions } from "../../../src/core/llm-client/sse-parser.ts";

/**
 * Create a ReadableStream<Uint8Array> from a string.
 */
function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/**
 * Create a ReadableStream<Uint8Array> that yields chunks one at a time.
 */
function streamFromChunks(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/**
 * Collect all yielded values from an async generator.
 */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const value of gen) {
    results.push(value);
  }
  return results;
}

describe("SseParser", () => {
  describe("parseSse()", () => {
    it("yields JSON objects from a simple SSE stream", async () => {
      const sse = `data: {"choices":[{"delta":{"content":"hello"}}]}

data: {"choices":[{"delta":{"content":" world"}}]}

data: [DONE]
`;
      const results = await collect(parseSse(streamFromText(sse)));
      expect(results).toEqual([
        { choices: [{ delta: { content: "hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
      ]);
    });

    it("handles comments (lines starting with ':')", async () => {
      const sse = `: this is a comment
data: {"id":"123"}

`;
      const results = await collect(parseSse(streamFromText(sse)));
      expect(results).toEqual([{ id: "123" }]);
    });

    it("handles blank lines between events", async () => {
      const sse = `data: {"a":1}


data: {"b":2}

`;
      const results = await collect(parseSse(streamFromText(sse)));
      expect(results).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it("ignores non-message events", async () => {
      // After event: ping, data lines belong to "ping" event.
      // Need to reset with event: (empty) or event: message to get back to default.
      const sse = `event: ping
data: {"type":"ping"}

event: message
data: {"choices":[{"delta":{"content":"ok"}}]}

`;
      const results = await collect(parseSse(streamFromText(sse)));
      expect(results).toEqual([{ choices: [{ delta: { content: "ok" } }] }]);
    });

    it("handles empty event name explicitly", async () => {
      const sse = `event:
data: {"explicit":true}

`;
      const results = await collect(parseSse(streamFromText(sse)));
      expect(results).toEqual([{ explicit: true }]);
    });
  });

  describe("multi-chunk JSON", () => {
    it("reassembles JSON split across network chunks (single data line)", async () => {
      // A single SSE data line whose JSON payload is split across read() calls.
      // The parser must accumulate the partial JSON until it's complete.
      const results = await collect(
        parseSse(streamFromChunks(
          'data: {"choices":[{"delta":{"content":"',
          'hello world"}}]}\n\n',
        )),
      );
      expect(results).toEqual([{ choices: [{ delta: { content: "hello world" } }] }]);
    });

    it("handles [DONE] flush of accumulated JSON", async () => {
      const results = await collect(
        parseSse(streamFromChunks(
          'data: {"choices":[{"delta":{"content":"x"}}]}\n',
          "data: [DONE]\n",
        )),
      );
      expect(results).toEqual([{ choices: [{ delta: { content: "x" } }] }]);
    });

    it("handles multiple complete events followed by split event", async () => {
      // First event is complete. Second event's JSON is split across chunks.
      const results = await collect(
        parseSse(streamFromChunks(
          'data: {"a":1}\n\n',
          'data: {"b":2}\n\n',
        )),
      );
      expect(results).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it("reassembles very large JSON split across many chunks", async () => {
      const bigContent = "x".repeat(10000);
      const json = JSON.stringify({ choices: [{ delta: { content: bigContent } }] });
      const mid = Math.floor(json.length / 2);
      // Split the JSON payload mid-stream: first chunk ends mid-JSON (no newline),
      // second chunk continues the JSON and ends with newlines.
      const results = await collect(
        parseSse(streamFromChunks(
          `data: ${json.slice(0, mid)}`,
          `${json.slice(mid)}\n\n`,
        )),
      );
      expect(results).toEqual([{ choices: [{ delta: { content: bigContent } }] }]);
    });

    it("handles partial JSON that becomes valid after accumulating more data", async () => {
      // First data line has incomplete JSON, second data line continues it.
      // (SSE concatenates multiple data: lines with newlines between them.)
      const results = await collect(
        parseSse(streamFromChunks(
          'data: {"partial":true',
          '\ndata: ,"complete":true}\n\n',
        )),
      );
      // The two data lines concatenate as: {"partial":true\n,"complete":true}
      // which is valid JSON with a newline in the middle of the object.
      expect(results.length).toBe(1);
      expect(results[0].partial).toBe(true);
      expect(results[0].complete).toBe(true);
    });
  });

  describe("error handling", () => {
    it("warns on malformed JSON at [DONE] flush", async () => {
      const warnings: string[] = [];
      const results = await collect(
        parseSse(
          streamFromText('data: {bad json}\ndata: [DONE]\n'),
          { onWarning: (msg) => warnings.push(msg) },
        ),
      );
      expect(results).toEqual([]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("malformed JSON on [DONE] flush");
    });

    it("warns and discards on buffer overflow", async () => {
      const warnings: string[] = [];
      const bigChunk = '{"x":"' + "a".repeat(1000) + '"';
      const results = await collect(
        parseSse(
          streamFromText(`data: ${bigChunk}\n`),
          { maxJsonBuffer: 100, onWarning: (msg) => warnings.push(msg) },
        ),
      );
      expect(results).toEqual([]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("malformed JSON");
    });

    it("warns on truncated JSON at EOF", async () => {
      const warnings: string[] = [];
      // Newline triggers line processing; incomplete JSON stays in jsonBuffer until EOF.
      const results = await collect(
        parseSse(
          streamFromText('data: {"incomplete\n'),
          { onWarning: (msg) => warnings.push(msg) },
        ),
      );
      expect(results).toEqual([]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("truncated JSON at EOF");
    });

    it("uses logger.warn when no onWarning callback provided", async () => {
      // Just verify it doesn't throw — logger.warn is a no-op in tests
      const results = await collect(
        parseSse(streamFromText('data: {bad}\n')),
      );
      expect(results).toEqual([]);
    });
  });

  describe("SseParser class", () => {
    it("provides the same parse() method as the factory function", async () => {
      const parser = new SseParser();
      const sse = 'data: {"test":true}\n\n';
      const results = await collect(parser.parse(streamFromText(sse)));
      expect(results).toEqual([{ test: true }]);
    });

    it("respects maxJsonBuffer option", async () => {
      const warnings: string[] = [];
      const parser = new SseParser({
        maxJsonBuffer: 50,
        onWarning: (msg) => warnings.push(msg),
      });
      const bigChunk = '{"x":"' + "a".repeat(200) + '"';
      const results = await collect(parser.parse(streamFromText(`data: ${bigChunk}\n`)));
      expect(results).toEqual([]);
      expect(warnings.length).toBe(1);
    });

    it("can be reused for multiple streams", async () => {
      const parser = new SseParser();
      const results1 = await collect(parser.parse(streamFromText('data: {"a":1}\n\n')));
      const results2 = await collect(parser.parse(streamFromText('data: {"b":2}\n\n')));
      expect(results1).toEqual([{ a: 1 }]);
      expect(results2).toEqual([{ b: 2 }]);
    });
  });

  describe("edge cases", () => {
    it("handles empty stream", async () => {
      const results = await collect(parseSse(streamFromText("")));
      expect(results).toEqual([]);
    });

    it("handles stream with only whitespace", async () => {
      const results = await collect(parseSse(streamFromText("   \n\n   \n")));
      expect(results).toEqual([]);
    });

    it("handles JSON with nested structures", async () => {
      const complex = {
        choices: [
          {
            delta: {
              content: "test",
              tool_calls: [{ function: { name: "read", arguments: '{"path":"x"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const sse = `data: ${JSON.stringify(complex)}\n\n`;
      const results = await collect(parseSse(streamFromText(sse)));
      expect(results).toEqual([complex]);
    });

    it("handles data lines with leading/trailing whitespace", async () => {
      const sse = `  data: {"trimmed":true}  
`;
      const results = await collect(parseSse(streamFromText(sse)));
      expect(results).toEqual([{ trimmed: true }]);
    });
  });
});
