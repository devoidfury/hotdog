import { describe, expect, it } from "bun:test";
import {
  parseWorkflow,
  renderWorkflow,
  topoOrder,
  type Workflow,
} from "@extensions/workflows/workflow.ts";

const MINIMAL = `
version: 1
name: smoke
description: A minimal workflow
nodes:
  - id: build
    profile: fixer
`;

function parseOk(text: string, opts?: Parameters<typeof parseWorkflow>[1]): Workflow {
  const r = parseWorkflow(text, opts);
  if (!r.workflow) throw new Error(`expected valid, errors: ${r.errors.join("; ")}`);
  return r.workflow;
}

function expectErrors(text: string, opts?: Parameters<typeof parseWorkflow>[1]): string[] {
  const r = parseWorkflow(text, opts);
  expect(r.workflow).toBeNull();
  expect(r.errors.length).toBeGreaterThan(0);
  return r.errors;
}

describe("parseWorkflow: happy path", () => {
  it("parses a minimal workflow and fills defaults", () => {
    const wf = parseOk(MINIMAL);
    expect(wf.name).toBe("smoke");
    expect(wf.version).toBe(1);
    expect(wf.limits.maxNodes).toBe(8);
    const node = wf.nodes[0]!;
    expect(node.dependsOn).toEqual([]);
    expect(node.inputs).toEqual({});
    expect(node.accept).toEqual({ files: [], retryOn: ["fail", "reject"], maxAttempts: 1 });
  });

  it("parses a full graph with every field", () => {
    const wf = parseOk(`
      version: 1
      name: full-graph
      description: exercises every schema field
      limits:
        maxNodes: 12
        maxRuntimeMins: 45
      nodes:
        - id: plan
          description: design it
        - id: impl
          profile: fixer
          description: write the code
          requires:
            ctx: 131072
            vision: true
            toolCalls: true
            toolDifficulty: 3
          pin:
            provider: ai365
            model: qwen3.8-27b
          dependsOn: [plan]
          inputs:
            notes: "{{nodes.plan.summary}}"
          accept:
            files: [src/foo.ts]
            judge: review
            retryOn: [fail, reject]
            maxAttempts: 2
          maxRuntimeMins: 20
        - id: review
          profile: explorer
          dependsOn: [impl]
          inputs:
            target: nodes.impl
          accept:
            files: [verdict.json]
    `);
    expect(wf.limits).toEqual({ maxNodes: 12, maxRuntimeMins: 45 });
    const impl = wf.nodes[1]!;
    expect(impl.requires).toEqual({ ctx: 131072, vision: true, toolCalls: true, toolDifficulty: 3 });
    expect(impl.inputs).toEqual({ notes: "nodes.plan.summary" });
    expect(impl.accept).toEqual({ files: ["src/foo.ts"], judge: "review", retryOn: ["fail", "reject"], maxAttempts: 2 });
    expect(topoOrder(wf)).toEqual(["plan", "impl", "review"]);
  });

  it("rejects a judge reachable only via a middle node (gate deadlock)", () => {
    // The engine runs the judge while the gated node is still unsettled; an
    // upstream 'middle' waiting on the gated node could never finish.
    const errors = expectErrors(`
      version: 1
      name: indirect-judge
      description: judge reached via middle node
      nodes:
        - id: build
          accept:
            judge: gate
        - id: middle
          dependsOn: [build]
        - id: gate
          dependsOn: [middle]
    `);
    expect(
      errors.some((e) => e.includes("judge 'gate' has upstream dependency 'middle'") && e.includes("deadlock")),
    ).toBe(true);
  });

  it("accepts a direct judge with extra upstream that ignores the gated node", () => {
    const wf = parseOk(`
      version: 1
      name: shared-ancestor-judge
      description: judge depends on producer directly plus a shared spec
      nodes:
        - id: spec
        - id: build
          dependsOn: [spec]
          accept:
            judge: gate
        - id: gate
          dependsOn: [build, spec]
    `);
    expect(wf.nodes[1]!.accept.judge).toBe("gate");
  });

  it("rejects a judge gating multiple nodes", () => {
    const errors = expectErrors(`
      version: 1
      name: shared-judge
      description: one judge for two producers
      nodes:
        - id: a
          accept:
            judge: gate
        - id: b
          accept:
            judge: gate
        - id: gate
          dependsOn: [a, b]
    `);
    expect(errors.some((e) => e.includes("gates multiple nodes"))).toBe(true);
  });

  it("collects multiple independent errors instead of first-fail", () => {
    const errors = expectErrors(`
      version: 2
      nodes: []
      bogus: 1
    `);
    expect(errors.some((e) => e.includes("version"))).toBe(true);
    expect(errors.some((e) => e.includes("nodes"))).toBe(true);
    expect(errors.some((e) => e.includes("unknown key 'bogus'"))).toBe(true);
    expect(errors.some((e) => e.includes("'name'"))).toBe(true);
    expect(errors.some((e) => e.includes("'description'"))).toBe(true);
  });
});

describe("parseWorkflow: structure", () => {
  it("never throws on broken input", () => {
    for (const bad of ["", "null", "just a string", "- a\n- b", "{[", "\t- : :"]) {
      const r = parseWorkflow(bad);
      expect(r.workflow).toBeNull();
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects duplicate and malformed ids", () => {
    expectErrors(`
      version: 1
      name: dup
      description: d
      nodes:
        - id: a
        - id: a
    `).some((e) => e.includes("duplicate id"));
    expectErrors(`
      version: 1
      name: bad-id
      description: d
      nodes:
        - id: Bad Id
    `);
  });

  it("rejects unknown keys at every level", () => {
    expect(expectErrors(`version: 1\nname: k\ndescription: d\nnodes:\n  - id: a\n    depends: []`).some((e) => e.includes("unknown key 'depends'"))).toBe(true);
    expect(expectErrors(`version: 1\nname: k\ndescription: d\nnodes:\n  - id: a\n    accept:\n      judge2: x`).some((e) => e.includes("unknown key 'judge2'"))).toBe(true);
  });
});

describe("parseWorkflow: graph integrity", () => {
  const wf = (nodes: string) =>
    `version: 1\nname: g\ndescription: d\nnodes:\n${nodes}`;

  it("rejects self-dependency", () => {
    expect(
      expectErrors(wf("  - id: a\n    dependsOn: [a]")).some((e) => e.includes("dependsOn itself")),
    ).toBe(true);
  });

  it("rejects two-node cycles with a readable path", () => {
    const errors = expectErrors(
      wf("  - id: a\n    dependsOn: [b]\n  - id: b\n    dependsOn: [a]"),
    );
    const cyc = errors.find((e) => e.startsWith("cycle:"));
    expect(cyc).toBeDefined();
    expect(cyc!).toMatch(/a -> b -> a|b -> a -> b/);
  });

  it("detects cycles introduced only by data edges", () => {
    expect(
      expectErrors(
        wf("  - id: a\n    inputs:\n      x: '{{nodes.b}}'\n  - id: b\n    inputs:\n      y: nodes.a"),
      ).some((e) => e.startsWith("cycle:")),
    ).toBe(true);
  });

  it("accepts diamonds", () => {
    const w = parseOk(
      wf("  - id: a\n  - id: b\n    dependsOn: [a]\n  - id: c\n    dependsOn: [a]\n  - id: d\n    dependsOn: [b, c]"),
    );
    expect(topoOrder(w)).toEqual(["a", "b", "c", "d"]);
  });

  it("rejects unknown and self references", () => {
    expect(
      expectErrors(wf("  - id: a\n    dependsOn: [ghost]")).some((e) => e.includes("unknown node 'ghost'")),
    ).toBe(true);
    expect(
      expectErrors(wf("  - id: a\n    inputs:\n      x: '{{nodes.a}}'")).some((e) => e.includes("references itself")),
    ).toBe(true);
  });

  it("rejects non-reference input strings", () => {
    expectErrors(wf("  - id: a\n    inputs:\n      x: see the notes in nodes.b prose"));
  });
});

describe("parseWorkflow: judge rules", () => {
  it("rejects self-judge and unknown judge", () => {
    expect(expectErrors(`version: 1\nname: g\ndescription: d\nnodes:\n  - id: a\n    accept:\n      judge: a`).some((e) => e.includes("cannot be itself"))).toBe(true);
    expect(expectErrors(`version: 1\nname: g\ndescription: d\nnodes:\n  - id: a\n    accept:\n      judge: ghost`).some((e) => e.includes("unknown node 'ghost'"))).toBe(true);
  });

  it("rejects a judge that does not depend on its producer", () => {
    expect(
      expectErrors(
        `version: 1\nname: g\ndescription: d\nnodes:\n  - id: a\n    accept:\n      judge: j\n  - id: j`,
      ).some((e) => e.includes("must depend (transitively)")),
    ).toBe(true);
  });

  it("rejects a judge that is itself gated (nested judge)", () => {
    // A node that is some node's judge may not declare its own accept.judge:
    // the inner judge is never driven, so any node depending on it awaits
    // forever and run() hangs. Rejected at validation (no hang risk).
    const errors = expectErrors(`
      version: 1
      name: nested-judge
      description: judge with its own judge
      nodes:
        - id: build
          accept:
            judge: gate
        - id: gate
          dependsOn: [build]
          accept:
            judge: gate2
        - id: gate2
          dependsOn: [gate]
    `);
    expect(
      errors.some(
        (e) => e.includes("a judge may not itself be gated") && e.includes("'gate'"),
      ),
    ).toBe(true);
  });
});

describe("parseWorkflow: accept + limits", () => {
  it("rejects absolute and traversal paths in accept.files", () => {
    const errors = expectErrors(
      `version: 1\nname: g\ndescription: d\nnodes:\n  - id: a\n    accept:\n      files: [/etc/passwd, ../escape, ok/rel.txt]`,
    );
    expect(errors.filter((e) => e.includes("relative path")).length).toBe(2);
  });

  it("enforces the maxAttempts ceiling, configurable via opts", () => {
    expectErrors(`version: 1\nname: g\ndescription: d\nnodes:\n  - id: a\n    accept:\n      maxAttempts: 0`);
    expectErrors(`version: 1\nname: g\ndescription: d\nnodes:\n  - id: a\n    accept:\n      maxAttempts: 4`);
    expect(parseOk(`version: 1\nname: g\ndescription: d\nnodes:\n  - id: a\n    accept:\n      maxAttempts: 5`, { limits: { maxAttempts: 5 } }).nodes[0]!.accept.maxAttempts).toBe(5);
  });

  it("rejects bogus retryOn values", () => {
    expectErrors(`version: 1\nname: g\ndescription: d\nnodes:\n  - id: a\n    accept:\n      retryOn: [maybe]`);
  });

  it("soft cap warns, hard ceiling errors", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `  - id: n${i}`).join("\n");
    const r = parseWorkflow(`version: 1\nname: g\ndescription: d\nnodes:\n${nine}`);
    expect(r.workflow).not.toBeNull();
    expect(r.warnings.some((w) => w.includes("soft cap"))).toBe(true);

    expectErrors(`version: 1\nname: g\ndescription: d\nnodes:\n${Array.from({ length: 33 }, (_, i) => `  - id: n${i}`).join("\n")}`);
    // A workflow may lower the soft cap but not exceed the hard ceiling.
    expectErrors(`version: 1\nname: g\ndescription: d\nlimits:\n  maxNodes: 40\nnodes:\n  - id: a`);
    const lowered = parseWorkflow(`version: 1\nname: g\ndescription: d\nlimits:\n  maxNodes: 2\nnodes:\n  - id: a\n  - id: b\n  - id: c`);
    expect(lowered.warnings.filter((w) => w.includes("soft cap")).length).toBe(1);
  });

  it("validates requires and maxRuntimeMins numerics", () => {
    expectErrors(`version: 1\nname: g\ndescription: d\nnodes:\n  - id: a\n    requires:\n      toolDifficulty: 6`);
    expectErrors(`version: 1\nname: g\ndescription: d\nnodes:\n  - id: a\n    requires:\n      ctx: 0`);
    expectErrors(`version: 1\nname: g\ndescription: d\nnodes:\n  - id: a\n    requires:\n      vision: yes-please`);
    expectErrors(`version: 1\nname: g\ndescription: d\nnodes:\n  - id: a\n    maxRuntimeMins: -5`);
  });
});

describe("renderWorkflow", () => {
  it("renders a stable snapshot (declaration order != execution order)", () => {
    const wf = parseOk(`
      version: 1
      name: render-me
      description: renders deterministically
      nodes:
        - id: review
          profile: explorer
          dependsOn: [impl]
          accept:
            files: [verdict.json]
        - id: impl
          profile: fixer
          pin:
            provider: ai365
            model: qwen3.8-27b
          inputs:
            notes: nodes.plan.summary
          accept:
            files: [src/foo.ts]
            judge: review
            maxAttempts: 2
        - id: plan
    `);
    const out = renderWorkflow(wf);
    expect(out).toBe(
      [
        "workflow render-me (v1)",
        "  renders deterministically",
        "  limits: maxNodes 8, maxRuntime default 30m",
        "",
        "nodes (execution order):",
        "  1. plan",
        "     accept: verdict only, attempts=1",
        "  2. impl [profile=fixer]",
        "     pin: ai365/qwen3.8-27b",
        "     input notes <- nodes.plan.summary",
        "     accept: 1 file(s), judge=review, attempts=2 retry-on fail|reject",
        "  3. review [profile=explorer]",
        "     depends: impl",
        "     accept: 1 file(s), attempts=1",
        "",
        "data edges:",
        "  impl.notes <- nodes.plan.summary",
        "",
      ].join("\n"),
    );
    // Same object rendered twice: byte-identical.
    expect(renderWorkflow(wf)).toBe(out);
  });
});

describe("parseWorkflow: model groups", () => {
  it("accepts a group key and renders it", () => {
    const wf = parseOk(`
      version: 1
      name: grouped
      description: fan out across declared models
      nodes:
        - id: worker
          group: mid-level
          accept:
            files: [out.md]
    `);
    expect(wf.nodes[0]!.group).toBe("mid-level");
    expect(renderWorkflow(wf)).toContain("group: mid-level");
  });

  it("rejects pin and group together", () => {
    const errors = expectErrors(`
      version: 1
      name: conflict
      description: pin plus group
      nodes:
        - id: worker
          group: mid-level
          pin:
            model: ai365/big
    `);
    expect(errors.join("; ")).toContain("mutually exclusive");
  });

  it("rejects malformed group names", () => {
    const errors = expectErrors(`
      version: 1
      name: badgroup
      description: group name shape
      nodes:
        - id: worker
          group: Mid Level
    `);
    expect(errors.join("; ")).toContain("'group' must be a model-group name");
  });
});
