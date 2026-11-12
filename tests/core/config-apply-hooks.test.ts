// Tests for the apply-hook core (src/core/config/apply-hooks.ts, design
// §3.1/§3.2). Pure-registry + runner tests (the transaction end-to-end lives
// in tests/core/config-live/transaction.test.ts): registration order is run
// order, unregister removes exactly one entry, prefix match is ROOT-segment
// equality ("" matches every publish; "web" never matches "webui"), the
// timeout default/cap arithmetic refuses opt-out, and runConfigApplyHook
// never throws -- prepare failures report "refused", apply failures and
// timeouts report "degraded" with formatError text, and a timed-out hook
// cannot poison the run with an unhandled rejection.

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_TIMEOUT_CAP_MS,
  hookMatchesChangedRoot,
  hookTimeoutMs,
  hooksForPhase,
  registerConfigApplyHook,
  registeredHooks,
  runConfigApplyHook,
  type ConfigApplyContext,
} from "@core/config/apply-hooks.ts";
import type { ConfigStore } from "@core/config/store.ts";

const ctxStub = {
  store: {} as ConfigStore,
  notice: () => {},
  core: {},
} as unknown as ConfigApplyContext;

const hook = (
  keyPath: string,
  phase: "prepare" | "apply",
  extra: { timeoutMs?: number } = {},
) => ({ keyPath, phase, handle: () => {}, ...extra });

describe("apply-hooks registration", () => {
  it("registration order is run order; unregister removes exactly the one entry and is idempotent", () => {
    const before = registeredHooks().length;
    const order: string[] = [];
    const a = registerConfigApplyHook({ ...hook("a", "apply"), handle: () => { order.push("a"); } });
    const b = registerConfigApplyHook({ ...hook("b", "apply"), handle: () => { order.push("b"); } });
    const c = registerConfigApplyHook({ ...hook("c", "apply"), handle: () => { order.push("c"); } });
    expect(hooksForPhase("apply", ["a", "b", "c"]).map((h) => h.keyPath)).toEqual(["a", "b", "c"]);
    b();
    expect(hooksForPhase("apply", ["a", "b", "c"]).map((h) => h.keyPath)).toEqual(["a", "c"]);
    b(); // idempotent
    a();
    c();
    expect(registeredHooks().length).toBe(before);
  });

  it("a hook registered twice is one entry per registration (two unregisters clear both)", () => {
    const h = hook("dup", "prepare");
    const u1 = registerConfigApplyHook(h);
    const u2 = registerConfigApplyHook(h);
    const seen = hooksForPhase("prepare", ["dup"]);
    expect(seen.filter((x) => x.keyPath === "dup").length).toBe(2);
    u1();
    expect(hooksForPhase("prepare", ["dup"]).filter((x) => x === h).length).toBe(1);
    u2();
    expect(hooksForPhase("prepare", ["dup"]).filter((x) => x === h).length).toBe(0);
  });
});

describe("apply-hooks prefix match (changed ROOTS)", () => {
  it('"" matches every publish; a nested keyPath matches its root; sibling roots miss', () => {
    expect(hookMatchesChangedRoot("", [])).toBe(true);
    expect(hookMatchesChangedRoot("", ["anything"])).toBe(true);
    expect(hookMatchesChangedRoot("websocket.sessionTimeoutMin", ["websocket"])).toBe(true);
    expect(hookMatchesChangedRoot("websocket.sessionTimeoutMin", ["webui"])).toBe(false);
    // ROOT-segment equality, not string prefix.
    expect(hookMatchesChangedRoot("web", ["webui"])).toBe(false);
    expect(hookMatchesChangedRoot("webui", ["webui"])).toBe(true);
  });

  it("hooksForPhase filters phase AND match, keeping registration order", () => {
    const u1 = registerConfigApplyHook(hook("x", "prepare"));
    const u2 = registerConfigApplyHook(hook("x", "apply"));
    const u3 = registerConfigApplyHook(hook("y", "apply"));
    const prepares = hooksForPhase("prepare", ["x"]).map((h) => h.keyPath);
    expect(prepares).toContain("x");
    expect(prepares).not.toContain("y");
    const applies = hooksForPhase("apply", ["x"]);
    expect(applies.some((h) => h.phase === "apply" && h.keyPath === "x")).toBe(true);
    expect(hooksForPhase("apply", ["nothing-matches"]).every((h) => h.keyPath === "")).toBe(true);
    u1();
    u2();
    u3();
  });
});

describe("apply-hooks timeout discipline (default 2000, cap 15000)", () => {
  it("unset/junk/non-positive fall to the default; anything above lands capped", () => {
    expect(hookTimeoutMs(hook("t", "apply"))).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(hookTimeoutMs(hook("t", "apply", { timeoutMs: 0 }))).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(hookTimeoutMs(hook("t", "apply", { timeoutMs: -5 }))).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(hookTimeoutMs(hook("t", "apply", { timeoutMs: NaN }))).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(hookTimeoutMs(hook("t", "apply", { timeoutMs: 500 }))).toBe(500);
    expect(hookTimeoutMs(hook("t", "apply", { timeoutMs: 999999 }))).toBe(HOOK_TIMEOUT_CAP_MS);
  });
});

describe("runConfigApplyHook never throws", () => {
  it("clean run -> applied", async () => {
    const report = await runConfigApplyHook(ctxStub, hook("k", "apply", {}), 1, 2);
    expect(report).toEqual({ keyPath: "k", phase: "apply", status: "applied" });
  });

  it("apply-phase throw -> degraded with formatError text (sync throw included)", async () => {
    const report = await runConfigApplyHook(
      ctxStub,
      { keyPath: "k", phase: "apply", handle: () => { throw new Error("boom-sync"); } },
      1,
      2,
    );
    expect(report.status).toBe("degraded");
    expect(report.error).toContain("boom-sync");
  });

  it("prepare-phase async failure -> refused (the veto status)", async () => {
    const report = await runConfigApplyHook(
      ctxStub,
      { keyPath: "k", phase: "prepare", handle: async () => { throw new Error("nope"); } },
      1,
      2,
    );
    expect(report.status).toBe("refused");
    expect(report.error).toContain("nope");
  });

  it("hung hook times out as degraded inside its timeoutMs and leaves no unhandled rejection", async () => {
    let unhandled: unknown = null;
    const spy = (e: unknown) => {
      unhandled = e;
    };
    process.on("unhandledRejection", spy);
    try {
      // Rejects AFTER the timeout: must not surface as unhandled.
      let rejectLate!: (e: unknown) => void;
      const late = new Promise<void>((_, rej) => (rejectLate = rej));
      const t0 = Date.now();
      const report = await runConfigApplyHook(
        ctxStub,
        {
          keyPath: "hang",
          phase: "apply",
          timeoutMs: 30,
          handle: () => late,
        },
        1,
        2,
      );
      expect(report.status).toBe("degraded");
      expect(report.error).toContain("timed out after 30ms");
      expect(Date.now() - t0).toBeLessThan(1000);
      rejectLate(new Error("late rejection after the timeout was already reported"));
      await Bun.sleep(10);
      expect(unhandled).toBe(null);
    } finally {
      process.off("unhandledRejection", spy);
    }
  });
});
