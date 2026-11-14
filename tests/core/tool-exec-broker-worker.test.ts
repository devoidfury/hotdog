// Broker-child unit tests: the worker half runs in a spawned `bun <file>`
// child whose coverage never reports back to the test process, so these
// tests drive tool-exec-broker-main.ts's exported seams in-process instead.
// Real behavior (wire protocol, pooling, cancel, reap) stays covered end-to-end by
// tool-exec-broker-spawn.test.ts and tool-exec-hardening.test.ts; no LLM
// endpoints, and real spawns are only the few short-lived processes needed to
// exercise spawnEntry's stdio plumbing.

import { describe, it, expect, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import {
  handleFrame,
  parseBrokerArgs,
  poolKey,
  relayRunnerLine,
  spawnEntry,
  type BrokerState,
  type PoolEntry,
} from "@core/tool-exec-broker-main.ts";

const TOOL_CONFIG = {
  bashTool: { bashTimeoutMs: 5000, maxToolOutputLines: 100, maxTimeoutMs: 10000 },
  coreTools: { readToolLimit: 500, maxImageSize: 10485760, grepMaxResults: 50, maxToolOutputLines: 600 },
  envScrubbing: true,
  envScrubExtra: [],
};

// ── supervisor-frame capture ─────────────────────────────────────────
// writeSupervisor/relay write NDJSON to process.stdout; intercept it while a
// test runs and restore right after so the reporter keeps its own writes.

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

async function waitForFrame(pred: (f: any) => boolean, ms = 5000): Promise<any> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = captured.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error("timed out waiting for supervisor frame");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeState(overrides: Partial<BrokerState> = {}): BrokerState {
  // Hand-built states start tool-less, like a child awaiting its register.
  return { pool: new Map(), idleReapMs: 0, descriptors: [], ...overrides };
}

/** A pool entry whose "process" is a recorder; no spawn, no stdio. */
function fakeEntry(opts: {
  fenceId?: string;
  pending?: string[];
  endThrows?: boolean;
  writeThrows?: boolean;
  writeErr?: Error;
} = {}) {
  const written: any[] = [];
  const proc = new EventEmitter() as any;
  proc.pid = 4242;
  proc.kill = () => true;
  proc.stdin = {
    write: (frame: string, cb?: (e?: Error) => void) => {
      if (opts.writeThrows) throw new Error("stdin exploded");
      written.push(JSON.parse(frame));
      cb?.(opts.writeErr);
      return true;
    },
    end: () => {
      if (opts.endThrows) throw new Error("already gone");
    },
  };
  const entry: PoolEntry = {
    proc,
    pending: new Set(opts.pending ?? []),
    dead: false,
    idleTimer: null,
    fenceId: opts.fenceId ?? "",
    killTimer: null,
  };
  return { entry, written };
}

function invokeFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "i1",
    op: "invoke",
    session: "unit",
    class: "rw",
    tool: "bash",
    args: { command: "true" },
    ctx: {
      session: "unit",
      workspace: { roots: [tmpdir()], deny: [] },
      toolConfig: TOOL_CONFIG,
    },
    ...overrides,
  });
}

afterEach(stopCapture);

describe("parseBrokerArgs", () => {
  it("defaults, overrides, and ignores unknown flags", () => {
    expect(parseBrokerArgs([]).idleReapMs).toBe(5 * 60_000);
    expect(parseBrokerArgs(["--idle-reap-ms=250"]).idleReapMs).toBe(250);
    expect(parseBrokerArgs(["--nope", "--idle-reap-ms=abc", "--idle-reap-ms=7"]).idleReapMs).toBe(7);
  });
});

describe("poolKey", () => {
  it("joins session and class with one space (the reap parser splits on the last one)", () => {
    expect(poolKey("sess 1", "rw")).toBe("sess 1 rw");
  });
});

describe("handleFrame malformed input", () => {
  it("answers with an error log frame and keeps going", () => {
    startCapture();
    const state = makeState();
    handleFrame("{not json", state);
    const f = captured.find((f) => f.op === "log");
    expect(f.level).toBe("error");
    expect(f.msg).toContain("malformed frame from supervisor dropped");
    expect(state.pool.size).toBe(0);
  });
});

describe("cancel routing (fake entry)", () => {
  it("forwards the cancel to the entry holding the id", () => {
    startCapture();
    const state = makeState();
    const { entry, written } = fakeEntry({ pending: ["c1"] });
    state.pool.set(poolKey("s", "rw"), entry);
    handleFrame(JSON.stringify({ id: "c1", op: "cancel" }), state);
    expect(written).toEqual([{ id: "c1", op: "cancel" }]);
  });

  it("an unknown id is a silent no-op", () => {
    startCapture();
    const state = makeState();
    handleFrame(JSON.stringify({ id: "ghost", op: "cancel" }), state);
    expect(captured.length).toBe(0);
  });

  it("a failed cancel write degrades to a warn log frame", () => {
    startCapture();
    const state = makeState();
    const { entry } = fakeEntry({ pending: ["c2"], writeThrows: true });
    state.pool.set(poolKey("s", "rw"), entry);
    handleFrame(JSON.stringify({ id: "c2", op: "cancel" }), state);
    const f = captured.find((f) => f.op === "log");
    expect(f.level).toBe("warn");
    expect(f.msg).toContain("cancel frame write failed for c2");
  });
});

describe("reap frames (fake entries)", () => {
  it("a session-scoped reap drops that session's runner and leaves another session's untouched", () => {
    startCapture();
    const state = makeState();
    const doomed = fakeEntry({ pending: ["d1"] });
    const other = fakeEntry({ pending: ["o1"] });
    state.pool.set(poolKey("dead-session", "rw"), doomed.entry);
    state.pool.set(poolKey("other-session", "rw"), other.entry);
    handleFrame(JSON.stringify({ op: "reap", session: "dead-session" }), state);
    expect(doomed.entry.dead).toBe(true);
    expect(state.pool.has(poolKey("dead-session", "rw"))).toBe(false);
    expect(other.entry.dead).toBe(false);
    expect(state.pool.has(poolKey("other-session", "rw"))).toBe(true);
  });

  it("drops matching entries, fails their pending calls as executor-died, keeps the rest", () => {
    startCapture();
    const state = makeState();
    const doomed = fakeEntry({ pending: ["p1"] });
    const keeper = fakeEntry({ pending: ["keep"] });
    const net = fakeEntry({ pending: ["netcall"] });
    state.pool.set(poolKey("gone", "rw"), doomed.entry);
    state.pool.set(poolKey("alive", "rw"), keeper.entry);
    state.pool.set(poolKey("gone", "net"), net.entry);
    handleFrame(JSON.stringify({ op: "reap", session: "gone", class: "rw" }), state);
    expect(doomed.entry.dead).toBe(true);
    expect(state.pool.has(poolKey("gone", "rw"))).toBe(false);
    expect(keeper.entry.dead).toBe(false);
    expect(net.entry.dead).toBe(false);
    const fail = captured.find((f) => f.ok === false);
    expect(fail.id).toBe("p1");
    expect(fail.error).toEqual({ kind: "executor-died", poolKey: "gone rw" });
  });

  it("an already-gone stdin does not derail the reap", () => {
    startCapture();
    const state = makeState();
    const { entry } = fakeEntry({ pending: ["p9"], endThrows: true });
    state.pool.set(poolKey("s", "rw"), entry);
    handleFrame(JSON.stringify({ op: "reap" }), state);
    expect(entry.dead).toBe(true);
    expect(state.pool.size).toBe(0);
  });
});

describe("warm frames (fake entry reuse)", () => {
  it("a warm that matches the live entry's fence reuses it (no spawn, no frames)", () => {
    startCapture();
    const state = makeState();
    const { entry } = fakeEntry();
    state.pool.set(poolKey("s", "rw"), entry);
    handleFrame(JSON.stringify({ op: "warm", session: "s", class: "rw" }), state);
    expect(entry.dead).toBe(false);
    expect(state.pool.size).toBe(1);
    expect(captured.length).toBe(0);
  });

  it("a warm with no idle window never arms the reaper", () => {
    const state = makeState({ idleReapMs: 0 });
    const { entry } = fakeEntry();
    state.pool.set(poolKey("s", "rw"), entry);
    handleFrame(JSON.stringify({ op: "warm", session: "s", class: "rw" }), state);
    expect(entry.idleTimer).toBeNull();
  });

  it("a busy entry is never idle; once drained the reaper arms and drops it", async () => {
    startCapture();
    const state = makeState({ idleReapMs: 30 });
    const { entry } = fakeEntry({ pending: ["busy"] });
    state.pool.set(poolKey("s", "rw"), entry);
    handleFrame(JSON.stringify({ op: "warm", session: "s", class: "rw" }), state);
    expect(entry.idleTimer).toBeNull(); // pending.size > 0
    entry.pending.delete("busy");
    handleFrame(JSON.stringify({ op: "warm", session: "s", class: "rw" }), state);
    expect(entry.idleTimer).not.toBeNull();
    await new Promise((r) => setTimeout(r, 90));
    expect(entry.dead).toBe(true);
    expect(state.pool.size).toBe(0);
  });
});

describe("fence-plan swap (real short-lived entry)", () => {
  it("a warmed plain entry is replaced by the fenced invoke; the in-flight call answers replaced", async () => {
    startCapture();
    try {
      const state = makeState();
      const { entry: plain } = fakeEntry({ pending: ["inflight"] });
      state.pool.set(poolKey("swap", "rw"), plain);
      const runner = [process.execPath, "-e", "process.stdin.resume()"];
      handleFrame(
        JSON.stringify({
          op: "warm",
          session: "swap",
          class: "rw",
          fence: { id: "f-new", prefix: runner },
        }),
        state,
      );
      // Old entry: dead, its pending call gets the replaced shape.
      expect(plain.dead).toBe(true);
      const fail = captured.find((f) => f.ok === false);
      expect(fail.error).toEqual({ kind: "executor-replaced", poolKey: "swap rw" });
      // New entry: really spawned through the fence argv.
      const next = state.pool.get(poolKey("swap", "rw"))!;
      expect(next).not.toBe(plain);
      expect(next.fenceId).toBe("f-new");
      expect(next.proc.pid).toBeNumber();
      // Tear it down: EOF lets the stand-in runner exit.
      next.proc.stdin!.end();
      await waitForFrame((f) => f.op === "log" && f.msg.includes("executor exited"));
    } finally {
      stopCapture();
    }
  });
});

describe("invoke routing (fake entry)", () => {
  it("routes to the pooled entry with the fence stripped from the runner frame", () => {
    startCapture();
    const state = makeState();
    const { entry, written } = fakeEntry({ fenceId: "f" });
    state.pool.set(poolKey("unit", "rw"), entry);
    handleFrame(invokeFrame({ fence: { id: "f", prefix: ["x"] } }), state);
    expect(written.length).toBe(1);
    expect(written[0].op).toBe("invoke");
    expect(written[0].id).toBe("i1");
    expect("fence" in written[0]).toBe(false); // the runner never sees its jail plan
    expect(entry.pending.has("i1")).toBe(true);
    expect(captured.length).toBe(0); // write callback succeeded silently
  });

  it("a failed runner write fails the call, never downgrades", () => {
    startCapture();
    const state = makeState();
    const { entry } = fakeEntry({ writeErr: new Error("EPIPE") });
    state.pool.set(poolKey("unit", "rw"), entry);
    handleFrame(invokeFrame(), state);
    const fail = captured.find((f) => f.ok === false);
    expect(fail.id).toBe("i1");
    expect(fail.error.message).toContain("runner write failed: EPIPE");
    expect(entry.pending.has("i1")).toBe(false);
  });

  it("a clear-on-write entry also clears the idle timer", () => {
    const state = makeState();
    const { entry } = fakeEntry();
    entry.idleTimer = setTimeout(() => {}, 10_000);
    state.pool.set(poolKey("unit", "rw"), entry);
    handleFrame(invokeFrame(), state);
    expect(entry.idleTimer).toBeNull();
  });
});

describe("spawn failure paths", () => {
  it("an invoke whose spawn throws synchronously answers the caller, not a hang", () => {
    startCapture();
    const state = makeState();
    handleFrame(invokeFrame({ fence: { id: "bad", prefix: [42 as unknown as string] } }), state);
    const fail = captured.find((f) => f.ok === false);
    expect(fail.id).toBe("i1");
    expect(fail.error.message).toContain("executor spawn failed");
    expect(state.pool.size).toBe(0);
  });

  it("a warm whose spawn throws only logs (there is no caller to answer)", () => {
    startCapture();
    const state = makeState();
    handleFrame(
      JSON.stringify({
        op: "warm",
        session: "s",
        class: "rw",
        fence: { id: "bad", prefix: [null as unknown as string] },
      }),
      state,
    );
    const f = captured.find((f) => f.op === "log");
    expect(f.level).toBe("error");
    expect(f.msg).toContain("executor spawn failed");
  });

  it("a spawned-but-ENOENT entry relays the death and disappears from the pool", async () => {
    startCapture();
    try {
      const state = makeState();
      handleFrame(
        JSON.stringify({
          op: "warm",
          session: "gone",
          class: "rw",
          fence: { id: "e1", prefix: ["no-such-binary-xyz-42", "--", "bun", "runner"] },
        }),
        state,
      );
      const entry = state.pool.get("gone rw");
      expect(entry).toBeDefined(); // spawn returns, the ENOENT arrives async
      const f = await waitForFrame(
        (f) => f.op === "log" && f.msg.includes("executor spawn failed"),
      );
      expect(f.level).toBe("warn");
      expect(state.pool.size).toBe(0);
    } finally {
      stopCapture();
    }
  });
});

describe("relayRunnerLine", () => {
  it("drops malformed runner lines with an error log frame", () => {
    startCapture();
    const state = makeState();
    const { entry } = fakeEntry();
    relayRunnerLine("s rw", entry, "}{garbage", state);
    const f = captured.find((f) => f.op === "log");
    expect(f.level).toBe("error");
    expect(f.msg).toContain("malformed frame dropped");
  });

  it("forwards an ok reply verbatim and re-arms the idle clock", () => {
    startCapture();
    const state = makeState();
    const { entry } = fakeEntry({ pending: ["r1", "r2"] });
    const line = JSON.stringify({ id: "r1", ok: true, result: { kind: "tool-result" } });
    relayRunnerLine("s rw", entry, line, state);
    expect(captured.some((f) => f.id === "r1" && f.ok === true)).toBe(true);
    expect(entry.pending.has("r1")).toBe(false);
    expect(entry.pending.has("r2")).toBe(true);
    expect(entry.idleTimer).toBeNull(); // still busy: armIdle declines
  });

  it("relays runner log frames with the pool key attributed", () => {
    startCapture();
    const state = makeState();
    const { entry } = fakeEntry();
    relayRunnerLine("s rw", entry, JSON.stringify({ op: "log", level: "warn", msg: "hi" }), state);
    const f = captured.find((f) => f.op === "log");
    expect(f.msg).toBe("runner[s rw]: hi");
  });

  it("drops a reply whose id the entry never owned (cross-entry spoof guard)", () => {
    startCapture();
    const state = makeState();
    const { entry: runnerA } = fakeEntry({ pending: ["mine"] });
    const { entry: runnerB } = fakeEntry({ pending: ["theirs"] });
    state.pool.set(poolKey("b", "rw"), runnerB);
    // Runner A "replies" for runner B's pending id: nothing goes to stdout,
    // B's pending set is untouched, and A keeps its own call.
    relayRunnerLine("a rw", runnerA, JSON.stringify({ id: "theirs", ok: true, result: "forged" }), state);
    expect(captured.length).toBe(0);
    expect(runnerA.pending.has("theirs")).toBe(false);
    expect(runnerB.pending.has("theirs")).toBe(true);
    // A reply for an id nobody holds pending (already answered, guessed uuid)
    // is dropped the same way.
    relayRunnerLine("a rw", runnerA, JSON.stringify({ id: "ghost", ok: true }), state);
    expect(captured.length).toBe(0);
    // A real reply for the legitimately-pending id still relays verbatim.
    const line = JSON.stringify({ id: "mine", ok: true, result: { kind: "tool-result" } });
    relayRunnerLine("a rw", runnerA, line, state);
    expect(captured.some((f) => f.id === "mine" && f.ok === true)).toBe(true);
    expect(runnerA.pending.has("mine")).toBe(false);
    expect(runnerB.pending.has("theirs")).toBe(true);
  });

  it("a post-cancel reply still relays: routeCancel leaves the id pending", () => {
    startCapture();
    const state = makeState();
    const { entry, written } = fakeEntry({ pending: ["c1"] });
    state.pool.set(poolKey("c", "rw"), entry);
    handleFrame(JSON.stringify({ id: "c1", op: "cancel" }), state);
    expect(written).toEqual([{ id: "c1", op: "cancel" }]);
    expect(entry.pending.has("c1")).toBe(true); // cancel does not clear pending
    relayRunnerLine("c rw", entry, JSON.stringify({ id: "c1", ok: false, error: { message: "cancelled", expected: true } }), state);
    expect(captured.some((f) => f.id === "c1" && f.ok === false)).toBe(true);
    expect(entry.pending.has("c1")).toBe(false);
  });
});

describe("spawnEntry stdio plumbing (real short-lived processes)", () => {
  it("a plain entry relays runner replies and its death after EOF", async () => {
    startCapture();
    try {
      const state = makeState();
      const entry = spawnEntry("plain rw", state);
      expect(entry.fenceId).toBe("");
      // The runner answers malformed input with a log frame: this exercises
      // the entry's stdout data callback into relayRunnerLine for real.
      entry.proc.stdin!.write("not-a-frame\n");
      await waitForFrame((f) => f.op === "log" && f.msg.includes("malformed frame dropped"));
      // EOF drains the runner; its exit must surface as a warn and evict it.
      entry.proc.stdin!.end();
      const exitFrame = await waitForFrame((f) => f.op === "log" && f.msg.includes("executor exited"));
      expect(exitFrame.level).toBe("warn");
      expect(state.pool.size).toBe(0);
    } finally {
      stopCapture();
    }
  });

  it("a reaped entry logs its graceful exit at debug, not warn", async () => {
    startCapture();
    try {
      const state = makeState();
      handleFrame(JSON.stringify({ op: "warm", session: "s", class: "rw" }), state);
      expect(state.pool.size).toBe(1);
      // A reap frame is the idle-reaper's path: dropEntry ends stdin, the
      // runner drains and exits 0. The exit handler sees dead === true and
      // must demote the frame to debug -- a clean reap is lifecycle, not a
      // crash, and warn-level noise drowns real failures.
      handleFrame(JSON.stringify({ op: "reap", session: "s", class: "rw" }), state);
      const reapFrame = await waitForFrame((f) => f.op === "log" && f.msg.includes("executor reaped"));
      expect(reapFrame.level).toBe("debug");
      expect(state.pool.size).toBe(0);
    } finally {
      stopCapture();
    }
  });

  it("runner stderr rides up as an attributed warn", async () => {
    startCapture();
    try {
      const state = makeState();
      const entry = spawnEntry("noisy rw", state, {
        id: "f-noisy",
        prefix: [
          "env",
          "FENCED=1",
          process.execPath,
          "-e",
          "console.error('unit-oops'); process.stdin.resume()",
        ],
      });
      expect(entry.fenceId).toBe("f-noisy");
      await waitForFrame((f) => f.op === "log" && f.msg.includes("unit-oops"));
      entry.proc.stdin!.end();
      await waitForFrame((f) => f.op === "log" && f.msg.includes("executor exited"));
    } finally {
      stopCapture();
    }
  });
});

// ── register frames ──────────────────────────────────────────────────────────
//
// Storage (verbatim; a later register REPLACES) pins through the in-process
// handleFrame seam; ordering pins by real spawn: register as the broker
// child's first line, and a child-side invoke landing behind the replayed
// register on one runner stdin.

import { ToolExecBroker } from "@core/tool-exec-broker.ts";
import { PROJECT_ROOT } from "@core/tool-exec-layout.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WIRES = [
  { tool: "bash", module: pathToFileURL(join(PROJECT_ROOT, "src/extensions/bash-tool/index.ts")).href, factory: "WIRE_TOOL_FACTORIES" },
];

describe("register frames (child storage)", () => {
  it("stores the list verbatim, replaces on the next register, garbage degrades to empty", () => {
    const state = makeState();
    handleFrame(JSON.stringify({ op: "register", tools: WIRES }), state);
    expect(state.descriptors).toEqual(WIRES);

    const second = [{ tool: "read", module: "file:///x/read.ts", factory: "WIRE_TOOL_FACTORIES" }];
    handleFrame(JSON.stringify({ op: "register", tools: second }), state);
    expect(state.descriptors).toEqual(second); // complete-set semantics: REPLACES

    handleFrame(JSON.stringify({ op: "register", tools: "not-an-array" }), state);
    expect(state.descriptors).toEqual([]); // never a guess

    // Unknown ops never mutate the stored set.
    handleFrame(JSON.stringify({ op: "reap", session: "x" }), state);
    expect(state.descriptors).toEqual([]);
  });
});

describe("register frames (real spawn ordering)", () => {
  it("the supervisor stub ships register as the broker child's FIRST frame", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hotdog-regfirst-"));
    const firstLine = join(dir, "first.txt");
    const stub = join(dir, "stub-broker.ts");
    writeFileSync(
      stub,
      `import { writeFileSync } from "node:fs";\n` +
        `process.stdin.setEncoding("utf8");\n` +
        `let buf = "";\n` +
        `process.stdin.on("data", (c) => {\n` +
        `  buf += c;\n` +
        `  const i = buf.indexOf("\\n");\n` +
        `  if (i >= 0) { writeFileSync(${JSON.stringify(firstLine)}, buf.slice(0, i)); process.exit(0); }\n` +
        `});\n`,
    );
    const broker = new ToolExecBroker({
      fence: "off",
      brokerEntry: stub,
      respawnCap: 0,
      toolDescriptors: WIRES,
    });
    try {
      broker.warm("regfirst", "rw"); // fire-and-forget: startup alone ships the register
      const deadline = Date.now() + 5000;
      let line = "";
      while (Date.now() < deadline) {
        try {
          line = readFileSync(firstLine, "utf8");
          if (line) break;
        } catch {
          // stub has not written yet
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      const frame = JSON.parse(line);
      expect(frame.op).toBe("register");
      expect(frame.tools).toEqual(WIRES);
    } finally {
      await broker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("spawnEntry replays register before any invoke reaches the runner", async () => {
    // spawnEntry writes register first, the invoke follows on the same
    // stdin: a tool result (not the unknown-tool fail) proves the order.
    startCapture();
    const state = makeState({ descriptors: WIRES });
    try {
      handleFrame(invokeFrame(), state); // session "unit", tool "bash", args {command:"true"}
      const frame = await waitForFrame((f) => "ok" in f && f.id === "i1", 15_000);
      expect(frame.ok).toBe(true);
    } finally {
      stopCapture();
      for (const entry of state.pool.values()) {
        try {
          entry.proc.stdin?.end();
          entry.proc.kill();
        } catch {
          // already gone
        }
      }
    }
  }, 20_000);
});
