// Tests for core/config/store.ts -- the boot-adopted live store (B1).
// Pins the contract: adopt is a SILENT replacement (boot fires nothing, the
// atom never moves during adopt -- legal only while nothing has published,
// after the first publish adopt throws (§1.6's footgun guard), swap is the
// only publish step (reads see
// the NEW generation immediately -- the torn-read posture; applying() covers
// the swap-to-commit window), commit fires the atom exactly once and is
// one-shot, changed is the top-level canonical-JSON diff computed at swap
// time, a second swap with a commit pending throws (publishes serialize),
// and createCore's config/resolved accessors delegate byte-identically to
// the boot-adopted bag (behavior neutrality; the existing suites --
// main.test.ts above all -- are the primary byte-identity pins).

import { describe, it, expect } from "bun:test";
import { createConfigStore, type ConfigGeneration } from "@core/config/store.ts";
import { createCore } from "@core/main.ts";
import { ConfigRegistry } from "@core/extensions/config.ts";
import { createSubcommandRegistry } from "@core/extensions/registries.ts";
import type { CoreConfigWithExtensions } from "@core/config/schema-loader.ts";
import type { ResolvedConfig } from "@core/extensions/types.ts";

function cfg(extra: Record<string, unknown> = {}): CoreConfigWithExtensions {
  return { webui: { port: 8787 }, providers: [], ...extra } as CoreConfigWithExtensions;
}

function res(extra: Record<string, unknown> = {}): ResolvedConfig {
  return { baseUrl: "http://a", apiKey: "k", chatTimeout: 60, ...extra } as ResolvedConfig;
}

describe("ConfigStore - boot adopt", () => {
  it("current() before adopt throws (the boot pipeline must adopt first)", () => {
    const store = createConfigStore();
    expect(() => store.current()).toThrow("before adopt");
    expect(() => store.swap({ config: cfg(), resolved: res() })).toThrow("before adopt");
    expect(store.applying()).toEqual([]);
  });

  it("boot adopts TWICE: each adopt REPLACES the pending generation, the atom never fires", () => {
    const store = createConfigStore();
    let fires = 0;
    store.generation.effect(() => fires++); // even a pre-boot subscriber sees nothing

    const bag1 = cfg();
    store.adopt(bag1);
    expect(store.current().config).toBe(bag1);
    expect(store.current().resolved).toBeUndefined();
    expect(store.current().changed).toEqual([]);
    expect(store.current().batchId).toBe(0); // 0 = never published

    // The main.ts resolved-adopt path: second adopt replaces the pending one.
    const bag2 = cfg({ extra: 1 });
    const r = res();
    store.adopt(bag2, r);
    expect(store.current().config).toBe(bag2);
    expect(store.current().resolved).toBe(r);
    expect(store.current().batchId).toBe(0);
    expect(fires).toBe(0);
  });

  it("adopt() after anything has published THROWS (mid-process adopt would silently replace a generation with no publish)", () => {
    const store = createConfigStore();
    store.adopt(cfg(), res());
    store.swap({ config: cfg({ a: 1 }), resolved: res() })(); // one publish: batchId 1
    expect(() => store.adopt(cfg({ mid: true }), res())).toThrow("adopt() after a publish");
    // The throw takes nothing: the published generation survives untouched,
    // no new generation, no atom fire, the mid-process bag never lands.
    expect(store.current().batchId).toBe(1);
    expect(store.current().config).not.toHaveProperty("mid");
  });
});

describe("ConfigStore - publish (swap -> commit)", () => {
  it("the first live publish assigns batchId 1 and fires the atom exactly once", () => {
    const store = createConfigStore();
    store.adopt(cfg(), res()); // both boot adopts, no subscriber yet
    const fired: ConfigGeneration[] = [];
    store.generation.effect(() => fired.push(store.current()));

    const commit = store.swap({ config: cfg({ touched: true }), resolved: res() });
    expect(store.current().batchId).toBe(1); // stamped at swap; no fire before commit
    expect(fired.length).toBe(0);

    commit();
    expect(fired.length).toBe(1);
    expect(fired[0]).toBe(store.current());
    expect(fired[0]!.batchId).toBe(1);
  });

  it("swap: reads see NEW before commit, applying() lists the changed prefixes; commit clears, fires once, and is one-shot", () => {
    const store = createConfigStore();
    store.adopt(cfg({ keep: 1 }), res());
    let fires = 0;
    store.generation.effect(() => fires++);

    const nextCfg = cfg({ keep: 1 }); // same VALUE, fresh objects: canonical-equal, not changed
    const commit = store.swap({ config: nextCfg, resolved: res({ chatTimeout: 90 }) });
    expect(store.current().config).toBe(nextCfg); // torn-read posture: NEW immediately
    expect([...store.applying()]).toEqual(["chatTimeout"]);
    expect(store.current().changed).toEqual(["chatTimeout"]);

    commit();
    expect(fires).toBe(1);
    expect(store.applying()).toEqual([]);

    expect(() => commit()).toThrow("already ran"); // one-shot commit
    expect(fires).toBe(1); // ... and the atom still fired exactly once
  });

  it("the second swap gets a higher batchId", () => {
    const store = createConfigStore();
    store.adopt(cfg(), res());
    let fires = 0;
    store.generation.effect(() => fires++);

    store.swap({ config: cfg({ a: 1 }), resolved: res() })();
    expect(store.current().batchId).toBe(1);
    const commit2 = store.swap({ config: cfg({ a: 2 }), resolved: res() });
    expect(store.current().batchId).toBe(2);
    commit2();
    expect(fires).toBe(2);
  });

  it("changed is the top-level canonical-JSON diff computed at swap time", () => {
    const store = createConfigStore();
    store.adopt(cfg({ nested: { a: 1, b: 2 }, gone: true }), res());
    const commit = store.swap({
      config: cfg({ nested: { b: 2, a: 1 }, added: 5 }), // nested: same canonical value; gone removed; added new
      resolved: res({ chatTimeout: 90 }), // resolved-side roots participate in the same prefix namespace
    });
    expect([...store.current().changed].sort()).toEqual(["added", "chatTimeout", "gone"]);
    expect(store.current().changed).not.toContain("webui"); // same value, new object reference
    expect(store.current().changed).not.toContain("providers");
    expect(store.current().changed).not.toContain("nested"); // reordered key order is NOT a change
    commit();
  });

  it("a reordered-only rebuild yields changed:[] and still publishes once", () => {
    const store = createConfigStore();
    store.adopt(cfg({ deep: { x: 1, y: { p: 1, q: 2 } } }), res());
    let fires = 0;
    store.generation.effect(() => fires++);
    const commit = store.swap({ config: cfg({ deep: { y: { q: 2, p: 1 }, x: 1 } }), resolved: res() });
    expect(store.current().changed).toEqual([]);
    expect(store.current().batchId).toBe(1); // the batch still happens; the bookkeeping is honest
    commit();
    expect(fires).toBe(1);
  });

  it("one publish at a time: a second swap with a commit pending throws and takes nothing, the pending commit still fires once", () => {
    const store = createConfigStore();
    store.adopt(cfg(), res());
    let fires = 0;
    store.generation.effect(() => fires++);

    const commit1 = store.swap({ config: cfg({ a: 1 }), resolved: res() });
    const gen1 = store.current();
    expect(() => store.swap({ config: cfg({ a: 2 }), resolved: res() })).toThrow("serialize");
    expect(store.current()).toBe(gen1); // the throw happened before any mutation
    expect([...store.applying()]).toEqual(["a"]);

    commit1();
    expect(fires).toBe(1); // never a lost notify
    expect(store.applying()).toEqual([]);

    const commit2 = store.swap({ config: cfg({ a: 3 }), resolved: res() }); // publishes resume
    expect(store.current().batchId).toBe(2);
    commit2();
    expect(fires).toBe(2);
  });
});

describe("ConfigStore - degraded reports", () => {
  it("the degraded list round-trips through commit and is attached before the atom fires", () => {
    const store = createConfigStore();
    store.adopt(cfg(), res());
    const seen: Array<ConfigGeneration["degraded"]> = [];
    store.generation.effect(() => seen.push(store.current().degraded));

    const commit = store.swap({ config: cfg({ a: 1 }), resolved: res() });
    expect(store.current().degraded).toBeUndefined();
    const reports = [{ keyPath: "webui.port", why: "rebind failed: port busy" }];
    const gen = commit(reports);
    expect(store.current().degraded).toEqual(reports);
    expect(gen.degraded).toEqual(reports); // commit returns the published generation, list attached
    expect(seen).toEqual([reports]); // visible INSIDE the notify pass, not a lost reply
  });

  it("degraded survives a publish that does not touch its prefix and clears on one that does", () => {
    const store = createConfigStore();
    store.adopt(cfg({ a: 1 }), res());
    const c1 = store.swap({ config: cfg({ a: 1 }), resolved: res() });
    c1([{ keyPath: "webui.port", why: "x" }]);
    expect(store.current().degraded).toEqual([{ keyPath: "webui.port", why: "x" }]);

    const c2 = store.swap({ config: cfg({ a: 2 }), resolved: res() }); // touches "a" only
    c2();
    expect(store.current().degraded).toEqual([{ keyPath: "webui.port", why: "x" }]); // durable

    const c3 = store.swap({ config: cfg({ a: 2, webui: { port: 9999 } }), resolved: res() }); // touches "webui"
    c3();
    expect(store.current().degraded).toBeUndefined(); // cleared by the publish touching its prefix
  });
});

describe("core delegation (createCore surface)", () => {
  function bootCore() {
    const cfgIn = { modelWireFormat: "xml", providers: [] } as CoreConfigWithExtensions;
    const core = createCore(cfgIn, new ConfigRegistry(), createSubcommandRegistry());
    return { core, cfgIn };
  }

  it("core.config delegates to the store's boot generation; core.resolved starts undefined", () => {
    const { core, cfgIn } = bootCore();
    const store = core.configStore!;
    expect(store).toBeDefined();
    expect(core.config).toBe(store.current().config); // the store is the owner, identity included
    // Byte-identical to the pre-store coreConfig bag: {...config, profileName, profileDef}.
    expect({ ...core.config }).toEqual({ ...cfgIn, profileName: "default", profileDef: undefined });
    expect(core.resolved).toBeUndefined();
    expect(store.current().batchId).toBe(0);
    expect(store.applying()).toEqual([]);
  });

  it("the resolved-adopt (core.resolved =) is the silent second boot adopt: zero fires, config identity survives", () => {
    const { core } = bootCore();
    const store = core.configStore!;
    const bagBefore = core.config;
    let fires = 0;
    store.generation.effect(() => fires++);

    const r = res();
    core.resolved = r;
    expect(core.resolved).toBe(r);
    expect(core.config).toBe(bagBefore); // same adopted bag reference, unchanged
    expect(fires).toBe(0); // boot fires nothing
    expect(store.current().batchId).toBe(0);
  });

  it("a live publish through the store is answered by core.config/core.resolved immediately (before commit) and fires once", () => {
    const { core } = bootCore();
    core.resolved = res();
    const store = core.configStore!;
    let firedGen: ConfigGeneration | undefined;
    store.generation.effect(() => {
      firedGen = store.current();
    });

    const nextCfg = { ...core.config, liveKey: "new" } as CoreConfigWithExtensions;
    const nextRes = res({ baseUrl: "http://b" });
    const commit = store.swap({ config: nextCfg, resolved: nextRes });
    expect(core.config).toBe(nextCfg); // NEW through the accessor, before commit
    expect(core.resolved).toBe(nextRes);
    expect([...store.applying()].sort()).toEqual(["baseUrl", "liveKey"]);

    commit();
    expect(firedGen?.batchId).toBe(1);
    expect(core.config).toBe(nextCfg);
    expect(store.applying()).toEqual([]);
  });

  it("each createCore gets a fresh store; options.store is honored", () => {
    const a = bootCore();
    const b = bootCore();
    expect(a.core.configStore).not.toBe(b.core.configStore);

    const store = createConfigStore();
    const injected = createCore(cfg({ inj: 1 }), new ConfigRegistry(), createSubcommandRegistry(), { store });
    expect(injected.configStore).toBe(store);
    expect(store.current().config).toBe(injected.config);
  });
});
