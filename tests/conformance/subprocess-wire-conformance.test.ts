// Subprocess conformance tier: spawn the real `bin/hotdog` against a loopback
// scripted-wire server and assert what reaches the provider over an actual
// socket -- transport, headers, and request-body shape.
//
// The in-process suites (openai-wire-conformance.test.ts, the ui-one-shot
// tests) keep their stream mocks; this tier adds the end-to-end `-p` path they
// cannot reach: argv -> config resolution -> LlmClient -> fetch -> wire.
//
// Oracle: the vendored openai-openapi fixtures, same rule as the rest of this
// directory -- scripted provider responses are the sealed official-example
// fixtures or mechanically derived from them (never from hotdog output).

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJsonFixture, loadTextFixture } from "./helpers.ts";

const BIN = join(import.meta.dir, "..", "..", "bin", "hotdog");
const API_KEY = "test-key";
const MODEL = "test-model";

// ---------------------------------------------------------------- fixtures

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
      tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[];
    };
    finish_reason: string;
  }[];
  usage: Record<string, unknown>;
}>("openai/tools-response.json");

const { text: streamSse } = await loadTextFixture("openai/stream.sse");

// DERIVED from tools-response.json (official example): the non-stream
// tool_calls message -> streaming deltas, splitting the fixture's
// `arguments` JSON string into two fragments. Mechanical transform only.
function toolCallSseFromFixture(): string {
  const call = toolResp.choices[0]!.message.tool_calls[0]!;
  const args = call.function.arguments;
  const half = Math.ceil(args.length / 2);
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] })}\n\n`;
  return (
    chunk(
      { role: "assistant", tool_calls: [{ index: 0, id: call.id, type: call.type, function: { name: call.function.name, arguments: "" } }] },
      null,
    ) +
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] }, null) +
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }, null) +
    chunk({}, toolResp.choices[0]!.finish_reason) +
    "data: [DONE]\n\n"
  );
}

// ---------------------------------------------------------------- server

interface CapturedRequest {
  method: string;
  path: string;
  auth: string | null;
  contentType: string | null;
  body: Record<string, unknown> | null;
}

interface Scripted {
  requests: CapturedRequest[];
  readonly chatRequests: CapturedRequest[];
  url: string;
  stop(): void;
}

/** Loopback provider: /v1/models answers an empty list; each
 *  /v1/chat/completions pops the next scripted Response factory. An
 *  unscripted chat call gets 599 -- if a test hangs, look here first:
 *  hotdog retries retryable failures with exponential backoff, and an
 *  over-run script turns into a long retry spiral, not a fast failure. */
function startScriptedProvider(script: Array<() => Response>): Scripted {
  const requests: CapturedRequest[] = [];
  let chat = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let body: Record<string, unknown> | null = null;
      if (req.method === "POST") {
        try {
          body = JSON.parse(await req.text());
        } catch {
          body = null;
        }
      }
      requests.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body,
      });
      if (url.pathname.endsWith("/chat/completions")) {
        const next = script[chat++];
        if (!next) return new Response("unscripted chat call", { status: 599 });
        return next();
      }
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [] });
      return new Response("not found", { status: 404 });
    },
  });
  return {
    requests,
    get chatRequests() {
      return requests.filter((r) => r.path.endsWith("/chat/completions"));
    },
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(),
  };
}

// ---------------------------------------------------------------- spawn

const sandbox = mkdtempSync(join(tmpdir(), "hotdog-wire-"));
mkdirSync(join(sandbox, "config"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** One isolated `-p` run: empty config dir (pure defaults), scrubbed env,
 *  cwd inside the sandbox so no workspace or user config is picked up. */
async function runOneShot(provider: Scripted): Promise<Run> {
  const proc = Bun.spawn(
    [process.execPath, BIN, "-p", toolReq.messages[0]!.content, "--ai-url", provider.url, "-k", API_KEY, "-m", MODEL],
    {
      cwd: sandbox,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: sandbox,
        HOTDOG_CONFIG_DIR: join(sandbox, "config"),
        HOTDOG_LOG_LEVEL: "error",
        HOTDOG_LOG_TARGET: "none",
      },
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout: stdout.replace(/\u001b\[[0-9;]*m/g, ""), stderr };
}

const sseResponse = (sse: string) =>
  new Response(sse, { headers: { "content-type": "text/event-stream" } });

// ---------------------------------------------------------------- tests

describe("subprocess wire conformance: -p against a loopback provider", () => {
  let provider: Scripted;
  let run: Run;

  beforeAll(async () => {
    provider = startScriptedProvider([
      () => sseResponse(toolCallSseFromFixture()), // first chat: fixture tool_calls, streamed
      () => sseResponse(streamSse), // second: the official streaming example
    ]);
    run = await runOneShot(provider);
  }, 30_000);

  afterAll(() => provider.stop());

  it("OpenAI API ref: POST /v1/chat/completions over a real socket, exit 0", () => {
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const chats = provider.chatRequests;
    expect(chats).toHaveLength(2); // tool round-trip, then final answer
    for (const c of chats) {
      expect(c.method).toBe("POST");
      expect(c.path).toBe("/v1/chat/completions");
      expect(c.contentType).toMatch(/application\/json/);
    }
  });

  it("OpenAI API ref: Bearer auth header reaches the provider", () => {
    for (const c of provider.chatRequests) expect(c.auth).toBe(`Bearer ${API_KEY}`);
  });

  it("OpenAI API ref: request body carries model, stream, stream_options.include_usage", () => {
    for (const c of provider.chatRequests) {
      expect(c.body!.model).toBe(MODEL);
      expect(c.body!.stream).toBe(true);
      expect(c.body!.stream_options).toEqual({ include_usage: true });
    }
  });

  it("OpenAI API ref: messages are {role, content}; system first, prompt last as user", () => {
    const msgs = provider.chatRequests[0]!.body!.messages as Record<string, unknown>[];
    expect(msgs[0]!.role).toBe("system");
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toBe(toolReq.messages[0]!.content); // verbatim from the official example
    for (const m of msgs) expect(typeof m.role).toBe("string");
  });

  it("OpenAI API ref: tools[] are {type:'function', function:{name, description, parameters.type:'object'}}", () => {
    const tools = provider.chatRequests[0]!.body!.tools as Record<string, unknown>[];
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.type).toBe("function");
      const fn = t.function as Record<string, unknown>;
      expect(typeof fn.name).toBe("string");
      expect(typeof fn.description).toBe("string");
      expect((fn.parameters as Record<string, unknown>).type).toBe("object");
    }
  });

  it("OpenAI API ref: tool_choice / parallel_tool_calls take only legal values", () => {
    for (const c of provider.chatRequests) {
      const choice = c.body!.tool_choice;
      const legal =
        choice === "none" || choice === "auto" || choice === "required" || typeof choice === "object";
      expect(legal).toBe(true);
      expect(typeof c.body!.parallel_tool_calls).toBe("boolean");
    }
  });

  it("OpenAI API ref: streamed tool_calls round-trip into assistant + role:'tool' messages", () => {
    // The oracle id/name from tools-response.json must come back on the
    // second request exactly as the first response streamed it.
    const call = toolResp.choices[0]!.message.tool_calls[0]!;
    const msgs = provider.chatRequests[1]!.body!.messages as Record<string, unknown>[];
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const toolCalls = assistant!.tool_calls as Record<string, unknown>[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.id).toBe(call.id);
    expect(toolCalls[0]!.type).toBe("function");
    const fn = toolCalls[0]!.function as Record<string, unknown>;
    expect(fn.name).toBe(call.function.name);
    expect(typeof fn.arguments).toBe("string"); // arguments stays a JSON string on the wire
    expect(() => JSON.parse(fn.arguments as string)).not.toThrow();
    expect(JSON.parse(fn.arguments as string)).toEqual(JSON.parse(call.function.arguments));

    const toolMsg = msgs.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe(call.id);
    expect(typeof toolMsg!.content).toBe("string");
    // tool result must immediately follow its assistant call
    expect(msgs.indexOf(toolMsg!)).toBe(msgs.indexOf(assistant!) + 1);
  });

  it("OpenAI streaming docs: [DONE]-terminated stream reaches stdout, exit 0", () => {
    // stream.sse delta contents concat to "Hello".
    expect(run.stdout).toContain("Hello");
  });
});
