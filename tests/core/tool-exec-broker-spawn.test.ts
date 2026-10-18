// Real-spawn integration: supervisor-side ToolExecBroker -> broker child ->
// pooled runner executing the pilot tools for real. One broker (and one `rw`
// pool entry) is shared across the file to respect the <10s suite budget;
// no fleet, no LLM endpoints, fixture files only.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";
import { ToolExecBroker } from "@core/tool-exec-broker.ts";
import type { WireToolCtx } from "@core/tool-exec-protocol.ts";
import { tmpDir, cleanupDir } from "../mocks/io.ts";

const TOOL_CONFIG = {
  bashTool: { bashTimeoutMs: 5000, maxToolOutputLines: 100, maxTimeoutMs: 10000 },
  coreTools: { readToolLimit: 500, grepMaxResults: 50, maxToolOutputLines: 600 },
  envScrubbing: true,
  envScrubExtra: [],
};

let dir: string;
let broker: ToolExecBroker;

function ctx(overrides: Partial<WireToolCtx["workspace"]> = {}): WireToolCtx {
  return {
    session: "spawn-test",
    workspace: { roots: [dir], deny: [".env*", ".git"], ...overrides },
    toolConfig: TOOL_CONFIG,
  };
}

beforeAll(() => {
  dir = tmpDir("hotdog-txexec-");
  fs.writeFileSync(join(dir, "hello.txt"), "runner content\n");
  fs.writeFileSync(join(dir, ".env"), "SECRET=never-read\n");
  fs.writeFileSync(join(dir, "haystack.txt"), "needle here\nline two\n");
  broker = new ToolExecBroker({ fence: "off" });
});

afterAll(async () => {
  await broker.close();
  cleanupDir(dir);
});

describe("broker worker (real spawn)", () => {
  it("runs bash in the pooled runner", async () => {
    const result = await broker.invoke({
      session: "spawn-test",
      tool: "bash",
      args: { command: "echo hi && pwd" },
      ctx: ctx(),
    });
    expect(result.kind).toBe("tool-result");
    if (result.kind !== "tool-result") return;
    expect(result.success).toBe(true);
    expect(result.output).toContain("hi");
    // The runner spawns from the workspace root, not the repo root.
    expect(result.output).toContain(fs.realpathSync(dir));
    expect(result.metadata).toContainEqual(["exit_code", "0"]);
  });

  it("reuses the pool entry and rebuilds the workspace from ctx", async () => {
    const result = await broker.invoke({
      session: "spawn-test",
      tool: "read",
      args: { path: "hello.txt" },
      ctx: ctx(),
    });
    expect(result.kind).toBe("tool-result");
    if (result.kind !== "tool-result") return;
    expect(result.success).toBe(true);
    expect(result.output).toContain("runner content");
  });

  it("enforces the ctx deny list runner-side (belt under the fence)", async () => {
    const result = await broker.invoke({
      session: "spawn-test",
      tool: "read",
      args: { path: ".env" },
      ctx: ctx(),
    });
    expect(result.kind).toBe("tool-result");
    if (result.kind !== "tool-result") return;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Denylisted");
  });

  it("runs grep in the same pooled entry", async () => {
    const result = await broker.invoke({
      session: "spawn-test",
      tool: "grep",
      args: { pattern: "needle" },
      ctx: ctx(),
    });
    expect(result.kind).toBe("tool-result");
    if (result.kind !== "tool-result") return;
    expect(result.success).toBe(true);
    expect(result.output).toContain("haystack.txt");
  });

  it("rejects with an error for a tool the runner does not host", async () => {
    await expect(
      broker.invoke({
        session: "spawn-test",
        tool: "not-a-pilot",
        args: {},
        ctx: ctx(),
      }),
    ).rejects.toThrow(/not registered in the runner/);
  });
});
