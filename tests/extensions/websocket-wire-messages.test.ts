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
  toS2CMessage,
} from "@extensions/websocket/wire-messages.ts";
import { S2C } from "@extensions/websocket/protocol.ts";
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
