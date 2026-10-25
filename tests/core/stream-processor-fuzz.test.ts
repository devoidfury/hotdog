import { describe, it, expect } from "bun:test";
import {
  createStreamProcessor,
  type StreamResult,
} from "@core/llm-client/stream-processor.ts";
import type { StreamEvent } from "@core/llm-client/client.ts";
import type { ToolCall } from "@core/context/message.ts";
import { makeRng, randomChunks, type Rng } from "../fuzz/prng.ts";

// Fuzz suite for StreamProcessor (untrusted provider stream events).
// The real input shape is AsyncIterable<StreamEvent> (src/core/llm-client/client.ts),
// so the "delta splitting" axis is the toolArgument STRING: every `arguments`
// payload is re-split into consecutive toolArgument events (random pieces,
// adversarial boundaries, and fragments interleaved across call indices) and the
// assembly must be identical to the atomic (one-event-per-payload) feed.
// Invariants, audited on EVERY generated scenario:
//
//   1. Assembled args per index === concatenation of that index's received
//      delta strings in arrival order; the assembled result of a split feed
//      deep-equals the assembled result of the atomic feed (text, reasoning,
//      tool-call ORDER = first-touch order of indices, ids, usage, finish).
//   2. Out-of-order / duplicate / gapped indices: pinned documented behavior
//      (Map keyed by index, first-touch order; toolName merges, never replaces;
//      args-before-name slots get filled later; empty id -> crypto.randomUUID,
//      masked as <uuid> in comparisons). Never crashes, never corrupts other
//      indices' assembly.
//   3. Truncated mid-arguments: assembled args stay byte-exactly the received
//      prefix -- invalid JSON stays invalid, never silently repaired.
//   4. Content interleaved with tool_calls across arbitrary splits: final text
//      and onChunk joins identical to the unsplit feed.
//   5. Malformed deltas (nulls, wrong types, unknown event types): the real
//      error contract is "never throws; coerce on join, ignore unknown types"
//      (no skip, no expected-error -- pinned in the malformed section,
//      including the exact coercion table).

// ── Driving helpers ─────────────────────────────────────────────────

interface RunOutput {
  result: StreamResult;
  chunks: string[];
  reasoning: string[];
  deltas: { index: number; name: string; args: string }[];
  toolCallsCb: ToolCall[] | null;
}

async function runEv(events: StreamEvent[]): Promise<RunOutput> {
  const processor = createStreamProcessor();
  const out: RunOutput = {
    result: undefined as unknown as StreamResult,
    chunks: [],
    reasoning: [],
    deltas: [],
    toolCallsCb: null,
  };
  let cbSeen = false;
  out.result = await processor.process(
    { async *[Symbol.asyncIterator]() { for (const e of events) yield e; } },
    {
      onChunk: (c) => out.chunks.push(c),
      onReasoning: (c) => out.reasoning.push(c),
      onToolCallDelta: (tc) => out.deltas.push({ index: tc.index, name: tc.name, args: tc.args }),
      onToolCalls: (tcs) => {
        cbSeen = true;
        out.toolCallsCb = tcs;
      },
    },
  );
  if (!cbSeen) out.toolCallsCb = null;
  return out;
}

// ── Independent model oracle (pins the documented merge/assembly rules) ──

interface ModelCall {
  index: number;
  name: string;
  id: string;
  args: string;
}

function modelOf(events: StreamEvent[]) {
  let text = "";
  let reasoning = "";
  let reasoningSeen = false;
  const map = new Map<number, { name: string; args: string[]; id: string }>();
  let usage: Record<string, unknown> | null = null;
  let finishReason: string | null = null;
  for (const e of events) {
    switch (e.type) {
      case "content":
        text += e.content;
        break;
      case "reasoning":
        reasoning += e.content;
        reasoningSeen = true;
        break;
      case "toolName": {
        const ex = map.get(e.index);
        map.set(e.index, {
          name: e.name || ex?.name || "",
          args: ex?.args ?? [],
          id: e.toolCallId || ex?.id || "",
        });
        break;
      }
      case "toolArgument": {
        const ex = map.get(e.index) ?? { name: "", args: [], id: "" };
        ex.args.push(e.arguments);
        map.set(e.index, ex);
        break;
      }
      case "usage":
        usage = e.data;
        break;
      case "finish":
        finishReason = e.reason;
        break;
      case "reset":
        text = "";
        reasoning = "";
        reasoningSeen = false;
        map.clear();
        usage = null;
        finishReason = null;
        break;
    }
  }
  const calls: ModelCall[] = Array.from(map.entries()).map(([index, c]) => ({
    index,
    name: c.name,
    id: c.id,
    args: c.args.join(""),
  }));
  return { fullText: text, fullReasoning: reasoningSeen ? reasoning : null, calls, finishReason, usage };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function normalizeResult(r: StreamResult): string {
  const tcs =
    r.finalToolCalls?.map((tc) => ({
      id: typeof tc.id === "string" && UUID_RE.test(tc.id) ? "<uuid>" : tc.id,
      type: tc.type,
      function: tc.function,
    })) ?? null;
  return JSON.stringify({
    fullText: r.fullText,
    fullReasoning: r.fullReasoning,
    usage: r.usage,
    finishReason: r.finishReason,
    finalToolCalls: tcs,
  });
}

function checkCalls(actual: ToolCall[] | null, expected: ModelCall[]): void {
  if (expected.length === 0) {
    expect(actual).toBeNull();
    return;
  }
  expect(actual).not.toBeNull();
  expect(actual!.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const tc = actual![i]!;
    const m = expected[i]!;
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe(m.name);
    expect(tc.function.arguments).toBe(m.args);
    if (m.id === "") expect(tc.id).toMatch(UUID_RE);
    else expect(tc.id).toBe(m.id);
  }
}

// ── Scenario generator ──────────────────────────────────────────────

const NAMES = ["read_file", "bash", "write", "", "lookup", "very_long_name_of_a_tool", "call\u{1F50D}"] as const;
const IDS = ["call-1", "call-2", "id with space", "\u{1F0A1}id"] as const;

function genContent(rng: Rng): string {
  return rng.pick([
    "Hello ",
    "\u4F60\u597D\u4E16\u754C",
    "\u{1F600}\u{1F389}",
    "```js\nx=1\n```",
    "<m_abc> not really",
    "line1\nline2\r\nline3\r",
    "",
    "  ",
  ])!;
}

function genArgsPayload(rng: Rng): string {
  const roll = rng.int(10);
  if (roll < 5) {
    const obj: Record<string, unknown> = {};
    const k = rng.int(4);
    for (let i = 0; i < k; i++) {
      obj["p" + i] = rng.pick([
        rng.int(100),
        'quote"and\\slash',
        "uni\u{1F600}\u6F22\u5B57",
        "nl\nshape",
        rng.bool(),
        null,
        [1, "two", { deep: "x" }],
      ])!;
    }
    return JSON.stringify(obj);
  }
  if (roll < 7) return rng.pick(["", "{", "garbage text", '{"a":', "null", "42", "[]"])!;
  if (roll < 9) {
    let s = "";
    const n = 1 + rng.int(40);
    for (let i = 0; i < n; i++) s += String.fromCodePoint(0x20 + rng.int(0x60));
    return s;
  }
  return "x".repeat(rng.int(200));
}

function genScenario(rng: Rng): StreamEvent[] {
  const nCalls = 1 + rng.int(3);
  const idxs: number[] = [];
  while (idxs.length < nCalls) {
    const c = rng.int(5); // sparse and unordered: gaps allowed
    if (!idxs.includes(c)) idxs.push(c);
  }
  const calls = idxs.map((index) => ({
    index,
    name: rng.pick(NAMES)!,
    id: rng.bool(0.25) ? "" : rng.pick(IDS)!,
    args: genArgsPayload(rng),
  }));

  const events: StreamEvent[] = [];
  for (const c of calls) {
    if (rng.bool(0.2)) {
      // args-before-name shape
      events.push({ type: "toolArgument", index: c.index, arguments: c.args });
      events.push({ type: "toolName", index: c.index, name: c.name, toolCallId: c.id });
    } else {
      events.push({ type: "toolName", index: c.index, name: c.name, toolCallId: c.id });
      if (rng.bool(0.3)) events.push({ type: "toolName", index: c.index, name: "", toolCallId: "" });
      else if (rng.bool(0.2)) events.push({ type: "toolName", index: c.index, name: c.name, toolCallId: c.id });
      events.push({ type: "toolArgument", index: c.index, arguments: c.args });
    }
  }

  const out: StreamEvent[] = [];
  for (const e of events) {
    if (rng.bool(0.25)) out.push({ type: "content", content: genContent(rng) });
    if (rng.bool(0.1)) out.push({ type: "reasoning", content: genContent(rng) });
    out.push(e);
  }
  if (rng.bool(0.15)) out.splice(rng.int(out.length + 1), 0, { type: "reset" });
  if (rng.bool(0.5)) out.push({ type: "usage", data: { prompt_tokens: rng.int(1000), completion_tokens: rng.int(500) } });
  if (rng.bool(0.6)) out.push({ type: "finish", reason: rng.pick(["stop", "tool_calls", "length", "content_filter"])! });
  return out;
}

// Re-split toolArgument payloads into pieces, sometimes interleaved across
// indices (parallel-call streaming), preserving per-index piece order.
function splitArgs(rng: Rng, events: StreamEvent[]): StreamEvent[] {
  const queues: { index: number; pieces: string[] }[] = [];
  const out: StreamEvent[] = [];
  const drainStep = (): void => {
    const q = queues[rng.int(queues.length)]!;
    out.push({ type: "toolArgument", index: q.index, arguments: q.pieces.shift()! });
    if (q.pieces.length === 0) queues.splice(queues.indexOf(q), 1);
  };
  for (const e of events) {
    if (e.type === "reset") {
      // reset is a semantic barrier: queued fragments belong to the failed
      // attempt and must land BEFORE it, exactly as in the atomic feed.
      while (queues.length > 0) drainStep();
      out.push(e);
      continue;
    }
    if (e.type === "toolArgument" && e.arguments.length > 0 && rng.bool(0.7)) {
      const pieces = randomChunks(rng, e.arguments, 1 + rng.int(4), rng.bool() ? "adversarial" : "random");
      out.push({ type: "toolArgument", index: e.index, arguments: pieces[0]! });
      if (pieces.length > 1) queues.push({ index: e.index, pieces: pieces.slice(1) });
    } else {
      out.push(e);
    }
    while (queues.length > 0 && rng.bool(0.35)) drainStep();
  }
  while (queues.length > 0) drainStep();
  return out;
}

// ── Differential fuzz ───────────────────────────────────────────────

describe("stream-processor fuzz", () => {
  it("split feeds assemble identically to the atomic feed and to the model", async () => {
    const rng = makeRng(0x57720001);
    const ITERS = 250;
    for (let i = 0; i < ITERS; i++) {
      const scenario = genScenario(rng);
      const model = modelOf(scenario);

      const atomic = await runEv(scenario);
      expect(atomic.result.fullText).toBe(model.fullText);
      expect(atomic.result.fullReasoning).toEqual(model.fullReasoning);
      expect(atomic.result.finishReason).toBe(model.finishReason);
      expect(atomic.result.usage).toEqual(model.usage);
      checkCalls(atomic.result.finalToolCalls, model.calls);
      // onChunk joins (from the last reset onward -- display callbacks fire
      // live and reset only discards stored state) agree with the full text
      let lastReset = -1;
      scenario.forEach((e, idx) => {
        if (e.type === "reset") lastReset = idx;
      });
      const chunksBefore = scenario.slice(0, lastReset + 1).filter((e) => e.type === "content").length;
      expect(atomic.chunks.slice(chunksBefore).join("")).toBe(model.fullText);

      const splitEvents = splitArgs(rng, scenario);
      const split = await runEv(splitEvents);
      expect(split.result.fullText).toBe(model.fullText);
      // whole-stream assembly equals the atomic feed, including call order
      expect(normalizeResult(split.result)).toBe(normalizeResult(atomic.result));
      checkCalls(split.result.finalToolCalls, model.calls);

      // last in-flight delta per index carries that index's full accumulated args
      const lastDelta = new Map<number, string>();
      for (const d of split.deltas) lastDelta.set(d.index, d.args);
      for (const c of model.calls) expect(lastDelta.get(c.index)).toBe(c.args);
    }
  });

  it("every single split point of a short payload assembles identically", async () => {
    const args = '{"p":"a\u{1F600}b\\nc"}';
    const atomic = await runEv([
      { type: "toolName", index: 0, name: "w", toolCallId: "c" },
      { type: "toolArgument", index: 0, arguments: args },
    ]);
    const ref = normalizeResult(atomic.result);
    expect(atomic.result.finalToolCalls![0]!.function.arguments).toBe(args);
    for (let i = 1; i < args.length; i++) {
      // cuts bisect surrogate pairs too (UTF-16 unit splits)
      const split = await runEv([
        { type: "toolName", index: 0, name: "w", toolCallId: "c" },
        { type: "toolArgument", index: 0, arguments: args.slice(0, i) },
        { type: "toolArgument", index: 0, arguments: args.slice(i) },
      ]);
      expect(normalizeResult(split.result)).toBe(ref);
    }
  });

  it("byte-at-a-time arg deltas on short payloads assemble identically", async () => {
    const rng = makeRng(0x57720002);
    for (let i = 0; i < 40; i++) {
      const args = genArgsPayload(rng).slice(0, 60);
      const atomic = await runEv([
        { type: "toolName", index: 0, name: "t", toolCallId: "c1" },
        { type: "toolArgument", index: 0, arguments: args },
      ]);
      const pieces = Array.from(args);
      const split = await runEv([
        { type: "toolName", index: 0, name: "t", toolCallId: "c1" },
        ...pieces.map((p) => ({ type: "toolArgument" as const, index: 0, arguments: p })),
      ]);
      expect(split.result.finalToolCalls![0]!.function.arguments).toBe(args);
      expect(normalizeResult(split.result)).toBe(normalizeResult(atomic.result));
    }
  });

  it("gapped, out-of-order, duplicate, and args-first indices never corrupt assembly", async () => {
    // pinned: final order is first-touch order of indices; duplicates merge;
    // a resent name without id/name keeps buffered args; gaps stay gaps.
    const res = await runEv([
      { type: "toolArgument", index: 5, arguments: '{"a":' },
      { type: "toolName", index: 2, name: "second", toolCallId: "id2" },
      { type: "toolName", index: 5, name: "first", toolCallId: "id5" },
      { type: "toolArgument", index: 2, arguments: "{}" },
      { type: "toolName", index: 5, name: "", toolCallId: "" },
      { type: "toolArgument", index: 5, arguments: "1}" },
      { type: "toolName", index: 9, name: "never-args", toolCallId: "id9" },
    ]);
    const tcs = res.result.finalToolCalls!;
    expect(tcs.map((t) => t.function.name)).toEqual(["first", "second", "never-args"]);
    expect(tcs.map((t) => t.function.arguments)).toEqual(['{"a":1}', "{}", ""]);
    expect(tcs.map((t) => t.id)).toEqual(["id5", "id2", "id9"]);
  });

  it("truncated mid-arguments stays honestly incomplete, never repaired", async () => {
    const rng = makeRng(0x57720003);
    const ITERS = 150;
    for (let i = 0; i < ITERS; i++) {
      const obj = { path: "src/\u6587\u4EF6.ts", cmd: 'ls "a b"', n: 41 + i, arr: [1, "two", null], nested: { deep: "\u{1F600}" } };
      const full = JSON.stringify(obj);
      const cut = 1 + rng.int(full.length - 1);
      const truncated = full.slice(0, cut);
      const pieces = randomChunks(rng, truncated, 5, rng.bool() ? "adversarial" : "random");
      const res = await runEv([
        { type: "toolName", index: 0, name: "t", toolCallId: "c1" },
        ...pieces.map((p) => ({ type: "toolArgument" as const, index: 0, arguments: p })),
        { type: "finish", reason: "length" },
      ]);
      const args = res.result.finalToolCalls![0]!.function.arguments;
      expect(args).toBe(truncated); // byte-exact prefix, not coerced into other JSON
      expect(() => JSON.parse(args)).toThrow(); // invalid stays invalid
      expect(res.result.finishReason).toBe("length");
    }
  });
});

// ── Malformed deltas: pin the (silent) error contract ───────────────

describe("stream-processor malformed deltas", () => {
  it("wrong-typed deltas never throw; coercion is exactly as pinned", async () => {
    const junk = [
      { type: "toolName", index: 0, name: undefined, toolCallId: 42 },
      { type: "toolArgument", index: "s", arguments: null },
      { type: "toolArgument", index: "s", arguments: 42 },
      { type: "toolArgument", index: 1, arguments: {} },
      { type: "content", content: undefined },
      { type: "content", content: 7 },
      { type: "usage", data: null },
      { type: "finish", reason: undefined },
      { type: "weird" },
      { type: "toolArgument", index: NaN, arguments: "abc" },
    ] as unknown as StreamEvent[];

    const res = await runEv(junk); // no rejection
    expect(res.result.fullText).toBe("7"); // Array.join: undefined -> "", 7 -> "7"
    const tcs = res.result.finalToolCalls!;
    expect(tcs.length).toBe(4); // indices 0, "s", 1, NaN -- string/number/NaN are distinct keys
    expect(tcs[0]!.function.name).toBe(""); // undefined name -> ""
    expect(tcs[0]!.id as unknown).toBe(42); // truthy non-string id passes through untouched
    expect(tcs[0]!.function.arguments).toBe("");
    expect(tcs[1]!.function.arguments).toBe("42"); // null -> "", 42 -> "42"
    expect(tcs[2]!.function.arguments).toBe("[object Object]");
    expect(tcs[3]!.function.arguments).toBe("abc");
    expect(res.result.usage).toBeNull();
    expect(res.result.finishReason).toBeUndefined(); // raw passthrough when reason missing
  });

  it("random malformed streams always resolve; args are always strings", async () => {
    const rng = makeRng(0x57720004);
    const junkValues: unknown[] = [null, undefined, 0, 42, -1, {}, [], "x", "\u{1F600}", true, false, NaN];
    for (let i = 0; i < 200; i++) {
      const n = 1 + rng.int(15);
      const events: StreamEvent[] = [];
      for (let j = 0; j < n; j++) {
        const roll = rng.int(6);
        if (roll === 0) {
          events.push({ type: "toolName", index: rng.pick([0, 1, NaN, -0]) as number, name: rng.pick(junkValues) as string, toolCallId: rng.pick(junkValues) as string });
        } else if (roll === 1) {
          events.push({ type: "toolArgument", index: rng.pick([0, 1, "1", null]) as unknown as number, arguments: rng.pick(junkValues) as string });
        } else if (roll === 2) {
          events.push({ type: "content", content: rng.pick(junkValues) as string });
        } else if (roll === 3) {
          events.push({ type: "reasoning", content: rng.pick(junkValues) as string });
        } else if (roll === 4) {
          events.push({ type: "usage", data: rng.pick(junkValues) as Record<string, unknown> });
        } else {
          events.push(rng.pick([{ type: "finish", reason: rng.pick(junkValues) as string }, { type: "reset" }, { type: "?" }]) as StreamEvent);
        }
      }
      // The contract: process() never rejects on malformed deltas.
      const res = await runEv(events);
      expect(typeof res.result.fullText).toBe("string");
      expect(res.result.finalToolCalls === null || Array.isArray(res.result.finalToolCalls)).toBe(true);
      for (const tc of res.result.finalToolCalls ?? []) {
        expect(typeof tc.function.arguments).toBe("string"); // join() always coerces
      }
    }
  });

  it("onToolCalls callback receives exactly the returned final calls", async () => {
    const res = await runEv([
      { type: "toolName", index: 0, name: "t", toolCallId: "c1" },
      { type: "toolArgument", index: 0, arguments: '{"a":1}' },
    ]);
    expect(res.toolCallsCb).toEqual(res.result.finalToolCalls);
  });
});
