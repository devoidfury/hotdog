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
  coreTools: { readToolLimit: 500, maxImageSize: 10485760, grepMaxResults: 50, maxToolOutputLines: 600 },
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

// ── Env posture (envScrubbing) ──────────────────────────────────────────────
//
// Scrubbing happens on two hops: the broker spawn (supervisor -> broker child,
// inherited by every pool entry) and the runner's BashTool. The sentinel is
// secret-shaped (HOTDOG* is scrubbed by the heuristic); set it AFTER module
// setup and build a broker per case so each spawn sees the env it claims to.

describe("broker env posture (envScrubbing)", () => {
  const SENTINEL = "HOTDOG_SPAWN_ENV_SENTINEL";
  const echoSentinel = { command: `echo "v=\${${SENTINEL}:-gone}"` };

  it("scrubs secret-shaped keys into the plane by default", async () => {
    process.env[SENTINEL] = "plane-visible";
    const tight = new ToolExecBroker({ fence: "off" });
    try {
      const result = await tight.invoke({
        session: "spawn-tight-env",
        tool: "bash",
        args: echoSentinel,
        ctx: ctx(),
      });
      expect(result.kind).toBe("tool-result");
      if (result.kind !== "tool-result") return;
      expect(result.output).toContain("v=gone");
    } finally {
      await tight.close();
      delete process.env[SENTINEL];
    }
  });

  it("envScrubbing off: the full copy reaches bash (--disable-env-scrubbing respected)", async () => {
    process.env[SENTINEL] = "plane-visible";
    const open = new ToolExecBroker({ fence: "off", envScrubbing: false });
    try {
      const result = await open.invoke({
        session: "spawn-open-env",
        tool: "bash",
        args: echoSentinel,
        ctx: {
          session: "spawn-open-env",
          workspace: { roots: [dir], deny: [".env*"] },
          // The runner honors the same opt-out on its hop (agent-factory
          // passes the resolved value in the wire toolConfig).
          toolConfig: { ...TOOL_CONFIG, envScrubbing: false },
        },
      });
      expect(result.kind).toBe("tool-result");
      if (result.kind !== "tool-result") return;
      expect(result.output).toContain("v=plane-visible");
    } finally {
      await open.close();
      delete process.env[SENTINEL];
    }
  });
});

// ── spawnEnv rides the frame into the runner's child (policy proxy lane) ────

describe("broker spawnEnv (real spawn)", () => {
  const POLICY = { HTTP_PROXY: "http://spawn-test:tok@127.0.0.1:5999", NO_PROXY: "127.0.0.1,localhost,::1" };

  it("the runner merges frame.ctx.spawnEnv into the bash child, last", async () => {
    const result = await broker.invoke({
      session: "spawn-test",
      tool: "bash",
      args: { command: 'echo "h=$HTTP_PROXY n=$NO_PROXY"' },
      ctx: { ...ctx(), spawnEnv: POLICY },
    });
    expect(result.kind).toBe("tool-result");
    if (result.kind !== "tool-result") return;
    expect(result.output).toContain(`h=${POLICY.HTTP_PROXY}`);
    expect(result.output).toContain(`n=${POLICY.NO_PROXY}`);
  });

  it("per-call: the reused pool entry injects nothing once the frame stops carrying it", async () => {
    // Same (session, class) entry as above. hotdog must ADD nothing, so the
    // child keeps whatever the host env had (pass-through, not injection).
    const probe =
      'bun -e "console.log(JSON.stringify({h: process.env.HTTP_PROXY ?? null}))"';
    const result = await broker.invoke({
      session: "spawn-test",
      tool: "bash",
      args: { command: probe },
      ctx: ctx(),
    });
    expect(result.kind).toBe("tool-result");
    if (result.kind !== "tool-result") return;
    expect(JSON.parse(result.output.trim()).h).toBe(process.env.HTTP_PROXY ?? null);
  });
});
