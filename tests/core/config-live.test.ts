// Tests for core/config/live.ts -- the notify seam above the store atom (B2).
// Drives a REAL createConfigStore() and publishes via adopt+swap+commit
// exactly like config-store.test.ts (no mocks: the seam's whole purpose is
// riding the atom's fire-blind + Set-iteration semantics, so faking the
// store would test nothing). Pins the matrix: the root filter (unrelated
// publish wakes nothing), canonical-rebuild suppression (byte-identical
// fresh subtree with reordered keys does NOT fire), the real-change payload
// (value/previous/batchId), nested vs block keyPaths, per-subscriber
// `previous` chains seeded at subscribe time and chained across publishes,
// the §1.6 Set-iteration consequences (added-mid-pass runs in the same pass
// and is idempotent -- it observes the new value twice; removed-mid-pass
// stops), throwing-subscriber error isolation (peers all run; logger.error
// through the real hook plumbing, house pattern), and idempotent
// unsubscribe incl. the resubscribe seeding rule (a fresh subscription
// never claims a value it never observed).

import { describe, it, expect, afterEach } from "bun:test";
import { createConfigStore, type ConfigStore } from "@core/config/store.ts";
import { onConfigChange, type ConfigChange } from "@core/config/live.ts";
import type { CoreConfigWithExtensions } from "@core/config/schema-loader.ts";
import type { ResolvedConfig } from "@core/extensions/types.ts";
import { createHooks } from "@core/hooks.ts";
import {
  initializeLogger,
  resetLoggerForTesting,
  type LogEvent,
} from "@utils/logger.ts";

function cfg(extra: Record<string, unknown> = {}): CoreConfigWithExtensions {
  return {
    webui: { port: 8787 },
    providers: [],
    websocket: { sessionTimeoutMin: 30, limits: { soft: 10, hard: 50 } },
    ...extra,
  } as CoreConfigWithExtensions;
}

// Fresh-object websocket block on every call: re-resolve semantics (same
// values, new references), optionally with fields added/changed.
function ws(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionTimeoutMin: 30, limits: { soft: 10, hard: 50 }, ...extra };
}

function res(extra: Record<string, unknown> = {}): ResolvedConfig {
  return { baseUrl: "http://a", apiKey: "k", chatTimeout: 60, ...extra } as ResolvedConfig;
}

function boot(): ConfigStore {
  const store = createConfigStore();
  store.adopt(cfg(), res());
  return store;
}

// The only publish shape the store allows: swap then its one-shot commit.
function publish(store: ConfigStore, config: CoreConfigWithExtensions, resolved = res()): void {
  store.swap({ config, resolved })();
}

describe("onConfigChange - root filter", () => {
  it("unrelated-root publish: fn zero calls (and zero at subscribe)", () => {
    const store = boot();
    const calls: ConfigChange[] = [];
    onConfigChange(store, "websocket.sessionTimeoutMin", (c) => calls.push(c));
    expect(calls.length).toBe(0); // subscribe never invokes fn

    publish(store, cfg({ webui: { port: 9090 } }));
    expect(store.current().changed).toEqual(["webui"]);
    expect(calls.length).toBe(0); // fast exit: "websocket" not in changed
  });

  it("onConfigChange on a pre-adopt store throws (boot-order bug named)", () => {
    const store = createConfigStore();
    expect(() => onConfigChange(store, "websocket.sessionTimeoutMin", () => {})).toThrow(
      "before adopt",
    );
  });
});

describe("onConfigChange - the real-change test", () => {
  it("own-root publish, value at keyPath byte-identical-but-fresh: zero calls (canonical compare catches the rebuild)", () => {
    const store = boot();
    const calls: ConfigChange[] = [];
    onConfigChange(store, "websocket.limits", (c) => calls.push(c));

    // "websocket" IS in changed (host added), so the filter passes; the
    // limits subtree is rebuilt fresh, REORDERED inside -- insertion-order
    // stringify would fire, the key-sorted canon (store.swap's technique)
    // must not.
    publish(store, cfg({ websocket: { host: "0.0.0.0", sessionTimeoutMin: 30, limits: { hard: 50, soft: 10 } } }));
    expect(store.current().changed).toContain("websocket");
    expect(calls.length).toBe(0);
  });

  it("own-keyPath real change: exactly one call with correct value/previous/batchId", () => {
    const store = boot();
    const calls: ConfigChange[] = [];
    onConfigChange(store, "websocket.sessionTimeoutMin", (c) => calls.push(c));

    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 45 }) }));
    expect(calls).toEqual([
      { keyPath: "websocket.sessionTimeoutMin", value: 45, previous: 30, batchId: 1 },
    ]);
  });

  it("nested keyPath vs block keyPath: both fire on the real inner change; the untouched sibling subtree stays quiet", () => {
    const store = boot();
    const bag0 = store.current().config;
    const nested: ConfigChange[] = [];
    const block: ConfigChange[] = [];
    const sibling: ConfigChange[] = [];
    onConfigChange(store, "websocket.sessionTimeoutMin", (c) => nested.push(c));
    onConfigChange(store, "websocket", (c) => block.push(c));
    onConfigChange(store, "websocket.limits", (c) => sibling.push(c));

    const nextBag = cfg({ websocket: ws({ sessionTimeoutMin: 45 }) });
    publish(store, nextBag);
    expect(nested).toEqual([
      { keyPath: "websocket.sessionTimeoutMin", value: 45, previous: 30, batchId: 1 },
    ]);
    expect(block.length).toBe(1);
    expect(block[0]!.previous).toBe(bag0.websocket); // per-subscriber seed: the block as observed at subscribe
    expect(block[0]!.value).toBe(nextBag.websocket);
    expect(block[0]!.previous).not.toBe(block[0]!.value);
    expect(sibling.length).toBe(0); // fresh identical limits object: canonical-equal
  });

  it("array-root block keyPath ('providers'): ref-unequal-but-equal rebuild no-ops at the filter; a real append fires", () => {
    const store = boot();
    const calls: ConfigChange[] = [];
    onConfigChange(store, "providers", (c) => calls.push(c));

    publish(store, cfg()); // fresh [] each cfg() call: canonical-equal -> "providers" never enters changed
    expect(store.current().changed).toEqual([]);
    expect(calls.length).toBe(0);

    publish(store, cfg({ providers: [{ id: "openai" }] }));
    expect(calls.length).toBe(1);
    expect(calls[0]!.value).toEqual([{ id: "openai" }]);
    expect(calls[0]!.previous).toEqual([]);
    expect(calls[0]!.batchId).toBe(2);
  });
});

describe("onConfigChange - previous chains (§1.4 reconstruction)", () => {
  it("two subscribers on the same keyPath: same batchId, independent previous; a late subscriber's first previous is the value at its subscribe time", () => {
    const store = boot();
    const a: ConfigChange[] = [];
    const b: ConfigChange[] = [];
    onConfigChange(store, "websocket.sessionTimeoutMin", (c) => a.push(c));

    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 45 }) })); // batch 1

    onConfigChange(store, "websocket.sessionTimeoutMin", (c) => b.push(c)); // seeded at 45
    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 60 }) })); // batch 2

    expect(a).toEqual([
      { keyPath: "websocket.sessionTimeoutMin", value: 45, previous: 30, batchId: 1 },
      { keyPath: "websocket.sessionTimeoutMin", value: 60, previous: 45, batchId: 2 },
    ]);
    expect(b).toEqual([
      { keyPath: "websocket.sessionTimeoutMin", value: 60, previous: 45, batchId: 2 },
    ]);
  });

  it("previous chains across sequential publishes, including key removal (value undefined)", () => {
    const store = boot();
    const calls: ConfigChange[] = [];
    onConfigChange(store, "websocket.sessionTimeoutMin", (c) => calls.push(c));

    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 45 }) }));
    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 60 }) }));
    publish(store, cfg({ websocket: { limits: { soft: 10, hard: 50 } } })); // key gone from both bags

    expect(calls.map((c) => [c.previous, c.value, c.batchId])).toEqual([
      [30, 45, 1],
      [45, 60, 2],
      [60, undefined, 3],
    ]);
  });
});

describe("onConfigChange - Set iteration during a notify pass (§1.6)", () => {
  it("subscriber ADDED during a notify pass runs in that same pass; its double observation of the new value is idempotent", () => {
    const store = boot();
    const late: ConfigChange[] = [];
    let rawSeen = 0;
    let rawStop: (() => void) | undefined;
    let lateUnsub: (() => void) | undefined;

    const aUnsub = onConfigChange(store, "websocket.sessionTimeoutMin", () => {
      if (rawStop) return; // register the mid-pass pair once, on pass 1
      // Mid-pass registrations: a raw atom effect AND an onConfigChange
      // subscription, added while the for..of over the effect Set is still
      // running. JS Set iteration visits entries added during iteration.
      rawStop = store.generation.effect(() => rawSeen++);
      lateUnsub = onConfigChange(store, "websocket.sessionTimeoutMin", (c) => late.push(c));
    });

    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 45 }) })); // batch 1
    expect(rawSeen).toBe(1); // the mid-pass addition ran IN the same pass
    expect(late.length).toBe(0); // and the seam made it harmless: the late
    // subscriber's two observations (subscribe-time read + mid-pass wake)
    // are the SAME new value -- the change test no-ops the extra wake.

    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 60 }) })); // batch 2
    expect(rawSeen).toBe(2);
    expect(late).toEqual([
      { keyPath: "websocket.sessionTimeoutMin", value: 60, previous: 45, batchId: 2 },
    ]); // chain seeded through the idempotent pass-1 observation

    rawStop?.();
    lateUnsub?.();
    aUnsub();
  });

  it("subscriber REMOVED during a notify pass gets no further calls that pass", () => {
    const store = boot();
    const aCalls: number[] = [];
    const bCalls: ConfigChange[] = [];
    let unsubB: () => void = () => {};

    const unsubA = onConfigChange(store, "websocket.sessionTimeoutMin", () => {
      aCalls.push(1);
      unsubB(); // tears down the LATER-iterated peer mid-pass
    });
    const realB = onConfigChange(store, "websocket.sessionTimeoutMin", (c) => bCalls.push(c));
    unsubB = realB;

    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 45 }) })); // batch 1
    expect(aCalls.length).toBe(1);
    expect(bCalls.length).toBe(0); // Set iteration skips deleted entries

    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 60 }) })); // batch 2
    expect(aCalls.length).toBe(2); // A still runs (and re-runs its now-idempotent unsubB)
    expect(bCalls.length).toBe(0);
    unsubA();
  });
});

describe("onConfigChange - error isolation", () => {
  afterEach(() => {
    resetLoggerForTesting();
  });

  it("throwing subscriber: peers all still called, logger.error carries the formatError text, the pass is not aborted", () => {
    resetLoggerForTesting();
    const hooks = createHooks();
    const lines: string[] = [];
    hooks.on("log", (data) => {
      const ev = data as LogEvent;
      if (ev.level === "error") lines.push(ev.message);
    });
    initializeLogger({ hooks, minLevel: "error", target: "none" });

    const store = boot();
    const peers: ConfigChange[] = [];
    const secondPeers: ConfigChange[] = [];
    const unsubThrower = onConfigChange(store, "websocket.sessionTimeoutMin", () => {
      throw new Error("subscriber-blew-up");
    });
    // registration order: thrower FIRST -- the raw primitive would stop the
    // pass here (pinned in reactive-state.test.ts); the wrapper must not.
    onConfigChange(store, "websocket.sessionTimeoutMin", (c) => peers.push(c));
    onConfigChange(store, "websocket", (c) => secondPeers.push(c));

    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 45 }) }));

    expect(peers.length).toBe(1); // the next peer ran despite the throw
    expect(secondPeers.length).toBe(1); // ... and the pass ran to the end
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("websocket.sessionTimeoutMin");
    expect(lines[0]).toContain("subscriber-blew-up");

    // The thrower's own chain advanced (delivered = observed): the next
    // real change fires it again from the new value, not from the seed.
    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 60 }) }));
    expect(lines.length).toBe(2); // it ran again (threw again), not silently dropped

    unsubThrower();
  });
});

describe("onConfigChange - unsubscribe", () => {
  it("unsubscribe stops calls; double-unsubscribe is safe", () => {
    const store = boot();
    const calls: ConfigChange[] = [];
    const unsub = onConfigChange(store, "websocket.sessionTimeoutMin", (c) => calls.push(c));

    unsub();
    expect(() => unsub()).not.toThrow();

    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 45 }) }));
    expect(calls.length).toBe(0);
  });

  it("after unsubscribe+resubscribe, previous starts from the current value (never claims a value it never observed)", () => {
    const store = boot();
    const first: ConfigChange[] = [];
    const unsub1 = onConfigChange(store, "websocket.sessionTimeoutMin", (c) => first.push(c));
    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 45 }) })); // batch 1: prev 30
    unsub1();

    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 60 }) })); // batch 2: nobody listening

    const second: ConfigChange[] = [];
    const unsub2 = onConfigChange(store, "websocket.sessionTimeoutMin", (c) => second.push(c));
    publish(store, cfg({ websocket: ws({ sessionTimeoutMin: 75 }) })); // batch 3

    expect(first).toEqual([
      { keyPath: "websocket.sessionTimeoutMin", value: 45, previous: 30, batchId: 1 },
    ]);
    expect(second).toEqual([
      { keyPath: "websocket.sessionTimeoutMin", value: 75, previous: 60, batchId: 3 },
    ]); // previous = the value AT RESUBSCRIBE TIME, not 30 and not 45
    unsub2();
  });
});
