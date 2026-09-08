// user-gate extension: SANDBOX_GATE hook handler unit tests. The prompt
// seam (payload.input / payload.signal, supplied by bash-tool's gate
// decider) is faked at its natural boundary; no kernel involved.

import { describe, it, expect } from "bun:test";
import { HookSystem, HOOKS, type SandboxGateAction } from "../../src/core/hooks.ts";
import type { HookPayloads } from "../../src/core/extensions/types.ts";
import type { CoreContext } from "../../src/core/extensions/types.ts";
import { create } from "../../src/extensions/user-gate/index.ts";

type GatePayload = HookPayloads["sandbox:gate"];

function payload(over: Partial<GatePayload> = {}): GatePayload {
  return {
    kind: "open.write",
    pid: 4242,
    paths: ["/ws/.env"],
    why: "deny-listed: /ws/.env",
    command: "echo SECRET=1 > .env",
    workspaceRoots: ["/ws"],
    ...over,
  };
}

/** Load the extension against a fresh HookSystem and run the pipeline with
 * the exact options bash-tool's buildGateDecider uses. */
async function runGate(
  p: GatePayload,
  opts: { enabled?: boolean } = {},
): Promise<{ action?: string; reason?: string }> {
  const hooks = new HookSystem();
  const core = {
    hooks,
    config: { userGate: { enabled: opts.enabled ?? true } },
  } as unknown as CoreContext;
  const instance = create(core);
  for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
    hooks.on(name, handler as never, "user-gate");
  }
  const res = await hooks.runHookPipeline<SandboxGateAction, "sandbox:gate">(
    HOOKS.SANDBOX_GATE,
    p,
    {
      failOnError: true,
      shouldStop: (r) => {
        const a = (r as SandboxGateAction | undefined)?.action;
        return a === "allow" || a === "deny";
      },
    },
  );
  return {
    action: res.lastResult?.action,
    reason: (res.lastResult as { reason?: string } | undefined)?.reason,
  };
}

describe("user-gate SANDBOX_GATE handler", () => {
  it("allows when the human answers 'allow'; prompt shows command/kind/paths/why/pid", async () => {
    let askedPrompt = "";
    const input = {
      isInteractive: () => true,
      collectAnswers: (qs: { key: string; prompt?: string; options?: string[] }[]) => {
        askedPrompt = qs[0]?.prompt ?? "";
        return { [qs[0]!.key]: "allow" };
      },
    };
    const hooks = new HookSystem();
    const instance = create({ hooks, config: {} } as unknown as CoreContext);
    for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
      hooks.on(name, handler as never, "user-gate");
    }
    const res = await hooks.runHookPipeline<SandboxGateAction, "sandbox:gate">(
      HOOKS.SANDBOX_GATE,
      payload({ input: input as unknown as GatePayload["input"] }),
    );
    expect(res.lastResult?.action).toBe("allow");
    expect(askedPrompt).toContain("echo SECRET=1");
    expect(askedPrompt).toContain("/ws/.env");
    expect(askedPrompt).toContain("deny-listed");
    expect(askedPrompt).toContain("4242");
  });

  it("denies when the human answers 'deny'", async () => {
    const input = {
      isInteractive: () => true,
      collectAnswers: (qs: { key: string }[]) => ({ [qs[0]!.key]: "deny" }),
    };
    const r = await runGate(payload({ input: input as unknown as GatePayload["input"] }));
    expect(r.action).toBe("deny");
  });

  it("denies on an empty answer (default-resolved prompt) -- fail closed", async () => {
    const input = {
      isInteractive: () => true,
      collectAnswers: (qs: { key: string }[]) => ({ [qs[0]!.key]: "" }),
    };
    const r = await runGate(payload({ input: input as unknown as GatePayload["input"] }));
    expect(r.action).toBe("deny");
  });

  it("denies immediately when there is no input on the payload (no UI)", async () => {
    const r = await runGate(payload());
    expect(r.action).toBe("deny");
    expect(r.reason).toContain("no interactive");
  });

  it("denies immediately when the input is non-interactive", async () => {
    let collected = false;
    const input = {
      isInteractive: () => false,
      collectAnswers: () => {
        collected = true;
        return {};
      },
    };
    const r = await runGate(payload({ input: input as unknown as GatePayload["input"] }));
    expect(r.action).toBe("deny");
    expect(collected).toBe(false);
  });

  it("denies when collectAnswers throws (UI error never escapes)", async () => {
    const input = {
      isInteractive: () => true,
      collectAnswers: () => {
        throw new Error("readline exploded");
      },
    };
    const r = await runGate(payload({ input: input as unknown as GatePayload["input"] }));
    expect(r.action).toBe("deny");
    expect(r.reason).toContain("readline exploded");
  });

  it("denies when collectAnswers rejects asynchronously", async () => {
    const input = {
      isInteractive: () => true,
      collectAnswers: () => Promise.reject(new Error("async boom")),
    };
    const r = await runGate(payload({ input: input as unknown as GatePayload["input"] }));
    expect(r.action).toBe("deny");
  });

  it("denies mid-prompt when the abort signal fires (cancel -> no dangling prompt)", async () => {
    const ac = new AbortController();
    const input = {
      isInteractive: () => true,
      collectAnswers: () => new Promise<Record<string, string>>(() => {
        /* never resolves on its own */
      }),
    };
    const p = payload({ input: input as unknown as GatePayload["input"], signal: ac.signal });
    const run = runGate(p);
    setTimeout(() => ac.abort(), 20);
    const r = await run;
    expect(r.action).toBe("deny");
    expect(r.reason?.toLowerCase()).toContain("cancel");
  });

  it("does not even prompt when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let collected = false;
    const input = {
      isInteractive: () => true,
      collectAnswers: () => {
        collected = true;
        return {};
      },
    };
    const r = await runGate(
      payload({ input: input as unknown as GatePayload["input"], signal: ac.signal }),
    );
    expect(r.action).toBe("deny");
    expect(collected).toBe(false);
  });

  it("registers no handler when disabled by config", async () => {
    const hooks = new HookSystem();
    const instance = create({
      hooks,
      config: { userGate: { enabled: false } },
    } as unknown as CoreContext);
    for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
      hooks.on(name, handler as never, "user-gate");
    }
    expect(hooks.handlerCount(HOOKS.SANDBOX_GATE)).toBe(0);
  });

  it("serializes prompts: exactly one collectAnswers in flight at a time", async () => {
    const hooks = new HookSystem();
    const instance = create({ hooks, config: {} } as unknown as CoreContext);
    for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
      hooks.on(name, handler as never, "user-gate");
    }
    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];
    const input = {
      isInteractive: () => true,
      collectAnswers: (qs: { key: string }[]) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<Record<string, string>>((res) => {
          release.push(() => {
            inFlight--;
            res({ [qs[0]!.key]: "allow" });
          });
        });
      },
    };
    const p1 = hooks.runHookPipeline<SandboxGateAction, "sandbox:gate">(
      HOOKS.SANDBOX_GATE,
      payload({ pid: 1, input: input as unknown as GatePayload["input"] }),
    );
    const p2 = hooks.runHookPipeline<SandboxGateAction, "sandbox:gate">(
      HOOKS.SANDBOX_GATE,
      payload({ pid: 2, input: input as unknown as GatePayload["input"] }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(release.length).toBe(1); // second ask waits its turn
    expect(maxInFlight).toBe(1);
    release[0]!();
    await new Promise((r) => setTimeout(r, 20));
    expect(release.length).toBe(2); // queue advanced to the second ask
    expect(maxInFlight).toBe(1);
    release[1]!();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.lastResult?.action).toBe("allow");
    expect(r2.lastResult?.action).toBe("allow");
    expect(maxInFlight).toBe(1);
  });

  it("an ask whose signal aborts while queued denies without prompting; queue drains", async () => {
    const hooks = new HookSystem();
    const instance = create({ hooks, config: {} } as unknown as CoreContext);
    for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
      hooks.on(name, handler as never, "user-gate");
    }
    const pidsAsked: number[] = [];
    const release: Array<() => void> = [];
    const input = {
      isInteractive: () => true,
      collectAnswers: (qs: { key: string }[]) => {
        pidsAsked.push(Number(/_(\d+)$/.exec(qs[0]!.key)![1])); // key embeds the pid
        return new Promise<Record<string, string>>((res) => {
          release.push(() => res({ [qs[0]!.key]: "allow" }));
        });
      },
    };
    const run = (pid: number, signal?: AbortSignal) =>
      hooks.runHookPipeline<SandboxGateAction, "sandbox:gate">(
        HOOKS.SANDBOX_GATE,
        payload({ pid, input: input as unknown as GatePayload["input"], signal }),
      );
    const p1 = run(11);
    const ac2 = new AbortController();
    const p2 = run(22, ac2.signal); // queued behind p1
    const p3 = run(33);
    await new Promise((r) => setTimeout(r, 20));
    expect(release.length).toBe(1); // only p1 is prompting
    ac2.abort(); // p2's child dies while its ask sits in the queue
    release[0]!(); // answer p1
    const r1 = await p1;
    expect(r1.lastResult?.action).toBe("allow");
    const r2 = await p2;
    expect(r2.lastResult?.action).toBe("deny");
    expect(pidsAsked).not.toContain(22); // p2 never reached the human
    await new Promise((r) => setTimeout(r, 20));
    expect(release.length).toBe(2); // queue skipped ahead to p3
    release[1]!();
    const r3 = await p3;
    expect(r3.lastResult?.action).toBe("allow");
    expect(pidsAsked).toEqual([11, 33]);
  });
});
