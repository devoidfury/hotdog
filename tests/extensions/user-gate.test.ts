// user-gate extension: the TOOL_CALL approval handler. The prompt seam
// (toolCtx "input") is faked at its natural boundary -- no UI, no kernel --
// and every fail-closed path is pinned, because a gate that fails open is
// worse than no gate.

import { describe, it, expect } from "bun:test";
import { HookSystem, HOOKS, type GateAction } from "@core/hooks.ts";
import type { CoreContext, HookPayloads } from "@core/extensions/types.ts";
import { Workspace } from "@utils/workspace.ts";
import { create } from "@extensions/user-gate/index.ts";
import type { UserGateConfig } from "@utils/approvals/rules.ts";

type ToolCallPayload = HookPayloads["tool:call"];

const ws = new Workspace("/ws");

interface FakeInput {
  isInteractive: () => boolean;
  collectAnswers: (qs: Record<string, unknown>[]) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

function answerWith(...answers: string[]): { input: FakeInput; asked: string[] } {
  const asked: string[] = [];
  let n = 0;
  return {
    asked,
    input: {
      isInteractive: () => true,
      collectAnswers: (qs) => {
        asked.push(String(qs[0]?.prompt ?? ""));
        const answer = answers[Math.min(n++, answers.length - 1)] ?? "deny";
        return { approve: answer };
      },
    },
  };
}

function payload(over: Partial<ToolCallPayload> & { inputOverride?: unknown } = {}): ToolCallPayload {
  const { inputOverride, ...rest } = over;
  const store: Record<string, unknown> = { workspace: ws };
  if (inputOverride !== undefined) store["input"] = inputOverride;
  return {
    toolCallId: "call-1",
    toolName: "bash",
    input: JSON.stringify({ command: "git status" }),
    agent: { sessionId: "s" },
    toolCtx: { get: (k: string) => store[k] },
    ...rest,
  } as unknown as ToolCallPayload;
}

async function run(
  cfg: UserGateConfig,
  p: ToolCallPayload,
): Promise<{ action: string | undefined; result: string }> {
  const hooks = new HookSystem();
  const core = { hooks, config: { userGate: cfg } } as unknown as CoreContext;
  const instance = create(core);
  for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
    hooks.on(name, handler as never, "user-gate");
  }
  const res = await hooks.runHookPipeline<GateAction, "tool:call">(HOOKS.TOOL_CALL, p, {
    failOnError: true,
  });
  const blocked = res.lastResult as { result?: unknown } | undefined;
  return { action: res.lastResult?.action, result: String(blocked?.result ?? "") };
}

describe("user-gate TOOL_CALL handler", () => {
  it("registers nothing unless explicitly enabled", () => {
    const hooks = new HookSystem();
    const off = create({ hooks, config: {} } as unknown as CoreContext);
    expect(Object.keys(off.hooks ?? {})).toEqual([]);
    expect(hooks.handlerCount(HOOKS.TOOL_CALL)).toBe(0);
  });

  it("asks the human and continues on 'allow once'", async () => {
    const { input, asked } = answerWith("allow once");
    const r = await run({ enabled: true }, payload({ inputOverride: input } as never));
    expect(r.action).toBe("continue");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("git status");
    expect(asked[0]).toContain("cmd: git");
    expect(asked[0]).toContain("to persist:");
  });

  it("blocks on 'deny' with the reason and the config line", async () => {
    const { input } = answerWith("deny");
    const r = await run({ enabled: true }, payload({ inputOverride: input } as never));
    expect(r.action).toBe("block");
    expect(r.result).toContain("user denied");
    expect(r.result).toContain('"userGate": { "allow": [');
    expect(r.result).toContain("bash.cmd=git");
  });

  it("blocks with no prompt at all when a deny rule matches", async () => {
    let asked = 0;
    const input = {
      isInteractive: () => true,
      collectAnswers: () => {
        asked++;
        return { approve: "allow once" };
      },
    };
    const p = payload({
      input: JSON.stringify({ command: "rm -rf /tmp/x" }),
      inputOverride: input,
    } as never);
    const r = await run({ enabled: true, deny: ["bash.cmd=rm"] }, p);
    expect(r.action).toBe("block");
    expect(asked).toBe(0);
    expect(r.result).toContain("bash.cmd=rm");
    expect(r.result).toContain("cannot be overridden");
  });

  it("does not prompt for what userGate.allow already covers", async () => {
    let asked = 0;
    const input = {
      isInteractive: () => true,
      collectAnswers: () => {
        asked++;
        return { approve: "allow once" };
      },
    };
    const r = await run(
      { enabled: true, allow: ["bash.cmd=git"] },
      payload({ inputOverride: input } as never),
    );
    expect(r.action).toBe("continue");
    expect(asked).toBe(0);
  });

  it("allow-for-session suppresses the next identical ask; allow-once does not", async () => {
    for (const [answer, expectSecondPrompt] of [
      ["allow for session", false],
      ["allow once", true],
    ] as const) {
      const hooks = new HookSystem();
      const core = { hooks, config: { userGate: { enabled: true } } } as unknown as CoreContext;
      const instance = create(core);
      for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
        hooks.on(name, handler as never, "user-gate");
      }
      let asked = 0;
      const input = {
        isInteractive: () => true,
        collectAnswers: () => {
          asked++;
          return { approve: answer };
        },
      };
      const make = () => payload({ inputOverride: input } as never);
      expect((await hooks.runHookPipeline<GateAction, "tool:call">(HOOKS.TOOL_CALL, make(), { failOnError: true })).lastResult?.action).toBe("continue");
      await hooks.runHookPipeline<GateAction, "tool:call">(HOOKS.TOOL_CALL, make(), { failOnError: true });
      expect(asked).toBe(expectSecondPrompt ? 2 : 1);
    }
  });

  it("the session memo is per target set, not per tool", async () => {
    const hooks = new HookSystem();
    const core = { hooks, config: { userGate: { enabled: true } } } as unknown as CoreContext;
    const instance = create(core);
    for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
      hooks.on(name, handler as never, "user-gate");
    }
    let asked = 0;
    const input = {
      isInteractive: () => true,
      collectAnswers: () => {
        asked++;
        return { approve: "allow for session" };
      },
    };
    const runCmd = (command: string) =>
      hooks.runHookPipeline<GateAction, "tool:call">(
        HOOKS.TOOL_CALL,
        payload({ input: JSON.stringify({ command }), inputOverride: input } as never),
        { failOnError: true },
      );
    await runCmd("git status");
    await runCmd("git status");
    expect(asked).toBe(1);
    await runCmd("git push origin main");
    expect(asked).toBe(2);
  });
});

describe('default "deny" (allowlist-only)', () => {
  it("blocks without ever reaching the UI, and prints the line that would allow it", async () => {
    const { input, asked } = answerWith("allow once");
    const r = await run(
      { enabled: true, default: "deny", allow: ["bash.cmd=ls"] },
      payload({ input: JSON.stringify({ command: "git push origin main" }), inputOverride: input } as never),
    );
    expect(r.action).toBe("block");
    expect(asked).toHaveLength(0);
    expect(r.result).toContain('userGate.default is "deny"');
    // the block text is the fix: no human to ask, so the log has to be enough
    expect(r.result).toContain('"userGate": { "allow": ["bash.cmd=git"] }');
  });

  it("still allows what the allow list covers, with no prompt", async () => {
    let asked = 0;
    const input = {
      isInteractive: () => true,
      collectAnswers: () => {
        asked++;
        return { approve: "allow once" };
      },
    };
    const r = await run(
      { enabled: true, default: "deny", allow: ["bash.cmd=ls"] },
      payload({ input: JSON.stringify({ command: "ls -la" }), inputOverride: input } as never),
    );
    expect(r.action).toBe("continue");
    expect(asked).toBe(0);
  });

  it("a rule denial says it cannot be overridden instead of offering a config line", async () => {
    const r = await run({ enabled: true, default: "deny", deny: ["bash.cmd=rm"] }, payload({
      input: JSON.stringify({ command: "rm -rf /" }),
    } as never));
    expect(r.action).toBe("block");
    expect(r.result).toContain("cannot be overridden");
    expect(r.result).not.toContain("to persist:");
  });
});

describe("fail-closed matrix", () => {
  const cases: Array<[string, Partial<ToolCallPayload>, string]> = [
    ["no toolCtx at all", { toolCtx: undefined }, "no interactive UI"],
    ["no input on the context", {}, "no interactive UI"],
  ];
  for (const [name, over, mentions] of cases) {
    it(`blocks when there is ${name}`, async () => {
      const r = await run({ enabled: true }, payload(over as never));
      expect(r.action).toBe("block");
      expect(r.result).toContain(mentions);
    });
  }

  it("blocks when the UI is non-interactive, without calling collectAnswers", async () => {
    let collected = false;
    const input = {
      isInteractive: () => false,
      collectAnswers: () => {
        collected = true;
        return {};
      },
    };
    const r = await run({ enabled: true }, payload({ inputOverride: input } as never));
    expect(r.action).toBe("block");
    expect(collected).toBe(false);
    expect(r.result).toContain("no interactive UI");
  });

  it("blocks when collectAnswers throws", async () => {
    const input = {
      isInteractive: () => true,
      collectAnswers: () => {
        throw new Error("readline exploded");
      },
    };
    const r = await run({ enabled: true }, payload({ inputOverride: input } as never));
    expect(r.action).toBe("block");
    expect(r.result).toContain("readline exploded");
  });

  it("blocks when collectAnswers rejects", async () => {
    const input = {
      isInteractive: () => true,
      collectAnswers: () => Promise.reject(new Error("async boom")),
    };
    const r = await run({ enabled: true }, payload({ inputOverride: input } as never));
    expect(r.action).toBe("block");
    expect(r.result).toContain("async boom");
  });

  it("blocks on an empty answer", async () => {
    const input = { isInteractive: () => true, collectAnswers: () => ({ approve: "" }) };
    const r = await run({ enabled: true }, payload({ inputOverride: input } as never));
    expect(r.action).toBe("block");
    expect(r.result).toContain("no answer");
  });

  it("blocks mid-prompt when the run is aborted", async () => {
    const ac = new AbortController();
    const input = {
      isInteractive: () => true,
      collectAnswers: () => new Promise<Record<string, unknown>>(() => {}),
    };
    const p = payload({ inputOverride: input } as never);
    (p.agent as { runAbortController: AbortController }).runAbortController = ac;
    const run_ = run({ enabled: true }, p);
    setTimeout(() => ac.abort(), 20);
    const r = await run_;
    expect(r.action).toBe("block");
    expect(r.result.toLowerCase()).toContain("cancel");
  });

  it("does not even prompt when the run is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let collected = false;
    const input = {
      isInteractive: () => true,
      collectAnswers: () => {
        collected = true;
        return { approve: "allow once" };
      },
    };
    const p = payload({ inputOverride: input } as never);
    (p.agent as { runAbortController: AbortController }).runAbortController = ac;
    const r = await run({ enabled: true }, p);
    expect(r.action).toBe("block");
    expect(collected).toBe(false);
  });

  it("blocks every call when the config is malformed (fail closed, loudly)", async () => {
    const { input, asked } = answerWith("allow once");
    const r = await run(
      { enabled: true, allow: ["oops."] } as unknown as UserGateConfig,
      payload({ inputOverride: input } as never),
    );
    expect(r.action).toBe("block");
    expect(r.result).toContain("invalid");
    expect(asked).toHaveLength(0);
  });

  it("forces an ask for unparseable arguments, even under default allow", async () => {
    const { input } = answerWith("allow once");
    const r = await run(
      { enabled: true, default: "allow" },
      payload({ input: "{not json", inputOverride: input } as never),
    );
    // the bail forces an ask, and the human still has to say yes
    expect(r.action).toBe("continue");

    const blocked = await run({ enabled: true, default: "allow" }, payload({ input: "{not json" } as never));
    expect(blocked.action).toBe("block");
    expect(blocked.result).toContain("not valid JSON");
  });
});

describe("prompt queue", () => {
  it("runs exactly one prompt at a time", async () => {
    const hooks = new HookSystem();
    const core = { hooks, config: { userGate: { enabled: true } } } as unknown as CoreContext;
    const instance = create(core);
    for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
      hooks.on(name, handler as never, "user-gate");
    }
    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];
    const input = {
      isInteractive: () => true,
      collectAnswers: () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<Record<string, unknown>>((res) => {
          release.push(() => {
            inFlight--;
            res({ approve: "allow once" });
          });
        });
      },
    };
    const p1 = hooks.runHookPipeline<GateAction, "tool:call">(
      HOOKS.TOOL_CALL,
      payload({ input: JSON.stringify({ command: "ls" }), inputOverride: input } as never),
      { failOnError: true },
    );
    const p2 = hooks.runHookPipeline<GateAction, "tool:call">(
      HOOKS.TOOL_CALL,
      payload({ input: JSON.stringify({ command: "pwd" }), inputOverride: input } as never),
      { failOnError: true },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(release.length).toBe(1);
    expect(maxInFlight).toBe(1);
    release[0]!();
    await new Promise((r) => setTimeout(r, 20));
    expect(release.length).toBe(2);
    release[1]!();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.lastResult?.action).toBe("continue");
    expect(r2.lastResult?.action).toBe("continue");
    expect(maxInFlight).toBe(1);
  });
});
