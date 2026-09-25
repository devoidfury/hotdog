// Top-level session provider-lane gating: session turns take one slot in the
// cross-process ledger (turn-lanes.ts) through the MessageBus, mirroring the
// task-agent lane semantics (see the cross-process suite in task-manager.test.ts).

import { describe, it, expect } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageBus } from "@core/session/message-bus.ts";
import { createTurnLanes } from "@core/session/turn-lanes.ts";
import { LaneLedger } from "@core/session/lane-ledger.ts";
import { SessionManager } from "@core/session/index.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
import { createHooks } from "@core/hooks.ts";

// Poll until a condition holds (fails loudly on timeout) instead of a fixed sleep.
async function settle(fn: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function freshLanesDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "session-lanes-"));
}

async function slotCount(lanesDir: string, lane: string): Promise<number> {
  try {
    const names = await readdir(join(lanesDir, lane));
    return names.filter((n) => n.startsWith("slot-")).length;
  } catch {
    return 0;
  }
}

async function settleCount(
  get: () => Promise<number>,
  want: number,
  what: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await get()) === want) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Bus-shaped fake agent whose turns resolve only when the test says so. */
function gatedAgent(model: string) {
  const gates: Array<{ resolve: (v: unknown) => void }> = [];
  const agent: any = {
    sessionId: `s-${Math.random().toString(36).slice(2, 10)}`,
    model,
    hooks: { runHookPipeline: async (_name: string, data: unknown) => data },
    run: () =>
      new Promise((resolve) => gates.push({ resolve })),
    resetCancel: () => {},
    cancel: () => {},
    executeCommand: async () => null,
  };
  return {
    agent,
    finishTurn: () => gates.shift()!.resolve({ type: "completion", content: "ok" }),
    started: () => gates.length,
  };
}

function makeSink(): { emit: (event: any) => void; events: any[] } {
  const events: any[] = [];
  return { emit: (e) => events.push(e), events };
}

function laneWaitEvents(events: any[]): any[] {
  return events.filter(
    (e) => e.type === OUTPUT_EVENT.SYSTEM_MESSAGE && String(e.content).includes("provider lane"),
  );
}

function makeBus(
  agent: any,
  lanesDir: string | null,
  opts: { lanesPerProvider?: number; providerDefs?: { name: string; taskLanes?: unknown }[] } = {},
) {
  const sink = makeSink();
  const lanes = createTurnLanes({ lanesDir, lanesRetryMs: 25, ...opts });
  const bus = new MessageBus({ sessionManager: { getAgent: () => agent }, sink, lanes });
  return { bus, sink };
}

describe("session turn lanes", () => {
  it("a turn holds one ledger slot for its duration and releases it after", async () => {
    const lanesDir = await freshLanesDir();
    const ga = gatedAgent("prov/m1");
    const { bus } = makeBus(ga.agent, lanesDir, { lanesPerProvider: 1 });
    const loop = bus.run();
    bus.enqueue("hello");
    await settle(() => ga.started() === 1, "turn starts");
    expect(await slotCount(lanesDir, "prov")).toBe(1);

    ga.finishTurn();
    await settleCount(() => slotCount(lanesDir, "prov"), 0, "slot released once the run settles");
    bus.cancel();
    await loop;
    await rm(lanesDir, { recursive: true, force: true });
  });

  it("a raw ledger holder blocks the turn; releasing it lets it proceed, with a visible waiting event", async () => {
    const lanesDir = await freshLanesDir();
    const holder = new LaneLedger({ dir: lanesDir });
    const held = (await holder.acquire("prov", 1))!;
    const ga = gatedAgent("prov/m1");
    const { bus, sink } = makeBus(ga.agent, lanesDir, { lanesPerProvider: 1 });
    const loop = bus.run();
    bus.enqueue("hello");
    await settle(() => laneWaitEvents(sink.events).length >= 1, "waiting event emitted");
    expect(ga.started()).toBe(0);

    // Let several retry intervals pass on the full lane: the wait is announced once, not per retry.
    await new Promise((r) => setTimeout(r, 150));
    expect(ga.started()).toBe(0);
    expect(laneWaitEvents(sink.events).length).toBe(1);

    await holder.release(held);
    await settle(() => ga.started() === 1, "turn proceeds once the slot frees");
    ga.finishTurn();
    await settleCount(() => slotCount(lanesDir, "prov"), 0, "all slots released");
    bus.cancel();
    await loop;
    await rm(lanesDir, { recursive: true, force: true });
  });

  it("cancel during a lane wait leaks no slot and leaves the bus usable", async () => {
    const lanesDir = await freshLanesDir();
    const holder = new LaneLedger({ dir: lanesDir });
    const held = (await holder.acquire("prov", 1))!;
    const ga = gatedAgent("prov/m1");
    const { bus, sink } = makeBus(ga.agent, lanesDir, { lanesPerProvider: 1 });
    const loop = bus.run();
    bus.enqueue("hello");
    await settle(() => laneWaitEvents(sink.events).length >= 1, "waiting event emitted");

    bus.cancel();
    await loop; // the parked turn unwinds; the run loop exits
    expect(ga.started()).toBe(0);

    await holder.release(held);
    await settleCount(() => slotCount(lanesDir, "prov"), 0, "no leaked slot after cancel");

    // The bus is reusable after reset: the next turn takes the freed slot normally.
    bus.reset();
    const loop2 = bus.run();
    bus.enqueue("again");
    await settle(() => ga.started() === 1, "bus usable after cancelled lane wait");
    ga.finishTurn();
    bus.cancel();
    await loop2;
    await settleCount(() => slotCount(lanesDir, "prov"), 0, "all slots released");
    await rm(lanesDir, { recursive: true, force: true });
  });

  it("interrupt during a lane wait drops the turn but keeps the loop alive, no slot leaked", async () => {
    const lanesDir = await freshLanesDir();
    const holder = new LaneLedger({ dir: lanesDir });
    const held = (await holder.acquire("prov", 1))!;
    const ga = gatedAgent("prov/m1");
    const { bus, sink } = makeBus(ga.agent, lanesDir, { lanesPerProvider: 1 });
    const loop = bus.run();
    bus.enqueue("hello");
    await settle(() => laneWaitEvents(sink.events).length >= 1, "waiting event emitted");

    bus.interrupt();
    expect(ga.started()).toBe(0); // the parked message is dropped, the loop stays alive

    await holder.release(held);
    await settleCount(() => slotCount(lanesDir, "prov"), 0, "no leaked slot after interrupt");
    bus.enqueue("next");
    await settle(() => ga.started() === 1, "loop still consuming after interrupt");
    ga.finishTurn();
    bus.cancel();
    await loop;
    await rm(lanesDir, { recursive: true, force: true });
  });

  it("unlimited cap or no lanesDir means no ledger writes and the turn proceeds", async () => {
    const base = await freshLanesDir();
    const lanesDir = join(base, "lanes"); // must never be created

    const ga1 = gatedAgent("prov/m1");
    const { bus: bus1 } = makeBus(ga1.agent, lanesDir, { lanesPerProvider: 0 }); // 0 = unlimited
    const loop1 = bus1.run();
    bus1.enqueue("hello");
    await settle(() => ga1.started() === 1, "unlimited-cap turn runs immediately");

    const ga2 = gatedAgent("prov/m1");
    const { bus: bus2 } = makeBus(ga2.agent, null, { lanesPerProvider: 1 }); // no dir: no coordination
    const loop2 = bus2.run();
    bus2.enqueue("hello");
    await settle(() => ga2.started() === 1, "no-dir turn runs immediately");

    let exists = true;
    try {
      await readdir(lanesDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false); // the ledger dir was never touched

    ga1.finishTurn();
    ga2.finishTurn();
    bus1.cancel();
    bus2.cancel();
    await Promise.all([loop1, loop2]);
    await rm(base, { recursive: true, force: true });
  });

  it("a bare model name lands on the shared '_' lane", async () => {
    const lanesDir = await freshLanesDir();
    const ga = gatedAgent("llama3");
    const { bus } = makeBus(ga.agent, lanesDir, { lanesPerProvider: 1 });
    const loop = bus.run();
    bus.enqueue("hello");
    await settle(() => ga.started() === 1, "turn starts");
    expect(await slotCount(lanesDir, "_")).toBe(1);
    ga.finishTurn();
    await settleCount(() => slotCount(lanesDir, "_"), 0, "bare-lane slot released");
    bus.cancel();
    await loop;
    await rm(lanesDir, { recursive: true, force: true });
  });

  it("provider taskLanes overrides the global cap for its lane", async () => {
    const lanesDir = await freshLanesDir();
    const holder = new LaneLedger({ dir: lanesDir });
    const held = (await holder.acquire("prov", 1))!;
    const ga = gatedAgent("prov/m1");
    const { bus, sink } = makeBus(ga.agent, lanesDir, {
      lanesPerProvider: 0, // global unlimited...
      providerDefs: [{ name: "prov", taskLanes: 1 }], // ...but this lane caps at 1
    });
    const loop = bus.run();
    bus.enqueue("hello");
    await settle(() => laneWaitEvents(sink.events).length >= 1, "per-provider cap blocks the turn");
    expect(ga.started()).toBe(0);
    await holder.release(held);
    await settle(() => ga.started() === 1, "turn proceeds when the lane frees");
    ga.finishTurn();
    bus.cancel();
    await loop;
    await rm(lanesDir, { recursive: true, force: true });
  });

  it("an unusable lanesDir fails open: the turn runs uncoordinated", async () => {
    const base = await freshLanesDir();
    const blocker = join(base, "afile");
    await writeFile(blocker, "not a directory");
    const ga = gatedAgent("prov/m1");
    const { bus, sink } = makeBus(ga.agent, join(blocker, "lanes"), { lanesPerProvider: 1 });
    const loop = bus.run();
    bus.enqueue("hello");
    await settle(() => ga.started() === 1, "turn proceeds despite the broken ledger");
    expect(laneWaitEvents(sink.events).length).toBe(0);
    ga.finishTurn();
    bus.cancel();
    await loop;
    await rm(base, { recursive: true, force: true });
  });

  it("SessionManager wires the coordinator into every session bus", async () => {
    const lanesDir = await freshLanesDir();
    const ga = gatedAgent("prov/m1");
    const sm = await SessionManager.create({
      hooks: createHooks() as any,
      buildAgent: async () => ga.agent as any,
      taskConfig: {
        maxIterations: 5,
        taskProfile: "default",
        lanesPerProvider: 1,
        lanesDir,
      },
    });
    const bus = sm.getBus(sm.sessionId()!);
    expect(bus).toBeDefined();
    bus!.enqueue("hello");
    await settle(() => ga.started() === 1, "SessionManager-driven turn starts");
    expect(await slotCount(lanesDir, "prov")).toBe(1);
    ga.finishTurn();
    await settleCount(() => slotCount(lanesDir, "prov"), 0, "slot released after the turn");
    bus!.cancel();
    await rm(lanesDir, { recursive: true, force: true });
  });
});
