// The central tool-result char cap (maxToolResultChars): seam unit tests,
// hook-replacement binding, session-log bytes, loop-detect ordering, bash's
// pre-result layer, and the knob-vs-wire-constant ordering.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  capToolResult,
  capToolResultPart,
  capToolResultText,
} from "@core/tool-result-cap.ts";
import { createToolExecutor, type ToolExecutorDeps } from "@core/tool-executor.ts";
import { createToolRegistry } from "@core/extensions/tool-registry.ts";
import { createHooks, HOOKS } from "@core/hooks.ts";
import {
  ToolResult,
  TOOL_STOP_LOOP,
  INTERNAL_MAX_OUTPUT_LINES,
} from "@core/extensions/tool-utils.ts";
import { Agent } from "@core/agent.ts";
import type { ToolResultPart } from "@core/context/wrappers.ts";
import type { Message } from "@core/context/message.ts";
import { Message as MessageClass } from "@core/context/message.ts";
import type { Tool, ToolDef } from "@core/extensions/tool-registry.ts";
import { CONFIG_SCHEMA, getLayerDefault, resolveKey, type ResolutionContext } from "@core/config/schema-loader.ts";
import { MAX_FRAME_BYTES } from "@core/tool-exec-protocol.ts";
import { create as createLoopDetect } from "@extensions/loop-detect/index.ts";
import { BashTool } from "@extensions/bash-tool/index.ts";
import { create as createSessionLog } from "@extensions/session-log/index.ts";
import { readSessionEntries, replayEntriesIntoContext, LOG_SOURCE } from "@core/session/session-log.ts";
import { closeSessionIndex } from "@core/session/session-index.ts";
import { createMockCore } from "../helpers.ts";

const MARKER_RE = /--- \[output truncated, (\d+) chars elided\] ---$/;

/** True when s contains a code unit that is half of a surrogate pair with no partner. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// ── capToolResultText ────────────────────────────────────────────────────────

describe("capToolResultText", () => {
  it("leaves an under-cap text identical (same reference)", () => {
    const text = "x".repeat(500);
    expect(capToolResultText(text, 1000)).toBe(text);
  });

  it("leaves an exactly-at-cap text identical (boundary: no marker at == cap)", () => {
    const text = "y".repeat(1000);
    expect(capToolResultText(text, 1000)).toBe(text);
  });

  it("truncates one char over cap with an exact elided-count marker", () => {
    const max = 1000;
    const text = "z".repeat(max + 1);
    const out = capToolResultText(text, max);
    expect(out.length).toBeLessThanOrEqual(max);
    const m = out.match(MARKER_RE);
    expect(m).not.toBeNull();
    const kept = out.lastIndexOf("\n--- [output truncated,");
    expect(kept).toBeGreaterThan(0);
    expect(Number(m![1])).toBe(text.length - kept);
    expect(out.slice(0, kept)).toBe("z".repeat(kept));
  });

  it("is idempotent: re-capping capped output is a no-op", () => {
    const text = "w".repeat(5000);
    const once = capToolResultText(text, 900);
    expect(capToolResultText(once, 900)).toBe(once);
    expect(once.length).toBeLessThanOrEqual(900);
  });

  it("maxChars below the marker's own room falls back to a bare bound (no marker)", () => {
    const text = "q".repeat(10_000);
    const out = capToolResultText(text, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out).not.toContain("elided");
  });

  it("never cuts between CR and LF (the single-cluster control pair)", () => {
    // Budget lands exactly between \r and \n: the cut must back off the \r.
    const text = "a".repeat(34) + "\r\n" + "b".repeat(500);
    const out = capToolResultText(text, 80);
    expect(out).toMatch(MARKER_RE);
    const kept = out.slice(0, out.lastIndexOf("\n--- [output truncated,"));
    expect(kept.endsWith("\r")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it("never splits a surrogate pair at the exact cap edge", () => {
    // Fill so the naive cut at max lands inside the astral pair.
    for (let max = 20; max < 60; max++) {
      const text = "a".repeat(max - 1) + "\u{1F600}" + "b".repeat(100);
      const out = capToolResultText(text, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(hasLoneSurrogate(out)).toBe(false);
      const prefix = out.slice(0, out.lastIndexOf("\n--- [output truncated,"));
      // Either the pair is whole in the prefix or it was elided entirely.
      expect(prefix).not.toBe("a".repeat(max - 1) + "\ud83d");
    }
  });

  it("seeded sweep over multi-byte strings: never a lone surrogate, always within cap, boundary on a grapheme start", () => {
    const PIECES = [
      "a", "k", "9", " ",           // ASCII
      "\r\n",                        // the one ASCII control cluster
      "中", "文", "é",              // BMP non-ASCII
      "\u{1F600}", "\u{1F1EF}\u{1F1F5}", // astral + regional indicator pair
      "e\u0301",                     // combining mark
      "\u{1F469}\u200D\u{1F469}\u200D\u{1F467}", // ZWJ family
      "\u{1F468}\u{1F3FF}",          // skin-tone modifier
      "\u{10FFFF}",                  // last valid codepoint
    ];
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let rndState = 12345;
    const rnd = () => {
      rndState = (rndState * 1103515245 + 12345) & 0x7fffffff;
      return rndState / 0x7fffffff;
    };
    for (let seed = 0; seed < 60; seed++) {
      let text = "";
      while (text.length < 400) text += PIECES[Math.floor(rnd() * PIECES.length)]!;
      for (let max = 10; max < 200; max += 7) {
        if (text.length <= max) continue;
        const out = capToolResultText(text, max);
        expect(out.length).toBeLessThanOrEqual(max);
        expect(hasLoneSurrogate(out)).toBe(false);
        let kept: number;
        if (max < 80) {
          // Below MIN_MARKER_ROOM the cap is a bare bound (no marker); the
          // kept prefix still ends on a safe boundary.
          expect(out).not.toContain("elided");
          kept = out.length;
        } else {
          expect(out).toMatch(MARKER_RE);
          kept = out.lastIndexOf("\n--- [output truncated,");
          expect(kept).toBeGreaterThanOrEqual(0);
          expect(Number(out.match(MARKER_RE)![1])).toBe(text.length - kept);
        }
        // The cut must land on a grapheme-cluster start of the ORIGINAL text
        // (no orphaned combining mark, ZWJ fragment, or lone surrogate).
        const starts = new Set<number>([0]);
        for (const g of seg.segment(text)) {
          if (g.index > kept) break;
          starts.add(g.index);
        }
        expect(starts.has(kept)).toBe(true);
      }
    }
  });
});

// ── result / part shapes ─────────────────────────────────────────────────────

describe("capToolResult (raw result shapes)", () => {
  it("caps a plain string result", () => {
    const out = capToolResult("u".repeat(2000), 500) as string;
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toMatch(MARKER_RE);
  });

  it("caps a ToolResult output while preserving prototype, images, metadata and the stop-loop symbol", () => {
    const images = [{ type: "image_url" as const, mimeType: "image/png", data: "AAAB" }];
    const r = ToolResult.stop("t".repeat(2000)).withEntries({ a: "1" });
    (r as { images: unknown }).images = images;
    const capped = capToolResult(r, 500) as ToolResult;
    expect(capped).not.toBe(r); // never mutates the tool's own object
    expect(capped).toBeInstanceOf(ToolResult);
    expect(capped.output).toMatch(MARKER_RE);
    expect(capped.output.length).toBeLessThanOrEqual(500);
    expect(capped.metadata?.get("a")).toBe("1");
    expect(capped.images).toBe(images); // non-text payload passes through untouched
    expect((capped as unknown as Record<symbol, unknown>)[TOOL_STOP_LOOP]).toBe(true);
    expect((r as unknown as Record<symbol, unknown>)[TOOL_STOP_LOOP]).toBe(true); // original intact
    expect(r.output.length).toBe(2000);
  });

  it("returns the same reference when under cap, and passes non-text shapes through", () => {
    const small = ToolResult.ok("small");
    expect(capToolResult(small, 1000)).toBe(small);
    const obj = { count: 3 };
    expect(capToolResult(obj, 10)).toBe(obj); // size unknown without stringify; the part pass bounds it
    expect(capToolResult(null, 10)).toBe(null);
    expect(capToolResult(42, 10)).toBe(42);
  });
});

describe("capToolResultPart", () => {
  const part = (over: Partial<ToolResultPart>): ToolResultPart => ({
    type: "tool-result",
    tool: "t",
    status: "success",
    meta: [],
    error: null,
    hint: null,
    output: "",
    ...over,
  });

  it("caps output, error, hint and oversized metadata values independently; keeps a passing part by reference", () => {
    const max = 300;
    const big = "M".repeat(5000);
    const p = part({
      output: big,
      error: big,
      hint: big,
      meta: [["key", big], ["small", "ok"]],
    });
    const out = capToolResultPart(p, max);
    expect(out.output).toMatch(MARKER_RE);
    expect(out.error).toMatch(MARKER_RE);
    expect(out.hint).toMatch(MARKER_RE);
    expect(out.meta[0]![1]).toMatch(MARKER_RE);
    expect(out.meta[1]![1]).toBe("ok");
    expect(out.output.length).toBeLessThanOrEqual(max);
    expect(out.error!.length).toBeLessThanOrEqual(max);
    expect(out.meta[0]![1].length).toBeLessThanOrEqual(max);
    // Small parts return the same object (common path allocates nothing).
    const small = part({ output: "tiny" });
    expect(capToolResultPart(small, max)).toBe(small);
  });
});

// ── executor seam ────────────────────────────────────────────────────────────

function makeTestTool(
  name: string,
  execute: (input: string | Record<string, unknown> | null, ctx?: unknown) => Promise<unknown>,
): Tool {
  return {
    metadata: { sideEffects: false, difficulty: 1 },
    toToolDef: () => ({
      type: "function",
      function: { name, description: "test tool", parameters: { type: "object", properties: {}, required: [] } },
    }),
    execute,
  };
}

function mockDeps(
  overrides: Partial<ToolExecutorDeps> & { sessionId?: string } = {},
): ToolExecutorDeps & { addedMessages: Message[] } {
  const { sessionId, ...rest } = overrides;
  const toolRegistry = createToolRegistry();
  const hooks = createHooks();
  const addedMessages: Message[] = [];
  const agent = {
    sessionId: sessionId ?? "cap-test",
    addMessage: (msg: Message) => {
      addedMessages.push(msg);
      hooks.notifyHooks(HOOKS.CONTEXT_MESSAGE, { message: msg, agent });
    },
    emitOutput: () => {},
    cancel: () => {},
    getToolDefs: async (): Promise<ToolDef[]> => [],
  } as unknown as Agent;
  return {
    toolRegistry,
    hooks,
    emitOutput: () => {},
    workspaceRoots: [process.cwd()],
    workspaceDeny: null,
    maxRetries: 0,
    toolRetryDelay: 0,
    isRestoring: () => false,
    agent,
    addedMessages,
    ...rest,
  };
}

function toolCall(name: string, id = "call-1"): { id: string; function: { name: string; arguments: string } } {
  return { id, function: { name, arguments: "{}" } };
}

function firstPart(result: { content: unknown }): ToolResultPart {
  const parts = result.content as ToolResultPart[];
  expect(Array.isArray(parts)).toBe(true);
  expect(parts.length).toBe(1);
  expect(parts[0]!.type).toBe("tool-result");
  return parts[0]!;
}

describe("executor seam (maxToolResultChars)", () => {
  it("caps a huge string result and a huge ToolResult part to the knob with the marker", async () => {
    const cap = 1000;
    const deps = mockDeps({ maxToolResultChars: cap });
    deps.toolRegistry.register("bigstr", makeTestTool("bigstr", async () => "s".repeat(2500)));
    deps.toolRegistry.register("bigres", makeTestTool("bigres", async () => ToolResult.ok("r".repeat(2500))));
    const executor = createToolExecutor(deps);

    const r1 = await executor.executeSingle(toolCall("bigstr") as never, new Set(["bigstr"]));
    const p1 = firstPart(r1);
    expect(p1.output).toMatch(MARKER_RE);
    expect(p1.output.length).toBeLessThanOrEqual(cap);

    const r2 = await executor.executeSingle(toolCall("bigres") as never, new Set(["bigres"]));
    const p2 = firstPart(r2);
    expect(p2.output).toMatch(MARKER_RE);
    expect(p2.output.length).toBeLessThanOrEqual(cap);
  });

  it("an object result is bounded at the part level (its JSON-serialized form is sliced, hook-replaced results included)", async () => {
    const cap = 400;
    const deps = mockDeps({ maxToolResultChars: cap });
    deps.toolRegistry.register("objres", makeTestTool("objres", async () => ({ payload: "p".repeat(5000) })));
    const executor = createToolExecutor(deps);
    const part = firstPart(await executor.executeSingle(toolCall("objres") as never, new Set(["objres"])));
    expect(part.output).toMatch(MARKER_RE);
    expect(part.output.length).toBeLessThanOrEqual(cap);
  });

  it("caps a hook-replaced { result } swap (the binding pass runs after the TOOL_RESULT pipeline)", async () => {
    const cap = 800;
    const deps = mockDeps({ maxToolResultChars: cap });
    deps.hooks.on(HOOKS.TOOL_RESULT, () => ({ result: new ToolResult({ output: "h".repeat(9000) }) }));
    deps.toolRegistry.register("small", makeTestTool("small", async () => "ok"));
    const executor = createToolExecutor(deps);
    const part = firstPart(await executor.executeSingle(toolCall("small") as never, new Set(["small"])));
    expect(part.output).not.toBe("ok"); // the swap landed
    expect(part.output).toMatch(MARKER_RE);
    expect(part.output.length).toBeLessThanOrEqual(cap);
  });

  it("passes image attachments through the cap untouched", async () => {
    const cap = 300;
    const deps = mockDeps({ maxToolResultChars: cap });
    const images = [{ type: "image_url" as const, mimeType: "image/png", data: "QkFCRUw=".repeat(200) }];
    deps.toolRegistry.register(
      "shot",
      makeTestTool("shot", async () => {
        const r = ToolResult.ok("desc".repeat(1000));
        (r as { images: unknown }).images = images;
        return r;
      }),
    );
    const executor = createToolExecutor(deps);
    const res = await executor.executeSingle(toolCall("shot") as never, new Set(["shot"]));
    expect(firstPart(res).output).toMatch(MARKER_RE);
    expect(deps.addedMessages[0]!.images).toStrictEqual(images); // non-text untouched
  });

  it("no knob (hand-built caller): no cap, marker absent", async () => {
    const deps = mockDeps();
    deps.toolRegistry.register("big", makeTestTool("big", async () => "n".repeat(20_000)));
    const executor = createToolExecutor(deps);
    const part = firstPart(await executor.executeSingle(toolCall("big") as never, new Set(["big"])));
    expect(part.output.length).toBe(20_000);
    expect(part.output).not.toContain("elided");
  });
});

// ── loop-detect sees the capped string ───────────────────────────────────────

describe("loop-detect resultDigest observes the capped result", () => {
  async function runLoopScenario(sessionId: string, cap: number, suffixInsideCap: boolean): Promise<number> {
    const deps = mockDeps({ maxToolResultChars: cap, sessionId });
    let n = 0;
    // Same output up to the cap, differing only in the elided tail -- and the
    // tails DIFFER IN LENGTH ("1" vs ten chars) so resultDigest's length term
    // sees distinct digests unless the seam actually capped both to the same
    // string. Without that asymmetry this fires pass-1 or not and guards nothing.
    // suffixInsideCap instead puts the difference inside the kept prefix.
    deps.toolRegistry.register(
      "poll",
      makeTestTool("poll", async () =>
        suffixInsideCap ? `${++n}${"P".repeat(cap * 2)}` : `${"P".repeat(cap * 2)}${++n === 1 ? "1" : "0000000002"}`,
      ),
    );
    const loopInstance = createLoopDetect({
      config: { loopDetect: { enabled: true, repeatThreshold: 2, pingPongThreshold: 100 } },
      hooks: deps.hooks,
    } as never);
    deps.hooks.on(HOOKS.TOOL_RESULT, loopInstance.hooks![HOOKS.TOOL_RESULT] as never, "loop-detect");
    let fired = 0;
    deps.hooks.on(HOOKS.LOOP_DETECTED, () => { fired++; }, "observer");

    const executor = createToolExecutor(deps);
    await executor.executeSingle(toolCall("poll", "c1") as never, new Set(["poll"]));
    await executor.executeSingle(toolCall("poll", "c2") as never, new Set(["poll"]));
    return fired;
  }

  it("fires: results differ only beyond the cap, so the digest saw the identical capped string", async () => {
    expect(await runLoopScenario("ld-capped", 64, false)).toBe(1);
  });

  it("does not fire when results differ inside the kept prefix (control: the test measures the digest)", async () => {
    expect(await runLoopScenario("ld-distinct", 64, true)).toBe(0);
  });
});

// ── bash's own 1M buffer cap fires before the seam ───────────────────────────

describe("bash pre-result cap vs the seam", () => {
  const FLOOD = "head -c 1500000 /dev/zero | tr '\\0' 'x'";

  async function runBash(cap: number) {
    const deps = mockDeps({ maxToolResultChars: cap });
    deps.toolRegistry.register(
      "bash",
      new BashTool({ timeoutMs: 30_000, maxOutputLines: INTERNAL_MAX_OUTPUT_LINES }),
    );
    const executor = createToolExecutor(deps);
    const call = { id: "b1", function: { name: "bash", arguments: JSON.stringify({ command: FLOOD }) } };
    return firstPart(await executor.executeSingle(call as never, new Set(["bash"])));
  }

  it("with the knob above bash's 1M buffer cap, bash's own marker lands and the seam stays silent", async () => {
    const part = await runBash(2_000_000);
    expect(part.output.length).toBeGreaterThanOrEqual(1_000_000);
    expect(part.output.length).toBeLessThan(1_500_000); // bash bounded the buffer first
    expect(part.output).toContain("[output truncated]"); // bash's internal marker
    expect(part.output).not.toMatch(MARKER_RE); // seam never fired
    expect(part.meta.some(([k, v]) => k === "truncated" && v === "true")).toBe(true);
  }, 30_000);

  it("with the knob below 1M, the seam is the binding constraint on top of bash's cap", async () => {
    const part = await runBash(500_000);
    expect(part.output.length).toBeLessThanOrEqual(500_000);
    expect(part.output).toMatch(MARKER_RE);
  }, 30_000);
});

// ── knob ceiling vs the wire constant ────────────────────────────────────────

describe("maxToolResultChars schema vs MAX_FRAME_BYTES", () => {
  const baseContext: ResolutionContext = {
    cli: {}, config: {}, provider: null, profile: null, profileName: "default", profilesPath: "./config/profiles",
  };

  it("default 1_000_000; maximum 2_000_000 strictly under the 4_000_000 frame bound; 2 * DEFAULT <= MAX_FRAME_BYTES", () => {
    const knob = CONFIG_SCHEMA.maxToolResultChars!;
    const def = getLayerDefault(knob) as number;
    expect(def).toBe(1_000_000);
    expect(knob.maximum).toBe(2_000_000);
    expect(knob.maximum!).toBeLessThan(MAX_FRAME_BYTES);
    // Pinned relationship: even a doubled default stays within the wire frame.
    expect(2 * def).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });

  it("a config value above the maximum falls through to the default layer", () => {
    const knob = CONFIG_SCHEMA.maxToolResultChars!;
    expect(resolveKey("maxToolResultChars", knob, { ...baseContext, config: { maxToolResultChars: 5_000_000 } })).toBe(1_000_000);
    expect(resolveKey("maxToolResultChars", knob, { ...baseContext, config: { maxToolResultChars: 2_000_000 } })).toBe(2_000_000);
    expect(resolveKey("maxToolResultChars", knob, { ...baseContext, config: { maxToolResultChars: 250_000 } })).toBe(250_000);
    expect(resolveKey("maxToolResultChars", knob, baseContext)).toBe(1_000_000);
  });
});

// ── session log records capped bytes (real path, temp session, replay) ───────

describe("session log records the capped tool result", () => {
  let dir: string;
  const sessionId = `cap-log-${Date.now()}`;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hotdog-cap-log-"));
    process.env.HOTDOG_SESSIONS_DIR = dir;
  });

  afterAll(async () => {
    delete process.env.HOTDOG_SESSIONS_DIR;
    closeSessionIndex();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("huge result reaches the log capped (marker, length) and replays as the same bytes", async () => {
    const cap = 50_000;
    const hooks = createHooks();
    const slExt = await createSessionLog(createMockCore() as never);
    for (const [name, handler] of Object.entries(slExt.hooks ?? {})) {
      hooks.on(name as never, handler as never, "session-log");
    }

    const registry = createToolRegistry();
    registry.register("capme", makeTestTool("capme", async () => "L".repeat(500_000)));

    const agent = new Agent({
      hooks,
      toolRegistry: registry,
      llmClient: {} as never,
      model: "test/model",
      maxIterations: 2,
      contextLimit: 100_000,
      sessionId,
      config: {
        maxToolCallsPerIteration: 2,
        maxRetries: 0,
        toolRetryDelay: 0,
        maxEmptyRetries: 0,
        maxToolResultChars: cap,
      },
    });

    // Assistant tool_calls first: replay repairs orphan results away, so the
    // round trip needs the call the result answers (wire-valid pairing).
    agent.addMessage(
      new MessageClass({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc-1", type: "function", function: { name: "capme", arguments: "{}" } }],
      }),
    );

    // The executor the agent would run; same seam, same hooks, real addMessage.
    const executor = createToolExecutor({
      toolRegistry: registry,
      hooks,
      emitOutput: () => {},
      workspaceRoots: null,
      workspaceDeny: null,
      maxRetries: 0,
      toolRetryDelay: 0,
      isRestoring: () => false,
      agent,
      maxToolResultChars: cap,
    });
    await executor.executeSingle(toolCall("capme", "tc-1") as never, new Set(["capme"]));

    // addMessage fires CONTEXT_MESSAGE without awaiting; poll for the record.
    let toolEntries = (await readSessionEntries(sessionId)).filter(
      (e) => e.source === LOG_SOURCE.TOOL_RESULT,
    );
    for (let i = 0; toolEntries.length === 0 && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      toolEntries = (await readSessionEntries(sessionId)).filter((e) => e.source === LOG_SOURCE.TOOL_RESULT);
    }
    expect(toolEntries.length).toBe(1);

    const logged = toolEntries[0]!.content as unknown as ToolResultPart[];
    expect(Array.isArray(logged)).toBe(true);
    expect(logged[0]!.output).toMatch(MARKER_RE);
    expect(logged[0]!.output.length).toBeLessThanOrEqual(cap);
    expect(JSON.stringify(toolEntries[0]!.content).length).toBeLessThan(100_000);

    // Replay the log: the restored tool message carries the exact same bytes.
    const replayed: Message[] = [];
    const result = replayEntriesIntoContext(
      { addMessage: (m: Message) => replayed.push(m) } as never,
      await readSessionEntries(sessionId),
    );
    expect(result.replayed).toBeGreaterThan(0);
    const toolMsg = replayed.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(JSON.stringify(toolMsg!.content)).toBe(JSON.stringify(logged));
    expect((toolMsg!.content as unknown as ToolResultPart[])[0]!.output).toMatch(MARKER_RE);
  }, 30_000);
});
