/**
 * The §2.4 transaction negatives + the §7.1 reply contract (design §9 tests
 * 2, 3, 4, 4c). Test-registered hooks drive the negative classes (the real
 * trustedProxy/apiKey prepare hooks are B8; these prove the MECHANISM):
 *  - test 2  last-good: re-resolve throws -> ok:true + restart-required, the
 *            plain notice carrying the formatError text (liveApplyError
 *            ruling: §7.1's wire has no such field, the text rides
 *            appliedNotices), the store generation UNTOUCHED, and a following
 *            clean write re-resolves everything (the previously failed key
 *            flips live too).
 *  - test 3  failed apply hook: value lands, degraded in the reply AND on
 *            store.degraded, the hook's own old side effect still functions,
 *            the next publish of the prefix clears it.
 *  - test 4  prepare refusal: file persisted, store unchanged, refusal reason
 *            verbatim, apply hooks never run.
 *  - test 4c applying window + FIFO: store.applying() names the prefix until
 *            commit; a concurrent second write queues behind the transaction
 *            and never interleaves; one notify pass (one batchId) per write.
 *  - timeouts: a hung hook with a small timeoutMs -> degraded inside the cap,
 *            the transaction completes regardless.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyConfigKeyEdit } from "@extensions/websocket/handlers-config.ts";
import { registerConfigApplyHook } from "@core/config/apply-hooks.ts";
import { bootLive, fsDeps, withShadowEnvCleared, type LiveEnv } from "./probes.ts";

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until(): condition never became true");
    await Bun.sleep(2);
  }
}

describe("config-live B4 test 2: last-good when re-resolve throws", () => {
  let env: LiveEnv | undefined;
  afterEach(() => {
    env?.cleanup();
    env = undefined;
  });

  it("the file keeps the write, the store keeps the generation, the reply says so plainly; a following clean write re-resolves ALL", async () => {
    const seed = { aiUrl: "http://boot.invalid/v1", hookTrace: false, note: "$B4_MISSING_VAR" };
    env = await bootLive(seed);
    const e = env;
    const genBefore = e.store.current();
    expect(e.core.hooks.trace).toBe(false);

    const res = await withShadowEnvCleared(() =>
      applyConfigKeyEdit(e.core, "hookTrace", { value: true }, { deps: fsDeps }),
    );

    // ok:true -- the bytes persisted (the verified chain stands); the live
    // side did not move.
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.applied).toBe("restart-required");
      expect(res.needsRestart).toBe(true);
      // The §2.3 plain notice, formatError text included (the liveApplyError
      // ruling: no such wire field -- the text rides appliedNotices).
      const joined = (res.appliedNotices ?? []).join("\n");
      expect(joined).toContain("re-resolution failed");
      expect(joined).toContain("B4_MISSING_VAR");
    }

    // The FILE holds the write (next boot's truth).
    expect(JSON.parse(readFileSync(join(e.dir, "defaults.json"), "utf-8")).hookTrace).toBe(true);

    // The STORE kept the previous generation, untouched: same object, batchId
    // 0, old values; the runtime never moved.
    expect(e.store.current()).toBe(genBefore);
    expect(e.store.current().batchId).toBe(0);
    expect((e.store.current().config as Record<string, unknown>).hookTrace).toBe(false);
    expect(e.core.hooks.trace).toBe(false);

    // A following clean write re-runs the WHOLE pipeline: the file resolves
    // again, and the previously failed key -- already persisted -- lands
    // live too (its apply hook fires on the candidate's changed roots).
    const res2 = await withShadowEnvCleared(() =>
      applyConfigKeyEdit(e.core, "note", { value: "fixed" }, { deps: fsDeps }),
    );
    expect(res2.ok).toBe(true);
    expect(e.store.current()).not.toBe(genBefore);
    expect(e.store.current().batchId).toBe(1);
    expect((e.store.current().config as Record<string, unknown>).hookTrace).toBe(true);
    expect(e.core.hooks.trace).toBe(true); // the previously-failed key is now LIVE
    // The written key itself ("note", no migrated live path) still attests
    // restart-required -- per-key honesty.
    if (res2.ok) expect(res2.applied).toBe("restart-required");
  });
});

describe("config-live B4 test 3: failed apply hook -> degraded, never re-swapped", () => {
  let env: LiveEnv | undefined;
  afterEach(() => {
    env?.cleanup();
    env = undefined;
  });

  it("value lands, applyHooks degraded, old side effect intact, store.degraded visible, next publish clears", async () => {
    env = await bootLive({ ...bootLiveSeed(), widget: 1 });
    const e = env;
    // A synthetic subsystem: `runningEffect` is what the OLD behavior serves
    // (1 since "boot"); the test-registered hook is its live-apply, which is
    // supposed to install next*10. It throws BEFORE installing anything, so
    // the OLD effect must still be the running behavior (runningEffect 1,
    // and the flag proving the install line never executed).
    let runningEffect = 1;
    let installedByNewHook = false;
    const unreg = registerConfigApplyHook({
      keyPath: "widget",
      phase: "apply",
      handle: (_ctx, _prev, next) => {
        const candidateEffect = Number(next) * 10;
        throw new Error("b4-apply-boom"); // dies before the install below
        // eslint-disable-next-line no-unreachable
        runningEffect = candidateEffect;
        installedByNewHook = true;
      },
    });
    try {
      const res = await withShadowEnvCleared(() =>
        applyConfigKeyEdit(e.core, "widget", { value: 2 }, { deps: fsDeps }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.applyHooks).toEqual([
          { keyPath: "widget", phase: "apply", status: "degraded", error: expect.stringContaining("b4-apply-boom") },
        ]);
      }
      // The store stayed NEW (§3.2: a failed apply NEVER re-swaps): the value
      // the file holds is what current() answers...
      expect((e.store.current().config as Record<string, unknown>).widget).toBe(2);
      // ...and the degraded report is DURABLE on the generation for the
      // snapshot to render later.
      expect(e.store.current().degraded).toEqual([
        { keyPath: "widget", why: expect.stringContaining("b4-apply-boom") },
      ]);
      // The OLD side effect still functions: the throwing hook installed
      // nothing (not even half); the old behavior is what keeps running.
      expect(installedByNewHook).toBe(false);
      expect(runningEffect).toBe(1);

      // The next successful publish touching the prefix clears it.
      unreg();
      const res2 = await withShadowEnvCleared(() =>
        applyConfigKeyEdit(e.core, "widget", { value: 3 }, { deps: fsDeps }),
      );
      expect(res2.ok).toBe(true);
      expect(e.store.current().degraded).toBeUndefined();
      expect((e.store.current().config as Record<string, unknown>).widget).toBe(3);
    } finally {
      unreg();
    }
  });

  it("degraded primary effect on a live-class key downgrades applied honestly (not a silent live claim)", async () => {
    env = await bootLive();
    const e = env;
    // Production's hookTrace row runs first (registration order) and succeeds;
    // the test hook on the same keyPath degrades. The attestation must refuse
    // to claim the write fully live while a hook on its own path degraded.
    const unreg = registerConfigApplyHook({
      keyPath: "hookTrace",
      phase: "apply",
      handle: () => {
        throw new Error("b4-second-hook-booms");
      },
    });
    try {
      const res = await withShadowEnvCleared(() =>
        applyConfigKeyEdit(e.core, "hookTrace", { value: true }, { deps: fsDeps }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.applied).toBe("restart-required");
        expect(res.needsRestart).toBe(true);
        const statuses = (res.applyHooks ?? []).map((h) => h.status);
        expect(statuses).toContain("degraded");
      }
      expect(e.store.current().degraded?.some((d) => d.keyPath === "hookTrace")).toBe(true);
    } finally {
      unreg();
    }
  });
});

describe("config-live B4 test 4: prepare refusal vetoes the swap", () => {
  let env: LiveEnv | undefined;
  afterEach(() => {
    env?.cleanup();
    env = undefined;
  });

  it("throwing prepare hook: file persisted, store unchanged, reason verbatim, apply hooks never run", async () => {
    env = await bootLive();
    const e = env;
    const genBefore = e.store.current();
    let applyHookRan = false;
    const unregPrepare = registerConfigApplyHook({
      keyPath: "hookTrace",
      phase: "prepare",
      handle: () => {
        throw new Error("b4-prepare-refusal: no");
      },
    });
    const unregApply = registerConfigApplyHook({
      keyPath: "hookTrace",
      phase: "apply",
      handle: () => {
        applyHookRan = true;
      },
    });
    try {
      const res = await withShadowEnvCleared(() =>
        applyConfigKeyEdit(e.core, "hookTrace", { value: true }, { deps: fsDeps }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.applied).toBe("restart-required");
        expect(res.needsRestart).toBe(true);
        expect(res.applyHooks).toEqual([
          {
            keyPath: "hookTrace",
            phase: "prepare",
            status: "refused",
            error: expect.stringContaining("b4-prepare-refusal: no"),
          },
        ]);
        // The refusal reason verbatim in the plain notice.
        expect((res.appliedNotices ?? []).join("\n")).toContain("b4-prepare-refusal: no");
      }
      // File persisted; runtime untouched (the swap never happened).
      expect(JSON.parse(readFileSync(join(e.dir, "defaults.json"), "utf-8")).hookTrace).toBe(true);
      expect(e.store.current()).toBe(genBefore);
      expect(e.core.hooks.trace).toBe(false);
      expect(applyHookRan).toBe(false); // prepare threw -> apply phase never reached
    } finally {
      unregPrepare();
      unregApply();
    }
  });
});

describe("config-live B4 test 4c: applying window, FIFO, one notify pass per write", () => {
  let env: LiveEnv | undefined;
  afterEach(() => {
    env?.cleanup();
    env = undefined;
  });

  it("applying() names the prefix until commit; a concurrent write queues behind, never interleaves", async () => {
    env = await bootLive({ ...bootLiveSeed(), widget: 1 });
    const e = env;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstCall = true;
    let calls = 0;
    let notifyPasses = 0;
    const stopWatch = e.store.generation.effect(() => notifyPasses++);
    const unreg = registerConfigApplyHook({
      keyPath: "widget",
      phase: "apply",
      timeoutMs: 10000, // parked deliberately; the cap must not fire (10s < 15s cap)
      handle: async () => {
        calls++;
        if (firstCall) {
          firstCall = false;
          await gate;
        }
      },
    });
    try {
      // The whole transaction window runs with the shadowing env cleared
      // (house hygiene like every other write test here: ambient HOTDOG_*
      // vars in CI would shadow the file and make the window prove nothing).
      await withShadowEnvCleared(async () => {
      const w1 = applyConfigKeyEdit(e.core, "widget", { value: 2 }, { deps: fsDeps });
      let w1Done = false;
      void w1.then(() => (w1Done = true));

      await until(() => e.store.applying().includes("widget"));
      // Inside the window: the prefix is marked applying (a snapshot would
      // render applying rows, never a bare live value), reads are NEW, and
      // the reply has not happened.
      expect(e.store.applying()).toContain("widget");
      expect((e.store.current().config as Record<string, unknown>).widget).toBe(2);
      expect(w1Done).toBe(false);

      // A concurrent second write must queue FIFO behind the transaction --
      // it cannot even reach its apply hooks while w1 is parked.
      const w2 = applyConfigKeyEdit(e.core, "widget", { value: 3 }, { deps: fsDeps });
      await Bun.sleep(30);
      expect(calls).toBe(1); // no interleaving: w2 has not started its hooks
      // ONE pending transaction: the applying set is unchanged from w1's
      // window (a second swap cannot open while the first commit is parked --
      // store.swap asserts exactly that; here it shows as widget appearing once).
      expect(e.store.applying().filter((p) => p === "widget")).toEqual(["widget"]);

      release();
      const r1 = await w1;
      const r2 = await w2;
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(e.store.applying()).toEqual([]);
      // FIFO byte order: w1 landed 2, then w2 landed 3.
      expect(JSON.parse(readFileSync(join(e.dir, "defaults.json"), "utf-8")).widget).toBe(3);
      // One notify pass per write (batchId moves once per write, no double
      // publish, no lost one).
      expect(notifyPasses).toBe(2);
      expect(e.store.current().batchId).toBe(2);
      expect(calls).toBe(2);
      stopWatch();
      });
    } finally {
      release();
      unreg();
    }
  });
});

describe("config-live B4 review F1: a shadowed live-class write cannot claim live", () => {
  let env: LiveEnv | undefined;
  afterEach(() => {
    env?.cleanup();
    env = undefined;
  });

  it("cli layer beats the file on baseUrl: the write lands, the hook never runs, the reply names the shadow", async () => {
    env = await bootLive(); // aiUrl file member + resolved baseUrl boot at http://boot.invalid/v1
    const e = env;
    // The live argv pins baseUrl at the CLI layer: an aiUrl FILE write can no
    // longer move the resolved root, so the baseUrl hook never fires.
    e.core.cliArgv = { aiUrl: "http://boot.invalid/v1" };

    const res = await withShadowEnvCleared(() =>
      applyConfigKeyEdit(e.core, "aiUrl", { value: "http://shadowed-target.invalid/v1" }, { deps: fsDeps }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The write DID move canonical values (config.aiUrl), but NOT the
      // resolved root -> restart-required, NOT the shadowed lie "live".
      expect(res.applied).toBe("restart-required");
      expect(res.needsRestart).toBe(true);
      const joined = (res.appliedNotices ?? []).join("\n");
      expect(joined, "the notice names the reality, not a generic failure").toContain("a higher layer decides");
      expect(joined).toContain("aiUrl");
      // The hook never ran: no baseUrl row on the reply.
      expect((res.applyHooks ?? []).some((h) => h.keyPath === "baseUrl")).toBe(false);
    }
    // The file keeps the write (persisted truth); the store swapped; the
    // resolved root and the shared-client field never moved.
    expect(JSON.parse(readFileSync(join(e.dir, "defaults.json"), "utf-8")).aiUrl).toBe("http://shadowed-target.invalid/v1");
    expect(e.store.current().changed.length).toBeGreaterThan(0);
    expect(e.store.current().changed).not.toContain("baseUrl");
    expect(e.store.current().resolved!.baseUrl).toBe("http://boot.invalid/v1");
    expect(e.ws.llmClient.baseUrl).toBe("http://boot.invalid/v1");
  });

  it("the TRUE no-op keeps its honest live claim: rewrite the same value -> live, zero notices", async () => {
    env = await bootLive();
    const e = env;
    // First: a genuinely live write (hook runs, shared client moves) -- also
    // settles the generation so the rewrite below diffs EMPTY.
    const first = await withShadowEnvCleared(() =>
      applyConfigKeyEdit(e.core, "aiUrl", { value: "http://first-target.invalid/v1" }, { deps: fsDeps }),
    );
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.applied).toBe("live");
    expect(e.ws.llmClient.baseUrl).toBe("http://first-target.invalid/v1");

    // Rewrite the SAME value: nothing in `changed`, no hook ran, nothing to
    // demote -- the running value already equals the file. Exact legacy shape.
    const noop = await withShadowEnvCleared(() =>
      applyConfigKeyEdit(e.core, "aiUrl", { value: "http://first-target.invalid/v1" }, { deps: fsDeps }),
    );
    expect(noop).toEqual({ ok: true, value: "http://first-target.invalid/v1", needsRestart: false, applied: "live" });
    expect(e.store.current().changed).toEqual([]);
  });
});

describe("config-live B4 timeouts + wire shape", () => {
  let env: LiveEnv | undefined;
  afterEach(() => {
    env?.cleanup();
    env = undefined;
  });

  it("hung hook with a small timeoutMs -> degraded inside the cap, transaction completes", async () => {
    env = await bootLive({ ...bootLiveSeed(), widget: 1 });
    const e = env;
    const unreg = registerConfigApplyHook({
      keyPath: "widget",
      phase: "apply",
      timeoutMs: 40,
      handle: () => new Promise<void>(() => {}), // hangs forever
    });
    try {
      const t0 = Date.now();
      const res = await withShadowEnvCleared(() =>
        applyConfigKeyEdit(e.core, "widget", { value: 2 }, { deps: fsDeps }),
      );
      expect(Date.now() - t0).toBeLessThan(1500); // nowhere near the 15s cap
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.applyHooks?.[0]?.status).toBe("degraded");
        expect(res.applyHooks?.[0]?.error).toContain("timed out after 40ms");
      }
      expect((e.store.current().config as Record<string, unknown>).widget).toBe(2);
    } finally {
      unreg();
    }
  });

  it("plain keys keep the exact legacy reply shape; live keys get the §7.1 fields; refusals stay {ok,error}", async () => {
    env = await bootLive({ ...bootLiveSeed(), note: "x" });
    const e = env;

    // Restart-required: NO notices/hooks keys at all -- the old shape plus the
    // one honest attestation field.
    const plain = await withShadowEnvCleared(() =>
      applyConfigKeyEdit(e.core, "note", { value: "y" }, { deps: fsDeps }),
    );
    expect(plain).toEqual({ ok: true, value: "y", needsRestart: true, applied: "restart-required" });

    // Live write: needsRestart is DERIVED false; every hook that ran on this
    // key's path reported applied (the list may carry one row per core ever
    // created in this process -- §3.1 registers once AT create(), and the
    // test file boots several hosts; production has one).
    const live = await withShadowEnvCleared(() =>
      applyConfigKeyEdit(e.core, "hookTrace", { value: true }, { deps: fsDeps }),
    );
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.value).toBe(true);
      expect(live.applied).toBe("live");
      expect(live.needsRestart).toBe(false);
      expect(live.appliedNotices).toBeUndefined();
      expect((live.applyHooks ?? []).length).toBeGreaterThan(0);
      expect((live.applyHooks ?? []).every((h) => h.keyPath === "hookTrace" && h.phase === "apply" && h.status === "applied")).toBe(true);
    }

    // A no-op write of the same live-class value: nothing in `changed`, no
    // hook ran, nothing to lie about -- still live (the running value equals
    // the file), still no notices, no hook rows.
    const noop = await withShadowEnvCleared(() =>
      applyConfigKeyEdit(e.core, "hookTrace", { value: true }, { deps: fsDeps }),
    );
    expect(noop).toEqual({ ok: true, value: true, needsRestart: false, applied: "live" });

    // Secret replace: live, never echoed -- no new-secret bytes anywhere on
    // the reply object.
    const secret = await withShadowEnvCleared(() =>
      applyConfigKeyEdit(e.core, "apiKey", { valueText: "wirecheck-secret" }, { deps: fsDeps }),
    );
    expect(secret.ok).toBe(true);
    if (secret.ok) expect(secret.applied).toBe("live");
    expect(JSON.stringify(secret)).not.toContain("wirecheck-secret");

    // Error refusals ride EXACTLY the old shape (no applied, no notices).
    const bad = await applyConfigKeyEdit(e.core, "webui.port", { value: true }, { deps: fsDeps });
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad).sort()).toEqual(["error", "ok"]);
  });
});

function bootLiveSeed(): Record<string, unknown> {
  return {
    aiUrl: "http://boot.invalid/v1",
    apiKey: "boot-key",
    hookTrace: false,
    chatTimeoutSecs: 600,
    maxRetries: 5,
    modelWireFormat: "xml",
    providerHealthCheckIntervalSecs: 30,
    websocket: { sessionTimeoutMin: 30, questionTimeoutSecs: 300 },
  };
}
