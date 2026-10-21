// Increment-2 hardening against REAL spawns: cancel frames,
// crash classification, broker respawn cap + degraded flag, idle reap, warm.
//
// Process discovery goes through the broker's OWN pid (`broker.pid`) and its
// child list, never a global pgrep pattern: `bun test` runs test files
// concurrently, and another file's broker would otherwise be killed here.
// Pool entries are direct children of the broker; the shell a bash call spawns
// is a grandchild, so it never shows up in the entry count.
//
// Budget discipline: one broker per describe, closed in afterAll; slow commands
// are short sleeps that a cancel or a kill preempts. No fleet, no LLM endpoints.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";
import { ToolExecBroker } from "@core/tool-exec-broker.ts";
import type { WireFence, WireToolCtx, WireToolResult } from "@core/tool-exec-protocol.ts";
import { tmpDir, cleanupDir, processAlive, waitForExit } from "../helpers.ts";

const TOOL_CONFIG = {
  bashTool: { bashTimeoutMs: 20000, maxToolOutputLines: 100, maxTimeoutMs: 20000 },
  coreTools: { readToolLimit: 500, grepMaxResults: 50, maxToolOutputLines: 600 },
  envScrubbing: true,
  envScrubExtra: [],
};

let dir: string;

beforeAll(() => {
  dir = tmpDir("hotdog-txexec-harden-");
});

afterAll(() => {
  cleanupDir(dir);
});

function ctx(session: string): WireToolCtx {
  return {
    session,
    workspace: { roots: [dir], deny: [".env*"] },
    toolConfig: TOOL_CONFIG,
  };
}

/** Pool entries (the broker's direct children). Empty when it has no child. */
function entries(broker: ToolExecBroker): number[] {
  const pid = broker.pid;
  if (pid === null) return [];
  const r = Bun.spawnSync(["pgrep", "-P", String(pid)]);
  const out = r.stdout.toString().trim();
  return out ? out.split("\n").map(Number) : [];
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function settle(fn: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function text(result: WireToolResult): string {
  return result.kind === "tool-result" ? result.output : String(result.value);
}

/** First whitespace-separated token of a result, as a pid. */
function pidOf(result: WireToolResult): number {
  return parseInt(text(result).trim().split(/\s+/)[0] ?? "", 10);
}

/**
 * A bash call that touches `marker` the moment its shell runs, returning the
 * unsettled promise. Waiting on the marker (not on a pool entry) proves the
 * frame reached the runner, so a broker killed afterwards fails the call as a
 * death rather than as a pipe write that never landed.
 */
function startSignalled(
  broker: ToolExecBroker,
  session: string,
  marker: string,
  command = "sleep 2",
): Promise<WireToolResult> {
  return broker.invoke({
    session,
    tool: "bash",
    args: { command: `echo > ${marker}; ${command}` },
    ctx: ctx(session),
  });
}

async function waitSignalled(marker: string): Promise<void> {
  await settle(() => fs.existsSync(marker), "the call to reach the runner", 5000);
  fs.rmSync(marker, { force: true });
}

/** The one pool entry of a broker known to hold exactly one. */
function onlyEntry(broker: ToolExecBroker): number {
  const pids = entries(broker);
  expect(pids.length).toBe(1);
  return pids[0]!;
}

// ── Cancel frames ───────────────────────────────────────────────────────────

describe("cancel frame (real spawn)", () => {
  let broker: ToolExecBroker;

  beforeAll(() => {
    broker = new ToolExecBroker({ fence: "off" });
  });

  afterAll(async () => {
    await broker.close();
  });

  it("kills the tool's process group and settles the call promptly", async () => {
    const pidFile = join(dir, "cancel.pid");
    const running = broker.invoke({
      id: "cancel-me",
      session: "harden-cancel",
      tool: "bash",
      args: { command: `echo $$ > ${pidFile}; sleep 30` },
      ctx: ctx("harden-cancel"),
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile)) {
      if (Date.now() > deadline) throw new Error("the runner never started the shell");
      await sleep(10);
    }
    const shellPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    expect(processAlive(shellPid)).toBe(true);

    const t0 = Date.now();
    broker.cancel("cancel-me");
    await expect(running).rejects.toThrow(/[Cc]ancelled/);
    // Nowhere near the 20s bash timeout or the 30s sleep.
    expect(Date.now() - t0).toBeLessThan(2000);
    await waitForExit(shellPid, 5000);
    expect(processAlive(shellPid)).toBe(false);
  });

  it("the pool entry survives a cancel and serves the next call", async () => {
    const before = onlyEntry(broker);
    const result = await broker.invoke({
      session: "harden-cancel",
      tool: "bash",
      args: { command: "echo $PPID still-alive" },
      ctx: ctx("harden-cancel"),
    });
    expect(text(result)).toContain("still-alive");
    // Same entry, not a replacement: a cancel is not an entry failure.
    expect(pidOf(result)).toBe(before);
  });

  it("cancelling an unknown id is a no-op, not a crash", async () => {
    broker.cancel("never-dispatched");
    const result = await broker.invoke({
      session: "harden-cancel",
      tool: "bash",
      args: { command: "echo fine" },
      ctx: ctx("harden-cancel"),
    });
    expect(text(result)).toContain("fine");
  });
});

// ── Crash classification ────────────────────────────────────────────────────

describe("pool entry crash (real spawn)", () => {
  let broker: ToolExecBroker;

  beforeAll(() => {
    broker = new ToolExecBroker({ fence: "off" });
  });

  afterAll(async () => {
    await broker.close();
  });

  it("kill -9 on a runner fails its call as [tool-exec crashed] and the pool refills", async () => {
    const running = broker.invoke({
      session: "harden-crash",
      tool: "bash",
      args: { command: "sleep 5" },
      ctx: ctx("harden-crash"),
    });
    await settle(() => entries(broker).length === 1, "the pool entry to spawn");
    const runnerPid = onlyEntry(broker);

    process.kill(runnerPid, "SIGKILL");
    await expect(running).rejects.toThrow(/\[tool-exec crashed\]/);
    await settle(() => !processAlive(runnerPid), "the killed runner to die");

    // Lazy re-fill: the next call spawns a different entry and works.
    const next = await broker.invoke({
      session: "harden-crash",
      tool: "bash",
      args: { command: "echo $PPID" },
      ctx: ctx("harden-crash"),
    });
    expect(next.kind).toBe("tool-result");
    expect(pidOf(next)).toBeGreaterThan(0);
    expect(pidOf(next)).not.toBe(runnerPid);
  });
});

// ── Broker death: respawn cap + degraded flag ───────────────────────────────

describe("broker death and respawn cap (real spawn)", () => {
  it("errors in-flight calls, respawns within the cap, then degrades without respawning", async () => {
    const broker = new ToolExecBroker({ fence: "off", respawnCap: 1 });
    try {
      // Death #1 with a call in flight: the caller learns, and nothing
      // completed, so the budget stays spent.
      const marker = join(dir, "cap-a.marker");
      const first = startSignalled(broker, "harden-cap", marker);
      await waitSignalled(marker);
      const pid1 = broker.pid!;
      process.kill(pid1, "SIGKILL");
      await expect(first).rejects.toThrow(/broker worker exited/);

      // Respawn #1 (cap 1): allowed, and the next call rides the new child.
      const second = startSignalled(broker, "harden-cap", marker);
      await waitSignalled(marker);
      const pid2 = broker.pid!;
      expect(pid2).not.toBe(pid1);
      process.kill(pid2, "SIGKILL");
      await expect(second).rejects.toThrow(/broker worker exited/);
      expect(broker.degraded).toBe(false);

      // Budget spent: loud rejection, no third child, no inline fallback.
      let message = "";
      try {
        await broker.invoke({
          session: "harden-cap",
          tool: "bash",
          args: { command: "echo three" },
          ctx: ctx("harden-cap"),
        });
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toContain("[tool-exec degraded]");
      expect(message).toContain("respawn cap");
      expect(message).toContain("NOT falling back to in-process");
      expect(broker.degraded).toBe(true);
      expect(broker.pid).toBeNull();

      // Degraded is sticky: another call still refuses, still without a child.
      await expect(
        broker.invoke({ session: "harden-cap", tool: "bash", args: { command: "echo four" }, ctx: ctx("harden-cap") }),
      ).rejects.toThrow(/tool-exec degraded/);
      expect(broker.pid).toBeNull();
    } finally {
      await broker.close();
    }
  });

  it("a completed call refreshes the budget (a flapping host is not a crash loop)", async () => {
    const broker = new ToolExecBroker({ fence: "off", respawnCap: 1 });
    try {
      const marker = join(dir, "reset-a.marker");
      const first = startSignalled(broker, "harden-reset", marker);
      await waitSignalled(marker);
      const pid1 = broker.pid!;
      process.kill(pid1, "SIGKILL");
      await expect(first).rejects.toThrow(/broker worker exited/);

      // Respawn #1, and let a call COMPLETE: that is the reset signal.
      const second = await broker.invoke({
        session: "harden-reset",
        tool: "bash",
        args: { command: "echo alive" },
        ctx: ctx("harden-reset"),
      });
      expect(text(second)).toContain("alive");
      const pid2 = broker.pid!;
      expect(pid2).not.toBe(pid1);

      // Death #2 with a call in flight: the budget is back to zero, so this
      // death alone must not exhaust a cap of 1.
      const third = startSignalled(broker, "harden-reset", marker);
      await waitSignalled(marker);
      process.kill(pid2, "SIGKILL");
      await expect(third).rejects.toThrow(/broker worker exited/);

      // Still respawnable, because the previous generation served a call.
      const fourth = await broker.invoke({
        session: "harden-reset",
        tool: "bash",
        args: { command: "echo $PPID again" },
        ctx: ctx("harden-reset"),
      });
      expect(text(fourth)).toContain("again");
      expect(broker.degraded).toBe(false);
      expect(broker.pid).not.toBe(pid2);
    } finally {
      await broker.close();
    }
  });
});

// ── Idle reap ───────────────────────────────────────────────────────────────

describe("idle reap (real spawn)", () => {
  it("drops an idle entry and refills it on the next call", async () => {
    const broker = new ToolExecBroker({ fence: "off", idleReapMs: 250 });
    try {
      const first = await broker.invoke({
        session: "harden-reap",
        tool: "bash",
        args: { command: "echo $PPID" },
        ctx: ctx("harden-reap"),
      });
      const runnerPid = pidOf(first);
      expect(processAlive(runnerPid)).toBe(true);

      // The idle clock starts when the entry goes quiet, so the entry dies on
      // its own while nobody is calling it.
      await settle(() => !processAlive(runnerPid), "the idle reaper to drop the entry");
      await settle(() => entries(broker).length === 0, "the pool map to empty");

      const next = await broker.invoke({
        session: "harden-reap",
        tool: "bash",
        args: { command: "echo $PPID" },
        ctx: ctx("harden-reap"),
      });
      expect(pidOf(next)).not.toBe(runnerPid);
      expect(processAlive(pidOf(next))).toBe(true);
    } finally {
      await broker.close();
    }
  });

  it("a call in flight is never reaped mid-flight", async () => {
    // The idle window is shorter than the command: arming happens on quiet,
    // so a busy entry survives the whole sleep and answers normally.
    const broker = new ToolExecBroker({ fence: "off", idleReapMs: 200 });
    try {
      const result = await broker.invoke({
        session: "harden-reap-busy",
        tool: "bash",
        args: { command: "sleep 0.5 && echo survived" },
        ctx: ctx("harden-reap-busy"),
      });
      expect(text(result)).toContain("survived");
    } finally {
      await broker.close();
    }
  });
});

// ── Warm ────────────────────────────────────────────────────────────────────

describe("warm and reap frames (real spawn)", () => {
  it("warm pre-spawns the entry (idempotent) and reap drops it", async () => {
    const broker = new ToolExecBroker({ fence: "off" });
    try {
      // A broker object is not a process: nothing spawns until asked.
      expect(broker.pid).toBeNull();
      expect(entries(broker)).toHaveLength(0);

      broker.warm("harden-warm", "rw");
      await settle(() => entries(broker).length === 1, "the warm spawn");
      const entryPid = onlyEntry(broker);

      broker.warm("harden-warm", "rw");
      await sleep(150);
      expect(entries(broker)).toHaveLength(1); // idempotent: one entry per key

      broker.reap("harden-warm");
      await settle(() => entries(broker).length === 0, "the reap to drop the entry");
      await settle(() => !processAlive(entryPid), "the reaped runner to exit");
    } finally {
      await broker.close();
    }
  });

  it("a warmed entry is the one the next call uses", async () => {
    const broker = new ToolExecBroker({ fence: "off" });
    try {
      broker.warm("harden-warm2", "rw");
      await settle(() => entries(broker).length === 1, "the warm spawn");
      const entryPid = onlyEntry(broker);

      const result = await broker.invoke({
        session: "harden-warm2",
        tool: "bash",
        args: { command: "echo $PPID" },
        ctx: ctx("harden-warm2"),
      });
      // The warmed entry served the call, so no second spawn happened.
      expect(pidOf(result)).toBe(entryPid);
      expect(entries(broker)).toHaveLength(1);
    } finally {
      await broker.close();
    }
  });

  it("reap of a session leaves other sessions' entries alone", async () => {
    const broker = new ToolExecBroker({ fence: "off" });
    try {
      const a = await broker.invoke({
        session: "harden-keep",
        tool: "bash",
        args: { command: "echo $PPID" },
        ctx: ctx("harden-keep"),
      });
      const b = await broker.invoke({
        session: "harden-drop",
        tool: "bash",
        args: { command: "echo $PPID" },
        ctx: ctx("harden-drop"),
      });
      expect(entries(broker)).toHaveLength(2);

      broker.reap("harden-drop");
      await settle(() => entries(broker).length === 1, "only the named session to drop");
      expect(processAlive(pidOf(b))).toBe(false);
      expect(processAlive(pidOf(a))).toBe(true);
    } finally {
      await broker.close();
    }
  });
});

// ── Fence argv (increment 3) ────────────────────────────────────────────────
//
// The fence is a complete spawn command computed supervisor-side; the broker
// prepends it verbatim. A real bwrap cannot be required on every test host,
// so the plumbing is tested through the `fencePlan` seam with `env` as a
// stand-in jail (a var the runner can print proves the wrapping is real),
// and the argv shape is pinned in tests/utils/exec-plan.test.ts. The broker
// child treats the seam fence and a bwrap fence identically -- that is the
// "isolation is argv" contract under test.

const RUNNER_ENTRY = join(import.meta.dir, "../../src/workers/tool-exec.ts");

function envFence(id: string): WireFence {
  return { id, prefix: ["env", "FAKE_FENCE_MARK=1", process.execPath, RUNNER_ENTRY] };
}

describe("fence argv (seam fence, real spawn)", () => {
  let nextFence: WireFence | null = envFence("f1");
  let broker: ToolExecBroker;

  beforeAll(() => {
    broker = new ToolExecBroker({ fencePlan: () => nextFence });
  });

  afterAll(async () => {
    await broker.close();
  });

  it("spawns the entry through the fence prefix (the runner runs wrapped)", async () => {
    const result = await broker.invoke({
      session: "harden-fence",
      tool: "bash",
      args: { command: "echo fence=$FAKE_FENCE_MARK" },
      ctx: ctx("harden-fence"),
    });
    expect(text(result)).toContain("fence=1");
  });

  it("the same fence id reuses the entry (per-entry wrapping, per-call dispatch)", async () => {
    const before = onlyEntry(broker);
    const result = await broker.invoke({
      session: "harden-fence",
      tool: "bash",
      args: { command: "echo $PPID again" },
      ctx: ctx("harden-fence"),
    });
    expect(text(result)).toContain("again");
    expect(pidOf(result)).toBe(before);
  });

  it("a changed fence id replaces the entry", async () => {
    const oldPid = onlyEntry(broker);
    nextFence = envFence("f2");
    const result = await broker.invoke({
      session: "harden-fence",
      tool: "bash",
      args: { command: "echo rewalled" },
      ctx: ctx("harden-fence"),
    });
    expect(text(result)).toContain("rewalled");
    const newPid = pidOf(result);
    expect(newPid).not.toBe(oldPid);
    await settle(() => !processAlive(oldPid), "the fence-changed entry to die");
  });

  it("a call in flight when the fence changes fails as replaced, not crashed", async () => {
    // The swap is a deliberate policy change, not a death: the pending call
    // must read "[tool-exec replaced]" (with the reason), never the crash
    // wording the model would otherwise act on.
    const marker = join(dir, `replaced-marker-${process.pid}-${Date.now()}`);
    const dying = startSignalled(broker, "harden-fence", marker, "sleep 3");
    const dyingSettled = dying.then(
      () => null,
      (e: Error) => e,
    ); // attached now: no unhandled rejection while the fresh call runs
    await waitSignalled(marker);
    nextFence = envFence("f3");
    const fresh = await broker.invoke({
      session: "harden-fence",
      tool: "bash",
      args: { command: "echo fresh-wall" },
      ctx: ctx("harden-fence"),
    });
    expect(text(fresh)).toContain("fresh-wall");
    const err = await dyingSettled;
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("[tool-exec replaced]");
    expect(err!.message).toContain("changed fence plan");
    expect(err!.message).not.toContain("crashed");
  });

  it("a warm that could not plan a fence is corrected by the first invoke", async () => {
    // Warm without a workspace spawns unfenced (there are no roots to plan
    // against); the fenced invoke for the same key must not reuse it.
    const plain = new ToolExecBroker({ fencePlan: () => envFence("warmfix") });
    try {
      plain.warm("harden-warmfix", "rw"); // no workspace -> no fence frame
      await settle(() => entries(plain).length === 1, "the warm spawn");
      const warmPid = onlyEntry(plain);
      const result = await plain.invoke({
        session: "harden-warmfix",
        tool: "bash",
        args: { command: "echo $FAKE_FENCE_MARK" },
        ctx: ctx("harden-warmfix"),
      });
      expect(text(result)).toContain("1");
      expect(pidOf(result)).not.toBe(warmPid);
      await settle(() => !processAlive(warmPid), "the unfenced warm entry to die");
    } finally {
      await plain.close();
    }
  });

  it("a fence-less broker never wraps (fencePlan null, the fence-off shape)", async () => {
    const plain = new ToolExecBroker({ fencePlan: null });
    try {
      const result = await plain.invoke({
        session: "harden-nofence",
        tool: "bash",
        // The seam var must NOT exist with no fence.
        args: { command: "echo fence=[${FAKE_FENCE_MARK:-absent}]" },
        ctx: ctx("harden-nofence"),
      });
      expect(text(result)).toContain("fence=[absent]");
    } finally {
      await plain.close();
    }
  });
});

// ── Reap takes the live shell with it (increment-3 review) ──────────────────
//
// The runner is not the leak: bash is spawned DETACHED (its own process
// group), so killing the runner alone orphaned the command. dropEntry now
// EOFs the runner, which cancels in-flight work and kills the whole group;
// this test fails against the old kill-first code (the shell would live out
// its sleep).

describe("reap kills the live process group", () => {
  it("a reap that races a live call kills the shell, not just the runner", async () => {
    const broker = new ToolExecBroker({ fence: "off" });
    const pidFile = join(dir, "reap-kill.pid");
    try {
      const running = broker.invoke({
        session: "harden-reapkill",
        tool: "bash",
        args: { command: `echo $$ > ${pidFile}; sleep 30` },
        ctx: ctx("harden-reapkill"),
      });
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(pidFile)) {
        if (Date.now() > deadline) throw new Error("the runner never started the shell");
        await sleep(10);
      }
      const shellPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);

      broker.reap("harden-reapkill");
      // Bookkeeping unchanged: the in-flight call learns via the crash shape...
      await expect(running).rejects.toThrow(/\[tool-exec crashed\]/);
      // ...and the shell is actually gone (the whole point of this fix).
      await waitForExit(shellPid, 8000);
      expect(processAlive(shellPid)).toBe(false);
    } finally {
      await broker.close();
    }
  }, 20000);
});

// ── Sliding death window (increment-3 review) ───────────────────────────────

describe("sliding broker-death window", () => {
  it("degrades on repeated deaths even when every death is followed by a completed call", async () => {
    // The consecutive-respawn cap resets on any completed call -- correct for
    // a flapping host, unreachable for a broker that dies once per served
    // call. The window catches exactly that: three crash deaths inside it
    // degrade regardless of the completions in between.
    const broker = new ToolExecBroker({ fence: "off", respawnCap: 50 });
    try {
      const marker = join(dir, "window.marker");
      for (let i = 0; i < 3; i++) {
        const running = startSignalled(broker, "harden-window", marker);
        await waitSignalled(marker);
        process.kill(broker.pid!, "SIGKILL");
        await expect(running).rejects.toThrow(/broker worker exited/);
        if (i < 2) {
          // A completed call on the respawned broker: the consecutive
          // counter resets, the window does not care.
          const ok = await broker.invoke({
            session: "harden-window",
            tool: "bash",
            args: { command: "echo ok" },
            ctx: ctx("harden-window"),
          });
          expect(text(ok)).toContain("ok");
        }
      }
      let message = "";
      try {
        await broker.invoke({
          session: "harden-window",
          tool: "bash",
          args: { command: "echo never" },
          ctx: ctx("harden-window"),
        });
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toContain("[tool-exec degraded]");
      expect(message).toContain("sliding-window cap");
      expect(broker.degraded).toBe(true);
      expect(broker.pid).toBeNull();
    } finally {
      await broker.close();
    }
  }, 30000);
});
