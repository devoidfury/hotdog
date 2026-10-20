import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOOKS } from "@core/hooks.ts";
import { buildUnifiedSchema, resolveKey } from "@core/config/schema-loader.ts";
import { create } from "@extensions/workflows/index.ts";
import {
  runWorkflowCommand,
  runWorkflowCommandOnText,
} from "@extensions/workflows/workflow-cli.ts";
import { parseWorkflow, renderWorkflow } from "@extensions/workflows/workflow.ts";
import { RunRegistry, WorkflowDispatchTool } from "@extensions/workflows/workflow-tools.ts";

const VALID = `
version: 1
name: cli-smoke
description: valid for the cli
nodes:
  - id: a
  - id: b
    dependsOn: [a]
`;

describe("runWorkflowCommandOnText", () => {
  it("validate prints a one-line summary", () => {
    const r = runWorkflowCommandOnText("validate", "f.yaml", VALID);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["valid: cli-smoke (2 nodes)"]);
    expect(r.err).toEqual([]);
  });

  it("validate lists collected errors and exits 1", () => {
    const r = runWorkflowCommandOnText("validate", "f.yaml", "version: 9\nnodes: notalist\n");
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("invalid workflow: f.yaml");
    expect(r.err.join("\n")).toContain("version must be 1");
    expect(r.err.join("\n")).toContain("'nodes' must be a non-empty array");
  });

  it("render matches renderWorkflow exactly", () => {
    const wf = parseWorkflow(VALID).workflow!;
    const r = runWorkflowCommandOnText("render", "f.yaml", VALID);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe(renderWorkflow(wf).replace(/\n$/, ""));
  });

  it("warnings ride stdout even when valid", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `  - id: n${i}`).join("\n");
    const r = runWorkflowCommandOnText(
      "validate",
      "f.yaml",
      `version: 1\nname: big\ndescription: d\nnodes:\n${nine}`,
    );
    expect(r.code).toBe(0);
    expect(r.out.some((l) => l.startsWith("warning:") && l.includes("soft cap"))).toBe(true);
  });
});

describe("runWorkflowCommand (args + I/O)", () => {
  it("rejects missing/unknown verbs with usage", async () => {
    expect((await runWorkflowCommand([])).err[0]).toContain("usage:");
    expect((await runWorkflowCommand(["validate"])).code).toBe(1);
    const r = await runWorkflowCommand(["frobnicate", "x.yaml"]);
    expect(r.err[0]).toContain("unknown verb 'frobnicate'");
  });

  it("reports unreadable files", async () => {
    const r = await runWorkflowCommand(["validate", "/tmp/does-not-exist-workflow.yaml"]);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("cannot read");
  });

  it("reads and validates a real file", async () => {
    const path = `/tmp/hotdog-wf-test-${process.pid}.workflow.yaml`;
    await Bun.write(path, VALID);
    const r = await runWorkflowCommand(["validate", path]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe("valid: cli-smoke (2 nodes)");
    await Bun.file(path).delete();
  });
});

describe("extension registration", () => {
  it("registers the 'workflow' subcommand on CLI_SUBCOMMANDS_REGISTER", async () => {
    const registered: Array<{ name: string; handler: unknown }> = [];
    const ext = await create({} as never);
    const hook = ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!;
    await hook({
      register: (name: string, def: { handler: unknown }) => registered.push({ name, handler: def.handler }),
    } as never);
    expect(registered.length).toBe(1);
    expect(registered[0]!.name).toBe("workflow");
    expect(typeof registered[0]!.handler).toBe("function");
  });
});

describe("workflows.path default (config schema)", () => {
  // Resolves the REAL workflows extension.json schema through the shared
  // config layer, pinning HOTDOG_DATA_DIR deterministically.
  const ENV = "HOTDOG_DATA_DIR";
  const saved = process.env[ENV];
  const savedSessions = process.env.HOTDOG_SESSIONS_DIR;
  const setEnv = (v: string | undefined) => {
    if (v === undefined) delete process.env[ENV];
    else process.env[ENV] = v;
  };
  afterAll(() => {
    setEnv(saved);
    if (savedSessions === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
    else process.env.HOTDOG_SESSIONS_DIR = savedSessions;
  });

  const extJson = JSON.parse(
    readFileSync(new URL("../../src/extensions/workflows/extension.json", import.meta.url), "utf-8"),
  );
  const schema = buildUnifiedSchema([{ configSchema: extJson.configSchema }]);
  const resolvePath = (config: Record<string, unknown> = {}): string | undefined => {
    const resolved = resolveKey("workflows", schema.workflows, { config });
    return (resolved as { path?: string } | undefined)?.path;
  };

  it("defaults to <data-dir>/workflows when HOTDOG_DATA_DIR is set", () => {
    setEnv("/tmp/hotdog-data-test");
    expect(resolvePath()).toBe("/tmp/hotdog-data-test/workflows");
  });

  it("falls back to ~/.cache/hotdog/workflows when the override is unset", () => {
    setEnv(undefined);
    expect(resolvePath()).toBe(join(homedir(), ".cache", "hotdog", "workflows"));
  });

  it("the sessions-dir override does not leak into the workflows default", () => {
    setEnv(undefined);
    process.env.HOTDOG_SESSIONS_DIR = "/tmp/hotdog-sessions-test";
    try {
      expect(resolvePath()).toBe(join(homedir(), ".cache", "hotdog", "workflows"));
    } finally {
      if (savedSessions === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
      else process.env.HOTDOG_SESSIONS_DIR = savedSessions;
    }
  });

  it("an explicit workflows.path still wins", () => {
    setEnv("/tmp/hotdog-data-test");
    expect(resolvePath({ workflows: { path: "/tmp/explicit-wf" } })).toBe("/tmp/explicit-wf");
  });
});

describe("workflows.enableRuntimeTimeouts (config schema)", () => {
  // Resolves the REAL workflows extension.json through the shared config
  // layer: the key exists, defaults false, and an explicit true passes.
  const extJson = JSON.parse(
    readFileSync(new URL("../../src/extensions/workflows/extension.json", import.meta.url), "utf-8"),
  );
  const schema = buildUnifiedSchema([{ configSchema: extJson.configSchema }]);
  const resolve = (config: Record<string, unknown> = {}): Record<string, unknown> =>
    resolveKey("workflows", schema.workflows, { config }) as Record<string, unknown>;

  it("defaults false and stays false when unset", () => {
    expect(resolve().enableRuntimeTimeouts).toBe(false);
    expect(resolve({ workflows: {} }).enableRuntimeTimeouts).toBe(false);
  });

  it("an explicit true resolves through", () => {
    expect(resolve({ workflows: { enableRuntimeTimeouts: true } }).enableRuntimeTimeouts).toBe(true);
  });
});

describe("runtime-cap text visibility (enableRuntimeTimeouts)", () => {
  const WITH_CAP = `
version: 1
name: captext
description: render text follows the toggle
nodes:
  - id: a
    maxRuntimeMins: 20
`;

  it("renderWorkflow-level: hidden when off, today's bytes when on or unset", () => {
    const on = runWorkflowCommandOnText("render", "f.yaml", WITH_CAP, undefined, undefined, undefined, true);
    expect(on.out[0]).toContain("maxRuntime default");
    expect(on.out[0]).toContain("max-runtime: 20m");
    const bare = runWorkflowCommandOnText("render", "f.yaml", WITH_CAP);
    expect(bare.out[0]).toContain("maxRuntime default"); // no config context: byte-identical to today
    expect(bare.out[0]).toContain("max-runtime: 20m");
    const off = runWorkflowCommandOnText("render", "f.yaml", WITH_CAP, undefined, undefined, undefined, false);
    expect(off.out[0]).not.toContain("maxRuntime");
    expect(off.out[0]).not.toContain("max-runtime");
    expect(off.out[0]).toContain("maxNodes 8"); // the rest of the render is untouched
  });

  it("CLI render follows deps.enableRuntimeTimeouts", async () => {
    const path = `/tmp/hotdog-wf-captext-${process.pid}.workflow.yaml`;
    await Bun.write(path, WITH_CAP);
    try {
      expect((await runWorkflowCommand(["render", path])).out[0]).toContain("maxRuntime default");
      const off = await runWorkflowCommand(["render", path], { enableRuntimeTimeouts: false });
      expect(off.code).toBe(0);
      expect(off.out[0]).not.toContain("maxRuntime");
    } finally {
      await Bun.file(path).delete();
    }
  });

  it("workflow_dispatch toolDef carries the cap note only when caps are on", () => {
    const opts = {
      taskManagerProvider: () => null,
      getRunsRoot: () => null,
      getWorkflowsDir: () => null,
      limits: {},
      registry: new RunRegistry(),
    };
    const on = JSON.stringify(new WorkflowDispatchTool({ ...opts, enableRuntimeTimeouts: true }).toToolDef());
    expect(on).toContain("A node over its maxRuntimeMins (default: 60)");
    const configured = JSON.stringify(
      new WorkflowDispatchTool({ ...opts, limits: { maxRuntimeMins: 45 }, enableRuntimeTimeouts: true }).toToolDef(),
    );
    expect(configured).toContain("A node over its maxRuntimeMins (default: 45)");
    const off = JSON.stringify(new WorkflowDispatchTool({ ...opts, enableRuntimeTimeouts: false }).toToolDef());
    expect(off).not.toContain("maxRuntime");
    const bare = JSON.stringify(new WorkflowDispatchTool(opts).toToolDef());
    expect(bare).toBe(off); // unset behaves as off: the note costs zero prompt bytes
  });
});
