// Wire-shape tests for the per-call duration meta added to the S2C builders
// (wire-messages.ts). The assistant frame gains callMs (one LLM call's wall
// time) as a SIBLING of durationMs (the turn total) -- the names must stay
// distinct -- and callDerived marks a log-gap derivation so the client tooltip
// can disclose it. The TOKEN_USAGE frame carries durationMs so the live path
// stamps the call the same way it stamps ctx.

import { describe, it, expect } from "bun:test";
import {
  s2cAssistantMessage,
  s2cTokenUsage,
  s2cToolCall,
  s2cToolResult,
  toS2CMessage,
} from "@extensions/websocket/wire-messages.ts";
import { S2C, type ToolDisplayWire } from "@extensions/websocket/protocol.ts";
import { ToolRegistry } from "@core/extensions/tool-registry.ts";
import { OUTPUT_EVENT, type TokenUsageEvent } from "@core/context/output.ts";

describe("s2cAssistantMessage per-call meta", () => {
  it("sends callMs as a distinct field beside the turn durationMs", () => {
    const msg = s2cAssistantMessage("s1", "hi", {
      ts: 1000,
      durationMs: 9000, // turn total
      callMs: 4200, // this call's own wall time
    });
    expect(msg.durationMs).toBe(9000);
    expect(msg.callMs).toBe(4200);
    // A recorded value rides no derived flag: only derived numbers say so.
    expect("callDerived" in msg).toBe(false);
  });

  it("marks a derived call duration so the tooltip can phrase it honestly", () => {
    const msg = s2cAssistantMessage("s1", "hi", { ts: 1000, callMs: 4200, callDerived: true });
    expect(msg.callMs).toBe(4200);
    expect(msg.callDerived).toBe(true);
  });

  it("omits both fields when no call duration is attested", () => {
    const msg = s2cAssistantMessage("s1", "hi", { ts: 1000, durationMs: 9000 });
    expect("callMs" in msg).toBe(false);
    expect("callDerived" in msg).toBe(false);
  });

  it("callDerived:false alone rides no field (only true is meaningful)", () => {
    const msg = s2cAssistantMessage("s1", "hi", { ts: 1, callMs: 5, callDerived: false });
    expect(msg.callMs).toBe(5);
    expect("callDerived" in msg).toBe(false);
  });

  it("duration fields ride only as trustworthy numbers (finite, >= 0)", () => {
    // A hand-corrupted log record must not push a negative/NaN onto the wire.
    const msg = s2cAssistantMessage("s1", "hi", {
      ts: 1,
      durationMs: -5,
      callMs: -1,
    });
    expect("durationMs" in msg).toBe(false);
    expect("callMs" in msg).toBe(false);
    const nan = s2cAssistantMessage("s1", "hi", {
      ts: 1,
      durationMs: Number.NaN,
      callMs: Number.POSITIVE_INFINITY,
    });
    expect("durationMs" in nan).toBe(false);
    expect("callMs" in nan).toBe(false);
    // Zero is a real (instant) measurement, not corruption.
    const zero = s2cAssistantMessage("s1", "hi", { ts: 1, durationMs: 0, callMs: 0 });
    expect(zero.durationMs).toBe(0);
    expect(zero.callMs).toBe(0);
  });
});

describe("s2cTokenUsage durationMs", () => {
  const base = {
    sessionPromptTokens: 0,
    sessionCompletionTokens: 0,
    sessionTotalTokens: 0,
    promptTokens: 80,
    completionTokens: 40,
    totalTokens: 120,
    cachedTokens: 10,
    contextWindow: 200000,
  };

  it("carries a finite durationMs on the frame", () => {
    const msg = s2cTokenUsage("s1", { ...base, durationMs: 4200 });
    expect(msg.durationMs).toBe(4200);
  });

  it("keeps durationMs 0 (a measured instant is attested, not absent)", () => {
    const msg = s2cTokenUsage("s1", { ...base, durationMs: 0 });
    expect(msg.durationMs).toBe(0);
  });

  it("omits a missing/non-finite/negative durationMs (no field, no lie)", () => {
    expect("durationMs" in s2cTokenUsage("s1", base)).toBe(false);
    expect("durationMs" in s2cTokenUsage("s1", { ...base, durationMs: NaN })).toBe(false);
    expect("durationMs" in s2cTokenUsage("s1", { ...base, durationMs: -5 })).toBe(false);
  });
});

describe("toS2CMessage maps a live TOKEN_USAGE durationMs onto the wire", () => {
  it("forwards the event's measured span", () => {
    const event = {
      type: OUTPUT_EVENT.TOKEN_USAGE,
      sessionPromptTokens: 0,
      sessionCachedTokens: 0,
      sessionCompletionTokens: 40,
      sessionTotalTokens: 120,
      turns: 1,
      promptTokens: 80,
      cachedTokens: 0,
      completionTokens: 40,
      totalTokens: 120,
      contextWindow: 200000,
      durationMs: 5100,
    } as TokenUsageEvent;
    const msg = toS2CMessage(event, "s1");
    expect(msg?.type).toBe(S2C.TOKEN_USAGE);
    expect(msg?.durationMs).toBe(5100);
  });

  it("a live ASSISTANT_MESSAGE carries no call/duration meta (the client times its own turn)", () => {
    const msg = toS2CMessage(
      { type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "hi" } as never,
      "s1",
    );
    expect("callMs" in (msg ?? {})).toBe(false);
    expect("durationMs" in (msg ?? {})).toBe(false);
  });
});

// TOOL_CALL display parts: the frame forwards the tool's declared
// ToolDisplaySpec[] (mapped through the single wireToolDisplay seam), in
// array order, with unknown kinds passed through untouched. Values are ARG
// PARAMETER NAMES (the args JSON rides the same frame), and a tool
// declaring nothing rides no field at all.
describe("TOOL_CALL display parts", () => {
  const toolCall = (toolName: string, args = "{}") =>
    ({
      type: OUTPUT_EVENT.TOOL_CALL,
      toolName,
      input: args,
      toolCallId: "tc-1",
    }) as never;

  it("forwards read's file part with its *Arg parameter names", () => {
    const msg = toS2CMessage(toolCall("read"), "s1", {
      display: (name) =>
        name === "read"
          ? [{ kind: "file", pathArg: "path", offsetArg: "offset", limitArg: "limit" }]
          : undefined,
    });
    expect(msg?.type).toBe(S2C.TOOL_CALL);
    expect(msg?.display).toEqual([
      { kind: "file", pathArg: "path", offsetArg: "offset", limitArg: "limit" },
    ]);
  });

  it("forwards multi-part declarations in order, untouched", () => {
    const spec = [
      { kind: "code", source: "args" as const, arg: "command", lang: "shell" },
      { kind: "prose", source: "result" as const, icon: "hourglass" },
    ];
    const msg = toS2CMessage(toolCall("multi"), "s1", { display: () => spec });
    expect(msg?.display).toEqual(spec);
  });

  it("unknown kinds pass through untouched (forward-compat; sinks skip them)", () => {
    const msg = toS2CMessage(toolCall("chart"), "s1", {
      display: () => [{ kind: "chart", source: "result" }],
    });
    expect(msg?.display).toEqual([{ kind: "chart", source: "result" }]);
  });

  it("lang rides the frame so sinks can pick a tokenizer", () => {
    const msg = toS2CMessage(toolCall("workflow_validate"), "s1", {
      display: () => [{ kind: "code", source: "args", arg: "yaml", lang: "yaml" }],
    });
    const parts = msg?.display as ToolDisplayWire[] | undefined;
    expect(parts?.[0]?.lang).toBe("yaml");
  });

  it("the display field never carries arg VALUES", () => {
    const msg = toS2CMessage(
      toolCall("bash", JSON.stringify({ command: "echo secret-value" })),
      "s1",
      { display: () => [{ kind: "code", source: "args", arg: "command", lang: "shell" }] },
    );
    const displayJson = JSON.stringify(msg?.display);
    expect(displayJson).toContain("command"); // parameter NAME
    expect(displayJson).not.toContain("secret-value"); // never the value
  });

  it("omits the field entirely for a hintless tool (no null-noise)", () => {
    const msg = toS2CMessage(toolCall("bash"), "s1", {
      display: (name) => (name === "read" ? [{ kind: "file", pathArg: "path" }] : undefined),
    });
    expect("display" in (msg ?? {})).toBe(false);
  });

  it("omits an empty display array too", () => {
    const msg = toS2CMessage(toolCall("mystery"), "s1", { display: () => [] });
    expect("display" in (msg ?? {})).toBe(false);
  });

  it("no resolver wired at all means no display field", () => {
    const msg = toS2CMessage(toolCall("read"), "s1");
    expect("display" in (msg ?? {})).toBe(false);
  });

  it("mutating metadata.display (the TOOL_METADATA hook surface) flows to the wire", () => {
    // The hook exposes the live mutable metadata objects; a resolver reading
    // the registry must therefore see post-registration annotations.
    const registry = new ToolRegistry();
    registry.register("annotate_me", {
      metadata: { sideEffects: false, difficulty: 1 },
      toToolDef: () => ({ type: "function", function: { name: "annotate_me", description: "", parameters: {} } }),
      execute: async () => "ok",
    });
    const resolve = (name: string) => registry.getMetadata(name)?.display;
    expect("display" in (toS2CMessage(toolCall("annotate_me"), "s1", { display: resolve }) ?? {})).toBe(false);
    // Annotate, exactly as a TOOL_METADATA handler would.
    registry.getMetadata("annotate_me")!.display = [{ kind: "prose", icon: "hourglass" }];
    const msg = toS2CMessage(toolCall("annotate_me"), "s1", { display: resolve });
    expect(msg?.display).toEqual([{ kind: "prose", icon: "hourglass" }]);
  });
});

describe("s2cToolCall title-bar fold (headerKeys)", () => {
  it("folds only the declared keys, labeled", () => {
    const msg = s2cToolCall("s1", {
      name: "bash",
      args: JSON.stringify({ command: "ls", timeoutMs: 30000 }),
      headerKeys: ["timeoutMs"],
    });
    expect(msg.argsSummary).toBe("timeoutMs: 30000");
  });

  it("rides the explicit empty fold when nothing declared remains", () => {
    // Present-but-empty is the signal: the title bar shows no summary and
    // the client's fallback heuristic must not step in.
    const msg = s2cToolCall("s1", {
      name: "bash",
      args: JSON.stringify({ command: "ls" }),
      headerKeys: ["timeoutMs"],
    });
    expect("argsSummary" in msg).toBe(true);
    expect(msg.argsSummary).toBe("");
  });

  it("headerKeys: [] always rides the empty fold", () => {
    const msg = s2cToolCall("s1", { name: "x", args: '{"a":1}', headerKeys: [] });
    expect(msg.argsSummary).toBe("");
  });

  it("keeps the old shape without a declaration: empty summaries ride no field", () => {
    const msg = s2cToolCall("s1", { name: "x", args: "{}" });
    expect("argsSummary" in msg).toBe(false);
    // The shared fold's single-key rule still bares the value (untouched).
    const shared = s2cToolCall("s1", { name: "x", args: '{"a":1}' });
    expect(shared.argsSummary).toBe("1");
  });

  it("toS2CMessage resolves headerKeys per tool for live TOOL_CALL events", () => {
    const msg = toS2CMessage(
      { type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: '{"command":"ls"}', toolCallId: "c1" } as never,
      "s1",
      { headerKeys: (name) => (name === "bash" ? ["timeoutMs"] : undefined) },
    );
    expect(msg!.argsSummary).toBe("");
  });
});

describe("s2cToolResult startLine", () => {
  const editPart = (meta: Array<[string, string]>) => ({
    type: "tool-result",
    tool: "edit",
    status: "success",
    meta,
    error: null,
    hint: null,
    output: "ok",
  });

  it("forwards the part's start_line meta as a number", () => {
    const msg = s2cToolResult("s1", { name: "edit", content: [editPart([["start_line", "207"]])] });
    expect(msg.startLine).toBe(207);
    // The flattened output still carries the META dump (no information lost
    // on the model-facing/audit side).
    expect(msg.output).toContain('META: {"start_line":"207"}');
  });

  it("drops non-integer, non-positive, and missing values (blank beats a fake)", () => {
    for (const v of ["0", "-3", "2.5", "x", ""]) {
      const msg = s2cToolResult("s1", { name: "edit", content: [editPart([["start_line", v]])] });
      expect("startLine" in msg).toBe(false);
    }
    expect("startLine" in s2cToolResult("s1", { name: "edit", content: "plain text" })).toBe(false);
    expect("startLine" in s2cToolResult("s1", { name: "read", content: [editPart([])] })).toBe(false);
  });
});
