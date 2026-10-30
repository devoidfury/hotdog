// Tests for openaiProtocol.parseStream() — SSE and non-SSE response parsing,
// mangler unescaping, and the invalid-response error paths.
// buildRequest/buildHeaders coverage lives in wire-format.test.ts and
// protocol-path.test.ts.

import { describe, it, expect } from "bun:test";
import { openaiProtocol } from "@core/llm-client/openai-protocol.ts";
import { StreamProcessor } from "@core/llm-client/stream-processor.ts";
import { MarkerMangler } from "@core/marker-mangler.ts";
import type { ProtocolContext } from "@core/llm-client/protocol.ts";
import type { StreamEvent } from "@core/llm-client/client.ts";

function ctx(mangler: MarkerMangler | null = null): ProtocolContext {
  // No WireFormat: these tests parse streams and build bodies with no
  // tool-result parts, which is exactly what a null format allows.
  return { mangler, wireFormat: null, roleMapping: null, baseUrl: "http://p.example", apiKey: "k", sessionId: "s1" };
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {"content-type": "text/event-stream"},
  });
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("openaiProtocol.parseStream", () => {
  it("parses a real non-streaming JSON completion (message shape)", async () => {
    // The shape an OpenAI-compatible gateway actually returns for a
    // non-streaming body: choices[].message, NOT choices[].delta.
    const resp = jsonResponse({
      choices: [{
        index: 0,
        message: { role: "assistant", content: "hello" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
    expect(await collect(openaiProtocol.parseStream(resp, ctx()))).toEqual([
      { type: "content", content: "hello" },
      { type: "finish", reason: "stop" },
      { type: "usage", data: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ]);
  });

  it("emits reasoning events from a message with reasoning_content (JSON body)", async () => {
    const resp = jsonResponse({
      choices: [{
        message: { role: "assistant", reasoning_content: "thinking hard", content: "answer" },
        finish_reason: "stop",
      }],
    });
    expect(await collect(openaiProtocol.parseStream(resp, ctx()))).toEqual([
      { type: "reasoning", content: "thinking hard" },
      { type: "content", content: "answer" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("prefers delta over message when a body oddly carries both", async () => {
    const resp = jsonResponse({
      choices: [{
        delta: { content: "from delta" },
        message: { content: "from message" },
        finish_reason: "stop",
      }],
    });
    expect(await collect(openaiProtocol.parseStream(resp, ctx()))).toEqual([
      { type: "content", content: "from delta" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("assembles two index-less message tool_calls end-to-end into two distinct calls", async () => {
    // Non-streaming tool_calls are COMPLETE entries (id + full arguments)
    // with NO index field. Keying them all at 0 would collapse the pair.
    const resp = jsonResponse({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
            { id: "call_b", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } },
          ],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    const result = await new StreamProcessor().process(
      openaiProtocol.parseStream(resp, ctx()),
    );
    expect(result.finalToolCalls).toEqual([
      { id: "call_a", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
      { id: "call_b", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } },
    ]);
    for (const tc of result.finalToolCalls!) {
      expect(() => JSON.parse(tc.function.arguments)).not.toThrow();
    }
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
    expect(result.fullText).toBe("");
  });

  it("throws InvalidResponse for non-SSE bodies that are not JSON", async () => {
    const resp = new Response("<html>oops</html>", {
      status: 200,
      headers: {"content-type": "text/html"},
    });
    await expect(collect(openaiProtocol.parseStream(resp, ctx()))).rejects.toThrow(
      "Unexpected Content-Type",
    );
  });

  it("throws InvalidResponse when an SSE response has a null body", async () => {
    const resp = new Response(null, {
      status: 200,
      headers: {"content-type": "text/event-stream"},
    });
    await expect(collect(openaiProtocol.parseStream(resp, ctx()))).rejects.toThrow(
      "Response body is null",
    );
  });

  it("emits raw wire content: no per-chunk unescaping", async () => {
    const mangler = new MarkerMangler();
    // A protected marker inside model output is mangled on the wire. The
    // protocol must emit the escaped alias verbatim (raw): unescaping
    // per delta would fossilize aliases that straddle a delta boundary.
    // Consumers unescape once on the assembled string (StreamProcessor).
    const tag = 'thinking'
    const wire = mangler.escape(`start </${tag}> end`) ?? "";
    expect(wire).not.toContain(`</${tag}>`);
    const body = `data: {"choices":[{"delta":{"reasoning_content":"${wire}"}}]}\n\n`;
    const events = await collect(openaiProtocol.parseStream(sseResponse(body), ctx(mangler)));
    expect(events).toEqual([{ type: "reasoning", content: wire }]);
    // Sanity: the raw wire content round-trips through the mangler.
    expect(mangler.unescape(wire)).toBe(`start </${tag}> end`);
  });

  it("passes an alias split across two deltas through unmodified", async () => {
    const mangler = new MarkerMangler();
    const tag = "tool-call";
    const escaped = mangler.escape(`<${tag}>body</${tag}>`) ?? "";
    const alias = escaped.slice(1, escaped.indexOf(">"));
    expect(alias).toMatch(/^m_[a-z2-9]{16}$/);
    // Split the tag form right through the middle of the alias body, the way
    // a tokenizer would.
    const mid = 2 + Math.floor(alias.length / 2);
    const [head, tail] = [escaped.slice(0, mid), escaped.slice(mid)];
    const body =
      `data: {"choices":[{"delta":{"content":"${head}"}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"${tail}"}}]}\n\n`;
    const events = await collect(openaiProtocol.parseStream(sseResponse(body), ctx(mangler)));
    // Raw halves, untouched: neither half is unescapeable on its own.
    expect(events.map((e) => (e as { content: string }).content)).toEqual([head, tail]);
  });

  it("emits tool call, finish, and usage events", async () => {
    const mangler = new MarkerMangler();
    const body =
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n` +
      `data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n`;
    expect(await collect(openaiProtocol.parseStream(sseResponse(body), ctx(mangler)))).toEqual([
      { type: "toolName", index: 0, name: "bash", toolCallId: "c1" },
      { type: "toolArgument", index: 0, arguments: '{"command":"ls"}' },
      { type: "finish", reason: "tool_calls" },
      { type: "usage", data: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
    ]);
  });
});
