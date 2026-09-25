import { describe, expect, it } from "bun:test";
import { HOOKS } from "@core/hooks.ts";
import { create } from "@extensions/workflows/index.ts";
import {
  runWorkflowCommand,
  runWorkflowCommandOnText,
} from "@extensions/workflows/workflow-cli.ts";
import { parseWorkflow, renderWorkflow } from "@extensions/workflows/workflow.ts";

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
