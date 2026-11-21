// Stream-batching tests: src/extensions/websocket/stream-batcher.ts wired
// through WebSocketChannel.write / deliverFrame / sendJson / detach and the
// ChannelHub publish fan-out. Deterministic: an injectable fake clock drives
// the window; zero sleeps, zero mock.module. Pins:
//   - knob 0 = byte-identical passthrough (vs the batcher-less reference)
//   - coalesced concatenation == unbatched bytes (nothing dropped)
//   - every flush point ships the batch BEFORE the frame that triggers it
//   - tool-call partials collapse latest-wins per call index
//   - first frame of a burst never waits; window expiry re-opens the burst
//   - buffers are per channel: one busy session never delays another
//   - the knob is read live (a swap applies to the next frame)

import { describe, it, expect } from "bun:test";
import { StreamBatcher, resolveStreamBatchMs, DEFAULT_STREAM_BATCH_MS } from "@extensions/websocket/stream-batcher.ts";
import { S2C } from "@extensions/websocket/protocol.ts";
import { WebSocketChannel } from "@extensions/websocket/websocket-channel.ts";
import { ChannelHub } from "@extensions/websocket/channel-hub.ts";
import { handleQuestionAnswer } from "@extensions/websocket/handlers-tasks.ts";
import { handleSwitchProfile } from "@extensions/websocket/handlers-sessions.ts";
import { routeMessage } from "@extensions/websocket/message-routing.ts";
import type { SessionRegistry } from "@extensions/websocket/session-registry.ts";
import { ChannelSessionManager } from "@core/channel.ts";
import { OUTPUT_EVENT, type OutputEvent } from "@core/context/output.ts";
import type { HotdogServerSocket } from "@extensions/websocket/socket.ts";

// ── Deterministic clock ─────────────────────────────────────────────────────

class FakeClock {
  now = 0;
  #seq = 0;
  #timers: { at: number; seq: number; cb: () => void }[] = [];

  setTimer = (cb: () => void, ms: number): (() => void) => {
    const t = { at: this.now + ms, seq: this.#seq++, cb };
    this.#timers.push(t);
    return () => {
      this.#timers = this.#timers.filter((x) => x !== t);
    };
  };

  /** Live timers (armed windows). */
  get armed(): number {
    return this.#timers.length;
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.#timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.now = due.at;
      this.#timers = this.#timers.filter((t) => t !== due);
      due.cb();
    }
    this.now = target;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const SID = "s1";

function chunk(content: string): Record<string, unknown> {
  return { type: S2C.STREAMING_CHUNK, sessionId: SID, content };
}
function reasoning(content: string): Record<string, unknown> {
  return { type: S2C.STREAMING_REASONING_CHUNK, sessionId: SID, content };
}
function toolDelta(index: number, name: string, args: string): Record<string, unknown> {
  return { type: S2C.STREAMING_TOOL_CALL, sessionId: SID, index, name, args };
}

/** A batcher on a fake clock; `sent` collects frames in ship order. */
function makeBatcher(batchMs: number | (() => number)) {
  const clock = new FakeClock();
  const sent: Record<string, unknown>[] = [];
  const batcher = new StreamBatcher({
    send: (f) => sent.push(f),
    getBatchMs: typeof batchMs === "number" ? () => batchMs : batchMs,
    setTimer: clock.setTimer,
  });
  return { clock, sent, batcher };
}

function mockWs(): { ws: HotdogServerSocket<unknown>; sent: string[] } {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    send: (data: string) => {
      sent.push(data);
    },
    close: () => {},
  } as unknown as HotdogServerSocket<unknown>;
  return { ws, sent };
}

function mockSessionManager(
  sessionIds: string[] = [SID],
  onEvents?: (handler: (ev: OutputEvent) => void) => void,
): ChannelSessionManager {
  return {
    enqueue: () => {},
    cancel: () => {},
    interrupt: () => {},
    executeCommand: async () => {},
    onSessionEvents: (_id: string, handler: (ev: OutputEvent) => void) => {
      onEvents?.(handler);
      return () => {};
    },
    sessionIds: () => sessionIds,
    getSessionInfo: (id: string) => ({ id, model: "test-model" }),
  } as unknown as ChannelSessionManager;
}

/** A real WebSocketChannel driven through write() (the bus handler the
 *  constructor subscribes), on the injected clock. `attested` flips the
 *  socket's toolCallDeltas capability (the C2S AUTH attestation). */
function makeChannel(
  opts: {
    streamBatchMs?: () => number;
    clock?: FakeClock;
    broadcastCallback?: (msg: Record<string, unknown>) => void;
    attested?: boolean;
  } = {},
): { channel: WebSocketChannel; sent: string[]; emit: (ev: OutputEvent) => void } {
  let handler: ((ev: OutputEvent) => void) | null = null;
  const { ws, sent } = mockWs();
  if (opts.attested) ws.toolCallDeltas = true;
  const channel = new WebSocketChannel({
    sessionManager: mockSessionManager([SID], (h) => {
      handler = h;
    }),
    ws,
    sessionId: SID,
    broadcastCallback: opts.broadcastCallback,
    streamBatchMs: opts.streamBatchMs,
    streamBatchTimer: opts.clock?.setTimer,
  });
  return {
    channel,
    sent,
    emit: (ev) => handler!(ev),
  };
}

// ── resolveStreamBatchMs ────────────────────────────────────────────────────

describe("resolveStreamBatchMs - the live knob", () => {
  it("falls back to the schema default when the block/key is absent or junk", () => {
    expect(resolveStreamBatchMs(undefined)).toBe(DEFAULT_STREAM_BATCH_MS);
    expect(resolveStreamBatchMs({})).toBe(DEFAULT_STREAM_BATCH_MS);
    expect(resolveStreamBatchMs({ webui: {} })).toBe(DEFAULT_STREAM_BATCH_MS);
    expect(resolveStreamBatchMs({ webui: { streamBatchMs: "100" } })).toBe(DEFAULT_STREAM_BATCH_MS);
    expect(resolveStreamBatchMs({ webui: { streamBatchMs: NaN } })).toBe(DEFAULT_STREAM_BATCH_MS);
    expect(resolveStreamBatchMs({ webui: "junk" })).toBe(DEFAULT_STREAM_BATCH_MS);
  });

  it("takes a finite number, clamps negatives to 0 (off)", () => {
    expect(resolveStreamBatchMs({ webui: { streamBatchMs: 250 } })).toBe(250);
    expect(resolveStreamBatchMs({ webui: { streamBatchMs: 0 } })).toBe(0);
    expect(resolveStreamBatchMs({ webui: { streamBatchMs: -5 } })).toBe(0);
  });
});

// ── Batcher unit: knob 0 = passthrough ─────────────────────────────────────

describe("StreamBatcher - knob 0 is byte-identical passthrough", () => {
  it("every frame ships alone, in order, untouched, never armed", () => {
    const script = [
      chunk("a"),
      reasoning("r1"),
      toolDelta(0, "bash", "{"),
      toolDelta(0, "bash", "{\"a\""),
      chunk("b"),
      { type: S2C.ASSISTANT_MESSAGE, sessionId: SID, content: "ab" },
      chunk("c"),
    ];
    const { clock, sent, batcher } = makeBatcher(0);
    for (const f of script) batcher.handle(f);
    expect(sent).toEqual(script);
    expect(sent.map((f) => JSON.stringify(f))).toEqual(script.map((f) => JSON.stringify(f)));
    expect(clock.armed).toBe(0);
    batcher.flush();
    expect(sent).toHaveLength(script.length); // flush adds nothing
  });

  it("a mid-stream swap to 0 drains the buffer then passes through byte-exactly", () => {
    let knob = 100;
    const { clock, sent, batcher } = makeBatcher(() => knob);
    batcher.handle(chunk("a1"));
    batcher.handle(chunk("a2")); // buffered
    knob = 0;
    batcher.handle(chunk("a3"));
    expect(sent.map((f) => f.content)).toEqual(["a1", "a2", "a3"]);
    expect(sent[2]).toEqual(chunk("a3")); // byte-identical solo frame
    expect(clock.armed).toBe(0);
  });
});

// ── Batcher unit: coalescing semantics ─────────────────────────────────────

describe("StreamBatcher - first paint never waits", () => {
  it("the first frame of a burst ships synchronously; the window arms once", () => {
    const { clock, sent, batcher } = makeBatcher(100);
    batcher.handle(chunk("a1"));
    expect(sent).toHaveLength(1);
    expect(clock.armed).toBe(1);
    batcher.handle(chunk("a2"));
    batcher.handle(chunk("a3"));
    expect(sent).toHaveLength(1); // both coalesced
    clock.advance(100);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.content).toBe("a2a3");
    // The closed window never re-fires; the next frame opens a NEW burst.
    clock.advance(1000);
    expect(sent).toHaveLength(2);
    batcher.handle(chunk("b1"));
    expect(sent).toHaveLength(3); // immediate again
    expect(sent[2]!.content).toBe("b1");
    expect(clock.armed).toBe(1);
  });

  it("non-streaming frames never arm a window", () => {
    const { clock, sent, batcher } = makeBatcher(100);
    batcher.handle({ type: S2C.SYSTEM_MESSAGE, sessionId: SID, content: "hi" });
    expect(sent).toHaveLength(1);
    expect(clock.armed).toBe(0);
  });
});

describe("StreamBatcher - concatenation equals the unbatched bytes", () => {
  it("text chunks merge byte-equal; reasoning keeps its own slot", () => {
    const parts = Array.from({ length: 5 }, (_, i) => `tok${i} `);
    const rParts = ["deep ", "thoughts ", "here"];
    const { clock, sent, batcher } = makeBatcher(100);
    // Interleave the two kinds: only the FIRST frame of the burst ships
    // immediately; each kind concatenates ONLY with its own slot.
    batcher.handle(chunk(parts[0]!));
    batcher.handle(reasoning(rParts[0]!));
    parts.slice(1).forEach((p, i) => {
      batcher.handle(chunk(p!));
      if (rParts[i + 1]) batcher.handle(reasoning(rParts[i + 1]!));
    });
    clock.advance(100);
    // a1 shipped immediately; flush adds one merged frame per kind, in
    // first-arrival SLOT order (the reasoning slot opened first).
    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual(chunk(parts[0]!));
    expect(sent[1]).toEqual({
      type: S2C.STREAMING_REASONING_CHUNK,
      sessionId: SID,
      content: rParts.join(""),
    });
    expect(sent[2]).toEqual({ type: S2C.STREAMING_CHUNK, sessionId: SID, content: parts.slice(1).join("") });
    // End-to-end byte equality: reassembled stream == unbatched concatenation.
    const text = sent.filter((f) => f.type === S2C.STREAMING_CHUNK).map((f) => f.content as string).join("");
    const rText = sent
      .filter((f) => f.type === S2C.STREAMING_REASONING_CHUNK)
      .map((f) => f.content as string)
      .join("");
    expect(text).toBe(parts.join(""));
    expect(rText).toBe(rParts.join(""));
  });

  it("the merged frame does not mutate the original (publish fan-out shares objects)", () => {
    const { batcher } = makeBatcher(100);
    const f1 = chunk("a1");
    const shared = chunk("shared");
    batcher.handle(f1);
    batcher.handle(shared);
    batcher.handle(chunk("a2"));
    batcher.flush();
    expect(shared.content).toBe("shared"); // the fan-out frame is untouched
  });
});

describe("StreamBatcher - tool-call partials collapse latest-wins per index", () => {
  it("interleaved parallel calls keep only the newest cumulative partial each", () => {
    const { clock, sent, batcher } = makeBatcher(100);
    batcher.handle(toolDelta(0, "write", "{"));
    batcher.handle(toolDelta(1, "bash", "{"));
    batcher.handle(toolDelta(0, "write", "{\"a"));
    batcher.handle(toolDelta(1, "bash", "{\"comm"));
    batcher.handle(toolDelta(0, "write", "{\"a\":1}"));
    batcher.handle(toolDelta(1, "bash", "{\"command\":\"ls\"}"));
    clock.advance(100);
    expect(sent).toHaveLength(3); // 1 immediate + one merged frame PER INDEX
    const byIndex = new Map<number, string>();
    for (const f of sent) {
      if (f.type === S2C.STREAMING_TOOL_CALL) byIndex.set(f.index as number, f.args as string);
    }
    // Each index's newest cumulative partial is ALL the client renders; every
    // older partial is dead weight, and the FINAL state is frame-for-frame
    // what the unbatched stream would leave rendered.
    expect(byIndex.get(0)).toBe("{\"a\":1}");
    expect(byIndex.get(1)).toBe("{\"command\":\"ls\"}");
  });

  it("a name that lands mid-burst rides the surviving frame", () => {
    const { batcher, sent } = makeBatcher(100);
    batcher.handle(toolDelta(0, "", "{"));
    batcher.handle(toolDelta(0, "grep", "{\"pat"));
    batcher.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(toolDelta(0, "grep", "{\"pat"));
  });
});

// ── Delta posture: `delta` frames CONCATENATE per index ─────────────────────
// The batcher merges tool-preview slots BY FRAME SHAPE: a `delta` frame is an
// increment (text/reasoning concatenation doctrine), an `args` frame is the
// repeated cumulative partial (latest-wins, untouched above). Slots never
// collide across postures, and a merged window stays byte-equal to the
// concatenated increments.

function toolDeltaInc(index: number, name: string, delta: string): Record<string, unknown> {
  return { type: S2C.STREAMING_TOOL_CALL, sessionId: SID, index, name, delta };
}

describe("StreamBatcher - tool-call delta frames concatenate per index", () => {
  it("the flushed frame is BYTE-EQUAL to the concatenated increments; first paint still ships immediately", () => {
    const { clock, sent, batcher } = makeBatcher(50);
    batcher.handle(toolDeltaInc(0, "write", "{"));
    expect(sent).toHaveLength(1); // zero added latency on the first token
    batcher.handle(toolDeltaInc(0, "write", "\"a\":"));
    batcher.handle(toolDeltaInc(0, "write", "1}"));
    clock.advance(50);
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1])).toBe(
      JSON.stringify({
        type: S2C.STREAMING_TOOL_CALL,
        sessionId: SID,
        index: 0,
        name: "write",
        delta: "\"a\":1}",
      }),
    );
  });

  it("concatenating the shipped deltas reassembles the unbatched stream exactly", () => {
    const parts = ["{", "\"a\":", "1}", ",\"b\":2}"];
    const { clock, sent, batcher } = makeBatcher(50);
    for (const p of parts) batcher.handle(toolDeltaInc(0, "write", p));
    clock.advance(50);
    const joined = sent.map((f) => f.delta as string).join("");
    expect(joined).toBe(parts.join(""));
  });

  it("interleaved parallel calls keep one concatenation slot each, in first-arrival order", () => {
    const { clock, sent, batcher } = makeBatcher(50);
    batcher.handle(toolDeltaInc(0, "write", "a")); // immediate
    batcher.handle(toolDeltaInc(1, "bash", "L")); // slot tool:1
    batcher.handle(toolDeltaInc(0, "write", "b")); // slot tool:0
    batcher.handle(toolDeltaInc(1, "bash", "M"));
    clock.advance(50);
    expect(sent).toHaveLength(3);
    expect(sent.slice(1).map((f) => [f.index, f.delta])).toEqual([
      [1, "LM"],
      [0, "b"],
    ]);
  });

  it("a mixed slot folds an incoming increment into the buffered cumulative partial", () => {
    // The attestation lands mid-window: the slot holds an args frame, the
    // next frame is a delta. Growing the partial keeps BOTH clients honest.
    const { clock, sent, batcher } = makeBatcher(50);
    batcher.handle(toolDelta(0, "bash", "{")); // immediate
    batcher.handle(toolDelta(0, "bash", "{\"a\":")); // cumulative slot
    batcher.handle(toolDeltaInc(0, "bash", "1}"));
    clock.advance(50);
    expect(sent[1]).toEqual(toolDelta(0, "bash", "{\"a\":1}"));
  });

  it("an incoming cumulative frame wins over a buffered delta slot (latest-wins kept for args)", () => {
    const { clock, sent, batcher } = makeBatcher(50);
    batcher.handle(toolDeltaInc(0, "bash", "x")); // immediate
    batcher.handle(toolDeltaInc(0, "bash", "y")); // delta slot
    batcher.handle(toolDelta(0, "bash", "complete")); // cumulative frame arrives
    clock.advance(50);
    expect(sent[1]).toEqual(toolDelta(0, "bash", "complete"));
  });

  it("the slot copy keeps the batcher from mutating a shared fan-out frame", () => {
    // ChannelHub.publish hands the SAME frame object to sibling batchers:
    // concatenation must not double-append on the second channel.
    const frame = toolDeltaInc(0, "bash", "a");
    const { batcher, sent } = makeBatcher(50);
    batcher.handle(frame); // immediate: unbuffered, sent as-is
    batcher.handle(frame); // buffered copy grows, never the original
    batcher.handle(frame);
    expect(frame.delta).toBe("a");
    batcher.flush();
    expect(sent[1]!.delta).toBe("aa");
  });
});

describe("WebSocketChannel - both postures batch on separate channels at once", () => {
  it("an attested socket concatenates increments while a legacy socket collapses latest-wins", () => {
    const clock = new FakeClock();
    const fast = makeChannel({ streamBatchMs: () => 50, clock, attested: true });
    const legacy = makeChannel({ streamBatchMs: () => 50, clock });
    const script: OutputEvent[] = [
      { type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "bash", args: "{", argsDelta: "{" },
      { type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "bash", args: "{\"a\":", argsDelta: "\"a\":" },
      { type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "bash", args: "{\"a\":1}", argsDelta: "1}" },
    ];
    for (const ev of script) {
      fast.emit(ev);
      legacy.emit(ev);
    }
    clock.advance(50);
    const fastFrames = fast.sent.map((s) => JSON.parse(s));
    const legacyFrames = legacy.sent.map((s) => JSON.parse(s));
    // Attested: increment frames; the merged window carries the concatenation
    // of what the burst held, and the full-delta reassembly equals the wire.
    expect(fastFrames.map((f) => f.delta)).toEqual(["{", "\"a\":1}"]);
    expect(fastFrames.every((f) => !("args" in f))).toBe(true);
    // Legacy: today's cumulative latest-wins collapse, byte-for-byte.
    expect(legacyFrames.map((f) => f.args)).toEqual(["{", "{\"a\":1}"]);
    expect(legacyFrames.every((f) => !("delta" in f))).toBe(true);
  });
});

// ── Flush points ────────────────────────────────────────────────────────────

describe("StreamBatcher - flush-before-send at every flush point", () => {
  const flushFrames: Array<[string, Record<string, unknown>]> = [
    ["assistant response", { type: S2C.ASSISTANT_MESSAGE, sessionId: SID, content: "done" }],
    ["tool start", { type: S2C.TOOL_CALL, sessionId: SID, name: "bash", args: {} }],
    ["tool result", { type: S2C.TOOL_RESULT, sessionId: SID, name: "bash", output: "ok" }],
    ["system message", { type: S2C.SYSTEM_MESSAGE, sessionId: SID, content: "notice" }],
    [
      "question",
      { type: S2C.QUESTION, sessionId: SID, questions: [{ prompt: "which?" }] },
    ],
    ["footer/state", { type: S2C.SESSION_STATE, sessionId: SID, key: "working", value: false }],
    ["stream reset", { type: S2C.STREAM_RESET, sessionId: SID }],
    ["turn-usage", { type: S2C.TOKEN_USAGE, sessionId: SID }],
  ];

  it.each(flushFrames)("%s flushes the buffered chunk BEFORE itself", (_name, frame) => {
    const { sent, batcher } = makeBatcher(100);
    batcher.handle(chunk("a1")); // immediate
    batcher.handle(chunk("a2")); // buffered
    batcher.handle(frame);
    // The batched chunk NEVER overtakes the frame: strict order a1, a2, frame.
    expect(sent).toHaveLength(3);
    expect(sent[1]!.content).toBe("a2");
    expect(sent[2]).toBe(frame);
  });

  it("window expiry flushes, and an empty window costs nothing", () => {
    const { clock, sent, batcher } = makeBatcher(100);
    batcher.handle(chunk("a1")); // immediate; window armed
    clock.advance(100); // expiry with nothing buffered: silent, window closed
    expect(sent).toHaveLength(1);
    expect(clock.armed).toBe(0);
    batcher.handle(chunk("a2")); // new burst: immediate again
    batcher.handle(chunk("a3"));
    expect(sent).toHaveLength(2);
    clock.advance(99);
    expect(sent).toHaveLength(2);
    clock.advance(1);
    expect(sent).toHaveLength(3);
    expect(sent[2]!.content).toBe("a3");
  });
});

// ── Channel integration ─────────────────────────────────────────────────────

describe("WebSocketChannel - batching through the real sink", () => {
  it("default construction (no reader) is off: today's per-event wire, byte-exact", () => {
    const { sent, emit } = makeChannel();
    const parts = ["a1", "a2", "a3"];
    for (const p of parts) emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: p });
    expect(sent).toEqual(
      parts.map((p) => JSON.stringify({ type: S2C.STREAMING_CHUNK, sessionId: SID, content: p })),
    );
  });

  it("with the knob: coalesced bytes reassemble the unbatched stream exactly", () => {
    const clock = new FakeClock();
    const { sent, emit } = makeChannel({ streamBatchMs: () => 50, clock });
    const parts = ["Hel", "lo ", "wor", "ld"];
    for (const p of parts) emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: p });
    clock.advance(50);
    expect(sent).toHaveLength(2);
    const reassembled = sent.map((s) => (JSON.parse(s) as { content: string }).content).join("");
    expect(reassembled).toBe("Hello world");
  });

  it("a tool-call delta burst collapses, the final TOOL_CALL frame flushes it in order", () => {
    const clock = new FakeClock();
    const { sent, emit } = makeChannel({ streamBatchMs: () => 50, clock });
    emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "bash", args: "{" });
    emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "bash", args: "{\"command\":" });
    emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "bash", args: "{\"command\":\"ls\"}" });
    emit({
      type: OUTPUT_EVENT.TOOL_CALL,
      toolName: "bash",
      input: '{"command":"ls"}',
      toolCallId: "c1",
    });
    expect(sent).toHaveLength(3); // first delta, collapsed newest, final frame
    expect(JSON.parse(sent[1]!).args).toBe("{\"command\":\"ls\"}");
    expect(JSON.parse(sent[2]!).type).toBe(S2C.TOOL_CALL);
    void clock;
  });

  it("detach flushes the buffer (session switch / socket close never drop frames)", () => {
    const clock = new FakeClock();
    const { channel, sent, emit } = makeChannel({ streamBatchMs: () => 50, clock });
    emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "a1" });
    emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "a2" });
    expect(sent).toHaveLength(1);
    channel.detach(SID);
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1]!).content).toBe("a2");
    expect(clock.armed).toBe(0);
  });

  it("close() flushes too (the hub's delete path)", () => {
    const clock = new FakeClock();
    const { channel, sent, emit } = makeChannel({ streamBatchMs: () => 50, clock });
    emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "a1" });
    emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "a2" });
    channel.close();
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1]!).content).toBe("a2");
    // And after close the channel is silent.
    emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "a3" });
    expect(sent).toHaveLength(2);
  });

  it("sendJson flushes the batch first (same-socket order)", () => {
    const clock = new FakeClock();
    const { channel, sent, emit } = makeChannel({ streamBatchMs: () => 50, clock });
    emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "a1" });
    emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "a2" });
    channel.sendJson({ type: "custom", hello: true });
    expect(sent).toHaveLength(3);
    expect(JSON.parse(sent[1]!).content).toBe("a2");
    expect(JSON.parse(sent[2]!)).toEqual({ type: "custom", hello: true });
  });

  it("a session_state frame flushes before its broadcast lands on this socket", () => {
    const clock = new FakeClock();
    // At broadcast time the batched chunk must ALREADY be on the socket.
    let orderAtBroadcast = -1;
    const { sent, emit } = makeChannel({
      streamBatchMs: () => 50,
      clock,
      broadcastCallback: () => {
        orderAtBroadcast = sent.length;
      },
    });
    emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "a1" });
    emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "a2" });
    expect(sent).toHaveLength(1);
    emit({ type: OUTPUT_EVENT.SESSION_STATE, key: "working", value: true });
    // broadcast saw the buffer drained: a1, a2 shipped BEFORE the state frame.
    expect(orderAtBroadcast).toBe(2);
    expect(JSON.parse(sent[1]!).content).toBe("a2");
    expect(JSON.parse(sent[2]!).type).toBe(S2C.SESSION_STATE);
    // The state frame itself then rode this socket too (unchanged doctrine).
    expect(sent).toHaveLength(3);
  });
});

// ── ChannelHub publish: worker tails + multi-channel isolation ─────────────

function makeHub(opts: { streamBatchMs?: () => number; clock?: FakeClock } = {}) {
  const rows = new Map<string, { connectedClients: number; lastActivityAt: number; kind?: string }>();
  // Bus handlers per session, in REGISTRATION order -- the same subscription
  // order the core event bus dispatches through per session, which is exactly
  // where the cross-watcher session_state race lived.
  const busHandlers = new Map<string, ((ev: OutputEvent) => void)[]>();
  const hub = new ChannelHub({
    getSession: (sid) =>
      rows.has(sid)
        ? ({ agent: {}, metadata: rows.get(sid)! } as never)
        : null,
    getRow: (sid) => (rows.has(sid) ? (rows.get(sid)! as never) : null),
    getSessionManager: () =>
      ({
        onSessionEvents: (id: string, handler: (ev: OutputEvent) => void) => {
          const list = busHandlers.get(id) ?? [];
          list.push(handler);
          busHandlers.set(id, list);
          return () => {};
        },
      }) as never,
    streamBatchMs: opts.streamBatchMs,
    streamBatchTimer: opts.clock?.setTimer,
  });
  return {
    hub,
    rows,
    /** Fan one event to every channel of ONE session like that session's bus
     *  does (channel 1 writes first, then channel 2, ... -- the
     *  subscription-order shape of the race the broadcast seam must survive). */
    dispatch: (sessionId: string, ev: OutputEvent) => {
      for (const h of [...(busHandlers.get(sessionId) ?? [])]) h(ev);
    },
  };
}

describe("ChannelHub.publish - worker tails batch per watcher, sessions stay isolated", () => {
  it("streaming frames coalesce per channel; a non-streaming frame flushes each", () => {
    const clock = new FakeClock();
    const { hub, rows } = makeHub({ streamBatchMs: () => 100, clock });
    rows.set("w1", { connectedClients: 0, lastActivityAt: 0, kind: "worker" });
    const { ws: wsA, sent: sentA } = mockWs();
    const { ws: wsB, sent: sentB } = mockWs();
    hub.createChannel("w1", wsA);
    hub.createChannel("w1", wsB);

    hub.publish("w1", chunk("t1"));
    hub.publish("w1", chunk("t2"));
    expect(sentA).toHaveLength(1); // coalesced on BOTH watchers
    expect(sentB).toHaveLength(1);
    hub.publish("w1", { type: S2C.TOOL_RESULT, sessionId: "w1", name: "bash", output: "ok" });
    // Each watcher: t1, merged t2, then the tool result -- strict order.
    for (const sent of [sentA, sentB]) {
      expect(sent).toHaveLength(3);
      expect(JSON.parse(sent[1]!).content).toBe("t2");
      expect(JSON.parse(sent[2]!).type).toBe(S2C.TOOL_RESULT);
    }
  });

  it("a busy session's buffer never delays another session's frames", () => {
    const clock = new FakeClock();
    const { hub, rows } = makeHub({ streamBatchMs: () => 100, clock });
    rows.set("s-busy", { connectedClients: 0, lastActivityAt: 0 });
    rows.set("s-quiet", { connectedClients: 0, lastActivityAt: 0 });
    const { ws: wsBusy, sent: sentBusy } = mockWs();
    const { ws: wsQuiet, sent: sentQuiet } = mockWs();
    hub.createChannel("s-busy", wsBusy);
    hub.createChannel("s-quiet", wsQuiet);

    hub.publish("s-busy", chunk("b1"));
    hub.publish("s-busy", chunk("b2")); // buffered on the busy channel only
    hub.publish("s-quiet", chunk("q1"));
    hub.publish("s-quiet", { type: S2C.ASSISTANT_MESSAGE, sessionId: "s-quiet", content: "done" });
    expect(sentQuiet).toHaveLength(2); // the quiet session paid nothing
    expect(sentBusy).toHaveLength(1);
    clock.advance(100);
    expect(sentBusy).toHaveLength(2); // its own window flushes on its own clock
    expect(sentQuiet).toHaveLength(2);
  });

  it("closeChannels flushes every watcher (delete path ships the buffer)", () => {
    const clock = new FakeClock();
    const { hub, rows } = makeHub({ streamBatchMs: () => 100, clock });
    rows.set("w2", { connectedClients: 0, lastActivityAt: 0, kind: "worker" });
    const { ws, sent } = mockWs();
    hub.createChannel("w2", ws);
    hub.publish("w2", chunk("c1"));
    hub.publish("w2", chunk("c2"));
    expect(sent).toHaveLength(1);
    hub.closeChannels("w2");
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1]!).content).toBe("c2");
  });
});

// ── Cross-watcher broadcast seam (regression: cross-watcher session_state reorder) ──

describe("ChannelHub session_state broadcast - never overtakes another watcher's buffer", () => {
  it("the raw fan-out drains EVERY watcher channel of the session first", () => {
    // Two sockets on ONE session (the multi-tab shape). The bus dispatches
    // per-channel in subscription order: watcher 1's write() runs first and
    // its SESSION_STATE broadcast fans RAW (sendSafe) over every connection,
    // bypassing watcher 2's batcher. Without the seam drain, watcher 2's
    // socket gets [streamingChunk, sessionState, streamingChunk] -- and
    // noteWorking(false) commits the in-flight row before the trailing chunk
    // renders (a stray post-commit row on a plain Stop, no footer). The
    // unbatched wire ships the chunks first; the batcher must not reorder.
    const clock = new FakeClock();
    const { hub, rows, dispatch } = makeHub({ streamBatchMs: () => 100, clock });
    rows.set("s-multi", { connectedClients: 0, lastActivityAt: 0 });
    const { ws: ws1, sent: sent1 } = mockWs();
    const { ws: ws2, sent: sent2 } = mockWs();
    // Register like the server's onUpgrade does: hub.broadcast (the raw fan)
    // only reaches REGISTERED connections -- an unregistered fixture would
    // make the seam vacuously green.
    hub.registerConnection(ws1);
    hub.registerConnection(ws2);
    hub.createChannel("s-multi", ws1); // bus subscriber 1
    hub.createChannel("s-multi", ws2); // bus subscriber 2

    dispatch("s-multi", { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "Head" }); // immediate per channel
    dispatch("s-multi", { type: OUTPUT_EVENT.STREAMING_CHUNK, content: " and the rest of the streamed answer" }); // buffered per channel
    for (const sent of [sent1, sent2]) expect(sent).toHaveLength(1);

    // The Stop: working:false, and NO assistant_message follows (plain Stop).
    dispatch("s-multi", { type: OUTPUT_EVENT.SESSION_STATE, key: "working", value: false });

    for (const [name, sent] of [["socket1", sent1], ["socket2", sent2]] as const) {
      const types = sent.map((s) => (JSON.parse(s) as { type: string }).type);
      const firstState = types.indexOf(S2C.SESSION_STATE);
      expect(firstState, `${name}: the state frame must arrive`).toBeGreaterThan(-1);
      // Every streaming chunk of the session landed BEFORE the first state
      // frame on EVERY socket (the trailing merged chunk included).
      expect(types.slice(0, firstState), `${name}: chunks before state`).toEqual([
        S2C.STREAMING_CHUNK,
        S2C.STREAMING_CHUNK,
      ]);
      expect(JSON.parse(sent[firstState]!).key).toBe("working");
      expect(JSON.parse(sent[firstState]!).value).toBe(false);
    }
    // The trailing chunk rides merged, intact, ahead of the state frame.
    expect(JSON.parse(sent2[1]!).content).toBe(" and the rest of the streamed answer");
    // Nothing vanished with the knob off: the same dispatch is today's wire.
    void clock;
  });

  it("knob 0 keeps the cross-watcher order identical to the batched one (frame-for-frame, no dupes added)", () => {
    const clock = new FakeClock();
    const { hub, rows, dispatch } = makeHub({ streamBatchMs: () => 0, clock });
    rows.set("s-off", { connectedClients: 0, lastActivityAt: 0 });
    const { ws: ws1, sent: sent1 } = mockWs();
    const { ws: ws2, sent: sent2 } = mockWs();
    hub.registerConnection(ws1);
    hub.registerConnection(ws2);
    hub.createChannel("s-off", ws1);
    hub.createChannel("s-off", ws2);
    dispatch("s-off", { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "Head" });
    dispatch("s-off", { type: OUTPUT_EVENT.STREAMING_CHUNK, content: " tail" });
    dispatch("s-off", { type: OUTPUT_EVENT.SESSION_STATE, key: "working", value: false });
    // Off: every chunk its own frame, all before the first state frame (the
    // seam drain is a no-op on empty buffers; the duplicate state frames are
    // HEAD behavior, count included).
    for (const sent of [sent1, sent2]) {
      const types = sent.map((s) => (JSON.parse(s) as { type: string }).type);
      expect(types.slice(0, 2)).toEqual([S2C.STREAMING_CHUNK, S2C.STREAMING_CHUNK]);
      expect(types[2]).toBe(S2C.SESSION_STATE);
    }
  });
});

// ── Raw hub fan-outs: the drain lives IN ChannelHub.broadcast/broadcastScoped ──

describe("ChannelHub raw fan-outs - every same-session frame drains the watchers first", () => {
  // Raw same-session frames ride sendSafe over every connection, outside
  // the per-channel batchers: resume.ts re-presents a held QUESTION via
  // registry.broadcast and dismisses it with QUESTION_ANSWERED,
  // handlers-tasks answers with QUESTION_ANSWERED, and broadcastScoped fans
  // task frames. The drain therefore lives INSIDE broadcast() (keyed by the
  // frame's sessionId) and broadcastScoped().
  const sessionFrames: Array<[string, string, (sid: string) => Record<string, unknown>]> = [
    ["question (resume re-present)", S2C.QUESTION, (sid) => ({ type: S2C.QUESTION, sessionId: sid, questions: [{ prompt: "which?" }] })],
    ["question_answered (answer echo)", S2C.QUESTION_ANSWERED, (sid) => ({ type: S2C.QUESTION_ANSWERED, sessionId: sid, answers: {} })],
    ["question_answered (dismiss)", S2C.QUESTION_ANSWERED, (sid) => ({ type: S2C.QUESTION_ANSWERED, sessionId: sid, answers: {}, dismissed: true })],
  ];

  it.each(sessionFrames)("%s: both watchers ship the buffered chunk first", (_name, frameType, frame) => {
    const clock = new FakeClock();
    const { hub, rows, dispatch } = makeHub({ streamBatchMs: () => 100, clock });
    rows.set("s-q", { connectedClients: 0, lastActivityAt: 0 });
    const { ws: ws1, sent: sent1 } = mockWs();
    const { ws: ws2, sent: sent2 } = mockWs();
    hub.registerConnection(ws1);
    hub.registerConnection(ws2);
    hub.createChannel("s-q", ws1);
    hub.createChannel("s-q", ws2);

    dispatch("s-q", { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "Head" }); // immediate per channel
    dispatch("s-q", { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "tail" }); // buffered per channel
    for (const sent of [sent1, sent2]) expect(sent).toHaveLength(1);

    // The raw broadcast -- NOT through any channel's write().
    hub.broadcast(frame("s-q"));

    // [streamingChunk, streamingChunk(merged tail), <frame>] on BOTH sockets:
    // the tail never lags to window expiry behind the raw frame.
    for (const sent of [sent1, sent2]) {
      const types = sent.map((s) => (JSON.parse(s) as { type: string }).type);
      expect(types).toEqual([S2C.STREAMING_CHUNK, S2C.STREAMING_CHUNK, frameType]);
      expect(JSON.parse(sent[1]!).content).toBe("tail");
    }
    // Nothing left in the buffers: the window expiry adds zero frames.
    clock.advance(100);
    expect(sent1).toHaveLength(3);
    expect(sent2).toHaveLength(3);
  });

  it("broadcastScoped drains the scoped session's watchers before the fan too", () => {
    const clock = new FakeClock();
    const { hub, rows, dispatch } = makeHub({ streamBatchMs: () => 100, clock });
    rows.set("s-scoped", { connectedClients: 0, lastActivityAt: 0 });
    const { ws: wsA, sent: sentA } = mockWs();
    const { ws: wsB, sent: sentB } = mockWs();
    (wsA as unknown as { activeSessionId: string }).activeSessionId = "s-scoped";
    (wsB as unknown as { activeSessionId: string }).activeSessionId = "s-scoped";
    hub.registerConnection(wsA);
    hub.registerConnection(wsB);
    hub.createChannel("s-scoped", wsA);
    hub.createChannel("s-scoped", wsB);
    dispatch("s-scoped", { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "Head" });
    dispatch("s-scoped", { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "tail" });

    hub.broadcastScoped("s-scoped", { type: S2C.TASK_UPDATE, sessionId: "s-scoped", task: { taskId: "t1" } });
    for (const sent of [sentA, sentB]) {
      const types = sent.map((s) => (JSON.parse(s) as { type: string }).type);
      expect(types).toEqual([S2C.STREAMING_CHUNK, S2C.STREAMING_CHUNK, S2C.TASK_UPDATE]);
      expect(JSON.parse(sent[1]!).content).toBe("tail");
    }
    clock.advance(100);
    expect(sentA).toHaveLength(3); // expiry adds nothing: the drain emptied it
  });

  it("a frame with NO sessionId (sidebar lists) does NOT drain: the window keeps coalescing", () => {
    const clock = new FakeClock();
    const { hub, rows, dispatch } = makeHub({ streamBatchMs: () => 100, clock });
    rows.set("s-list", { connectedClients: 0, lastActivityAt: 0 });
    const { ws, sent } = mockWs();
    hub.registerConnection(ws);
    hub.createChannel("s-list", ws);
    dispatch("s-list", { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "Head" });
    dispatch("s-list", { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "tail" });
    hub.broadcast({ type: S2C.SESSIONS, sessions: [] }); // no sessionId
    // The sidebar frame lands (raw fan, as HEAD), but the buffered chunk does
    // NOT ride with it: the window keeps coalescing behind it.
    expect(sent).toHaveLength(2);
    expect((JSON.parse(sent[1]!) as { type: string }).type).toBe(S2C.SESSIONS);
    clock.advance(100);
    expect(sent).toHaveLength(3);
    expect(JSON.parse(sent[2]!).content).toBe("tail");
  });

  it("the drain is session-scoped: one session's broadcast never flushes another's buffer", () => {
    const clock = new FakeClock();
    const { hub, rows, dispatch } = makeHub({ streamBatchMs: () => 100, clock });
    rows.set("s-x", { connectedClients: 0, lastActivityAt: 0 });
    rows.set("s-y", { connectedClients: 0, lastActivityAt: 0 });
    const { ws: wsX, sent: sentX } = mockWs();
    const { ws: wsY, sent: sentY } = mockWs();
    hub.registerConnection(wsX);
    hub.registerConnection(wsY);
    hub.createChannel("s-x", wsX);
    hub.createChannel("s-y", wsY);
    dispatch("s-x", { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "X-head" });
    dispatch("s-x", { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "X-tail" });
    dispatch("s-y", { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "Y-head" });
    dispatch("s-y", { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "Y-tail" });
    // A raw question frame for X drains X's watcher only. (The fan is global:
    // Y's socket RECEIVES the frame, like HEAD -- what must NOT happen is
    // Y's own buffered chunk being flushed ahead of it.)
    hub.broadcast({ type: S2C.QUESTION, sessionId: "s-x", questions: [] });
    expect(sentX).toHaveLength(3); // head, merged tail (drained), question
    expect(JSON.parse(sentX[1]!).content).toBe("X-tail");
    expect(sentY).toHaveLength(2); // head, then the raw X frame -- NO X-tail,
    expect(JSON.parse(sentY[1]!).content).not.toBe("Y-tail"); // no premature Y flush
    clock.advance(100);
    expect(sentY).toHaveLength(3); // Y flushes on its own clock
    expect(JSON.parse(sentY[2]!).content).toBe("Y-tail");
  });
});

// ── Live knob (config-store doctrine) ──────────────────────────────────────

describe("StreamBatcher - the window is read live, panel edits apply per frame", () => {
  it("a swap 100 -> 2000 re-arms longer bursts; 2000 -> 0 passthroughs; 0 -> 50 re-enables", () => {
    let knob = 100;
    const { clock, sent, batcher } = makeBatcher(() => knob);
    batcher.handle(chunk("a1")); // immediate, window armed 100
    clock.advance(99);
    knob = 2000;
    batcher.handle(chunk("a2")); // joins the still-open 100ms window
    clock.advance(1); // the OLD window still closes on its armed length
    expect(sent).toHaveLength(2); // a1, a2(merged alone)
    batcher.handle(chunk("b1")); // new burst arms 2000
    batcher.handle(chunk("b2"));
    expect(sent).toHaveLength(3); // b1 immediate
    clock.advance(1000);
    expect(sent).toHaveLength(3); // window still open
    knob = 0;
    batcher.handle(chunk("b3")); // swap to off: drain, then passthrough
    expect(sent.map((f) => f.content)).toEqual(["a1", "a2", "b1", "b2", "b3"]);
    batcher.handle(chunk("b4"));
    expect(sent).toHaveLength(6); // pure passthrough
    knob = 50;
    batcher.handle(chunk("c1")); // burst re-arms on the new window
    batcher.handle(chunk("c2"));
    expect(sent).toHaveLength(7);
    clock.advance(50);
    expect(sent).toHaveLength(8);
    expect(sent[7]!.content).toBe("c2");
  });
});

// ── End-to-end: no frame dropped ───────────────────────────────────────────

describe("end-to-end - nothing is ever dropped", () => {
  it("a mixed burst reassembles the unbatched content and keeps every non-streaming frame", () => {
    const { sent, batcher } = makeBatcher(() => 100);
    const textEvents = ["alpha ", "beta ", "gamma"].map((c) => chunk(c));
    const rEvents = ["why ", "how "].map((c) => reasoning(c));
    const t0 = [toolDelta(0, "write", "{"), toolDelta(0, "write", "{\"path\":\"/tmp/a\"}")];
    const t1 = [toolDelta(1, "read", "{"), toolDelta(1, "read", "{\"path\":\"/tmp/b\"}")];
    const final = { type: S2C.TOOL_CALL, sessionId: SID, name: "write", args: { path: "/tmp/a" } };

    // Interleave everything inside one window.
    batcher.handle(textEvents[0]!);
    batcher.handle(rEvents[0]!);
    batcher.handle(t0[0]!);
    batcher.handle(t1[0]!);
    textEvents.slice(1).forEach((f) => batcher.handle(f!));
    rEvents.slice(1).forEach((f) => batcher.handle(f!));
    batcher.handle(t0[1]!);
    batcher.handle(t1[1]!);
    batcher.handle(final); // non-streaming: flushes everything before it

    const text = sent.filter((f) => f.type === S2C.STREAMING_CHUNK).map((f) => f.content as string).join("");
    const rtext = sent.filter((f) => f.type === S2C.STREAMING_REASONING_CHUNK).map((f) => f.content as string).join("");
    expect(text).toBe("alpha beta gamma");
    expect(rtext).toBe("why how ");
    const tool0 = sent.filter((f) => f.type === S2C.STREAMING_TOOL_CALL && f.index === 0).pop();
    const tool1 = sent.filter((f) => f.type === S2C.STREAMING_TOOL_CALL && f.index === 1).pop();
    expect(tool0?.args).toBe("{\"path\":\"/tmp/a\"}");
    expect(tool1?.args).toBe("{\"path\":\"/tmp/b\"}");
    expect(sent[sent.length - 1]).toBe(final); // and the final frame is last
  });
});

// ── Direct-socket sends: the requester's own buffered tail ships first ─────

describe("Direct-socket ERROR sends - drain the TARGET socket's batches first", () => {
  // Five handlers answer the REQUESTER with a raw
  // `ws.send(JSON.stringify(ERROR))` -- no hub method, no channel sink --
  // so the frame lands on the socket while its own batch window is open and
  // would overtake the requester's buffered tail. The client's handleError
  // FINALIZES the in-flight assistant row, so the flushed continuation would
  // render as a stray post-commit row. The hub's `flushSocket(ws)`
  // (iterate that socket's channels, flushPending each) runs synchronously
  // before each of the five sends. These pins drive the REAL handlers
  // against the REAL ChannelHub + WebSocketChannel (knob 100, fake clock);
  // the registry doubles forward EVERY call to the real hub, so every call
  // site exercises the production drain.

  const wireTypes = (sent: string[]): string[] =>
    sent.map((s) => (JSON.parse(s) as { type: string }).type);

  /** A hub-backed registry double: forwards to the REAL hub (no stubbed
   *  flush -- the point is to exercise the production drain). */
  function hubFacade(hub: ChannelHub, rows: Map<string, unknown>): SessionRegistry {
    return {
      getRow: (id: string) => (rows.has(id) ? rows.get(id) : null),
      flushSocket: (w: HotdogServerSocket<unknown>) => hub.flushSocket(w),
      broadcast: (m: Record<string, unknown>) => hub.broadcast(m),
      switchProfile: async () => ({ success: false, error: "profile refused" }),
    } as unknown as SessionRegistry;
  }

  /** One registered watcher streaming a burst: head shipped, tail buffered. */
  function streamingFixture(sid = "s-direct") {
    const clock = new FakeClock();
    const { hub, rows, dispatch } = makeHub({ streamBatchMs: () => 100, clock });
    rows.set(sid, { connectedClients: 0, lastActivityAt: 0 });
    const { ws, sent } = mockWs();
    hub.registerConnection(ws);
    hub.createChannel(sid, ws);
    dispatch(sid, { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "Head" });
    dispatch(sid, { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "tail" });
    expect(sent).toHaveLength(1); // head out, tail in the window
    return { clock, hub, rows, dispatch, ws, sent, registry: hubFacade(hub, rows), sid };
  }

  it("handlers-tasks: the stale 'No pending question' error ships after the merged tail", async () => {
    const clock = new FakeClock();
    const { hub, rows, dispatch } = makeHub({ streamBatchMs: () => 100, clock });
    const sid = "s-stale";
    rows.set(sid, { connectedClients: 0, lastActivityAt: 0 });
    const { ws, sent } = mockWs();
    const { ws: ws2, sent: sent2 } = mockWs();
    hub.registerConnection(ws);
    hub.registerConnection(ws2);
    hub.createChannel(sid, ws); // the stale-answer requester
    hub.createChannel(sid, ws2); // a foreign watcher: must NOT be drained
    dispatch(sid, { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "Head" });
    dispatch(sid, { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "tail" });
    for (const s of [sent, sent2]) expect(s).toHaveLength(1);

    await handleQuestionAnswer({
      ws,
      msg: { sessionId: sid, answers: { q: "a" } },
      registry: hubFacade(hub, rows),
      bridge: { answer: () => false },
    } as never);

    // Requester: [head, merged tail, error] -- the tail never lags to expiry
    // behind the commit frame.
    expect(wireTypes(sent)).toEqual([S2C.STREAMING_CHUNK, S2C.STREAMING_CHUNK, S2C.ERROR]);
    expect(JSON.parse(sent[1]!).content).toBe("tail");
    expect(JSON.parse(sent[2]!).message).toBe(`No pending question for session ${sid}`);
    // Foreign watcher: not drained by the requester's direct send -- its
    // tail is still buffered when the requester's wire already ends in the
    // error (checked before any clock advance; both windows share the clock).
    expect(sent2).toHaveLength(1);
    expect(sent[sent.length - 1]).toContain(S2C.ERROR);
    clock.advance(100);
    expect(sent).toHaveLength(3); // expiry adds NOTHING for the requester
    expect(wireTypes(sent2)).toEqual([S2C.STREAMING_CHUNK, S2C.STREAMING_CHUNK]);
  });

  it("handlers-tasks: the worker-question refusal drains the batched worker tail", async () => {
    const clock = new FakeClock();
    const { hub, rows } = makeHub({ streamBatchMs: () => 100, clock });
    const wsid = "wq";
    rows.set(wsid, { connectedClients: 0, lastActivityAt: 0, kind: "worker" });
    const { ws, sent } = mockWs();
    hub.registerConnection(ws);
    hub.createChannel(wsid, ws);
    // Worker tails ride hub.publish (the per-watcher batched path).
    hub.publish(wsid, { type: S2C.STREAMING_CHUNK, sessionId: wsid, content: "Head" });
    hub.publish(wsid, { type: S2C.STREAMING_CHUNK, sessionId: wsid, content: "tail" });
    expect(sent).toHaveLength(1);

    await handleQuestionAnswer({
      ws,
      msg: { sessionId: wsid, answers: { q: "a" } },
      registry: hubFacade(hub, rows),
      bridge: { answer: () => false },
    } as never);

    expect(wireTypes(sent)).toEqual([S2C.STREAMING_CHUNK, S2C.STREAMING_CHUNK, S2C.ERROR]);
    expect(JSON.parse(sent[1]!).content).toBe("tail");
    expect(JSON.parse(sent[2]!).message).toContain("task_followup");
    clock.advance(100);
    expect(sent).toHaveLength(3);
  });

  it("handlers-sessions: a failed profile switch drains this socket's tail first", async () => {
    const { clock, sent, ws, registry, sid } = streamingFixture();

    await handleSwitchProfile({
      ws,
      msg: { sessionId: sid, profileName: "other" },
      registry,
    } as never);

    expect(wireTypes(sent)).toEqual([S2C.STREAMING_CHUNK, S2C.STREAMING_CHUNK, S2C.ERROR]);
    expect(JSON.parse(sent[1]!).content).toBe("tail");
    expect(JSON.parse(sent[2]!).message).toBe("profile refused");
    clock.advance(100);
    expect(sent).toHaveLength(3);
  });

  it("message-routing: the 'Unknown message type' error ships after the merged tail", async () => {
    const { clock, sent, ws, registry } = streamingFixture();

    await routeMessage(ws, { type: "bogusType" } as never, registry, undefined, {} as never, {} as never);

    expect(wireTypes(sent)).toEqual([S2C.STREAMING_CHUNK, S2C.STREAMING_CHUNK, S2C.ERROR]);
    expect(JSON.parse(sent[1]!).content).toBe("tail");
    expect(JSON.parse(sent[2]!).message).toBe("Unknown message type: bogusType");
    clock.advance(100);
    expect(sent).toHaveLength(3);
  });

  it("server.ts 'Invalid JSON' shape: without the drain the error overtakes (repro), with it the wire is [head, merged tail, error]", () => {
    // The send lives inside createWsServer's onMessage (not exported); pin
    // the exact send shape against the real hub. The production call site is
    // covered end-to-end in websocket-server.test.ts ("an Invalid JSON error
    // never overtakes...").
    const { clock, sent, ws } = streamingFixture("s-json");
    // Without the drain: the raw handler send overtakes the buffered tail.
    ws.send(JSON.stringify({ type: S2C.ERROR, message: "Invalid JSON" }));
    expect(wireTypes(sent)).toEqual([S2C.STREAMING_CHUNK, S2C.ERROR]); // reordered
    clock.advance(100);
    expect(sent).toHaveLength(3); // the tail lands AFTER the commit frame
    expect(JSON.parse(sent[2]!).content).toBe("tail");

    // Drained shape: same fixture (what the five call sites do).
    const f2 = streamingFixture("s-json2");
    f2.registry.flushSocket(f2.ws);
    f2.ws.send(JSON.stringify({ type: S2C.ERROR, message: "Invalid JSON" }));
    expect(wireTypes(f2.sent)).toEqual([S2C.STREAMING_CHUNK, S2C.STREAMING_CHUNK, S2C.ERROR]);
    expect(JSON.parse(f2.sent[1]!).content).toBe("tail");
    f2.clock.advance(100);
    expect(f2.sent).toHaveLength(3);
  });

  it("knob 0: the direct sends keep HEAD's solo-frame wire (the drain is a no-op)", async () => {
    const clock = new FakeClock();
    const { hub, rows, dispatch } = makeHub({ streamBatchMs: () => 0, clock });
    const sid = "s-off-direct";
    rows.set(sid, { connectedClients: 0, lastActivityAt: 0 });
    const { ws, sent } = mockWs();
    hub.registerConnection(ws);
    hub.createChannel(sid, ws);
    dispatch(sid, { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "Head" });
    dispatch(sid, { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "tail" });
    await handleQuestionAnswer({
      ws,
      msg: { sessionId: sid, answers: { q: "a" } },
      registry: hubFacade(hub, rows),
      bridge: { answer: () => false },
    } as never);
    expect(wireTypes(sent)).toEqual([S2C.STREAMING_CHUNK, S2C.STREAMING_CHUNK, S2C.ERROR]);
    expect(JSON.parse(sent[1]!).content).toBe("tail"); // SOLO frame, not merged
    clock.advance(100);
    expect(sent).toHaveLength(3);
  });
});

// ── Ceiling guard: an absent content never stringifies into the text slot ──

describe("StreamBatcher - a content-less chunk frame is not batchable text", () => {
  it("it flushes + ships raw inside the window and never poisons the slot with 'undefined'", () => {
    const { clock, sent, batcher } = makeBatcher(() => 100);
    batcher.handle(chunk("a1")); // immediate, window armed
    batcher.handle(chunk("a2")); // buffered
    // Typed core never builds these; without the batchKey guard the slot
    // would concat to "a2undefined" and a3 would ride the poisoned slot.
    batcher.handle({ type: S2C.STREAMING_CHUNK, sessionId: SID }); // content absent
    batcher.handle({ type: S2C.STREAMING_REASONING_CHUNK, sessionId: SID, content: undefined });
    batcher.handle(chunk("a3")); // fresh burst after the flush-first sends
    clock.advance(100);
    expect(sent.map((f) => f.content)).toEqual(["a1", "a2", undefined, undefined, "a3"]);
    expect(JSON.stringify(sent).includes("undefined")).toBe(false);
  });
});
