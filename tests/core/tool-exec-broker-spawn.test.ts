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
// AUXILIARY seam, not e2e: this file tests the DIRECT broker constructor,
// so the descriptor list is part of what it constructs. Zero-hand-passed
// proof: tests/core/tool-exec-wire-plane.test.ts.
import { poolWireDescriptors } from "../fixtures/wire-descriptors.ts";

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
  broker = new ToolExecBroker({ fence: "off", toolDescriptors: poolWireDescriptors() });
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

  it("a warm-spawned entry carries the register frame (invoke reuses it, never respawns tool-less)", async () => {
    // warm spawns the entry, the invoke REUSES it (same key, same fence
    // id): success proves the register reached the warm-time spawn too.
    broker.warm("warm-entry", "rw", { roots: [dir], deny: [] });
    const result = await broker.invoke({
      session: "warm-entry",
      tool: "bash",
      args: { command: "echo warm-loaded" },
      ctx: { session: "warm-entry", workspace: { roots: [dir], deny: [] }, toolConfig: TOOL_CONFIG },
    });
    expect(result.kind === "tool-result" && result.output).toContain("warm-loaded");
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
    const tight = new ToolExecBroker({ fence: "off", toolDescriptors: poolWireDescriptors() });
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
    const open = new ToolExecBroker({ fence: "off", envScrubbing: false, toolDescriptors: poolWireDescriptors() });
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

// ── Descriptor discipline (runner-side validation) ───────────────────────────
//
// The runner-side file:-under-PROJECT_ROOT check is the belt against FORGED
// frames, not the containment boundary. A rogue module outside the root
// writes a sentinel file when imported: a refused descriptor must leave no
// sentinel AND answer the loud unknown-tool error, while sibling descriptors
// in the SAME register frame keep working (per-descriptor refusal, never a
// whole-frame abort).

import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { PROJECT_ROOT, RUNNER_ENTRY } from "@core/tool-exec-layout.ts";
import { WIRE_FACTORIES_EXPORT } from "@core/tool-exec-protocol.ts";

describe("descriptor discipline (real runner)", () => {
  it("refuses a descriptor outside PROJECT_ROOT: no import, loud error, siblings survive", async () => {
    const rogueDir = tmpDir("hotdog-rogue-");
    const sentinel = join(rogueDir, "imported.sentinel");
    const rogueModule = join(rogueDir, "rogue.ts");
    fs.writeFileSync(rogueModule, `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(sentinel)}, "imported");
      export const ${WIRE_FACTORIES_EXPORT} = { rogue: () => { throw new Error("nope"); } };
    `);
    const rogueUrl = pathToFileURL(rogueModule).href;
    const broker = new ToolExecBroker({
      fence: "off",
      toolDescriptors: [
        { tool: "bash", module: pathToFileURL(join(import.meta.dir, "../../src/extensions/bash-tool/index.ts")).href, factory: WIRE_FACTORIES_EXPORT },
        { tool: "rogue", module: rogueUrl, factory: WIRE_FACTORIES_EXPORT },
      ],
    });
    try {
      await expect(
        broker.invoke({ session: "rogue", tool: "rogue", args: {}, ctx: ctx() }),
      ).rejects.toThrow(/not registered in the runner/);
      expect(fs.existsSync(sentinel)).toBe(false); // never imported
      // Sibling descriptor from the same register frame still serves calls.
      const ok = await broker.invoke({
        session: "rogue",
        tool: "bash",
        args: { command: "echo sibling-ok" },
        ctx: ctx(),
      });
      expect(ok.kind).toBe("tool-result");
      expect(ok.kind === "tool-result" && ok.output).toContain("sibling-ok");
    } finally {
      await broker.close();
      cleanupDir(rogueDir);
    }
  });

  it("refuses non-file: schemes, ../ traversals and NUL-byte paths as a group, sibling survives", async () => {
    const bad = [
      { tool: "https", module: "https://example.invalid/x.ts", factory: WIRE_FACTORIES_EXPORT },
      { tool: "node", module: "node:fs", factory: WIRE_FACTORIES_EXPORT },
      // Raw `..` segments in the href: they normalize OUTSIDE the root, and
      // the runner must resolve-then-compare rather than substring-match.
      { tool: "escape", module: pathToFileURL(PROJECT_ROOT.endsWith("/") ? PROJECT_ROOT.slice(0, -1) : PROJECT_ROOT).href + "/../../../etc/passwd", factory: WIRE_FACTORIES_EXPORT },
      // Bun decodes %00 where Node's fileURLToPath throws, so the lexical
      // check must refuse the NUL itself (it can never name an existing file).
      { tool: "nul", module: pathToFileURL(PROJECT_ROOT.endsWith("/") ? PROJECT_ROOT.slice(0, -1) : PROJECT_ROOT).href + "/src/x%00.ts", factory: WIRE_FACTORIES_EXPORT },
    ];
    const broker = new ToolExecBroker({
      fence: "off",
      toolDescriptors: [
        { tool: "bash", module: pathToFileURL(join(import.meta.dir, "../../src/extensions/bash-tool/index.ts")).href, factory: WIRE_FACTORIES_EXPORT },
        ...bad,
      ],
    });
    try {
      for (const d of bad) {
        await expect(
          broker.invoke({ session: "schemes", tool: d.tool, args: {}, ctx: ctx() }),
        ).rejects.toThrow(/not registered in the runner/);
      }
      const ok = await broker.invoke({
        session: "schemes",
        tool: "bash",
        args: { command: "echo survivors" },
        ctx: ctx(),
      });
      expect(ok.kind === "tool-result" && ok.output).toContain("survivors");
    } finally {
      await broker.close();
    }
  });

  it("a missing required numeric rides the fail frame with the E1 message; the runner lives on", async () => {
    const broker = new ToolExecBroker({ fence: "off", toolDescriptors: poolWireDescriptors() });
    try {
      // bash with no bashTool.bashTimeoutMs -> reqWireNum throws ConfigError
      // with the exact `tool-exec ctx: missing numeric config <key>` shape.
      const noTimeout = {
        session: "missing",
        workspace: { roots: [dir], deny: [".env*"] },
        toolConfig: { bashTool: { maxToolOutputLines: 100 }, coreTools: {}, envScrubbing: true, envScrubExtra: [] },
      };
      await expect(
        broker.invoke({ session: "missing", tool: "bash", args: { command: "true" }, ctx: noTimeout }),
      ).rejects.toThrow(/tool-exec ctx: missing numeric config bashTool\.bashTimeoutMs/);
      // Same entry, next call with a complete ctx: fine (the failed build did
      // not poison the runner).
      const ok = await broker.invoke({ session: "missing", tool: "bash", args: { command: "echo after-config-error" }, ctx: ctx() });
      expect(ok.kind === "tool-result" && ok.output).toContain("after-config-error");
    } finally {
      await broker.close();
    }
  });
});


// ── register replacement vs an in-flight lazy import (direct runner) ────────
//
// Register REPLACES the tool map totally; a lazy import still in flight when
// a replacement lands must not reinstate a factory whose descriptor was just
// evicted. The broker API sends one register per runner birth, so this
// drives the runner's frame loop directly on its stdin.

describe("register replacement mid-import (direct runner)", () => {
  it("a register landing during the import leaves the evicted tool unregistered", async () => {
    const proc = spawn(process.execPath, [RUNNER_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: PROJECT_ROOT,
    });
    const frames: Array<Record<string, unknown>> = [];
    proc.stdout!.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (!line.trim()) continue;
        try {
          frames.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* not a frame line */
        }
      }
    });
    proc.stderr!.on("data", () => {});
    proc.stdin!.on("error", () => {});
    const write = (frame: Record<string, unknown>): void => {
      proc.stdin!.write(JSON.stringify(frame) + "\n");
    };
    const slowModule = pathToFileURL(join(import.meta.dir, "../fixtures/wire-slow-import.ts")).href;
    const raceCtx: WireToolCtx = {
      session: "race",
      workspace: { roots: [dir], deny: [] },
      toolConfig: TOOL_CONFIG,
    };
    try {
      // register -> invoke (the fixture import lags 400ms) -> a register
      // replacing the map, all on the FIFO before the import settles.
      write({ op: "register", tools: [{ tool: "slow", module: slowModule, factory: WIRE_FACTORIES_EXPORT }] });
      write({ op: "invoke", id: "race-1", session: "race", tool: "slow", args: {}, ctx: raceCtx });
      write({ op: "register", tools: [] });
      await new Promise((r) => setTimeout(r, 900)); // the in-flight import resolves here
      write({ op: "invoke", id: "race-2", session: "race", tool: "slow", args: {}, ctx: raceCtx });
      const deadline = Date.now() + 8000;
      for (;;) {
        const answered = ["race-1", "race-2"].every((id) => frames.some((f) => f.id === id));
        if (answered) break;
        if (Date.now() > deadline) throw new Error("timed out waiting for both race replies");
        await new Promise((r) => setTimeout(r, 10));
      }
      const errors = frames
        .filter((f) => f.id === "race-1" || f.id === "race-2")
        .map((f) => (f.ok === true ? "ok" : String((f.error as { message?: string })?.message ?? "")));
      expect(errors).toHaveLength(2);
      // Neither call may run the evicted tool: the stale import result falls,
      // it never re-enters the factory cache.
      for (const msg of errors) expect(msg).toMatch(/not registered in the runner/);
    } finally {
      proc.stdin!.end();
      proc.kill();
    }
  });
});
