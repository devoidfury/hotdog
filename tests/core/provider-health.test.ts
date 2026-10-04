// Tests for the provider-pool health registry (src/core/session/provider-health.ts).
// Injected probes only -- no network, no mock.module.

import { describe, it, expect } from "bun:test";
import {
  makeProviderHealth,
  type ProbeResult,
  type ProviderProbe,
} from "@core/session/provider-health.ts";
import type { ModelConfig, ProviderDef } from "@core/config/providers.ts";

const def = (
  name: string,
  extra: Partial<ProviderDef> = {},
): ProviderDef => ({
  name,
  url: `http://${name}.test`,
  models: [],
  ...extra,
});

/** Probe that answers per-provider from a mutable verdict table. */
function tableProbe(
  verdicts: Record<string, ProbeResult>,
  opts: { count?: { n: number }; throwOn?: string } = {},
): ProviderProbe {
  return async (p) => {
    opts.count && opts.count.n++;
    if (opts.throwOn && p.name === opts.throwOn) throw new Error("probe exploded");
    return verdicts[p.name] ?? { up: true };
  };
}

describe("provider-health sweep verdicts", () => {
  it("down probe marks down, up probe clears (transition via sweep)", async () => {
    const verdicts: Record<string, ProbeResult> = {
      p1: { up: false, reason: "ECONNREFUSED" },
      p2: { up: true },
    };
    const health = makeProviderHealth({
      providers: [def("p1"), def("p2")],
      intervalMs: 0,
      timeoutMs: 1000,
      probe: tableProbe(verdicts),
    });
    await health.sweep();
    expect(health.isDown("p1")).toBe(true);
    expect(health.isDown("p2")).toBe(false);

    verdicts.p1 = { up: true };
    await health.sweep();
    expect(health.isDown("p1")).toBe(false);
  });

  it("unknown provider names are up (fail-open)", () => {
    const health = makeProviderHealth({
      providers: [def("p1")],
      intervalMs: 0,
      timeoutMs: 1000,
      probe: tableProbe({}),
    });
    expect(health.isDown("who")).toBe(false);
  });

  it("failure-driven markDown is cleared by a successful probe", async () => {
    const health = makeProviderHealth({
      providers: [def("p1")],
      intervalMs: 0,
      timeoutMs: 1000,
      probe: tableProbe({ p1: { up: true } }),
    });
    health.markDown("p1", "boom");
    expect(health.isDown("p1")).toBe(true);
    await health.sweep();
    expect(health.isDown("p1")).toBe(false);
  });

  it("providers with no url anywhere are never probed or demoted", async () => {
    const counted = { n: 0 };
    const health = makeProviderHealth({
      providers: [
        { name: "orphan", models: [] } as ProviderDef,
        def("p1"),
      ],
      globals: {},
      intervalMs: 0,
      timeoutMs: 1000,
      probe: tableProbe({ p1: { up: false, reason: "nope" } }, { count: counted }),
    });
    await health.sweep();
    expect(counted.n).toBe(1);
    expect(health.isDown("orphan")).toBe(false);
    expect(health.isDown("p1")).toBe(true);
  });

  it("a throwing probe leaves state untouched and does not crash the sweep", async () => {
    const health = makeProviderHealth({
      providers: [def("p1")],
      intervalMs: 0,
      timeoutMs: 1000,
      probe: tableProbe({}, { throwOn: "p1" }),
    });
    health.markDown("p1", "earlier verdict");
    await health.sweep(); // must resolve despite the throwing probe
    expect(health.isDown("p1")).toBe(true);
  });

  it("status() snapshots the down map per provider", async () => {
    const health = makeProviderHealth({
      providers: [def("p1"), def("p2")],
      intervalMs: 0,
      timeoutMs: 1000,
      probe: tableProbe({ p2: { up: false, reason: "dns fail" } }),
    });
    await health.sweep();
    const s = health.status();
    expect(s.find((x) => x.name === "p1")).toEqual({ name: "p1", down: false, reason: null });
    expect(s.find((x) => x.name === "p2")).toEqual({ name: "p2", down: true, reason: "dns fail" });
  });

  it("onRecover fires only on an actual down->up transition", async () => {
    const recovered: string[] = [];
    const verdicts: Record<string, ProbeResult> = { p1: { up: false } };
    const health = makeProviderHealth({
      providers: [def("p1")],
      intervalMs: 0,
      timeoutMs: 1000,
      probe: tableProbe(verdicts),
      onRecover: (n) => recovered.push(n),
    });
    await health.sweep(); // down -> down: stays down, no recovery event
    expect(recovered).toEqual([]);
    verdicts.p1 = { up: true };
    await health.sweep(); // down -> up
    expect(recovered).toEqual(["p1"]);
    await health.sweep(); // up -> up: nothing to clear
    expect(recovered).toEqual(["p1"]);
  });
});

describe("provider-health catalog piggyback", () => {
  it("a successful fetchModels probe upserts into the live registry (upsert-only)", async () => {
    const registry: Record<string, ModelConfig> = {
      "prov/stale": { name: "prov/stale", temperature: null, contextLimit: 1, tags: [] },
    };
    const verdicts: Record<string, ProbeResult> = {
      prov: {
        up: true,
        models: [{ name: "m1", contextLimit: 4096 }],
      },
    };
    const health = makeProviderHealth({
      providers: [def("prov", { fetchModels: true })],
      intervalMs: 0,
      timeoutMs: 1000,
      probe: tableProbe(verdicts),
      modelRegistry: registry,
      contextLimit: 2048,
    });
    // Boot left the down provider out of the catalog entirely except a stale key.
    expect(registry["prov/m1"]).toBeUndefined();
    await health.sweep();
    const m1 = registry["prov/m1"];
    expect(m1).toBeDefined();
    expect(m1!.name).toBe("prov/m1");
    expect(m1!.contextLimit).toBe(4096);
    // UPSERT ONLY: keys absent from the probe payload survive (eviction would
    // need TaskManager occupancy checks -- deliberate ceiling).
    expect(registry["prov/stale"]).toBeDefined();

    // A failing probe keeps existing entries and marks down.
    verdicts.prov = { up: false, reason: "refused" };
    await health.sweep();
    expect(registry["prov/m1"]).toBeDefined();
    expect(health.isDown("prov")).toBe(true);
  });
});

describe("provider-health interval timer", () => {
  it("intervalMs 0 never sweeps on its own; sweep() works; stop() is safe", async () => {
    const counted = { n: 0 };
    const health = makeProviderHealth({
      providers: [def("p1")],
      intervalMs: 0,
      timeoutMs: 1000,
      probe: tableProbe({}, { count: counted }),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(counted.n).toBe(0);
    await health.sweep();
    expect(counted.n).toBe(1);
    health.stop();
    health.stop(); // idempotent
  });

  it("intervalMs > 0 fires the first sweep at once, not after one interval", async () => {
    // A provider dead at boot is placement-preferred until the first probe;
    // the constructor must sweep immediately, before the timer ever ticks.
    const counted = { n: 0 };
    const health = makeProviderHealth({
      providers: [def("p1")],
      intervalMs: 60000, // the timer itself must never fire during this test
      timeoutMs: 1000,
      probe: tableProbe({}, { count: counted }),
    });
    const deadline = Date.now() + 1000;
    while (counted.n === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(counted.n).toBeGreaterThanOrEqual(1); // startup sweep, not the timer
    health.stop();
  });

  it("intervalMs > 0 sweeps on the timer until stopped", async () => {
    const counted = { n: 0 };
    const health = makeProviderHealth({
      providers: [def("p1")],
      intervalMs: 15,
      timeoutMs: 1000,
      probe: tableProbe({}, { count: counted }),
    });
    await new Promise((r) => setTimeout(r, 55));
    health.stop();
    const after = counted.n;
    expect(after).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(counted.n).toBe(after);
  });
});
