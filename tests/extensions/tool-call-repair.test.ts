import { describe, it, expect } from "bun:test";
import { repairCallsInText } from "@extensions/tool-call-repair/grammar.ts";
import { create as createRepairExtension } from "@extensions/tool-call-repair/index.ts";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import { createFixture, MockLLMClient, buildStreamResponse, simpleTool } from "../helpers.ts";
import { expectCompletion } from "../test-helpers.ts";
import { toolContentText } from "@utils/tool-content.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
import type { StreamResult } from "@core/llm-client/stream-processor.ts";

// ── Token builders ───────────────────────────────────────────────────────────
// Same construction discipline as grammar.ts: a literal special token in
// this file's bytes can re-trigger the backend bug under test.

const LT = "<";
const GT = ">";
const T = (name: string): string => `${LT}|${name}|`;

/** Assemble a chatml-embedded XML-style call block (antml-ish): bare tags,
 name attaches inside the head with "=". */
function xmlBlock(
  fn: string,
  params: Array<[string, string]>,
  opts: { closeFunc?: boolean; closeCall?: boolean; paramOpen?: string } = {},
): string {
  const { closeFunc = true, closeCall = true, paramOpen = "parameter" } = opts;
  let s = LT + "tool-call" + GT + "\n";
  s += `${LT}function=${fn}${GT}\n`;
  for (const [name, value] of params) {
    s += `${LT}${paramOpen}=${name}${GT}\n${value}\n${LT}/parameter${GT}\n`;
  }
  if (closeFunc) s += `${LT}/function${GT}\n`;
  if (closeCall) s += LT + "/tool-call" + GT;
  return s;
}

/** Assemble a Hermes-format call block. */
function hermes(
  fn: string,
  params: Array<[string, string]>,
  opts: { closeFunc?: boolean; closeCall?: boolean; funcTag?: string } = {},
): string {
  const { closeFunc = true, closeCall = true, funcTag = "function" } = opts;
  let s = T("tool_call") + GT + "\n";
  s += `${T(funcTag)}${GT}=${fn}${GT}\n`;
  for (const [name, value] of params) {
    s += `${T("parameter")}${GT}=${name}${GT}\n${value}\n${T("/parameter")}${GT}\n`;
  }
  if (closeFunc) s += `${T("/" + funcTag)}${GT}\n`;
  if (closeCall) s += T("/tool_call") + GT;
  return s;
}

function mockCore(config: Record<string, unknown> = {}) {
  return {
    hooks: new HookSystem(),
    config,
    resolved: {},
    toolRegistry: { getAll: () => [], register: () => {}, has: () => false, remove: () => {} },
    extensions: { get: () => undefined },
  } as any;
}

function streamResult(opts: { fullText?: string; fullReasoning?: string } = {}) {
  const r: {
    fullText: string;
    fullReasoning: string | null;
    finalToolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> | null;
    usage: null;
    finishReason: string | null;
  } = {
    fullText: opts.fullText ?? "",
    fullReasoning: opts.fullReasoning ?? null,
    finalToolCalls: null,
    usage: null,
    finishReason: "stop",
  };
  return r;
}

function fakeAgent(opts: { iterationCount?: number; maxIterations?: number; cancelled?: boolean } = {}) {
  return {
    sessionId: "test-session",
    cancelled: opts.cancelled ?? false,
    iterationCount: opts.iterationCount ?? 1,
    maxIterations: opts.maxIterations ?? 10,
  } as any;
}

function loadExtension(config: Record<string, unknown> = {}) {
  const core = mockCore({ toolCallRepair: { enabled: true, maxRepairsPerTurn: 2, ...config } });
  const ext = createRepairExtension(core);
  return ((ext.hooks as any) ?? {})[HOOKS.PROVIDER_RESPONSE] as (p: any) => unknown;
}

// ── grammar.ts ───────────────────────────────────────────────────────────────

describe("repairCallsInText", () => {
  it("repairs a well-formed trailing call after prose", () => {
    const text = "Let me read that.\n" + hermes("read", [["path", "src/a.ts"]]);
    const r = repairCallsInText(text);
    expect(r.repaired).toBe(true);
    expect(r.text).toBe("Let me read that.");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.type).toBe("function");
    expect(r.calls[0]!.id.startsWith("call_")).toBe(true);
    expect(r.calls[0]!.function.name).toBe("read");
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ path: "src/a.ts" });
  });

  it("keeps multi-line values and strips Hermes newline wrapping", () => {
    const body = "line1\nline2";
    const text = hermes("edit", [["content", body]]);
    const r = repairCallsInText(text);
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ content: body });
  });

  it("coerces plain numbers and booleans", () => {
    const text = hermes("read", [["path", "x"], ["limit", "50"], ["raw", "false"]]);
    const r = repairCallsInText(text);
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ path: "x", limit: 50, raw: false });
  });

  it("keeps id-like numeric strings intact", () => {
    const args: Array<[string, string]> = [
      ["zip", "0123"], // leading zero
      ["snowflake", "9007199254740993"], // beyond 2^53, Number() would round
      ["neg", "-0"],
      ["decimal", "1.50"], // trailing zero is data
    ];
    const r = repairCallsInText(hermes("fetch", args));
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({
      zip: "0123",
      snowflake: "9007199254740993",
      neg: "-0",
      decimal: "1.50",
    });
  });

  it("repairs a truncated block missing its closes", () => {
    const text = hermes("bash", [["command", "ls"]], { closeFunc: false, closeCall: false });
    const r = repairCallsInText(text);
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ command: "ls" });
  });

  it("parses multiple calls in one wrapper", () => {
    const one = hermes("read", [["path", "a"]], { closeCall: false });
    const two = hermes("grep", [["pattern", "b"]], { closeFunc: false });
    // Splice: first block minus its close + second block's func region + close.
    const text = one + two;
    const r = repairCallsInText(text);
    expect(r.repaired).toBe(true);
    expect(r.calls).toHaveLength(2);
    expect(r.calls.map((c) => c.function.name)).toEqual(["read", "grep"]);
    expect(r.calls[0]!.id).not.toBe(r.calls[1]!.id);
  });

  it("repairs when a call token lands mid-sentence", () => {
    const text = "Working on it " + T("tool_call") + GT + "\n" +
      `${T("function")}${GT}=bash${GT}\n${T("parameter")}${GT}=command${GT}\necho hi\n${T("/parameter")}${GT}\n${T("/function")}${GT}`;
    const r = repairCallsInText(text);
    expect(r.repaired).toBe(true);
    expect(r.text).toBe("Working on it");
  });

  it("tolerates trailing junk: fences, commas, whitespace", () => {
    const text = hermes("bash", [["command", "ls"]]) + "\n```\n,  \n";
    const r = repairCallsInText(text);
    expect(r.repaired).toBe(true);
  });

  it("fails closed when prose follows the block", () => {
    const text = hermes("bash", [["command", "ls"]]) + "\nand then we ship it";
    const r = repairCallsInText(text);
    expect(r.repaired).toBe(false);
    expect(r.text).toBe(text);
  });

  it("fails closed on an unterminated parameter", () => {
    const text =
      T("tool_call") + GT + "\n" +
      `${T("function")}${GT}=bash${GT}\n${T("parameter")}${GT}=command${GT}\nls -la\n${T("/function")}${GT}`;
    const r = repairCallsInText(text);
    expect(r.repaired).toBe(false);
  });

  it("ignores text without any call token", () => {
    const r = repairCallsInText("just an ordinary answer <b>not markup</b>");
    expect(r.repaired).toBe(false);
  });

  it("strips a leaked think token glued to the front of the body", () => {
    const text = T("think") + GT + " hmm\n" + hermes("read", [["path", "x"]]);
    const r = repairCallsInText(text);
    expect(r.repaired).toBe(true);
    expect(r.text).toBe("hmm");
  });

  it("fails closed on a bare call open with no function block", () => {
    const text = "done " + T("tool_call") + GT;
    const r = repairCallsInText(text);
    expect(r.repaired).toBe(false);
  });

  it("fails closed when a truncated block is followed by another block", () => {
    // First block missing both closes must not swallow the second block's
    // parameters into the first call.
    const one = hermes("read", [["path", "a"]], { closeFunc: false, closeCall: false });
    const two = hermes("grep", [["pattern", "b"]]);
    const r = repairCallsInText(one + two);
    expect(r.repaired).toBe(false);
  });

  it("repairs a chatml XML-style block", () => {
    const r = repairCallsInText(xmlBlock("bash", [["command", "ls -alh ./"]]));
    expect(r.repaired).toBe(true);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.function.name).toBe("bash");
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ command: "ls -alh ./", });
  });

  it("repairs an XML-style block glued to prose with no newlines", () => {
    const r = repairCallsInText("Sure, running it." + xmlBlock("bash", [["command", "ls"]]));
    expect(r.repaired).toBe(true);
    expect(r.text).toBe("Sure, running it.");
  });

  it("repairs an XML-style block with the call close omitted", () => {
    const r = repairCallsInText("note" + xmlBlock("bash", [["command", "ls"]], { closeCall: false }));
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ command: "ls" });
  });

  it("repairs a half-piped block (bar dropped from one head)", () => {
    // antml tags with a stray Hermes bar: name still inside the head.
    const block =
      LT + "|tool-call" + GT + "\n" +
      LT + "function=bash|" + GT + "\n" +
      LT + "param=command" + GT + "\nls\n" + LT + "/param" + GT + "\n" +
      LT + "/function" + GT;
    const r = repairCallsInText(block);
    expect(r.repaired).toBe(true);
    expect(r.calls[0]!.function.name).toBe("bash");
  });
});

// ── index.ts hook ────────────────────────────────────────────────────────────

describe("tool-call-repair extension", () => {
  it("repairs a call leaked into content and flips the response", () => {
    const hook = loadExtension();
    const response = streamResult({ fullText: "Ok." + hermes("read", [["path", "f"]]) });
    hook!({ response, modelConfig: {}, agent: fakeAgent() });
    expect(response.finalToolCalls).toHaveLength(1);
    expect(response.fullText).toBe("Ok.");
    expect(response.finishReason).toBe("tool_calls");
  });

  it("repairs a call leaked into reasoning when content is empty", () => {
    const hook = loadExtension();
    const response = streamResult({ fullReasoning: hermes("bash", [["command", "ls"]]) });
    hook!({ response, modelConfig: {}, agent: fakeAgent() });
    expect(response.finalToolCalls).toHaveLength(1);
    expect(response.fullReasoning).toBe("");
  });

  it("leaves structured tool calls untouched", () => {
    const hook = loadExtension();
    const response = streamResult({ fullText: "x" });
    response.finalToolCalls = [
      { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
    ];
    hook!({ response, modelConfig: {}, agent: fakeAgent() });
    expect(response.finalToolCalls).toHaveLength(1);
    expect(response.finalToolCalls![0]!.id).toBe("call_1");
  });

  it("respects the per-turn repair budget", () => {
    const hook = loadExtension({ maxRepairsPerTurn: 2 });
    const mk = () => streamResult({ fullText: hermes("read", [["path", "f"]]) });
    const r1 = mk(); const r2 = mk(); const r3 = mk();
    hook!({ response: r1, modelConfig: {}, agent: fakeAgent({ iterationCount: 1 }) });
    hook!({ response: r2, modelConfig: {}, agent: fakeAgent({ iterationCount: 2 }) });
    hook!({ response: r3, modelConfig: {}, agent: fakeAgent({ iterationCount: 3 }) });
    expect(r1.finalToolCalls).toHaveLength(1);
    expect(r2.finalToolCalls).toHaveLength(1);
    expect(r3.finalToolCalls).toBeNull();
  });

  it("resets the budget on the next user turn", () => {
    const hook = loadExtension({ maxRepairsPerTurn: 1 });
    const mk = () => streamResult({ fullText: hermes("read", [["path", "f"]]) });
    const r1 = mk(); const r2 = mk();
    hook!({ response: r1, modelConfig: {}, agent: fakeAgent({ iterationCount: 1 }) });
    hook!({ response: r2, modelConfig: {}, agent: fakeAgent({ iterationCount: 1 }) });
    expect(r1.finalToolCalls).toHaveLength(1);
    expect(r2.finalToolCalls).toHaveLength(1);
  });

  it("never repairs on the final iteration", () => {
    const hook = loadExtension();
    const response = streamResult({ fullText: hermes("read", [["path", "f"]]) });
    hook!({ response, modelConfig: {}, agent: fakeAgent({ iterationCount: 10, maxIterations: 10 }) });
    expect(response.finalToolCalls).toBeNull();
  });

  it("registers no hooks when disabled", () => {
    const core = mockCore({ toolCallRepair: { enabled: false, maxRepairsPerTurn: 2 } });
    const ext = createRepairExtension(core);
    expect(Object.keys((ext.hooks as any) ?? {})).toHaveLength(0);
  });

  it("skips a cancelled agent", () => {
    const hook = loadExtension();
    const response = streamResult({ fullText: hermes("read", [["path", "f"]]) });
    hook!({ response, modelConfig: {}, agent: fakeAgent({ cancelled: true }) });
    expect(response.finalToolCalls).toBeNull();
  });

  it("returns the repaired response as the pipeline result", () => {
    const hook = loadExtension();
    const response = streamResult({ fullText: hermes("read", [["path", "f"]]) });
    const ret = hook!({ response, modelConfig: {}, agent: fakeAgent() });
    expect(ret).toEqual({ response });
  });

  it("emits a chat-visible SYSTEM_MESSAGE on repair", () => {
    const hook = loadExtension();
    const events: Array<{ type: number; content: string }> = [];
    const agent = {
      ...fakeAgent(),
      sink: { emit: (e: { type: number; content: string }) => events.push(e) },
    };
    const response = streamResult({ fullText: hermes("read", [["path", "f"]]) });
    hook!({ response, modelConfig: {}, agent });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe(OUTPUT_EVENT.SYSTEM_MESSAGE);
    expect(events[0]!.content).toContain("read");
  });

  it("emits a SYSTEM_MESSAGE when the per-turn budget is reached", () => {
    const hook = loadExtension({ maxRepairsPerTurn: 1 });
    const events: Array<{ type: number; content: string }> = [];
    const agent = {
      ...fakeAgent(),
      sink: { emit: (e: { type: number; content: string }) => events.push(e) },
    };
    const first = streamResult({ fullText: hermes("read", [["path", "a"]]) });
    const second = streamResult({ fullText: hermes("read", [["path", "b"]]) });
    hook!({ response: first, modelConfig: {}, agent });
    hook!({ response: second, modelConfig: {}, agent: { ...agent, iterationCount: 2 } });
    // First call repairs (one notice); second hits the budget (one notice).
    expect(events).toHaveLength(2);
    expect(events[0]!.content).toContain("Repaired");
    expect(events[1]!.content).toContain("budget");
    expect(second.finalToolCalls).toBeNull();
  });

  it("unlimited budget (-1) repairs past the second call", () => {
    const hook = loadExtension({ maxRepairsPerTurn: -1 });
    const mk = () => streamResult({ fullText: hermes("read", [["path", "f"]]) });
    const results = [mk(), mk(), mk(), mk()];
    results.forEach((r, i) =>
      hook!({ response: r, modelConfig: {}, agent: fakeAgent({ iterationCount: i + 1 }) }),
    );
    for (const r of results) expect(r.finalToolCalls).toHaveLength(1);
  });
});

// ── Agent loop integration ──────────────────────────────────────────────────
// The hook above is exercised through the REAL Agent, as loaded by the
// extension loader: handler on the agent's hooks, repaired calls executed,
// loop continued.

function attachRepair(hooks: HookSystem, config: Record<string, unknown> = {}) {
  const core = mockCore({ toolCallRepair: { enabled: true, maxRepairsPerTurn: 2, ...config } });
  const ext = createRepairExtension(core);
  const handler = (ext.hooks as any)![HOOKS.PROVIDER_RESPONSE];
  hooks.on(HOOKS.PROVIDER_RESPONSE, handler, "tool-call-repair");
}

describe("tool-call-repair in the agent loop", () => {
  it("repaired call executes and the loop continues", async () => {
    const leaked = "Let me check that.\n" + hermes("read", [["path", "f.txt"]]);
    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({ content: leaked }),
        buildStreamResponse({ content: "It's fine." }),
      ],
    });
    const sinkEvents: Array<{ type: number; content?: string }> = [];
    const { agent, toolRegistry, hooks } = createFixture({
      mockLLM,
      sink: { emit: (e) => sinkEvents.push(e as unknown as { type: number; content?: string }) },
    });
    toolRegistry.register("read", simpleTool("read", "file body"));
    attachRepair(hooks);

    const completion = expectCompletion(await agent.run("check f.txt"));

    expect(completion.content).toBe("It's fine.");
    expect(mockLLM.callCount).toBe(2); // loop continued after the repaired call

    const log = agent.context.log.getAll();
    const assistant = log.find((m) => m.role === "assistant");
    expect(assistant).toBeTruthy();
    // Leaked markup stripped from the visible text, forged call attached.
    expect(assistant!.toolCalls).toHaveLength(1);
    expect(assistant!.toolCalls![0]!.function.name).toBe("read");
    expect(JSON.parse(assistant!.toolCalls![0]!.function.arguments)).toEqual({ path: "f.txt" });
    expect(toolContentText(assistant!.content)).not.toContain("|");

    const toolMsg = log.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    expect(toolContentText(toolMsg!.content)).toContain("file body");

    // The repair is announced to the session log as a system message.
    const sys = sinkEvents.find((e) => e.type === OUTPUT_EVENT.SYSTEM_MESSAGE);
    expect(sys).toBeTruthy();
    expect(sys!.content).toContain("read");
  });

  it("uses a response replaced via the pipeline return", async () => {
    // Covers the agent.ts replacement branch: the handler returns a NEW
    // response object instead of mutating the streamed one.
    const mockLLM = new MockLLMClient({
      responseSequences: [buildStreamResponse({ content: "original text" })],
    });
    const { agent, hooks } = createFixture({ mockLLM });
    hooks.on(HOOKS.PROVIDER_RESPONSE, (data) => {
      const d = data as { response: StreamResult };
      return { response: { ...d.response, fullText: "replaced text" } };
    });

    const completion = expectCompletion(await agent.run("hi"));
    expect(completion.content).toBe("replaced text");
  });

  it("without the extension, the leaked markup ends the turn", async () => {
    const leaked = "Let me check that.\n" + hermes("read", [["path", "f.txt"]]);
    const mockLLM = new MockLLMClient({
      responseSequences: [buildStreamResponse({ content: leaked })],
    });
    const { agent } = createFixture({ mockLLM });

    const completion = expectCompletion(await agent.run("check f.txt"));
    expect(mockLLM.callCount).toBe(1); // no repair, no tool call, loop stopped
    expect(completion.content).toContain("|"); // raw markup stranded in the turn
  });
});
