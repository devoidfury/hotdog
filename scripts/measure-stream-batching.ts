// Deterministic measurement harness for webui stream batching.
// Feeds synthetic OutputEvent sequences through toS2CMessage and the S2C
// sink path (the same shape WebSocketChannel.write / ChannelHub.publish
// hand the socket), counting FRAMES and WIRE BYTES per scenario. No network,
// no timers: the batched run flushes by explicit window-end call.
//
// Run: bun scripts/measure-stream-batching.ts
// Emits one table row per scenario per mode (off = today's passthrough,
// batched = webui.streamBatchMs window coalescing).

import { OUTPUT_EVENT, type OutputEvent } from "@core/context/output.ts";
import { toS2CMessage, type WireMapOptions } from "@extensions/websocket/wire-messages.ts";
import { StreamBatcher, DEFAULT_STREAM_BATCH_MS } from "@extensions/websocket/stream-batcher.ts";

const SESSION = "measure-session";

// ── Scenarios (deterministic synthetic event scripts) ──────────────────────

function textStream(nTokens: number): OutputEvent[] {
  const events: OutputEvent[] = [];
  for (let i = 0; i < nTokens; i++) {
    events.push({
      type: OUTPUT_EVENT.STREAMING_CHUNK,
      content: i % 10 === 0 ? ` tok${String(i).padStart(4, "0")}` : `tok${String(i).padStart(4, "0")} `,
    });
  }
  return events;
}

function reasoningStream(nTokens: number): OutputEvent[] {
  return textStream(nTokens).map((e) => ({ ...e, type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK }));
}

// 50-delta args stream: core hands the CUMULATIVE partial AND the increment
// (argsDelta) on every event (stream-processor emitToolCallDelta). The
// posture decides which one rides the wire: cumulative re-ships ~N*10 chars
// on frame N; delta ships only the increment. Parallel call on index 1
// interleaves.
function toolCallArgsStream(deltas: number): OutputEvent[] {
  const events: OutputEvent[] = [];
  let args0 = "";
  let args1 = "";
  for (let i = 0; i < deltas; i++) {
    if (i === 0) {
      events.push({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "write", args: "", argsDelta: "" });
      events.push({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 1, name: "bash", args: "", argsDelta: "" });
    }
    const inc0 = `"p${i}":"${"x".repeat(8)}",`;
    const inc1 = `"c${i}":"${"y".repeat(8)}",`;
    args0 += inc0;
    args1 += inc1;
    events.push({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "write", args: `{${args0}`, argsDelta: inc0 });
    events.push({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 1, name: "bash", args: `{${args1}`, argsDelta: inc1 });
  }
  events.push({
    type: OUTPUT_EVENT.TOOL_CALL,
    toolName: "write",
    input: `{${args0}}`,
    toolCallId: "c0",
  });
  events.push({
    type: OUTPUT_EVENT.TOOL_CALL,
    toolName: "bash",
    input: `{${args1}}`,
    toolCallId: "c1",
  });
  return events;
}

// ── Runners ─────────────────────────────────────────────────────────────────

interface Stats {
  frames: number;
  bytes: number;
}

// Fresh per-run opts: a delta-posture run gets its own cap bookkeeping Map
// (one run = one socket = one call round).
function optsFor(deltaPosture: boolean): WireMapOptions | undefined {
  return deltaPosture
    ? { streamToolCalls: { deltas: () => true, emitted: new Map() } }
    : undefined;
}

function runUnbatched(events: OutputEvent[], deltaPosture = false): Stats {
  let frames = 0;
  let bytes = 0;
  for (const ev of events) {
    const msg = toS2CMessage(ev, SESSION, optsFor(deltaPosture));
    if (!msg) continue;
    frames++;
    bytes += JSON.stringify(msg).length;
  }
  return { frames, bytes };
}

function runBatched(events: OutputEvent[], batchMs: number, deltaPosture = false): Stats {
  let frames = 0;
  let bytes = 0;
  const batcher = new StreamBatcher({
    send: (frame) => {
      frames++;
      bytes += JSON.stringify(frame).length;
    },
    getBatchMs: () => batchMs,
    setTimer: () => () => {}, // never fires; the run flushes explicitly
  });
  for (const ev of events) {
    const msg = toS2CMessage(ev, SESSION, optsFor(deltaPosture));
    if (msg) batcher.handle(msg);
  }
  batcher.flush(); // window end
  return { frames, bytes };
}

// ── Latency probe ───────────────────────────────────────────────────────────
// Fake-clock probe on the real StreamBatcher, one window: the FIRST frame of
// a burst ships synchronously at its arrival (added latency 0, the window
// arms behind it); a frame arriving inside the window ships at the window's
// expiry -- its added latency is at most one window.

function latencyProbe(batchMs: number): { firstAddedMs: number; midWindowAddedMs: number } {
  let now = 0;
  let firstSendAt = -1;
  let secondArrival = -1;
  let secondSendAt = -1;
  let timers: { at: number; cb: () => void }[] = [];
  let sendCount = 0;
  const batcher = new StreamBatcher({
    send: () => {
      sendCount++;
      if (sendCount === 1) firstSendAt = now;
      if (sendCount === 2) secondSendAt = now;
    },
    getBatchMs: () => batchMs,
    setTimer: (cb, ms) => {
      const t = { at: now + ms, cb };
      timers.push(t);
      return () => {
        timers = timers.filter((x) => x !== t);
      };
    },
  });
  const msg = toS2CMessage({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "first token" }, SESSION)!;
  batcher.handle(msg); // burst start at t=0
  const firstArrival = 0;
  now = 1;
  secondArrival = 1;
  batcher.handle(toS2CMessage({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "second" }, SESSION)!); // buffered
  for (const t of timers) {
    now = t.at;
    t.cb();
  } // window expiry
  return {
    firstAddedMs: firstSendAt - firstArrival,
    midWindowAddedMs: secondSendAt - secondArrival,
  };
}

// ── Table ───────────────────────────────────────────────────────────────────

const toolArgsEvents = toolCallArgsStream(50);
const scenarios: Array<{ name: string; events: OutputEvent[]; delta?: boolean }> = [
  { name: "500-token text stream", events: textStream(500) },
  { name: "50-delta tool-call args cumulative (2 parallel calls)", events: toolArgsEvents },
  { name: "50-delta tool-call args deltas (2 parallel calls)", events: toolArgsEvents, delta: true },
  { name: "200-token reasoning stream", events: reasoningStream(200) },
];

const sep = " | ";
const line = (name: string, mode: string, frames: number, bytes: number) =>
  [name.padEnd(44), mode.padEnd(5), String(frames).padStart(7), String(bytes).padStart(9)].join(sep);

console.log(line("scenario", "mode", "frames", "bytes"));
for (const sc of scenarios) {
  const off = runBatched(sc.events, 0, sc.delta === true);
  const batched = runBatched(sc.events, DEFAULT_STREAM_BATCH_MS, sc.delta === true);
  console.log(line(sc.name, "off", off.frames, off.bytes));
  console.log(line("", `${DEFAULT_STREAM_BATCH_MS}ms`, batched.frames, batched.bytes));
  const savedBytes = off.bytes - batched.bytes;
  const savedPct = off.bytes > 0 ? ((savedBytes / off.bytes) * 100).toFixed(1) : "0.0";
  console.log(
    `    saved: ${off.frames - batched.frames} frames, ${savedBytes} bytes (${savedPct}%)`,
  );
}

// ── Latency claims ──────────────────────────────────────────────────────────
const lat = latencyProbe(DEFAULT_STREAM_BATCH_MS);
console.log(`latency: first-token added = ${lat.firstAddedMs} ms (first frame of a burst ships synchronously; the window arms behind it)`);
console.log(`latency: worst-case added = one window = ${DEFAULT_STREAM_BATCH_MS} ms (a frame arriving inside the window ships at expiry; probe: mid-burst frame added ${lat.midWindowAddedMs} ms <= window)`);
console.log(`latency: knob webui.streamBatchMs default ${DEFAULT_STREAM_BATCH_MS} ms; 0 disables all added latency (byte-identical passthrough)`);
