// Tests for the metrics extension — CSV export of LLM run metrics.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { create, buildCsvRow, csvEscape, computeMetricsRow } from "../../src/extensions/metrics/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { createMockCore } from "../helpers.ts";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

describe("metrics extension", () => {
  let testDir: string;
  let metricsFile: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `hotdog-metrics-test-${Date.now()}`);
    metricsFile = join(testDir, "metrics.csv");
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("returns extension with hooks", async () => {
    const core = createMockCore() as any;
    core.config = { ...core.config, metrics: { outputFile: metricsFile } };
    const ext = await create(core) as any;
    expect(ext.hooks).toBeDefined();
    expect(ext.hooks[HOOKS.PROVIDER_REQUEST]).toBeDefined();
    expect(ext.hooks[HOOKS.OUTPUT_EVENT]).toBeDefined();
    expect(ext.hooks[HOOKS.PROVIDER_RESPONSE]).toBeDefined();
    expect(ext.hooks[HOOKS.TURN_END]).toBeDefined();
  });

  it("writes CSV with header on first run", async () => {
    await mkdir(testDir, { recursive: true });
    const core = createMockCore() as any;
    core.config = { ...core.config, metrics: { outputFile: metricsFile } };
    const ext = await create(core) as any;
    const hooks = ext.hooks;

    // Simulate a full turn
    // 1. provider:request
    const requestHook = hooks[HOOKS.PROVIDER_REQUEST] as (ctx: any) => void;
    requestHook({ modelConfig: { name: "openai/gpt-4" } });

    // 2. output:event streaming_chunk (for TTFT)
    const outputHook = hooks[HOOKS.OUTPUT_EVENT] as (ctx: any) => void;
    outputHook({ type: "streaming_chunk", agent: { sessionId: "test-session" } });

    // 3. provider:response
    const responseHook = hooks[HOOKS.PROVIDER_RESPONSE] as (ctx: any) => void;
    responseHook({
      response: {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
      },
      modelConfig: { name: "openai/gpt-4" },
    });

    // 4. turn:end with stopped: true
    const turnEndHook = hooks[HOOKS.TURN_END] as (ctx: any) => Promise<void>;
    await turnEndHook({ stopped: true, turnIndex: 1, agent: { sessionId: "test-session" } });

    // Read the CSV file
    const content = await readFile(metricsFile, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2); // header + 1 data row

    // Check header
    expect(lines[0]).toContain("timestamp");
    expect(lines[0]).toContain("model");
    expect(lines[0]).toContain("backend");
    expect(lines[0]).toContain("prompt_tokens");
    expect(lines[0]).toContain("completion_tokens");
    expect(lines[0]).toContain("ttft_ms");
    expect(lines[0]).toContain("tok_per_sec");
    expect(lines[0]).toContain("memory_bytes");
    expect(lines[0]).toContain("workload_label");

    // Check data row
    const dataLine = lines[1];
    expect(dataLine).toContain("openai/gpt-4");
    expect(dataLine).toContain("openai");
    expect(dataLine).toContain("100");
    expect(dataLine).toContain("50");
    expect(dataLine).toContain("hotdog");
  });

  it("appends to existing CSV without duplicating header", async () => {
    await mkdir(testDir, { recursive: true });
    // Pre-create file with header
    await writeFile(metricsFile, "timestamp,model,backend,prompt_tokens,completion_tokens,ttft_ms,tok_per_sec,memory_bytes,workload_label\n");

    const core = createMockCore() as any;
    core.config = { ...core.config, metrics: { outputFile: metricsFile } };
    const ext = await create(core) as any;
    const hooks = ext.hooks;

    // Simulate a turn
    const requestHook = hooks[HOOKS.PROVIDER_REQUEST] as (ctx: any) => void;
    requestHook({ modelConfig: { name: "anthropic/claude-3" } });

    const outputHook = hooks[HOOKS.OUTPUT_EVENT] as (ctx: any) => void;
    outputHook({ type: "streaming_chunk", agent: { sessionId: "test-session" } });

    const responseHook = hooks[HOOKS.PROVIDER_RESPONSE] as (ctx: any) => void;
    responseHook({
      response: {
        usage: {
          prompt_tokens: 200,
          completion_tokens: 100,
        },
      },
      modelConfig: { name: "anthropic/claude-3" },
    });

    const turnEndHook = hooks[HOOKS.TURN_END] as (ctx: any) => Promise<void>;
    await turnEndHook({ stopped: true, turnIndex: 1, agent: { sessionId: "test-session" } });

    const content = await readFile(metricsFile, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2); // original header + 1 new data row
    expect(lines[0]).toContain("timestamp");
    expect(lines[1]).toContain("anthropic/claude-3");
  });

  it("does not write CSV row for non-stopped turns", async () => {
    await mkdir(testDir, { recursive: true });
    const core = createMockCore() as any;
    core.config = { ...core.config, metrics: { outputFile: metricsFile } };
    const ext = await create(core) as any;
    const hooks = ext.hooks;

    // Simulate a non-final turn
    const requestHook = hooks[HOOKS.PROVIDER_REQUEST] as (ctx: any) => void;
    requestHook({ modelConfig: { name: "openai/gpt-4" } });

    const responseHook = hooks[HOOKS.PROVIDER_RESPONSE] as (ctx: any) => void;
    responseHook({
      response: {
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      },
      modelConfig: { name: "openai/gpt-4" },
    });

    // turn:end with stopped: false (tool execution continues)
    const turnEndHook = hooks[HOOKS.TURN_END] as (ctx: any) => Promise<void>;
    await turnEndHook({ stopped: false, turnIndex: 1, agent: { sessionId: "test-session" } });

    // File should not exist
    try {
      await readFile(metricsFile, "utf-8");
      expect(false).toBe(true); // Should not reach here
    } catch {
      // Expected — file was not created
    }
  });

  it("captures TTFT from first streaming chunk", async () => {
    await mkdir(testDir, { recursive: true });
    const core = createMockCore() as any;
    core.config = { ...core.config, metrics: { outputFile: metricsFile } };
    const ext = await create(core) as any;
    const hooks = ext.hooks;

    const requestHook = hooks[HOOKS.PROVIDER_REQUEST] as (ctx: any) => void;
    requestHook({ modelConfig: { name: "openai/gpt-4" } });

    // Small delay to ensure TTFT is measurable
    await new Promise((r) => setTimeout(r, 50));

    const outputHook = hooks[HOOKS.OUTPUT_EVENT] as (ctx: any) => void;
    outputHook({ type: "streaming_chunk", agent: { sessionId: "test-session" } });

    const responseHook = hooks[HOOKS.PROVIDER_RESPONSE] as (ctx: any) => void;
    responseHook({
      response: {
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      },
      modelConfig: { name: "openai/gpt-4" },
    });

    const turnEndHook = hooks[HOOKS.TURN_END] as (ctx: any) => Promise<void>;
    await turnEndHook({ stopped: true, turnIndex: 1, agent: { sessionId: "test-session" } });

    const content = await readFile(metricsFile, "utf-8");
    const lines = content.trim().split("\n");
    const dataLine = lines[1];
    // TTFT should be > 0 (at least ~50ms from our delay)
    const fields = dataLine.split(",");
    const ttftMs = parseInt(fields[5]);
    expect(ttftMs).toBeGreaterThanOrEqual(40);
  });

  it("ignores non-streaming_chunk output events for TTFT", async () => {
    await mkdir(testDir, { recursive: true });
    const core = createMockCore() as any;
    core.config = { ...core.config, metrics: { outputFile: metricsFile } };
    const ext = await create(core) as any;
    const hooks = ext.hooks;

    const requestHook = hooks[HOOKS.PROVIDER_REQUEST] as (ctx: any) => void;
    requestHook({ modelConfig: { name: "openai/gpt-4" } });

    // Non-streaming events should not set TTFT
    const outputHook = hooks[HOOKS.OUTPUT_EVENT] as (ctx: any) => void;
    outputHook({ type: "user_message", agent: { sessionId: "test" } });
    outputHook({ type: "token_usage", agent: { sessionId: "test" } });
    outputHook({ type: "compaction_result", agent: { sessionId: "test" } });

    const responseHook = hooks[HOOKS.PROVIDER_RESPONSE] as (ctx: any) => void;
    responseHook({
      response: {
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      },
      modelConfig: { name: "openai/gpt-4" },
    });

    const turnEndHook = hooks[HOOKS.TURN_END] as (ctx: any) => Promise<void>;
    await turnEndHook({ stopped: true, turnIndex: 1, agent: { sessionId: "test-session" } });

    const content = await readFile(metricsFile, "utf-8");
    const lines = content.trim().split("\n");
    const dataLine = lines[1];
    const fields = dataLine.split(",");
    // TTFT should be 0 since no streaming_chunk was received
    const ttftMs = parseInt(fields[5]);
    expect(ttftMs).toBe(0);
  });

  it("handles missing usage data gracefully", async () => {
    await mkdir(testDir, { recursive: true });
    const core = createMockCore() as any;
    core.config = { ...core.config, metrics: { outputFile: metricsFile } };
    const ext = await create(core) as any;
    const hooks = ext.hooks;

    const requestHook = hooks[HOOKS.PROVIDER_REQUEST] as (ctx: any) => void;
    requestHook({ modelConfig: { name: "test/model" } });

    const responseHook = hooks[HOOKS.PROVIDER_RESPONSE] as (ctx: any) => void;
    responseHook({
      response: {}, // No usage data
      modelConfig: { name: "test/model" },
    });

    const turnEndHook = hooks[HOOKS.TURN_END] as (ctx: any) => Promise<void>;
    await turnEndHook({ stopped: true, turnIndex: 1, agent: { sessionId: "test-session" } });

    const content = await readFile(metricsFile, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    // Token counts should be 0
    const dataLine = lines[1];
    const fields = dataLine.split(",");
    expect(parseInt(fields[3])).toBe(0); // prompt_tokens
    expect(parseInt(fields[4])).toBe(0); // completion_tokens
  });
});

describe("metrics csvEscape", () => {
  it("returns value as-is for simple strings", () => {
    expect(csvEscape("hello")).toBe("hello");
    expect(csvEscape(123)).toBe("123");
  });

  it("wraps in quotes when value contains comma", () => {
    expect(csvEscape("hello, world")).toBe('"hello, world"');
  });

  it("wraps in quotes and escapes internal quotes", () => {
    expect(csvEscape('say "hello"')).toBe('"say ""hello"""');
  });

  it("wraps in quotes when value contains newline", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("metrics buildCsvRow", () => {
  it("builds correct CSV row", () => {
    const row = {
      timestamp: "2024-01-01T00:00:00.000Z",
      model: "openai/gpt-4",
      backend: "openai",
      prompt_tokens: 100,
      completion_tokens: 50,
      ttft_ms: 200,
      tok_per_sec: 25.5,
      memory_bytes: 0,
      workload_label: "hotdog",
    };
    const csv = buildCsvRow(row);
    expect(csv).toBe("2024-01-01T00:00:00.000Z,openai/gpt-4,openai,100,50,200,25.5,0,hotdog");
  });
});

describe("metrics computeMetricsRow", () => {
  it("computes correct tok/s from duration and completion tokens", () => {
    const turn = {
      turnIndex: 1,
      sessionId: "test",
      requestStartMs: 1000,
      firstTokenMs: 1200,
      responseEndMs: 3000,
      model: "openai/gpt-4",
      backend: "openai",
      promptTokens: 100,
      completionTokens: 200,
      memoryBytes: 0,
    };
    const row = computeMetricsRow(turn as any);
    expect(row.ttft_ms).toBe(200);
    // 200 tokens / 2000ms = 100 tok/s
    expect(row.tok_per_sec).toBe(100);
    expect(row.prompt_tokens).toBe(100);
    expect(row.completion_tokens).toBe(200);
    expect(row.workload_label).toBe("hotdog");
  });

  it("handles zero duration gracefully", () => {
    const turn = {
      turnIndex: 1,
      sessionId: "test",
      requestStartMs: 1000,
      firstTokenMs: 1000,
      responseEndMs: 1000,
      model: "openai/gpt-4",
      backend: "openai",
      promptTokens: 100,
      completionTokens: 50,
      memoryBytes: null,
    };
    const row = computeMetricsRow(turn as any);
    expect(row.ttft_ms).toBe(0);
    expect(row.tok_per_sec).toBe(0);
    expect(row.memory_bytes).toBe(0);
  });

  it("handles null values gracefully", () => {
    const turn = {
      turnIndex: 1,
      sessionId: "test",
      requestStartMs: null,
      firstTokenMs: null,
      responseEndMs: null,
      model: null,
      backend: null,
      promptTokens: null,
      completionTokens: null,
      memoryBytes: null,
    };
    const row = computeMetricsRow(turn as any);
    expect(row.model).toBe("unknown");
    expect(row.backend).toBe("unknown");
    expect(row.prompt_tokens).toBe(0);
    expect(row.completion_tokens).toBe(0);
    expect(row.ttft_ms).toBe(0);
    expect(row.tok_per_sec).toBe(0);
    expect(row.memory_bytes).toBe(0);
  });

  it("rounds tok/s to 2 decimal places", () => {
    const turn = {
      turnIndex: 1,
      sessionId: "test",
      requestStartMs: 1000,
      firstTokenMs: 1100,
      responseEndMs: 1300,
      model: "test/model",
      backend: "test",
      promptTokens: 100,
      completionTokens: 33,
      memoryBytes: 0,
    };
    const row = computeMetricsRow(turn as any);
    // 33 tokens / 300ms = 110 tok/s
    expect(row.tok_per_sec).toBe(110);
  });
});
