// OpenAI Chat Completions wire-shape conformance for openaiProtocol
// (src/core/llm-client/openai-protocol.ts) + serialize.ts.
//
// Oracle: fixtures vendored from the openai/openai-openapi spec repo
// (official docs examples). OpenAI's API is unversioned: assert only
// stable-required fields, pinned by the fixture capture dates.
//
// Case provenance:
//   - tools-request.json / tools-response.json / stream.sse: official-example.
//   - The streamed-tool-call chunks and the usage chunk below are DERIVED
//     mechanically from tools-response.json (non-stream shapes -> streaming
//     deltas), never from hotdog output.

import { describe, it, expect } from "bun:test";
import { openaiProtocol } from "@core/llm-client/openai-protocol.ts";
import { Message } from "@core/context/message.ts";
import type { ProtocolContext } from "@core/llm-client/protocol.ts";
import type { ModelConfig } from "@core/config/providers.ts";
import type { ToolDef } from "@core/extensions/tool-registry.ts";
import type { StreamEvent } from "@core/llm-client/client.ts";
import { developerRoleMapping } from "@extensions/role-mapping-default/index.ts";
import { loadJsonFixture } from "./helpers.ts";

function ctx(): ProtocolContext {
  return {
    mangler: null,
    wireFormat: null,
    roleMapping: developerRoleMapping,
    baseUrl: "https://api.openai.com",
    apiKey: "k",
    sessionId: "s1",
  };
}

const modelConfig = {
  name: "openai/gpt-4o",
  temperature: null,
  contextLimit: 128_000,
  tags: [],
} as ModelConfig;

async function collect(response: Response): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of openaiProtocol.parseStream(response, ctx())) events.push(e);
  return events;
}

const { data: toolReq } = await loadJsonFixture<{
  model: string;
  messages: { role: string; content: string }[];
  tools: Record<string, unknown>[];
  tool_choice: string;
}>("openai/tools-request.json");

const { data: toolResp } = await loadJsonFixture<{
  choices: {
    message: {
      role: string;
      content: string | null;
      tool_calls: { id: string; type: string; function: { name: string; arguments: unknown } }[];
    };
    finish_reason: string;
  }[];
  usage: Record<string, unknown>;
}>("openai/tools-response.json");

describe("OpenAI wire conformance: request shape (official Functions example)", () => {
  const { path, body } = openaiProtocol.buildRequest(
    [new Message({ role: "user", content: toolReq.messages[0]!.content, source: "user" })],
    modelConfig,
    toolReq.tools as unknown as ToolDef[],
    false,
    ctx(),
  );
  const wire = body as Record<string, unknown>;

  it("OpenAI API ref: chat completions endpoint path", () => {
    expect(path).toBe("/v1/chat/completions");
  });

  it("OpenAI API ref: user message serializes as {role, content}", () => {
    const msgs = wire.messages as Record<string, unknown>[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: "user", content: toolReq.messages[0]!.content });
  });

  it("OpenAI API ref: tools[] entries are {type:'function', function:{name, description, parameters}}", () => {
    // The fixture is the official definition; hotdog must pass it through
    // un-restructured -- a dropped/renamed wrapper field breaks every call.
    expect(wire.tools).toEqual(toolReq.tools);
    for (const t of toolReq.tools) {
      expect(t.type).toBe("function");
      const fn = t.function as Record<string, unknown>;
      expect(typeof fn.name).toBe("string");
      expect(typeof fn.description).toBe("string");
      expect((fn.parameters as Record<string, unknown>).type).toBe("object");
    }
  });

  it("OpenAI API ref: tool_choice is one of none/auto/required or a function object", () => {
    const choice = wire.tool_choice;
    const valid =
      choice === "none" ||
      choice === "auto" ||
      choice === "required" ||
      (typeof choice === "object" && choice !== null);
    expect(valid).toBe(true);
    expect(choice).toBe(toolReq.tool_choice);
  });

  it("OpenAI docs: streaming opts into usage with stream_options.include_usage", () => {
    const { body: sBody } = openaiProtocol.buildRequest(
      [new Message({ role: "user", content: "hi", source: "user" })],
      modelConfig,
      null,
      true,
      ctx(),
    );
    expect((sBody as Record<string, unknown>).stream).toBe(true);
    expect((sBody as Record<string, unknown>).stream_options).toEqual({ include_usage: true });
  });
});

describe("OpenAI wire conformance: response contract", () => {
  const tc = toolResp.choices[0]!.message.tool_calls[0]!;

  it("OpenAI API ref: tool_calls[].function.arguments is a JSON STRING, not an object", () => {
    // The AgentKthx bug this suite was modeled on: anything that assumes a
    // parsed object here corrupts the wire contract.
    expect(typeof tc.function.arguments).toBe("string");
    expect(() => JSON.parse(tc.function.arguments as string)).not.toThrow();
    expect(toolResp.choices[0]!.finish_reason).toBe("tool_calls");
  });

  it("OpenAI API ref: assistant message carries tool_calls; tool result message carries tool_call_id", () => {
    const messages = [
      new Message({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: tc.id,
            type: tc.type,
            function: { name: tc.function.name, arguments: tc.function.arguments as string },
          },
        ],
        source: "model",
      }),
      new Message({
        role: "tool",
        content: "sunny",
        toolCallId: tc.id,
        source: "tool",
      }),
    ];
    const { body } = openaiProtocol.buildRequest(messages, modelConfig, null, false, ctx());
    const msgs = (body as Record<string, unknown>).messages as Record<string, unknown>[];

    expect(msgs[0]!.role).toBe("assistant");
    expect(msgs[0]!.tool_calls).toEqual([tc]);
    expect(msgs[1]!.role).toBe("tool");
    expect(msgs[1]!.tool_call_id).toBe(tc.id);
  });
});

describe("OpenAI wire conformance: streaming replay (official chunk-object example)", () => {
  it("OpenAI streaming docs: official example stream parses to content + finish events, unknown fields tolerated", async () => {
    const streamText = await Bun.file(`${import.meta.dir}/fixtures/openai/stream.sse`).text();
    const payload = streamText.slice(streamText.indexOf("\n---\n") + 5);
    const response = new Response(payload, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    // The official chunks carry system_fingerprint, logprobs, obfuscation --
    // unknown fields must not throw; "" delta.content emits nothing.
    expect(await collect(response)).toEqual([
      { type: "content", content: "Hello" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("OpenAI streaming docs: tool_call deltas -- id/name then arguments fragments concatenate to the final string", async () => {
    // DERIVED: non-stream tool_call (fixture) turned into a chunk sequence.
    const args = tcArguments();
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_abc123", function: { name: "get_current_weather" } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 12) } }] } },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(12) } }] } },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    const events = await collect(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    expect(events).toEqual([
      { type: "toolName", index: 0, name: "get_current_weather", toolCallId: "call_abc123" },
      { type: "toolArgument", index: 0, arguments: args.slice(0, 12) },
      { type: "toolArgument", index: 0, arguments: args.slice(12) },
      { type: "finish", reason: "tool_calls" },
    ]);
    // The concatenated arguments must be the exact JSON string the final
    // (non-stream) response would have carried.
    const argStr = events
      .filter((e): e is Extract<StreamEvent, { type: "toolArgument" }> => e.type === "toolArgument")
      .map((e) => e.arguments)
      .join("");
    expect(JSON.parse(argStr)).toEqual(JSON.parse(args));
  });

  it("OpenAI docs (stream_options.include_usage): final usage chunk parses; empty choices is fine", async () => {
    // DERIVED: usage object taken verbatim from tools-response.json fixture.
    const chunk = { id: "chatcmpl-abc123", object: "chat.completion.chunk", choices: [], usage: toolResp.usage };
    const events = await collect(
      new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    expect(events).toEqual([{ type: "usage", data: toolResp.usage }]);
    for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
      expect(typeof toolResp.usage[key]).toBe("number");
    }
  });
});

function tcArguments(): string {
  return toolResp.choices[0]!.message.tool_calls[0]!.function.arguments as string;
}
