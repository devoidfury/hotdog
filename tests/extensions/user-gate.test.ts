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

/** Registry double for the display-declaration tests: metadata only, the one
 * field the gate reads (ToolDisplaySpec) is what it asks for. */
function registryWith(display: Record<string, unknown[]>): unknown {
  return {
    getMetadata: (name: string) =>
      display[name] ? { sideEffects: true, difficulty: 2, display: display[name] } : undefined,
  };
}

async function run(
  cfg: UserGateConfig,
  p: ToolCallPayload,
  toolRegistry?: unknown,
): Promise<{ action: string | undefined; result: string }> {
  const hooks = new HookSystem();
  const core = { hooks, config: { userGate: cfg }, ...(toolRegistry ? { toolRegistry } : {}) } as unknown as CoreContext;
  const instance = create(core);
  for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
    hooks.on(name, handler as never, "user-gate");
  }
  await hooks.runHookPipeline<GateAction, "tool:call">(HOOKS.TOOL_CALL, p, {
    failOnError: true,
  });
  // The gate's action/result are adopted onto the payload.
  return { action: p.action, result: String(p.result ?? "") };
}

describe("user-gate TOOL_CALL handler", () => {
  it("registers nothing unless explicitly enabled", () => {
    const hooks = new HookSystem();
    const off = create({ hooks, config: {} } as unknown as CoreContext);
    expect(Object.keys(off.hooks ?? {})).toEqual([]);
    expect(hooks.handlerCount(HOOKS.TOOL_CALL)).toBe(0);
  });

  it("asks the human and allows (no verdict adopted) on 'allow once'", async () => {
    const { input, asked } = answerWith("allow once");
    const r = await run({ enabled: true, default: "ask" }, payload({ inputOverride: input } as never));
    // Allow returns no opinion: nothing is adopted onto the payload.
    expect(r.action).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("git status");
    expect(asked[0]).toContain("cmd: git");
    expect(asked[0]).toContain("to persist:");
  });

  it("neutralizes spoofing code points in the approval prompt text", async () => {
    // `git di<U+202E>ff` reads as "git diff" but is not "git diff"; the
    // prompt the human approves must show the override, never hide it.
    // (JSON.stringify already escapes ESC/BEL as visible \u00XX text -- it is
    // the Unicode controls that survive into the echo, and those tokenize.)
    const { input, asked } = answerWith("deny");
    const evil = JSON.stringify({ command: "git di\u202eff\u200bx \u001b[2K" });
    const r = await run({ enabled: true, default: "ask" }, payload({ inputOverride: input, input: evil } as never));
    expect(r.action).toBe("block");
    expect(asked[0]).toContain("[U+202E]");
    expect(asked[0]).toContain("[U+200B]");
    expect(asked[0]).not.toContain("\u001b[2K");
  });

  it("blocks on 'deny' with the reason and the config line", async () => {
    const { input } = answerWith("deny");
    const r = await run({ enabled: true, default: "ask" }, payload({ inputOverride: input } as never));
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
    const r = await run({ enabled: true, default: "ask", deny: ["bash.cmd=rm"] }, p);
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
      { enabled: true, default: "ask", allow: ["bash.cmd=git"] },
      payload({ inputOverride: input } as never),
    );
    expect(r.action).toBeUndefined();
    expect(asked).toBe(0);
  });

  it("allow-for-session suppresses the next identical ask; allow-once does not", async () => {
    for (const [answer, expectSecondPrompt] of [
      ["allow for session", false],
      ["allow once", true],
    ] as const) {
      const hooks = new HookSystem();
      const core = { hooks, config: { userGate: { enabled: true, default: "ask" } } } as unknown as CoreContext;
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
      const p = make();
      await hooks.runHookPipeline<GateAction, "tool:call">(HOOKS.TOOL_CALL, p, { failOnError: true });
      expect(p.action).toBeUndefined();
      await hooks.runHookPipeline<GateAction, "tool:call">(HOOKS.TOOL_CALL, make(), { failOnError: true });
      expect(asked).toBe(expectSecondPrompt ? 2 : 1);
    }
  });

  it("the session memo is per target set, not per tool", async () => {
    const hooks = new HookSystem();
    const core = { hooks, config: { userGate: { enabled: true, default: "ask" } } } as unknown as CoreContext;
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
    expect(r.action).toBeUndefined();
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
      const r = await run({ enabled: true, default: "ask" }, payload(over as never));
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
    const r = await run({ enabled: true, default: "ask" }, payload({ inputOverride: input } as never));
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
    const r = await run({ enabled: true, default: "ask" }, payload({ inputOverride: input } as never));
    expect(r.action).toBe("block");
    expect(r.result).toContain("readline exploded");
  });

  it("blocks when collectAnswers rejects", async () => {
    const input = {
      isInteractive: () => true,
      collectAnswers: () => Promise.reject(new Error("async boom")),
    };
    const r = await run({ enabled: true, default: "ask" }, payload({ inputOverride: input } as never));
    expect(r.action).toBe("block");
    expect(r.result).toContain("async boom");
  });

  it("blocks on an empty answer", async () => {
    const input = { isInteractive: () => true, collectAnswers: () => ({ approve: "" }) };
    const r = await run({ enabled: true, default: "ask" }, payload({ inputOverride: input } as never));
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
    const run_ = run({ enabled: true, default: "ask" }, p);
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
    const r = await run({ enabled: true, default: "ask" }, p);
    expect(r.action).toBe("block");
    expect(collected).toBe(false);
  });

  // ── Q-CANCEL-1 twin: the interrupt seam is the run-lifetime ctx signal ──
  // While a gated tool runs, the per-iteration runAbortController is null;
  // interrupt() -> agent.cancel() aborts the run-lifetime signal the
  // executor wires onto the tool ctx as "abortSignal". Without reading it,
  // a held approval could never be interrupted and blocked the turn.

  /** Wire an extra key into the payload's fake tool context. */
  function injectCtxKey(p: ToolCallPayload, key: string, value: unknown): void {
    const ctx = p.toolCtx as unknown as { get(k: string): unknown };
    const orig = ctx.get.bind(p.toolCtx);
    (p as unknown as { toolCtx: { get(k: string): unknown } }).toolCtx = {
      get: (k: string) => (k === key ? value : orig(k)),
    };
  }

  it("Q-CANCEL-1: aborting the held approval through the ctx signal, not the stale controller", async () => {
    const ac = new AbortController();
    let seenSignal: AbortSignal | null | undefined;
    const input = {
      isInteractive: () => true,
      collectAnswers: (_qs: unknown, signal?: AbortSignal | null) => {
        seenSignal = signal;
        return new Promise<Record<string, unknown>>(() => {}); // hangs until abort
      },
    };
    const p = payload({ inputOverride: input } as never);
    injectCtxKey(p, "abortSignal", ac.signal);
    // A stale per-iteration controller must NOT mask the ctx signal.
    (p.agent as { runAbortController?: AbortController }).runAbortController = new AbortController();

    const run_ = run({ enabled: true, default: "ask" }, p);
    await new Promise((r) => setTimeout(r, 10));
    expect(seenSignal).toBe(ac.signal); // askUser got the interruptible signal
    ac.abort();
    const r = await run_;
    expect(r.action).toBe("block");
    expect(r.result.toLowerCase()).toContain("cancel");
  });

  it("Q-CANCEL-1: already-aborted ctx signal never prompts", async () => {
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
    injectCtxKey(p, "abortSignal", ac.signal);
    const r = await run({ enabled: true, default: "ask" }, p);
    expect(r.action).toBe("block");
    expect(collected).toBe(false);
  });

  it("blocks every call when the config is malformed (fail closed, loudly)", async () => {
    const { input, asked } = answerWith("allow once");
    const r = await run(
      { enabled: true, default: "ask", allow: ["oops."] } as unknown as UserGateConfig,
      payload({ inputOverride: input } as never),
    );
    expect(r.action).toBe("block");
    expect(r.result).toContain("invalid");
    expect(asked).toHaveLength(0);
  });

  it("blocks valid JSON that is not an object (array, null, scalar)", async () => {
    // `[{"command": "git status"}]` parses, and a naive extract would read
    // targets out of it; `typeof null === "object"` too. None of these are
    // argument objects, so each must bail -- never treated as a call whose
    // targets could be matched against rules.
    for (const input of ['[{"command": "git status"}]', "null", "42", '"git status"']) {
      const r = await run({ enabled: true, default: "ask" }, payload({ input } as never));
      expect(r.action).toBe("block");
      expect(r.result).toContain("not a JSON object");
    }
  });

  it("blocks rather than throwing when the handler itself blows up", async () => {
    // Belt and braces: the TOOL_CALL pipeline is failOnError, so a throw
    // here surfaces as a tool crash instead of a clean denial.
    const p = payload({
      toolCtx: {
        get: () => {
          throw new Error("ctx exploded");
        },
      },
    } as never);
    const r = await run({ enabled: true, default: "ask" }, p);
    expect(r.action).toBe("block");
    expect(r.result).toContain("the approvals layer failed");
    expect(r.result).toContain("ctx exploded");
  });

  it("forces an ask for unparseable arguments, even under default allow", async () => {
    const { input } = answerWith("allow once");
    const r = await run(
      { enabled: true, default: "allow" },
      payload({ input: "{not json", inputOverride: input } as never),
    );
    // the bail forces an ask, and the human still has to say yes
    expect(r.action).toBeUndefined();

    const blocked = await run({ enabled: true, default: "allow" }, payload({ input: "{not json" } as never));
    expect(blocked.action).toBe("block");
    expect(blocked.result).toContain("not valid JSON");
  });
});

describe("prompt queue", () => {
  it("runs exactly one prompt at a time", async () => {
    const hooks = new HookSystem();
    const core = { hooks, config: { userGate: { enabled: true, default: "ask" } } } as unknown as CoreContext;
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
    const gate1: ToolCallPayload = payload({ input: JSON.stringify({ command: "ls" }), inputOverride: input } as never);
    const gate2: ToolCallPayload = payload({ input: JSON.stringify({ command: "pwd" }), inputOverride: input } as never);
    const p1 = hooks.runHookPipeline<GateAction, "tool:call">(
      HOOKS.TOOL_CALL,
      gate1,
      { failOnError: true },
    );
    const p2 = hooks.runHookPipeline<GateAction, "tool:call">(
      HOOKS.TOOL_CALL,
      gate2,
      { failOnError: true },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(release.length).toBe(1);
    expect(maxInFlight).toBe(1);
    release[0]!();
    await new Promise((r) => setTimeout(r, 20));
    expect(release.length).toBe(2);
    release[1]!();
    await Promise.all([p1, p2]);
    expect(gate1.action).toBeUndefined();
    expect(gate2.action).toBeUndefined();
    expect(maxInFlight).toBe(1);
  });
});

describe("gate composition (DM-3)", () => {
  it("an allow (no opinion) leaves an earlier block verdict intact", async () => {
    // Registration-order torture: the user-gate allow path runs AFTER a
    // blocking gate. Its old `{ action: "continue" }` used to overwrite the
    // block on the payload; returning nothing must leave it alone. (Run
    // WITHOUT the executor's shouldStop on purpose -- the fix is the absent
    // adoption, not just the short-circuit.)
    const { input, asked } = answerWith("allow once");
    const hooks = new HookSystem();
    hooks.on(HOOKS.TOOL_CALL, () => ({ action: "block", result: "log-integrity barrier" }), "session-log");
    const core = {
      hooks,
      config: { userGate: { enabled: true, default: "ask", allow: ["bash.cmd=git"] } },
    } as unknown as CoreContext;
    const instance = create(core);
    for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
      hooks.on(name, handler as never, "user-gate");
    }
    const p = payload({ inputOverride: input } as never);
    await hooks.runHookPipeline<GateAction, "tool:call">(HOOKS.TOOL_CALL, p, { failOnError: true });
    expect(p.action).toBe("block");
    expect(String(p.result)).toContain("log-integrity barrier");
    expect(asked).toHaveLength(0); // the allow path ran: no prompt needed
  });
});

describe("session grants are keyed by session (no cross-session silencing)", () => {
  it("an allow-for-session in one session does not silence another session's prompt", async () => {
    // The webui/ws host serves many sessions per process: a grant made while
    // talking to session A must not answer for session B.
    const hooks = new HookSystem();
    const core = { hooks, config: { userGate: { enabled: true, default: "ask" } } } as unknown as CoreContext;
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
    const runAs = (sessionId: string) =>
      hooks.runHookPipeline<GateAction, "tool:call">(
        HOOKS.TOOL_CALL,
        payload({ inputOverride: input, agent: { sessionId } } as never),
        { failOnError: true },
      );

    await runAs("A");
    expect(asked).toBe(1);
    await runAs("A"); // same session: the memo answers
    expect(asked).toBe(1);
    await runAs("B"); // different session: must prompt again
    expect(asked).toBe(2);
  });

  it("grants are pruned when the session ends (no unbounded Map in a 24/7 host)", async () => {
    // The grants Map is keyed by sessionId and lives for the process. On a
    // webui/ws host that outlives every session, a finished session's Set
    // must be reclaimed at SESSION_END -- and only that session's grants.
    const hooks = new HookSystem();
    const core = { hooks, config: { userGate: { enabled: true, default: "ask" } } } as unknown as CoreContext;
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
    const runAs = (sessionId: string) =>
      hooks.runHookPipeline<GateAction, "tool:call">(
        HOOKS.TOOL_CALL,
        payload({ inputOverride: input, agent: { sessionId } } as never),
        { failOnError: true },
      );

    await runAs("A"); // prompts (1): grant recorded for A
    await runAs("A"); // silent (memo)
    await runAs("B"); // prompts (2): grant recorded for B
    await runAs("B"); // silent (memo)
    expect(asked).toBe(2);

    await hooks.notifyHooks(HOOKS.SESSION_END, { sessionId: "A" });

    // A is a dead session: no grants left, a session named A prompts again.
    await runAs("A");
    expect(asked).toBe(3);
    // ...and B's own grant survived A's teardown (prune is keyed, not global).
    await runAs("B");
    expect(asked).toBe(3);
  });

  it('an "allow for session" with no session id degrades to "allow once"', async () => {
    // No key to remember by -> no memo. The gate fails toward prompting.
    const hooks = new HookSystem();
    const core = { hooks, config: { userGate: { enabled: true, default: "ask" } } } as unknown as CoreContext;
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
    const runAnonymous = () =>
      hooks.runHookPipeline<GateAction, "tool:call">(
        HOOKS.TOOL_CALL,
        payload({ inputOverride: input, agent: {} } as never),
        { failOnError: true },
      );

    await runAnonymous();
    await runAnonymous();
    expect(asked).toBe(2);
  });
});

describe("agent_browser evaluate through the gate", () => {
  const evaluatePayload = (script: string, over: Partial<ToolCallPayload> = {}) =>
    payload({
      toolName: "agent_browser",
      input: JSON.stringify({ action: "evaluate", script }),
      ...over,
    });

  it("a tool-level allow still prompts for evaluate, and the prompt shows the script", async () => {
    const { input, asked } = answerWith("allow once");
    const p = evaluatePayload("fetch('http://169.254.169.254/').then(r=>r.text())", { inputOverride: input } as never);
    const r = await run({ enabled: true, default: "ask", allow: ["agent_browser"] }, p);
    expect(r.action).toBeUndefined(); // allowed only after the human said so
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("169.254.169.254"); // the human reads what they approve
  });

  it("allow-for-session is keyed to the exact script: a new script prompts again", async () => {
    // One gate instance (one memo map): the process-wide "always allow" memo
    // lives in the extension, so this pins it through a single wired hook set.
    const hooks = new HookSystem();
    const core = { hooks, config: { userGate: { enabled: true, default: "ask" } } } as unknown as CoreContext;
    const instance = create(core);
    for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
      hooks.on(name, handler as never, "user-gate");
    }
    const answers = ["allow for session", "deny"];
    let n = 0;
    let asked = 0;
    const input = {
      isInteractive: () => true,
      collectAnswers: () => {
        asked++;
        return { approve: answers[Math.min(n++, answers.length - 1)] };
      },
    };
    const through = (script: string) =>
      hooks.runHookPipeline<GateAction, "tool:call">(
        HOOKS.TOOL_CALL,
        evaluatePayload(script, { inputOverride: input } as never),
        { failOnError: true },
      );

    await through("alert(1)");
    expect(asked).toBe(1);
    await through("alert(1)");
    expect(asked).toBe(1); // memo hit: same session, same exact script
    const fresh = await through("alert(2)");
    expect(asked).toBe(2); // a different script is a new ask
    expect(fresh.data.action).toBe("block"); // and it was denied here
  });

  it("headless: with no interactive UI evaluate is denied, other actions keep the tool-level allow", async () => {
    const cfg: UserGateConfig = { enabled: true, default: "ask", allow: ["agent_browser"] };
    const open = await run(cfg, payload({ toolName: "agent_browser", input: JSON.stringify({ action: "open", url: "https://example.com" }) }));
    expect(open.action).toBeUndefined();
    const evalNoUi = await run(cfg, evaluatePayload("alert(1)"));
    expect(evalNoUi.action).toBe("block");
    expect(evalNoUi.result).toContain("no interactive UI");
  });

  it("huge script targets are truncated in the prompt line, but the session memo keeps the full script", async () => {
    // Two multi-KB scripts identical until deep past the display budget:
    // the human-facing targets line must stay bounded AND the two calls must
    // still be separate asks with separate allow-for-session grants (the
    // memo key keeps the FULL raw value, so truncation cannot collapse them).
    const hooks = new HookSystem();
    const core = { hooks, config: { userGate: { enabled: true, default: "ask" } } } as unknown as CoreContext;
    const instance = create(core);
    for (const [name, handler] of Object.entries(instance.hooks ?? {})) {
      hooks.on(name, handler as never, "user-gate");
    }
    const prompts: string[] = [];
    const input = {
      isInteractive: () => true,
      collectAnswers: (qs: Record<string, unknown>[]) => {
        prompts.push(String(qs[0]?.prompt ?? ""));
        return { approve: "allow for session" };
      },
    };
    const through = (script: string) =>
      hooks.runHookPipeline<GateAction, "tool:call">(
        HOOKS.TOOL_CALL,
        evaluatePayload(script, { inputOverride: input } as never),
        { failOnError: true },
      );

    const head = `run(${JSON.stringify("p".repeat(3000))} + `;
    const scriptA = `${head}"A")`;
    const scriptB = `${head}"B")`; // differs from A only past the truncation point

    await through(scriptA);
    expect(prompts).toHaveLength(1);
    await through(scriptA);
    expect(prompts).toHaveLength(1); // memo hit: same session, same exact script

    const targetsLine = (p: string) =>
      p.split("\n").find((l) => l.trimStart().startsWith("targets:")) ?? "";
    expect(targetsLine(prompts[0]!)).toContain("…");
    expect(targetsLine(prompts[0]!).length).toBeLessThan(300); // bounded, not multi-KB

    await through(scriptB);
    expect(prompts).toHaveLength(2); // its own prompt: the memo did NOT collapse it
    expect(targetsLine(prompts[1]!)).toBe(targetsLine(prompts[0]!)); // same visible prefix
    await through(scriptB);
    await through(scriptA);
    expect(prompts).toHaveLength(2); // BOTH grants live side by side: distinct memo entries
  });

  it("rule matching keeps the full raw script value, not the truncated display", async () => {
    // The identical-head/tail-differing pair again: an allow rule naming the
    // EXACT huge script admits it silently; the other one still prompts.
    const head = `run(${JSON.stringify("q".repeat(3000))} + `;
    const scriptA = `${head}"A")`;
    const scriptB = `${head}"B")`;
    const { input, asked } = answerWith("deny");
    const cfg: UserGateConfig = { enabled: true, default: "ask", allow: [`agent_browser.script=${scriptA}`] };
    const exact = await run(cfg, evaluatePayload(scriptA, { inputOverride: input } as never));
    expect(exact.action).toBeUndefined();
    expect(asked).toHaveLength(0);
    const other = await run(cfg, evaluatePayload(scriptB, { inputOverride: input } as never));
    expect(other.action).toBe("block"); // denied here, but only AFTER its own ask
    expect(asked).toHaveLength(1);
  });
});

describe("approval prompt shows the declared diff (approve what you can read)", () => {
  const EDIT_DISPLAY = [
    { kind: "diff", oldArg: "oldString", newArg: "newString", pathArg: "path" },
  ];
  const APPEND_DISPLAY = [{ kind: "diff", source: "args", arg: "content", pathArg: "path" }];

  async function ask(
    display: Record<string, unknown[]>,
    toolName: string,
    args: Record<string, unknown>,
    answer = "allow once",
  ): Promise<string> {
    const { input, asked } = answerWith(answer);
    const p = payload({ toolName, input: JSON.stringify(args), inputOverride: input } as never);
    const r = await run({ enabled: true, default: "ask" }, p, registryWith(display));
    expect(r.action).toBeUndefined(); // the ask still ran to an allow
    expect(asked).toHaveLength(1);
    return asked[0]!;
  }

  it("renders the change block with its path, stat, gutter and signs", async () => {
    const prompt = await ask({ edit: EDIT_DISPLAY }, "edit", {
      path: "src/app.ts",
      replace_all: false,
      oldString: "function hello() {\n  return 1;\n}",
      newString: "function hello() {\n  return 2;\n}",
    });
    const lines = prompt.split("\n");
    expect(lines[0]).toBe("Approve this tool call? (edit)");
    // The string args the block shows drop out of the echo; what is left is
    // the shared k: v fold, so the question stays readable.
    expect(lines[1]).toBe("  args: path: src/app.ts · replace_all: false");
    expect(lines[2]).toBe("  will change src/app.ts +1 \u22121");
    expect(lines[3]).toBe("      1 function hello() {");
    expect(lines[4]).toBe("  -   2   return 1;");
    expect(lines[5]).toBe("  +   2   return 2;");
    expect(lines[6]).toBe("      3 }");
    // No result fact exists before the call runs: the gutter numbers the
    // snippet, and the block is labeled as the proposal it is.
    expect(prompt).not.toContain("META");
    expect(prompt).toContain("why:");
    expect(prompt).toContain("to persist:");
  });

  it("shows a write tool's content as adds, with the same cap and elision line", async () => {
    const body = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
    const prompt = await ask({ append: APPEND_DISPLAY }, "append", { path: "notes.md", content: body });
    const lines = prompt.split("\n");
    expect(lines[2]).toBe("  will change notes.md +20");
    expect(lines.filter((l) => l.trimStart().startsWith("+ row"))).toHaveLength(20);
    expect(prompt).toContain("\u2026 10 more changed lines");
    expect(prompt).not.toContain("row 25"); // capped: the tail never floods the ask
  });

  it("keeps today's prompt when the tool declares nothing (registry absent or silent)", async () => {
    const args = { path: "src/app.ts", oldString: "a", newString: "b" };
    const { input, asked } = answerWith("allow once");
    // No registry (a bare core double), a registry with no metadata for the
    // tool, and metadata with no display parts: all three are undeclared.
    const bare: unknown[] = [undefined, { getMetadata: () => undefined }, registryWith({})];
    for (const toolRegistry of bare) {
      const p = payload({ toolName: "edit", input: JSON.stringify(args), inputOverride: input } as never);
      const r = await run({ enabled: true, default: "ask" }, p, toolRegistry);
      expect(r.action).toBeUndefined();
      const prompt = asked[asked.length - 1]!;
      expect(prompt).not.toContain("will change");
      // The raw args echo is the unchanged posture for an undeclared tool.
      expect(prompt).toContain('"oldString":"a"');
    }
  });

  it("tokenizes spoofing code points inside the diff body it shows", async () => {
    const prompt = await ask({ edit: EDIT_DISPLAY }, "edit", {
      path: "src/a\u200bpp.ts",
      oldString: "rm -rf /\u200b*",
      newString: "rm -rf /\u202e",
    });
    expect(prompt).toContain("[U+200B]");
    expect(prompt).toContain("[U+202E]");
    expect(prompt).not.toContain("\u200b");
    expect(prompt).not.toContain("\u202e");
  });

  it("a failed-to-parse or non-object args call still prompts with no diff block", async () => {
    const { input, asked } = answerWith("deny");
    const p = payload({ toolName: "edit", input: "{not json", inputOverride: input } as never);
    const r = await run({ enabled: true, default: "ask" }, p, registryWith({ edit: EDIT_DISPLAY }));
    expect(r.action).toBe("block");
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toContain("will change");
  });
});
