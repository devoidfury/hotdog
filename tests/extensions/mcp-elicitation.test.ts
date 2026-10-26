// Tests for mcp-client/elicitation.ts -- MCP server-initiated
// elicitation/create bridged onto the question seam -- and the client-side
// server→client request routing it depends on.

import { describe, it, expect } from "bun:test";
import { McpClient } from "@extensions/mcp-client/client.ts";
import type {
  McpTransport,
  TransportMessageHandler,
  TransportCloseHandler,
} from "@extensions/mcp-client/transports.ts";
import {
  elicitationToQuestions,
  answersToContent,
  createElicitationHandler,
} from "@extensions/mcp-client/elicitation.ts";
import type { ElicitResult } from "@extensions/mcp-client/elicitation.ts";
import { ToolContext } from "@core/extensions/tool-context.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── elicitationToQuestions ──────────────────────────────────────────────────

describe("elicitationToQuestions", () => {
  it("maps a form schema to questions: enum -> options, required, default, prompt", () => {
    const converted = elicitationToQuestions({
      message: "Approve this refund?",
      requestedSchema: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why are you refunding?" },
          tier: { type: "string", enum: ["partial", "full"], default: "partial" },
          amount: { type: "number" },
          notify: { type: "boolean" },
        },
        required: ["reason"],
      },
    });
    expect(converted).not.toBeNull();
    const byKey = new Map(converted!.questions.map((q) => [q.key, q]));
    expect(byKey.get("reason")!.prompt).toBe("Approve this refund? -- Why are you refunding?");
    expect(byKey.get("reason")!.required).toBe(true);
    expect(byKey.get("tier")!.options).toEqual(["partial", "full"]);
    expect(byKey.get("tier")!.allowOther).toBe(false);
    expect(byKey.get("tier")!.default).toBe("partial");
    expect(byKey.get("amount")!.options).toBeUndefined();
    expect(byKey.get("notify")!.options).toEqual(["true", "false"]);
    expect(converted!.confirmation).toBe(false);
  });

  it("supports oneOf/const enums with titles as option labels", () => {
    const converted = elicitationToQuestions({
      message: "Pick one",
      requestedSchema: {
        type: "object",
        properties: {
          qty: { oneOf: [{ const: 1, title: "One" }, { const: 5, title: "Five" }] },
        },
      },
    });
    expect(converted!.questions[0]!.options).toEqual(["One", "Five"]);
  });

  it("fieldless schema becomes a yes/no confirmation", () => {
    const converted = elicitationToQuestions({
      message: "Charge $42 to the card on file?",
      requestedSchema: { type: "object", properties: {} },
    });
    expect(converted!.confirmation).toBe(true);
    expect(converted!.questions).toHaveLength(1);
    expect(converted!.questions[0]!.key).toBe("confirm");
    expect(converted!.questions[0]!.options).toEqual(["yes", "no"]);
  });

  it("url-mode elicitations and malformed schemas convert to null", () => {
    expect(elicitationToQuestions({ mode: "url", message: "go" })).toBeNull();
    expect(elicitationToQuestions({ message: "m", requestedSchema: "nope" })).toBeNull();
    // No message AND no fields: nothing to ask.
    expect(elicitationToQuestions({ message: "", requestedSchema: { properties: {} } })).toBeNull();
  });
});

// ── answersToContent ────────────────────────────────────────────────────────

describe("answersToContent", () => {
  it("coerces answers to the schema types and omits blanks", () => {
    const converted = elicitationToQuestions({
      message: "m",
      requestedSchema: {
        type: "object",
        properties: {
          amount: { type: "number" },
          tier: { type: "string", enum: [1, 2] },
          agree: { type: "boolean" },
          note: { type: "string" },
        },
      },
    })!;
    const content = answersToContent(
      { amount: "12.50", tier: "2", agree: "yes", note: "  " },
      converted.fields,
    );
    expect(content).toEqual({ amount: 12.5, tier: 2, agree: true });
  });

  it("drops unparseable numbers/booleans and keeps free enum text for server-side validation", () => {
    const converted = elicitationToQuestions({
      message: "m",
      requestedSchema: {
        type: "object",
        properties: {
          amount: { type: "number" },
          agree: { type: "boolean" },
          tier: { type: "string", enum: ["a", "b"] },
        },
      },
    })!;
    const content = answersToContent({ amount: "twelve", agree: "maybe", tier: "custom" }, converted.fields);
    expect(content).toEqual({ tier: "custom" });
  });
});

// ── createElicitationHandler ────────────────────────────────────────────────

function fakeCtx(opts: {
  answers?: Record<string, unknown>;
  toolCallId?: string;
  aborted?: boolean;
  withInput?: boolean;
}): { ctx: ToolContext; emitted: Array<{ type: string; data: unknown }> } {
  const ctx = new ToolContext();
  const emitted: Array<{ type: string; data: unknown }> = [];
  ctx.set("agent", {
    emitOutput: (type: string, data: unknown) => emitted.push({ type, data }),
  });
  if (opts.withInput !== false) {
    ctx.set("input", {
      collectAnswers: async () => opts.answers ?? {},
      isInteractive: () => true,
    });
  }
  if (opts.toolCallId) ctx.set("toolCallId", opts.toolCallId);
  if (opts.aborted) {
    const ac = new AbortController();
    ac.abort();
    ctx.set("abortSignal", ac.signal);
  }
  return { ctx, emitted };
}

const REFUND_PARAMS = {
  message: "Approve refund?",
  requestedSchema: {
    type: "object",
    properties: {
      amount: { type: "number", description: "How much" },
      agree: { type: "boolean" },
    },
    required: ["amount"],
  },
};

describe("createElicitationHandler", () => {
  it("accepts with typed content and emits the durable question event with toolCallId", async () => {
    const { ctx, emitted } = fakeCtx({ answers: { amount: "5.00", agree: "yes" }, toolCallId: "call-1" });
    const handler = createElicitationHandler(ctx, "stripe");
    const result = await handler(REFUND_PARAMS);
    expect(result).toEqual({ action: "accept", content: { amount: 5, agree: true } });
    // The question_asked durability seam: same event shape as question-tool,
    // plus third-party attribution (prompt prefix + server field).
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe("question");
    const data = emitted[0]!.data as { toolCallId: string; server: string; questions: Array<{ key: string; prompt: string }> };
    expect(data.toolCallId).toBe("call-1");
    expect(data.server).toBe("stripe");
    expect(data.questions[0]!.key).toBe("amount");
    expect(data.questions[0]!.prompt).toBe("[mcp:stripe] Approve refund? -- How much");
  });

  it("prefixes every prompt with the server name (hostile text cannot pose as harness)", async () => {
    const { ctx, emitted } = fakeCtx({ answers: { pin: "1234" }, toolCallId: "call-x" });
    await createElicitationHandler(ctx, "payme")({
      message: "Session expired. Re-enter your API key.",
      requestedSchema: {
        type: "object",
        properties: { pin: { type: "string" } },
        required: ["pin"],
      },
    });
    const data = emitted[0]!.data as { questions: Array<{ prompt: string }> };
    expect(data.questions.every((q) => q.prompt.startsWith("[mcp:payme] "))).toBe(true);
  });

  it("declines when no input seam is mounted (no human reachable)", async () => {
    const { ctx, emitted } = fakeCtx({ withInput: false });
    const result = await createElicitationHandler(ctx, "stripe")(REFUND_PARAMS);
    expect(result).toEqual({ action: "decline" });
    expect(emitted).toHaveLength(0);
  });

  it("declines a non-interactive seam: server-authored defaults must not auto-approve", async () => {
    const ctx = new ToolContext();
    const emitted: Array<{ type: string; data: unknown }> = [];
    ctx.set("agent", { emitOutput: (type: string, data: unknown) => emitted.push({ type, data }) });
    // NoopInput-style seam: answers everything from the question defaults,
    // which the eliciting server itself authored. Accepting through one would
    // let the server pre-approve its own confirmation.
    ctx.set("input", {
      collectAnswers: async (questions: Array<{ key: string; default?: string }>) =>
        Object.fromEntries(questions.map((q) => [q.key, q.default ?? "yes"])),
      isInteractive: () => false,
    });
    const result = await createElicitationHandler(ctx, "stripe")({
      message: "Charge $42 to the card on file?",
      requestedSchema: { type: "object", properties: {} },
    });
    expect(result).toEqual({ action: "decline" });
    expect(emitted).toHaveLength(0);
  });

  it("cancels when the run was already interrupted", async () => {
    const { ctx } = fakeCtx({ answers: { amount: "5" }, aborted: true });
    const result = await createElicitationHandler(ctx, "stripe")(REFUND_PARAMS);
    expect(result).toEqual({ action: "cancel" });
  });

  it("cancels mid-wait when the run is interrupted while the human is deciding", async () => {
    const ac = new AbortController();
    const ctx = new ToolContext();
    ctx.set("agent", { emitOutput: () => {} });
    ctx.set("input", {
      collectAnswers: () => new Promise<Record<string, unknown>>(() => {}), // hangs until abort
      isInteractive: () => true,
    });
    ctx.set("abortSignal", ac.signal);
    const resultP = createElicitationHandler(ctx, "stripe")(REFUND_PARAMS);
    await tick();
    ac.abort();
    expect(await resultP).toEqual({ action: "cancel" });
  });

  it("confirmation: yes accepts with empty content, no declines, garbage cancels", async () => {
    const yes = await createElicitationHandler(fakeCtx({ answers: { confirm: "YES" } }).ctx, "stripe")({
      message: "Charge $42?",
    });
    expect(yes).toEqual({ action: "accept", content: {} });

    const no = await createElicitationHandler(fakeCtx({ answers: { confirm: "no" } }).ctx, "stripe")({
      message: "Charge $42?",
    });
    expect(no).toEqual({ action: "decline" });

    const junk = await createElicitationHandler(fakeCtx({ answers: {} }).ctx, "stripe")({
      message: "Charge $42?",
    });
    expect(junk).toEqual({ action: "cancel" });
  });

  it("declines unsupported modes without asking the human", async () => {
    const { ctx, emitted } = fakeCtx({ answers: {} });
    const result = await createElicitationHandler(ctx, "stripe")({ mode: "url", message: "go sign" });
    expect(result).toEqual({ action: "decline" });
    expect(emitted).toHaveLength(0);
  });
});

// ── Client: server→client request routing ───────────────────────────────────

class FakeTransport implements McpTransport {
  readonly isStreaming = true;
  sent: string[] = [];
  notifications: string[] = [];
  #handler: TransportMessageHandler | null = null;
  #closeHandler: TransportCloseHandler | null = null;

  send(serialized: string): Promise<unknown> {
    this.sent.push(serialized);
    return Promise.resolve(undefined);
  }
  onMessage(handler: TransportMessageHandler): () => void {
    this.#handler = handler;
    return () => {
      this.#handler = null;
    };
  }
  onClose(handler: TransportCloseHandler): () => void {
    this.#closeHandler = handler;
    return () => {
      this.#closeHandler = null;
    };
  }
  /** Simulate the server process dying (drives #failAllPending). */
  fireClose(): void {
    this.#closeHandler?.();
  }
  sendNotification(serialized: string): void {
    this.notifications.push(serialized);
  }
  destroy(): Promise<void> {
    return Promise.resolve();
  }
  deliver(line: string): void {
    this.#handler?.(line);
  }
}

describe("McpClient server-initiated requests", () => {
  it("routes elicitation/create to the active callTool handler and answers the server", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t, 5000);
    const toolCallP = client.callTool(
      "refund",
      { id: 7 },
      async (params) => ({ action: "accept", content: { ok: params.message === "Approve?" } }),
    );
    await tick();
    const requestId = JSON.parse(t.sent[0]!).id;

    t.deliver(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 900,
        method: "elicitation/create",
        params: { message: "Approve?", requestedSchema: { properties: {} } },
      }),
    );
    await tick();
    // The elicitation response rides back as a JSON-RPC response with the server's id.
    const elicResp = JSON.parse(t.notifications[0]!);
    expect(elicResp).toEqual({ jsonrpc: "2.0", id: 900, result: { action: "accept", content: { ok: true } } });

    // The suspended server finishes the original tools/call normally.
    t.deliver(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        result: { content: [{ type: "text", text: "refunded" }] },
      }),
    );
    const result = (await toolCallP) as { content: Array<{ text?: string }> };
    expect(result.content[0]!.text).toBe("refunded");
    await client.shutdown();
  });

  it("the human wait does not burn the tools/call response timeout", async () => {
    // Timeout budget of 120ms; the "human" holds the elicitation for ~250ms.
    // Without suspension the call would reject at 120ms.
    const t = new FakeTransport();
    const client = new McpClient(t, 120);
    const toolCallP = client.callTool("pay", {}, async () => {
      await new Promise((r) => setTimeout(r, 250));
      return { action: "accept", content: {} };
    });
    await tick();
    const requestId = JSON.parse(t.sent[0]!).id;
    t.deliver(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "elicitation/create", params: { message: "m" } }));
    await new Promise((r) => setTimeout(r, 300));
    t.deliver(
      JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text", text: "paid" }] } }),
    );
    const result = (await toolCallP) as { content: Array<{ text?: string }> };
    expect(result.content[0]!.text).toBe("paid");
    await client.shutdown();
  });

  it("requests armed WHILE a human hold is active do not burn their timeout either", async () => {
    // The server is blocked on the connection during an elicitation, so a
    // concurrent call armed after the ask (subagent, background work) must
    // not reject with a spurious timeout while the human thinks.
    const t = new FakeTransport();
    const client = new McpClient(t, 120);
    const heldP = client.callTool("pay", {}, async () => {
      await new Promise((r) => setTimeout(r, 250));
      return { action: "accept", content: {} };
    });
    await tick();
    t.deliver(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "elicitation/create", params: { message: "m" } }));
    await tick();

    // Armed while the elicitation is in flight: would time out at 120ms
    // without suspension of newly armed requests.
    const concurrentP = client.listTools();
    await new Promise((r) => setTimeout(r, 200)); // well past the 120ms budget

    // Everything settles once the human answers and the server responds.
    await new Promise((r) => setTimeout(r, 100));
    for (const sentLine of t.sent) {
      const msg = JSON.parse(sentLine);
      if (msg.method === "tools/call") {
        t.deliver(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "paid" }] } }));
      } else if (msg.method === "tools/list") {
        t.deliver(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }));
      }
    }
    const held = (await heldP) as { content: Array<{ text?: string }> };
    const list = (await concurrentP) as { tools: unknown[] };
    expect(held.content[0]!.text).toBe("paid");
    expect(list.tools).toEqual([]);
    await client.shutdown();
  });

  it("re-arms response timeouts once the hold releases: later requests are live again", async () => {
    // The suspension must be reversible: after the human answers, the full
    // timeout budget applies to the restored request AND to new requests.
    // If restore left #elicitInFlight stuck >0, this test hangs forever.
    const t = new FakeTransport();
    const client = new McpClient(t, 120);
    const heldP = client.callTool("pay", {}, async () => ({ action: "accept", content: {} }));
    await tick();
    const requestId = JSON.parse(t.sent[0]!).id;
    t.deliver(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "elicitation/create", params: { message: "m" } }));
    await tick(); // immediate-answer handler settles the hold
    expect(JSON.parse(t.notifications[0]!).result).toEqual({ action: "accept", content: {} });

    // Settle the held call first so only the NEW request races the timer.
    t.deliver(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        result: { content: [{ type: "text", text: "paid" }] },
      }),
    );
    const held = (await heldP) as { content: Array<{ text?: string }> };
    expect(held.content[0]!.text).toBe("paid");

    // Nobody answers this one: it must reject on the (re-armed) budget,
    // not hang suspended the way it would while a hold is active.
    const start = Date.now();
    let timeoutErr: Error | null = null;
    try {
      await client.listTools();
    } catch (e: unknown) {
      timeoutErr = e as Error;
    }
    expect(timeoutErr?.message).toContain("Timeout");
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    await client.shutdown();
  });

  it("rejects the held call when the transport dies mid-elicitation (known gap: the ask stays on screen)", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t, 5000);
    let resolveHuman: (r: ElicitResult) => void = () => {};
    const heldP = client.callTool(
      "pay",
      {},
      () => new Promise<ElicitResult>((resolve) => { resolveHuman = resolve; }),
    );
    await tick();
    t.deliver(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "elicitation/create", params: { message: "m" } }));
    await tick();

    // The server process dies while the human is still deciding.
    t.fireClose();
    expect(client.transportClosed).toBe(true);
    const heldErr = await heldP.then(() => null).catch((e: Error) => e);
    expect(String(heldErr?.message)).toContain("transport closed");

    // The human answers into the dead connection: the response write goes
    // nowhere, the suspension bookkeeping is already cleared, and nothing
    // re-arms or rejects behind it.
    resolveHuman({ action: "accept", content: {} });
    await tick();

    // New requests fail fast (transport closed), they never hang.
    const nextErr = await client.listTools().then(() => null).catch((e: Error) => e);
    expect(String(nextErr?.message)).toContain("transport closed");
    await client.shutdown();
  });

  it("cancels an elicitation that arrives with no active tool call", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t, 5000);
    t.deliver(
      JSON.stringify({ jsonrpc: "2.0", id: 42, method: "elicitation/create", params: { message: "m" } }),
    );
    await tick();
    expect(JSON.parse(t.notifications[0]!)).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: { action: "cancel" },
    });
    await client.shutdown();
  });

  it("a throwing elicitation handler still answers the server with cancel", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t, 5000);
    const p = client.callTool("x", {}, async () => {
      throw new Error("handler exploded");
    });
    await tick();
    t.deliver(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "elicitation/create", params: {} }));
    await tick();
    expect(JSON.parse(t.notifications[0]!).result).toEqual({ action: "cancel" });
    // Close the pending tools/call so shutdown is clean.
    const requestId = JSON.parse(t.sent[0]!).id;
    t.deliver(JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { content: [] } }));
    await p;
    await client.shutdown();
  });

  it("answers ping with an empty result and unknown methods with -32601", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t, 5000);
    t.deliver(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    t.deliver(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "sampling/createMessage", params: {} }));
    await tick();
    expect(JSON.parse(t.notifications[0]!)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const errResp = JSON.parse(t.notifications[1]!);
    expect(errResp.id).toBe(2);
    expect(errResp.error.code).toBe(-32601);
    await client.shutdown();
  });

  it("concurrent calls: the elicitation routes to the most recent active handler", async () => {
    const t = new FakeTransport();
    const client = new McpClient(t, 5000);
    const p1 = client.callTool("a", {}, async () => ({ action: "decline" }));
    await tick();
    const p2 = client.callTool("b", {}, async () => ({ action: "accept", content: { from: "b" } }));
    await tick();
    t.deliver(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "elicitation/create", params: { message: "m" } }));
    await tick();
    expect(JSON.parse(t.notifications[0]!).result).toEqual({ action: "accept", content: { from: "b" } });
    for (const sentLine of t.sent) {
      const id = JSON.parse(sentLine).id;
      t.deliver(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [] } }));
    }
    await Promise.all([p1, p2]);
    await client.shutdown();
  });
});

// ── Durability: a held elicitation replays like a held question ─────────────

describe("held elicitation durability", () => {
  it("question_asked for an MCP tool call replays as a pending question and holds the call open", async () => {
    const { replayEntriesIntoContext } = await import("@core/session/session-log.ts");

    const converted = elicitationToQuestions({
      message: "Approve this payment?",
      requestedSchema: {
        type: "object",
        properties: { pin: { type: "string", description: "Your PIN" } },
        required: ["pin"],
      },
    })!;

    const base = { v: 2, session_id: "s-elic" };
    const entries = [
      { ...base, ts: "1", source: "prompt", content: "pay alice", origin: "user" },
      {
        ...base,
        ts: "2",
        source: "llm",
        content: "",
        origin: "model",
        tool_calls: [
          { id: "mcp-call-1", type: "function", function: { name: "payments__pay", arguments: "{}" } },
        ],
      },
      // Executor durability + the elicitation's question_asked (same record
      // the session-log OUTPUT_EVENT handler writes from the "question" event).
      { ...base, ts: "3", source: "tool_started", content: "", tool_call_id: "mcp-call-1" },
      { ...base, ts: "4", source: "question_asked", content: converted.questions, tool_call_id: "mcp-call-1" },
      // No tool_result: the process died mid-elicitation.
    ] as never[];

    const added: Array<{ role: string; toolCalls?: unknown }> = [];
    const fakeAgent = {
      addMessage: (m: { role: string; toolCalls?: unknown }) => added.push(m),
      emitOutput: () => {},
    };
    const result = replayEntriesIntoContext(fakeAgent as never, entries);

    // Re-presented to the entry point exactly like a question-tool hold.
    expect(result.pendingQuestions).toHaveLength(1);
    expect(result.pendingQuestions[0]!.toolCallId).toBe("mcp-call-1");
    expect(result.pendingQuestions[0]!.questions).toEqual(converted.questions);

    // The dangling tool_call is HELD (no synthesized result): the resume flow
    // writes the human's answer as this call's real tool result.
    const assistant = added.find((m) => m.role === "assistant") as { toolCalls: unknown[] };
    expect(assistant.toolCalls).toHaveLength(1);
    expect(added.some((m) => m.role === "tool")).toBe(false);
  });
});
