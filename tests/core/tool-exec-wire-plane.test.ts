// The end-to-end pin of the wire plane: real extension discovery -> real
// ExtensionLoader -> real createAgentFactory -> real broker child -> real
// runner, a scripted LLM driving bash, read and grep, with ZERO hand-passed
// descriptors anywhere (neither this file nor its child fixture names
// `toolDescriptors` or builds a `WireToolDescriptor`).
//
// The child runs as its own process (the shared broker is process-global
// state). Content asserts live in the boot-"off" child; the boot-"probe"
// sibling-isolation child asserts plumbing and scratch-dir identity only --
// nested-jail hosts cannot reliably run tool payloads.

import { describe, it, expect } from "bun:test";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "../fixtures/wire-plane-child.ts");

interface ChildRun {
  steps: Map<string, Record<string, unknown>>;
  code: number;
  err: string;
}

async function runChild(scenario: "off" | "siblings"): Promise<ChildRun> {
  const proc = Bun.spawn([process.execPath, CHILD, scenario], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  const steps = new Map<string, Record<string, unknown>>();
  for (const line of out.split("\n")) {
    if (line.startsWith("STEP:")) {
      const j = JSON.parse(line.slice(5)) as { step: string; value: Record<string, unknown> };
      steps.set(j.step, j.value);
    }
  }
  return { steps, code, err };
}

describe("wire plane e2e (zero hand-passed descriptors)", () => {
  it("a real agent session reaches bash, read and grep through collected descriptors", async () => {
    const { steps, code, err } = await runChild("off");
    expect(code, `wire-plane-child(off) exited ${code}; child stderr:\n${err}`).toBe(0);

    // Loader-collected descriptors: one per tool, real module files.
    const load = steps.get("load")!;
    expect(load.registered).toBe(true);
    expect(load.workerTagged).toBe(true);
    expect(load.collected).toEqual([
      "bash@bash-tool/index.ts",
      "grep@core-tools/index.ts",
      "read@core-tools/index.ts",
    ]);

    // The scripted-LLM agent run: three tool calls, three result frames from
    // the pooled runner, real outputs, and neither of the two death shapes.
    const run = steps.get("agent-run")!;
    expect(run.final).toBe("all-three-routed");
    expect(run.toolCount).toBe(3);
    expect(run.bashOk, "bash ran in the pooled runner (register frame -> dynamic import)").toBe(true);
    expect(run.readOk, "read ran in the pooled runner").toBe(true);
    expect(run.grepOk, "grep ran in the pooled runner").toBe(true);
    expect(run.notRegisteredSeen).toBe(false);
    expect(run.replacedOrCrashed).toBe(false);
  }, 120_000);

  it("dropSession on one session never costs a sibling its tools or its scratch dir", async () => {
    const { steps, code, err } = await runChild("siblings");
    expect(code, `wire-plane-child(siblings) exited ${code}; child stderr:\n${err}`).toBe(0);

    const s = steps.get("siblings")!;
    const backend = s.backend as string | null;

    // B never lost registration across A's toggle; A's post-toggle plain
    // respawn is unfenced, so its content is assertable everywhere.
    expect(s.bLostTool).toBe(false);
    expect(s.aLostTool).toBe(false);
    expect(s.a2).toBe("sib-a-2");

    // Scratch identity: A's dropSession left B's mapping alone -- the SAME
    // dir before and after.
    const before = s.bScratchBefore as string[];
    const after = s.bScratchAfter as string[];
    const aBefore = s.aScratchBefore as string[];
    if (backend === null) {
      process.stderr.write(
        "[wire-plane] no jail backend on this host: scratch-dir identity is VACUOUS here (tool-survival assertions above still bind)\n",
      );
      expect(before).toEqual([]);
      expect(after).toEqual([]);
      expect(aBefore).toEqual([]);
    } else {
      expect(before).toHaveLength(1);
      expect(after).toEqual(before);
      expect(aBefore).toHaveLength(1);
      expect(aBefore[0]).not.toBe(before[0]);
    }
  }, 120_000);
});
