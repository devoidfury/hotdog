// PROVIDER_ERROR retry contract (improvement #9) -- the loop semantics in
// src/core/agent.ts (the catch around #performLlmCall) are load-bearing and
// their consumers are extensions (compaction's overflow rescue,
// tool-call-repair's corrupt-history drop). A regression here shows up as
// double-retries hammering a provider in production, not red CI -- so the
// contract is pinned at core:
//
//   * the hook fires exactly once per failing FIRST attempt;
//   * a retry is issued at most once -- the retry's own failure propagates
//     WITHOUT re-firing the hook (no retry loop against the LLM client);
//   * with no verdict the original error surfaces untouched (identity);
//   * classification lives with the consumers: whatever the pipeline
//     decides (retry vs surface) is what the loop does, on every handler's
//     structured fields;
//   * the consumer contract: the payload carries the thrown error, the
//     live request params (mutations ride the retry), the agent, and
//     retry:false by default;
//   * the capped-finish wrap-up call is NOT wrapped: it never fires the hook;
//   * a cancel (Esc) or host abort landing after the failure but before the
//     retry point KILLS the retry -- no second request ever reaches the client.

import { describe, it, expect } from "bun:test";
import { HOOKS } from "@core/hooks.ts";
import { AgentError, LlmError } from "@core/error.ts";
import type { Message } from "@core/context/message.ts";
import { MockLLMClient, createFixture, simpleTool, buildStreamResponse } from "../helpers.ts";

/** Scripted client: each call throws the scripted Error or streams the
 * scripted events. Beyond the script it repeats the last step. */
class ScriptedLLMClient extends MockLLMClient {
  readonly errorsThrown: unknown[] = [];
  private readonly script: Array<Error | Record<string, unknown>[]>;

  constructor(script: Array<Error | Record<string, unknown>[]>) {
    super();
    this.script = script;
  }

  override chatStreamCancellable(
    messages: unknown[],
    modelConfig: Record<string, unknown>,
    toolDefs: Record<string, unknown>[],
    cancelSignal: AbortSignal | null | undefined,
  ): AsyncGenerator<Record<string, unknown>> {
    this.callCount++;
    this.lastMessages = messages;
    this.lastModelConfig = modelConfig;
    this.lastToolDefs = toolDefs;
    this.lastCancelSignal = cancelSignal ?? null;
    const step = this.script[Math.min(this.callCount - 1, this.script.length - 1)]!;
    if (step instanceof Error) {
      this.errorsThrown.push(step);
      throw step;
    }
    return (async function* () {
      for (const ev of step) yield ev;
    })();
  }
}

const okSeq = (text: string) => [
  { type: "content", content: text },
  { type: "usage", data: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
];

interface ProviderErrorPayload {
  error: unknown;
  params: { messages: Message[]; modelConfig: unknown; toolDefs: unknown };
  agent: unknown;
  retry: boolean;
}

function collectHookPayloads(agent: { hooks: { on: (n: string, h: (p: unknown) => unknown) => unknown } }) {
  const payloads: ProviderErrorPayload[] = [];
  agent.hooks.on(HOOKS.PROVIDER_ERROR, (p) => {
    payloads.push(p as ProviderErrorPayload);
  });
  return payloads;
}

describe("Agent PROVIDER_ERROR pipeline", () => {
  it("fires exactly once for a failing request and surfaces the ORIGINAL error untouched", async () => {
    const err = LlmError.Api("HTTP 400 (body: bad request)", 400);
    const client = new ScriptedLLMClient([err]);
    const { agent } = createFixture({ mockLLM: client as unknown as MockLLMClient });
    const payloads = collectHookPayloads(agent);

    let caught: unknown = null;
    try {
      await agent.run("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err); // identity: the loop rethrows the thrown error
    expect(client.callCount).toBe(1); // no retry without a verdict
    expect(payloads).toHaveLength(1); // exactly one hook fire per failing attempt
  });

  it("payload carries the thrown error, live params, the agent, and retry:false", async () => {
    const err = LlmError.Timeout("upstream stalled");
    const client = new ScriptedLLMClient([err, okSeq("recovered")]);
    const { agent } = createFixture({ mockLLM: client as unknown as MockLLMClient });
    const payloads = collectHookPayloads(agent);

    // No handler flips retry here: the error surfaces and the payload the
    // handler SAW is the contract (it is also what a consumer would mutate).
    await expect(agent.run("hi")).rejects.toBe(err);
    expect(client.callCount).toBe(1);
    expect(payloads).toHaveLength(1);
    const p = payloads[0]!;
    expect(p.error).toBe(err);
    expect(p.agent).toBe(agent);
    expect(p.retry).toBe(false); // the default the pipeline starts from
    expect(Array.isArray(p.params.messages)).toBe(true);
    expect(p.params.messages.length).toBeGreaterThanOrEqual(1); // user msg at minimum
    expect(p.params.modelConfig).toBeTruthy();
    expect(Array.isArray(p.params.toolDefs)).toBe(true);
  });

  it("retry:true re-issues the request exactly once; success resumes the loop", async () => {
    const client = new ScriptedLLMClient([LlmError.Http("503 upstream"), okSeq("recovered")]);
    const { agent } = createFixture({ mockLLM: client as unknown as MockLLMClient });
    let fires = 0;
    agent.hooks.on(HOOKS.PROVIDER_ERROR, () => {
      fires++;
      return { retry: true };
    });

    const result = await agent.run("hi");
    expect(client.callCount).toBe(2); // initial + exactly one retry
    expect(fires).toBe(1);
    expect((result as { content?: string }).content).toBe("recovered");
  });

  it("a failing retry propagates WITHOUT re-firing the hook -- no retry loop reaches the client", async () => {
    const first = LlmError.Http("503 upstream");
    const second = LlmError.Http("503 again");
    const client = new ScriptedLLMClient([first, second]);
    const { agent } = createFixture({ mockLLM: client as unknown as MockLLMClient });
    const payloads = collectHookPayloads(agent);
    agent.hooks.on(HOOKS.PROVIDER_ERROR, () => ({ retry: true }));

    let caught: unknown = null;
    try {
      await agent.run("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(second); // the retry's own failure surfaces
    expect(client.callCount).toBe(2); // never a third call
    expect(payloads).toHaveLength(1); // hook saw only the FIRST failure
  });

  it("several handlers asking to retry still produce ONE request to the client", async () => {
    const client = new ScriptedLLMClient([
      LlmError.Api("parseable tool-call corruption", 500),
      LlmError.Api("still broken", 500),
    ]);
    const { agent } = createFixture({ mockLLM: client as unknown as MockLLMClient });
    agent.hooks.on(HOOKS.PROVIDER_ERROR, () => ({ retry: true }));
    agent.hooks.on(HOOKS.PROVIDER_ERROR, () => ({ retry: true }));
    agent.hooks.on(HOOKS.PROVIDER_ERROR, () => ({ retry: true }));

    await expect(agent.run("hi")).rejects.toBeTruthy();
    expect(client.callCount).toBe(2); // three verdicts, one retry
  });

  it("classification is consumer-driven: a handler retrying only timeouts surfaces cancelled errors", async () => {
    // Mirrors the real consumers: they classify on the structured error
    // fields and only answer { retry: true } for what they can repair. The
    // loop obeys -- cancelled surfaces without touching the client twice,
    // timeout gets the one retry.
    const decideRetryOnTimeoutOnly = () => {
      return (p: unknown) => {
        const { error } = p as ProviderErrorPayload;
        return error instanceof LlmError && error.type === "timeout" ? { retry: true } : undefined;
      };
    };

    const timeoutClient = new ScriptedLLMClient([LlmError.Timeout("stalled"), okSeq("late ok")]);
    const t = createFixture({ mockLLM: timeoutClient as unknown as MockLLMClient });
    t.agent.hooks.on(HOOKS.PROVIDER_ERROR, decideRetryOnTimeoutOnly());
    const r = await t.agent.run("hi");
    expect(timeoutClient.callCount).toBe(2);
    expect((r as { content?: string }).content).toBe("late ok");

    const cancelled = LlmError.Cancelled("user cancelled");
    const cancelledClient = new ScriptedLLMClient([cancelled]);
    const c = createFixture({ mockLLM: cancelledClient as unknown as MockLLMClient });
    c.agent.hooks.on(HOOKS.PROVIDER_ERROR, decideRetryOnTimeoutOnly());
    await expect(c.agent.run("hi")).rejects.toBe(cancelled);
    expect(cancelledClient.callCount).toBe(1); // surfaced, never retried
  });

  it("params mutation by a handler rides the retry request (consumer contract)", async () => {
    // tool-call-repair / compaction both rewrite params.messages before
    // returning retry:true -- the retry MUST send the mutated context.
    const client = new ScriptedLLMClient([LlmError.Api("400 corrupt history", 400), okSeq("repaired")]);
    const { agent } = createFixture({ mockLLM: client as unknown as MockLLMClient });
    agent.hooks.on(HOOKS.PROVIDER_ERROR, (p: unknown) => {
      const { params } = p as ProviderErrorPayload;
      params.messages = params.messages.filter((m) => m.role !== "system");
      return { retry: true };
    });

    await agent.run("hi");
    expect(client.callCount).toBe(2);
    const retryMessages = client.lastMessages as Message[];
    expect(retryMessages.every((m) => m.role !== "system")).toBe(true);
  });

  it("the capped-finish wrap-up call never fires the hook (exactly one attempt by design)", async () => {
    // Iteration 1 answers with a tool call (loop continues); the cap then
    // triggers the tools-off wrap-up, whose failure must NOT open the
    // provider:error seam -- the run dies honestly with MaxIterations.
    const tool = simpleTool("calculator", "42");
    const client = new ScriptedLLMClient([
      buildStreamResponse({
        content: "computing",
        toolCalls: [{ index: 0, name: "calculator", arguments: '{"expr":"2+2"}', id: "c1" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      LlmError.Http("503 wrap-up failed"),
    ]);
    const { agent, toolRegistry } = createFixture({
      mockLLM: client as unknown as MockLLMClient,
      maxIterations: 1,
    });
    toolRegistry.register("calculator", tool);
    const payloads = collectHookPayloads(agent);

    await expect(agent.run("use the tool then summarize")).rejects.toBeInstanceOf(AgentError);
    expect(payloads).toHaveLength(0); // the wrap-up failure is not a provider:error path
    expect(client.callCount).toBe(2); // iteration + single wrap-up attempt, no retry
  });

  // ── Cancellation re-check at the retry point (H-2) ──────────────────────
  // retry:true says "a handler repaired the history", not "the user still
  // wants a request". The failed attempt AND the hook pipeline are async,
  // so a cancel can land between the failure and the re-issue; the loop
  // must die with the original error and never touch the transport again.

  it("a cancel landing inside the hook pipeline kills the retry: no second request, run settles cancelled", async () => {
    const err = LlmError.Http("503 upstream");
    const client = new ScriptedLLMClient([err, okSeq("must never stream")]);
    const { agent } = createFixture({ mockLLM: client as unknown as MockLLMClient });
    const turnEnds: Array<{ cancelled: boolean; reason: string }> = [];
    agent.hooks.on(HOOKS.TURN_END, (p) => {
      turnEnds.push(p as unknown as { cancelled: boolean; reason: string });
    });
    // Esc DURING the pipeline: cancelled flips after the failure and before
    // the retry point. The handler's verdict must not overrule the user.
    agent.hooks.on(HOOKS.PROVIDER_ERROR, () => {
      agent.cancel();
      return { retry: true };
    });

    let caught: unknown = null;
    try {
      await agent.run("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err); // surfaces the original error, unmasked
    expect(client.callCount).toBe(1); // the second request is NEVER made
    expect(agent.cancelled).toBe(true);
    const end = turnEnds[turnEnds.length - 1]!;
    expect(end.cancelled).toBe(true);
    expect(end.reason).toBe("cancelled");
  });

  it("a host abort landing inside the hook pipeline kills the retry too (the run signal covers the race)", async () => {
    // Host aborts deliberately do NOT touch `cancelled` (see the run-setup
    // comment in agent.ts), so this pins the guard's second half in isolation.
    const ac = new AbortController();
    const err = LlmError.Timeout("stalled");
    const client = new ScriptedLLMClient([err, okSeq("must never stream")]);
    const { agent } = createFixture({
      mockLLM: client as unknown as MockLLMClient,
      abortSignal: ac.signal,
    });
    agent.hooks.on(HOOKS.PROVIDER_ERROR, () => {
      ac.abort();
      return { retry: true };
    });

    await expect(agent.run("hi")).rejects.toBe(err);
    expect(client.callCount).toBe(1); // signal alone gates the re-issue
  });

  it("positive control: nothing cancelled means the retry still fires exactly once", async () => {
    // The guard must be inert for the uncancelled case: same contract the
    // tests above pin, restated beside it so a future guard tweak that
    // also kills healthy retries goes red right here.
    const client = new ScriptedLLMClient([LlmError.Http("503 upstream"), okSeq("recovered")]);
    const { agent } = createFixture({ mockLLM: client as unknown as MockLLMClient });
    agent.hooks.on(HOOKS.PROVIDER_ERROR, () => ({ retry: true }));

    const result = await agent.run("hi");
    expect(client.callCount).toBe(2); // initial + exactly one retry, unchanged
    expect((result as { content?: string }).content).toBe("recovered");
    expect(agent.cancelled).toBe(false);
  });
});
