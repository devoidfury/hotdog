// Tests for openaiProtocol.parseStream() — SSE and non-SSE response parsing,
// mangler unescaping, and the invalid-response error paths.
// buildRequest/buildHeaders coverage lives in wire-format.test.ts and
// protocol-path.test.ts.

import { describe, it, expect } from "bun:test";
import { openaiProtocol } from "../../../src/core/llm-client/openai-protocol.ts";
import { MarkerMangler } from "../../../src/core/marker-mangler.ts";
import type { ProtocolContext } from "../../../src/core/llm-client/protocol.ts";
import type { StreamEvent } from "../../../src/core/llm-client/client.ts";

function ctx(mangler: MarkerMangler | null = null): ProtocolContext {
  return { mangler, baseUrl: "http://p.example", apiKey: "k", sessionId: "s1" };
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: new Map([["content-type", "text/event-stream"]]),
  });
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

describe("openaiProtocol.parseStream", () => {
  it("parses non-SSE JSON responses", async () => {
    const resp = new Response(
      JSON.stringify({ choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] }),
      { status: 200, headers: new Map([["content-type", "application/json"]]) },
    );
    expect(await collect(openaiProtocol.parseStream(resp, ctx()))).toEqual([
      { type: "content", content: "hello" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("throws InvalidResponse for non-SSE bodies that are not JSON", async () => {
    const resp = new Response("<html>oops</html>", {
      status: 200,
      headers: new Map([["content-type", "text/html"]]),
    });
    await expect(collect(openaiProtocol.parseStream(resp, ctx()))).rejects.toThrow(
      "Unexpected Content-Type",
    );
  });

  it("throws InvalidResponse when an SSE response has a null body", async () => {
    const resp = new Response(null, {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
    });
    await expect(collect(openaiProtocol.parseStream(resp, ctx()))).rejects.toThrow(
      "Response body is null",
    );
  });

  it("emits reasoning events unescaped through the mangler", async () => {
    const mangler = new MarkerMangler();
    // A protected marker inside model output is mangled on the wire and must
    // come back un-mangled.
    const tag = 'thinking'
    const wire = mangler.escape(`start </${tag}> end`);
    expect(wire).not.toContain(`</${tag}>`);
    const body = `data: {"choices":[{"delta":{"reasoning_content":"${wire}"}}]}\n\n`;
    expect(await collect(openaiProtocol.parseStream(sseResponse(body), ctx(mangler)))).toEqual([
      { type: "reasoning", content: `start </${tag}> end` },
    ]);
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
