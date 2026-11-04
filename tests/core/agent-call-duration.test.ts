// Agent-level pin: the token_usage emit carries a finite durationMs (the
// producing LLM call's own wall time -- the measured span documented in
// agent.ts: request issue through stream completion, provider retries and
// mid-stream resets included, response post-processing excluded). Honesty
// doctrine: a call whose provider reported usage always attests a finite
// duration; the number is never omitted when we measured it, and never
// invented when the provider kept usage private (no emit at all).

import { describe, it, expect } from "bun:test";
import { HOOKS } from "@core/hooks.ts";
import { OUTPUT_EVENT, type TokenUsageEvent } from "@core/context/output.ts";
import { createFixture } from "../helpers.ts";
import { MockLLMClient } from "../mocks/llm.ts";
import { LlmError } from "@core/error.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Client whose attempts each spend `ms` before streaming/throwing, so a
 * retried logical call's duration must include every failed attempt's wait. */
class TimingLLMClient extends MockLLMClient {
  readonly delays: number[];
  constructor(delays: number[]) {
    super({ cancelable: false });
    this.delays = delays;
  }
  override async *chatStreamCancellable(
    messages: unknown[],
    _modelConfig: Record<string, unknown>,
    _toolDefs: Record<string, unknown>[],
    _signal: AbortSignal | null | undefined,
  ): AsyncGenerator<Record<string, unknown>> {
    const step = Math.min(this.callCount, this.delays.length - 1);
    this.callCount++;
    this.lastMessages = messages;
    await sleep(this.delays[step] ?? 0);
    // First attempt (per script <=0 delay sentinel) throws; later succeed.
    if (step < this.delays.length - 1) {
      throw LlmError.Api("transient 500", 500);
    }
    yield { type: "content", content: "done" };
    yield { type: "usage", data: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } };
  }
}

function usageEvents(events: Array<Record<string, unknown>>): TokenUsageEvent[] {
  return events.filter((e) => e.type === OUTPUT_EVENT.TOKEN_USAGE) as unknown as TokenUsageEvent[];
}

describe("token_usage emit carries the call's wall time", () => {
  it("a completed call emits a finite, non-negative durationMs", async () => {
    const events: Array<Record<string, unknown>> = [];
    const mockLLM = new MockLLMClient({
      responseSequences: [[
        { type: "content", content: "hi" },
        { type: "usage", data: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } },
      ]],
    });
    const { agent } = createFixture({
      mockLLM,
      sink: { emit: (event) => events.push(event as unknown as Record<string, unknown>) },
    });
    await agent.run("test");
    const usage = usageEvents(events);
    expect(usage).toHaveLength(1);
    expect(typeof usage[0]!.durationMs).toBe("number");
    expect(Number.isFinite(usage[0]!.durationMs)).toBe(true);
    expect(usage[0]!.durationMs!).toBeGreaterThanOrEqual(0);
  });

  it("the measured span is the call, not the whole turn (below the run wall time)", async () => {
    const events: Array<Record<string, unknown>> = [];
    const client = new TimingLLMClient([25]); // one attempt, 25ms before stream
    const { agent } = createFixture({
      mockLLM: client as unknown as MockLLMClient,
      sink: { emit: (event) => events.push(event as unknown as Record<string, unknown>) },
    });
    const started = Date.now();
    await agent.run("test");
    const totalMs = Date.now() - started;
    const usage = usageEvents(events);
    expect(usage).toHaveLength(1);
    // Includes the client's own wait...
    expect(usage[0]!.durationMs!).toBeGreaterThanOrEqual(25);
    // ...but never exceeds the whole run wall time.
    expect(usage[0]!.durationMs!).toBeLessThanOrEqual(totalMs);
  });

  it("a retried logical call's durationMs includes the failed attempt", async () => {
    const events: Array<Record<string, unknown>> = [];
    // attempt 0: 20ms then throws; attempt 1 (the retry): 30ms then succeeds.
    const client = new TimingLLMClient([20, 30]);
    const { hooks, agent } = createFixture({
      mockLLM: client as unknown as MockLLMClient,
      sink: { emit: (event) => events.push(event as unknown as Record<string, unknown>) },
    });
    // Exactly one retry, the contract of the PROVIDER_ERROR seam.
    hooks.on(HOOKS.PROVIDER_ERROR, (p) => {
      (p as { retry: boolean }).retry = true;
      return p;
    });
    await agent.run("test");
    expect(client.callCount).toBe(2); // the retry actually re-issued
    const usage = usageEvents(events);
    expect(usage).toHaveLength(1);
    // Both attempts' waits are inside the one measured span.
    expect(usage[0]!.durationMs!).toBeGreaterThanOrEqual(50);
  });

  it("a provider that keeps usage private emits no token_usage, so no duration is invented", async () => {
    const events: Array<Record<string, unknown>> = [];
    const mockLLM = new MockLLMClient({
      responseSequences: [[{ type: "content", content: "no usage here" }]],
    });
    const { agent } = createFixture({
      mockLLM,
      sink: { emit: (event) => events.push(event as unknown as Record<string, unknown>) },
    });
    await agent.run("test");
    // No usage record at all -> nothing to attach a duration to: honest silence.
    expect(usageEvents(events)).toHaveLength(0);
  });
});
