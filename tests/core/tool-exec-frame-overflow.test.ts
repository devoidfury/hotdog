// C-2 frame-bound tests: LineDecoder's MAX_FRAME_BYTES cap, its overflow
// semantics, and the death mapping on BOTH wire hops (runner -> broker,
// broker -> supervisor) plus the runner's own stdin consumer. Mirrors the
// stubbing style of tool-exec-broker-worker.test.ts (in-process child-half
// seams, real short-lived processes) and tool-exec-hardening.test.ts (real
// ToolExecBroker respawn/degrade assertions). The seam cap constructor is
// used for the unit shapes; one test pins the real-constant boundary.

import { describe, it, expect, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import {
  encodeFrame,
  FrameOverflowError,
  LineDecoder,
  MAX_FRAME_BYTES,
  type WireToolCtx,
} from "@core/tool-exec-protocol.ts";
import { handleFrame, type BrokerState } from "@core/tool-exec-broker-main.ts";
import { ToolExecBroker } from "@core/tool-exec-broker.ts";
import { PROJECT_ROOT, RUNNER_ENTRY } from "@core/tool-exec-layout.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

async function waitFor(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// supervisor-frame capture (same shape as tool-exec-broker-worker.test.ts)
let captured: any[] = [];
const rawWrite = process.stdout.write.bind(process.stdout);

function startCapture() {
  captured = [];
  process.stdout.write = ((chunk: any) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      try {
        captured.push(JSON.parse(line));
      } catch {
        /* not a frame line */
      }
    }
    return true;
  }) as typeof process.stdout.write;
}

function stopCapture() {
  process.stdout.write = rawWrite;
}

async function waitForFrame(pred: (f: any) => boolean, ms = 8000): Promise<any> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = captured.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error("timed out waiting for supervisor frame");
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterEach(stopCapture);

// ── LineDecoder unit shapes (seam cap; no 4 MB allocations) ─────────────────

describe("LineDecoder frame cap (seam)", () => {
  it("stops buffering at the cap and latches: sticky throws, never flushes", () => {
    const d = new LineDecoder(8);
    expect(() => d.push("12345678")).not.toThrow(); // exactly at cap: fine
    expect(() => d.push("9")).toThrow(FrameOverflowError); // cap + 1, no newline
    // Latched: the stream is untrustworthy, so nothing resyncs it and the
    // dropped buffer is never flushed at EOF.
    expect(() => d.push("\n")).toThrow(FrameOverflowError);
    expect(() => d.push("x".repeat(100_000))).toThrow(FrameOverflowError);
    expect(d.end()).toEqual([]);
  });

  it("still delivers and parses frames under the cap", () => {
    const d = new LineDecoder(64);
    const lines = d.push('{"output":"just under the cap"}\n{"a":2}\n');
    expect(lines).toEqual(['{"output":"just under the cap"}', '{"a":2}']);
    expect(JSON.parse(lines[0]!).output).toBe("just under the cap");
  });

  it("caps on UTF-8 bytes, not UTF-16 characters", () => {
    const d = new LineDecoder(10);
    expect(d.push("\u00e9".repeat(5))).toEqual([]); // 5 chars, 10 bytes: at cap
    expect(() => d.push("\u00e9")).toThrow(FrameOverflowError); // +2 bytes over
    // A char-counting decoder would still think it is at 6 "characters".
  });

  it("rejects an oversized line delivered whole in a single chunk", () => {
    const d = new LineDecoder(8);
    // The newline IS present, but the line exceeds the cap: it never gets
    // delivered to JSON.parse either way.
    expect(() => d.push("01234567890123456789\n")).toThrow(FrameOverflowError);
    expect(d.end()).toEqual([]);
  });

  it("keeps a valid frame intact when multi-byte UTF-8 splits mid-codepoint", () => {
    // The realistic pipe reality: raw BYTES split inside a 4-byte codepoint,
    // reassembled by the stream's utf8 StringDecoder before the LineDecoder
    // sees them. The frame and the byte counting must both survive.
    const frame = encodeFrame({ t: "h\u00e9llo \u{1F30D} ok" });
    const raw = Buffer.from(frame + "\n", "utf8");
    const emoji = raw.indexOf(0xf0); // first byte of the 4-byte rocket
    const sd = new StringDecoder("utf8");
    const part1 = sd.write(raw.subarray(0, emoji + 2)); // cut the rocket in half
    const part2 = sd.write(raw.subarray(emoji + 2));
    const d = new LineDecoder();
    expect(d.push(part1)).toEqual([]);
    expect(d.push(part2)).toEqual([frame]);
    expect(JSON.parse(frame).t).toBe("h\u00e9llo \u{1F30D} ok");
  });

  it("cuts slow-drip bytes with no newline at the cap, not at deferred OOM", () => {
    const d = new LineDecoder(32);
    let threwAt = -1;
    for (let i = 0; i < 200 && threwAt < 0; i++) {
      try {
        d.push("a");
      } catch (e) {
        expect(e).toBeInstanceOf(FrameOverflowError);
        threwAt = i + 1;
      }
    }
    expect(threwAt).toBe(33); // first byte strictly above the cap
    // Bounded, not deferred: the buffer was dropped, later floods throw too.
    expect(() => d.push("x".repeat(1_000_000))).toThrow(FrameOverflowError);
    expect(d.end()).toEqual([]);
  });
});

describe("LineDecoder frame cap (real constant)", () => {
  it("honours the exact MAX_FRAME_BYTES boundary: at-cap parses, cap+1 overflows", () => {
    const probe = encodeFrame({ op: "log", level: "info", msg: "" });
    // A full valid frame whose line is exactly MAX_FRAME_BYTES with the
    // newline: delivered and parsed (the cap is shape, not content).
    const huge = encodeFrame({
      op: "log",
      level: "info",
      msg: "y".repeat(MAX_FRAME_BYTES - 1 - probe.length),
    });
    expect(Buffer.byteLength(huge)).toBe(MAX_FRAME_BYTES - 1);
    const d = new LineDecoder();
    const lines = d.push(huge + "\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).op).toBe("log");
    expect(JSON.parse(lines[0]!).msg.length).toBe(MAX_FRAME_BYTES - 1 - probe.length);

    // One more unterminated byte past the constant and the stream is dead.
    const d2 = new LineDecoder();
    expect(() => d2.push("x".repeat(MAX_FRAME_BYTES))).not.toThrow();
    expect(() => d2.push("x")).toThrow(FrameOverflowError);
  });
});

// ── hop 1: runner -> broker (broker-child half, in-process seams) ───────────

describe("runner frame overflow (broker-child half)", () => {
  it("fails the entry, answers pending executor-died, and reaps the runner", async () => {
    startCapture();
    const state: BrokerState = { pool: new Map(), idleReapMs: 0 };
    // A hostile runner: one giant newline-free line forever, and it only
    // ever leaves on stdin EOF -- so a later death proves the broker ended
    // the pipe (the interval outlives the stub's own work otherwise).
    const stub = [
      process.execPath,
      "-e",
      `process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); ` +
        `process.stdout.write("x".repeat(${MAX_FRAME_BYTES} + 64)); ` +
        `setInterval(() => {}, 60000);`,
    ];
    const warm = JSON.stringify({
      op: "warm",
      session: "ovrun",
      class: "rw",
      fence: { id: "f-ovrun", prefix: stub },
    });
    handleFrame(warm, state);
    expect(state.pool.size).toBe(1);
    const pid = state.pool.get("ovrun rw")!.proc.pid!;

    // A call rides the entry, then the overflow lands on its stdout.
    handleFrame(
      JSON.stringify({
        id: "c1",
        op: "invoke",
        session: "ovrun",
        class: "rw",
        fence: { id: "f-ovrun", prefix: stub },
        tool: "bash",
        args: { command: "true" },
        ctx: {
          session: "ovrun",
          workspace: { roots: [tmpdir()], deny: [] },
          toolConfig: {},
        },
      }),
      state,
    );

    // The entry dies with a distinct overflow log...
    const logFrame = await waitForFrame(
      (f) => f.op === "log" && String(f.msg).includes("frame overflow from runner"),
    );
    expect(logFrame.level).toBe("warn");
    // ...pending calls answer with the EXISTING executor-died contract...
    const fail = await waitForFrame((f) => f.id === "c1" && f.ok === false);
    expect(fail.error.kind).toBe("executor-died");
    expect(fail.error.poolKey).toBe("ovrun rw");
    // ...the entry is out of the pool, and the runner is killed (EOF drain
    // with the hard-kill fallback -- the same mechanism every death uses).
    expect(state.pool.size).toBe(0);
    await waitFor(() => !processAlive(pid), "the overflowed runner to die");
    // No oversized line ever reached the supervisor as a relayed frame
    // (the overflow log carries a stack, so the bound is generous).
    expect(captured.every((f) => JSON.stringify(f).length < 100_000)).toBe(true);
  });
});

// ── hop 2: broker -> supervisor (real ToolExecBroker + stub broker child) ───

describe("broker frame overflow (supervisor half)", () => {
  it("maps the oversized frame to broker death: reject, respawn within cap, degrade", async () => {
    const dir = tmpdir();
    const stubPath = join(dir, `overflow-broker-${process.pid}.ts`);
    const pidPath = join(dir, `overflow-broker-${process.pid}.pid`);
    // A broker child that readies, waits for the call to be in flight, then
    // talks forever with no newline.
    writeFileSync(
      stubPath,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\n` +
        `process.stdout.write('{"op":"ready"}\\n');\n` +
        `process.stdin.resume();\n` +
        `setTimeout(() => process.stdout.write("x".repeat(${MAX_FRAME_BYTES} + 64)), 60);\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    const ctx: WireToolCtx = {
      session: "ovsup",
      workspace: { roots: [dir], deny: [] },
      toolConfig: {},
    };
    const broker = new ToolExecBroker({ fence: "off", brokerEntry: stubPath, respawnCap: 1 });
    try {
      // Death #1 with a call in flight: answered with the overflow-as-death
      // message -- the same #handleDeath path a SIGKILLed broker takes.
      await expect(
        broker.invoke({ session: "ovsup", tool: "bash", args: {}, ctx }),
      ).rejects.toThrow(/frame overflow/);
      expect(broker.degraded).toBe(false);
      const pid1 = parseInt(readFileSync(pidPath, "utf8"), 10);
      await waitFor(() => !processAlive(pid1), "the overflowed broker child to be killed");

      // The death consumed the respawn budget on the EXISTING path: one
      // respawn (the stub dies the same way), then degraded, never an
      // inline fallback.
      await expect(
        broker.invoke({ session: "ovsup", tool: "bash", args: {}, ctx }),
      ).rejects.toThrow(/frame overflow/);
      let message = "";
      try {
        await broker.invoke({ session: "ovsup", tool: "bash", args: {}, ctx });
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toContain("[tool-exec degraded]");
      expect(message).toContain("respawn cap");
      expect(message).toContain("NOT falling back to in-process");
      expect(broker.degraded).toBe(true);
      expect(broker.pid).toBeNull();
    } finally {
      await broker.close();
      rmSync(stubPath, { force: true });
      rmSync(pidPath, { force: true });
    }
  });
});

// ── consumer 3: broker -> runner stdin (real runner, overflow surfaces) ─────

describe("runner stdin frame overflow (third consumer)", () => {
  it("logs the overflow and drains instead of swallowing it or growing forever", async () => {
    const proc = spawn(process.execPath, [RUNNER_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: PROJECT_ROOT,
    });
    let out = "";
    proc.stdout!.on("data", (c) => {
      out += String(c);
    });
    proc.stderr!.on("data", () => {});
    proc.stdin!.on("error", () => {});
    proc.stdin!.write("x".repeat(MAX_FRAME_BYTES + 64));

    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => resolve(-999), 8000);
      proc.on("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
      proc.on("error", () => {
        clearTimeout(t);
        resolve(-998);
      });
    });
    // Overflow is surfaced as a protocol error, then the runner drains like
    // an EOF would (exit 0; the broker answers pending with executor-died).
    expect(out).toContain("frame overflow from broker");
    expect(code).toBe(0);
  });
});
