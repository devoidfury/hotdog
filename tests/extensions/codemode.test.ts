// codemode extension skeleton: domain index, envelope params, prompt chunk.
// Boots the extension through the published ./testing kit (createTestCore +
// ExtensionLoader over the alias entry specifier); no mock.module anywhere.

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

import {
  createTestCore,
  discoverExtensions,
  ExtensionLoader,
  ToolResult,
} from "@read-receipt/hotdog/testing";
import { HOOKS } from "@core/hooks.ts";
import type { HookPayloads } from "@core/extensions/types.ts";
import type { ToolRegistry } from "@core/extensions/tool-registry.ts";
import type { Tool, ToolDef, ToolMetadata } from "@core/extensions/tool-registry.ts";

const EXT_DIR = resolve(import.meta.dir, "../../src/experimental/codemode");
const REPO_ROOT = resolve(import.meta.dir, "../..");
// The specifier discovery itself emits for @experimental entries.
const EXT_SPEC = "@experimental/codemode/index.ts";

interface Chunk {
  name: string;
  priority: number;
  content: string;
}

function makeFixtureTool(
  name: string,
  metadata: Partial<ToolMetadata> = {},
  defCalls?: { n: number },
): Tool {
  return {
    metadata: { sideEffects: false, difficulty: 1, tags: [], ...metadata },
    toToolDef(): ToolDef {
      if (defCalls) defCalls.n++;
      return {
        type: "function",
        function: {
          name,
          description: `${name} fixture`,
          parameters: { type: "object", properties: {} },
        },
      };
    },
    async execute() {
      return "ok";
    },
  };
}

async function bootCodemode(config: Record<string, unknown> = {}) {
  const core = createTestCore({ config });
  const loader = new ExtensionLoader(core);
  const inst = await loader.load("codemode", EXT_SPEC);
  expect(inst).not.toBeNull();
  const tool = core.toolRegistry.get("codemode");
  if (!tool) throw new Error("codemode tool was not registered");
  return { core, loader, tool };
}

async function indexLine(registry: ToolRegistry): Promise<string> {
  const def = await registry.getToolDef("codemode");
  if (!def) throw new Error("no codemode tool def");
  const m = /Domains: .*$/.exec(def.function.description);
  if (!m) throw new Error(`no domain index in description: ${def.function.description}`);
  return m[0];
}

function defsFor(...names: string[]): ToolDef[] {
  return names.map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  }));
}

async function runCodemodeChunk(core: ReturnType<typeof createTestCore>, agent: unknown): Promise<Chunk | undefined> {
  // The handler only needs the double's getToolDefs; the payload cast lives here.
  const payload = { agent } as HookPayloads["systemPrompt:build"];
  const { results } = await core.hooks.runHookPipeline(HOOKS.SYSTEM_PROMPT_BUILD, payload);
  return results
    .map((r) => r.result as Chunk | undefined)
    .find((r) => r && typeof r === "object" && r.name === "codemode");
}

describe("codemode manifest", () => {
  it("validates through the CLI (`bun bin/hotdog extension validate`)", () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "bin/hotdog", "extension", "validate", "src/experimental/codemode"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("dry-load: OK - tools: codemode");
    expect(proc.stdout.toString()).toContain("No problems found.");
  });

  it("discovers through the kit with an empty provides and NO configSchema", async () => {
    const discovered = await discoverExtensions([EXT_DIR]);
    expect(discovered).toHaveLength(1);
    const meta = discovered[0]!;
    expect(meta.name).toBe("codemode");
    expect(meta.manifestError).toBeUndefined();
    expect(meta.provides).toEqual([]);
    expect(meta.configSchema).toBeNull();
    expect(meta.loadOrder).toBe(10);
  });
});

describe("codemode domain index", () => {
  it("self-excludes codemode from buckets and counts", async () => {
    const { core } = await bootCodemode();
    // codemode itself carries tags ["system"]; one fixture system tool means
    // the count must be 1, not 2. head/tail are registered too: they add one
    // to files AND utility each (both tags), so files reads 3.
    core.toolRegistry.register("bashish", makeFixtureTool("bashish", { sideEffects: true, tags: ["system"] }));
    core.toolRegistry.register("readish", makeFixtureTool("readish", { tags: ["files"] }));
    const line = await indexLine(core.toolRegistry);
    expect(line).toContain("system(1)");
    expect(line).toContain("files(3)");
    expect(line).toContain("utility(2)");
    expect(line).not.toContain("codemode");
  });

  it("counts the untagged population exactly and normalizes tags", async () => {
    const { core } = await bootCodemode();
    core.toolRegistry.register("srv__a", makeFixtureTool("srv__a", { tags: [] }));
    core.toolRegistry.register("srv__b", makeFixtureTool("srv__b", { tags: [] }));
    core.toolRegistry.register("srv__c", makeFixtureTool("srv__c", { sideEffects: true, tags: [] }));
    // Double-declared + padded + empty tags normalize to one readish (getTags
    // semantics); + head + tail = files(3).
    core.toolRegistry.register("readish", makeFixtureTool("readish", { tags: [" Files ", "files", ""] }));
    const line = await indexLine(core.toolRegistry);
    expect(line).toContain("untagged(3)");
    expect(line).toContain("files(3)");
  });

  it("index size is CONSTANT across a 10-tool vs 200-tool fleet (§3.8)", async () => {
    const domains = ["files", "network", "utility", "system"];
    async function buildIndexLine(toolCount: number): Promise<string> {
      const { core } = await bootCodemode();
      for (let i = 0; i < toolCount; i++) {
        const name = `t${i}`;
        core.toolRegistry.register(
          name,
          makeFixtureTool(name, { tags: [domains[i % domains.length]!] }),
        );
      }
      return indexLine(core.toolRegistry);
    }

    const small = await buildIndexLine(10);
    const big = await buildIndexLine(200);
    // +2 files and +2 utility from head/tail on top of the fleet.
    expect(small).toContain("files(5)");
    expect(big).toContain("files(52)");
    expect(small).toContain("untagged(0)");
    expect(big).toContain("untagged(0)");
    // Only digit width may differ: 4 buckets, at most +1 char each.
    expect(big.length - small.length).toBeLessThanOrEqual(4);
    expect(big.length).toBeLessThan(220);
  });

  it("never re-enters def building: rendering reads metadata per name, not getToolDefs (§5 trap)", async () => {
    const { core } = await bootCodemode();
    const calls = { n: 0 };
    for (let i = 0; i < 5; i++) {
      const name = `t${i}`;
      core.toolRegistry.register(name, makeFixtureTool(name, { tags: ["utility"] }, calls));
    }
    // Building ALL defs drives codemode.toToolDef() once alongside the
    // fixtures; if codemode's description builder called registry
    // getToolDefs()/getToolDef() per fixture, the fixture def-call count
    // would exceed 5 (recursion into the cache being populated).
    await core.toolRegistry.getToolDefs();
    expect(calls.n).toBe(5);
  });

  it("policy >= index: a sandboxed profile keeps filtered tools out of buckets and counts (§3.8 authority rule)", async () => {
    const { core } = await bootCodemode({ sandboxMode: true });
    core.toolRegistry.register("readish", makeFixtureTool("readish", { tags: ["files"] }));
    core.toolRegistry.register("bashish", makeFixtureTool("bashish", { sideEffects: true, tags: ["system"] }));
    core.toolRegistry.register("srv__x", makeFixtureTool("srv__x", { sideEffects: true, tags: [] }));
    // The side-effect tools (system + one untagged) are policy-filtered out:
    // absent from any bucket AND any count. head/tail survive the sandbox
    // (read-only, difficulty 1) and carry files(3)/utility(2).
    expect(await indexLine(core.toolRegistry)).toBe(
      'Domains: files(3) utility(2) untagged(0). searchTools("<domain>") lists names + descriptions; describeTool(name) gives arguments.',
    );

    // Contrast: unsandboxed shows all three legs.
    const open = await bootCodemode();
    open.core.toolRegistry.register("readish", makeFixtureTool("readish", { tags: ["files"] }));
    open.core.toolRegistry.register("bashish", makeFixtureTool("bashish", { sideEffects: true, tags: ["system"] }));
    open.core.toolRegistry.register("srv__x", makeFixtureTool("srv__x", { sideEffects: true, tags: [] }));
    expect(await indexLine(open.core.toolRegistry)).toContain("system(1)");

    // The difficulty + blacklist legs filter too.
    const capped = await bootCodemode({ defaultMaxToolDifficulty: 1 });
    capped.core.toolRegistry.register("harsh", makeFixtureTool("harsh", { difficulty: 2, tags: ["files"] }));
    expect(await indexLine(capped.core.toolRegistry)).toContain("untagged(0)");

    const blacked = await bootCodemode({ blacklistTools: ["readish"] });
    blacked.core.toolRegistry.register("readish", makeFixtureTool("readish", { tags: ["files"] }));
    blacked.core.toolRegistry.register("keepish", makeFixtureTool("keepish", { tags: ["network"] }));
    const blackedLine = await indexLine(blacked.core.toolRegistry);
    expect(blackedLine).toContain("network(1)");
    // readish's files contribution is gone: only head + tail remain.
    expect(blackedLine).toContain("files(2)");
  });

  it("null difficulty knobs mean no-filter, like agent.ts reads them (resolved-bag pin)", async () => {
    // A real resolved config bag carries maxToolDifficulty /
    // defaultMaxToolDifficulty as null ("null = no filtering" in
    // core.config.json); passing that straight to filterByMetadata used to
    // run filterByDifficulty(null) and empty the index fleet-wide -- the
    // show-prompt run of 2026-11-23 caught it rendering "Domains:
    // untagged(0)" with a full registry.
    const { core } = await bootCodemode({
      maxToolDifficulty: null,
      defaultMaxToolDifficulty: null,
      sandboxMode: false,
    });
    core.toolRegistry.register("readish", makeFixtureTool("readish", { tags: ["files"] }));
    const line = await indexLine(core.toolRegistry);
    expect(line).toContain("files(3)"); // readish + head + tail
    expect(line).toContain("utility(2)");
  });
});

describe("codemode envelope params", () => {
  async function validEnvelopeCase() {
    const { core, tool } = await bootCodemode();
    return { core, tool };
  }

  it("schema is exactly {code, timeout_ms, max_output_chars} with additionalProperties: false", async () => {
    const { tool } = await validEnvelopeCase();
    const def = await tool.toToolDef();
    if (!def) throw new Error("codemode returned no def");
    const params = def.function.parameters as Record<string, unknown>;
    expect(Object.keys(params.properties as Record<string, unknown>).sort()).toEqual([
      "code",
      "max_output_chars",
      "timeout_ms",
    ]);
    expect(params.required).toEqual(["code"]);
    expect(params.additionalProperties).toBe(false);
    const props = params.properties as Record<string, Record<string, unknown>>;
    expect(props.timeout_ms!.type).toBe("integer");
    expect(props.max_output_chars!.type).toBe("integer");
  });

  it("metadata.display is the §5 script-in-args code spec", async () => {
    const { tool } = await validEnvelopeCase();
    expect(tool.metadata.display).toEqual([
      { kind: "code", lang: "javascript", source: "args", arg: "code" },
    ]);
  });

  it("refuses non-integer / zero / negative options pre-execution, model-fixable", async () => {
    const { tool } = await validEnvelopeCase();
    for (const bad of [0, -5, 1.5, "60000", true, null]) {
      const res = (await tool.execute({ code: "return 1", timeout_ms: bad })) as ToolResult;
      expect(res.success).toBe(false);
      expect(res.error).toContain("timeout_ms");
      expect(res.error).toContain("positive integer");

      const resOut = (await tool.execute({ code: "return 1", max_output_chars: bad })) as ToolResult;
      expect(resOut.success).toBe(false);
      expect(resOut.error).toContain("max_output_chars");
    }
    const missing = (await tool.execute({})) as ToolResult;
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("`code` is required");
  });

  it("refuses unknown properties (envelope closed)", async () => {
    const { core, tool } = await validEnvelopeCase();
    const res = (await tool.execute({ code: "return 1", title: "cute" })) as ToolResult;
    expect(res.success).toBe(false);
    expect(res.error).toContain("unknown parameter");
    expect(res.error).toContain("title");
    // The schema enforces it at the pipeline boundary too.
    const pipelineError = await core.toolRegistry.validateToolArgs(
      "codemode",
      { code: "return 1", title: "cute" },
    );
    expect(pipelineError).toContain("additional property not allowed");
    expect(await core.toolRegistry.validateToolArgs("codemode", { code: "x" })).toBeNull();
    expect(
      await core.toolRegistry.validateToolArgs("codemode", { code: "x", timeout_ms: 1.5 }),
    ).toContain("integer");
  });

  it("clamps over-ceiling values DOWN; absent params take the §3.5 defaults", async () => {
    const { tool } = await validEnvelopeCase();

    const clamped = (await tool.execute({
      code: "return 1",
      timeout_ms: 999_999,
      max_output_chars: 1_000_000,
    })) as ToolResult;
    // The tool runs for real, but this hand-built context has no dispatcher
    // mounted -- the run is refused, envelope echoed.
    expect(clamped.error).toContain("NOT executed");
    expect(clamped.error).toContain("timeout_ms=300000 (clamped down from 999999)");
    expect(clamped.error).toContain("max_output_chars=40000 (clamped down from 1000000)");

    const defaults = (await tool.execute({ code: "return 1" })) as ToolResult;
    expect(defaults.error).toContain("timeout_ms=60000 (default)");
    expect(defaults.error).toContain("max_output_chars=40000 (default)");

    const tightened = (await tool.execute({
      code: "return 1",
      timeout_ms: 5000,
      max_output_chars: 100,
    })) as ToolResult;
    expect(tightened.error).toContain("timeout_ms=5000");
    expect(tightened.error).toContain("max_output_chars=100");
  });
});

describe("codemode system-prompt chunk", () => {
  function shadowFixtureRegistry(registry: ToolRegistry) {
    registry.register("read", makeFixtureTool("read", { tags: ["files"] }));
    registry.register("bash", makeFixtureTool("bash", { sideEffects: true, tags: ["system"] }));
    registry.register("grep", makeFixtureTool("grep", { tags: ["files"] }));
    registry.register("fetch", makeFixtureTool("fetch", { sideEffects: true, tags: ["network"] }));
    registry.register("srv__tool_x", makeFixtureTool("srv__tool_x", { tags: [] }));
    // keep-direct population
    registry.register("question", makeFixtureTool("question", { tags: ["utility"] }));
    registry.register("handoff", makeFixtureTool("handoff", { tags: ["manager"] }));
    registry.register("delegate_task", makeFixtureTool("delegate_task", { managerOnly: true, tags: ["manager"] }));
    registry.register("load_skill", makeFixtureTool("load_skill", { tags: ["guidance"] }));
    // run-contract tool: the pinned exemption covers the shadow leg
    registry.register("contract_out", makeFixtureTool("contract_out", { pinned: true, tags: ["utility"] }));
  }

  it("absent when the extension is not loaded", async () => {
    const core = createTestCore();
    shadowFixtureRegistry(core.toolRegistry);
    const chunk = await runCodemodeChunk(core, { getToolDefs: async () => defsFor("read", "bash") });
    expect(chunk).toBeUndefined();
  });

  it("present when loaded, mid-priority, with the batching guidelines", async () => {
    const { core } = await bootCodemode();
    shadowFixtureRegistry(core.toolRegistry);
    const chunk = await runCodemodeChunk(core, { getToolDefs: async () => [] });
    if (!chunk) throw new Error("codemode chunk missing");
    expect(chunk.priority).toBe(260);
    expect(chunk.content).toContain("Run a JavaScript program that calls tools");
    expect(chunk.content).toContain("Promise.all");
    expect(chunk.content).toContain("tools.<name>({...})");
  });

  it("names the shadow inventory: policy set minus keep-direct, pinned and codemode (shadowed != declared)", async () => {
    const { core } = await bootCodemode();
    shadowFixtureRegistry(core.toolRegistry);
    // The double's "wire set": everything registered is DECLARED to it today
    // -- the inventory must be the shadow posture's set, not an echo of the
    // declarations.
    const allNames = [
      "read", "bash", "grep", "fetch", "srv__tool_x",
      "question", "handoff", "delegate_task", "load_skill", "contract_out", "codemode",
    ];
    const chunk = await runCodemodeChunk(core, { getToolDefs: async () => defsFor(...allNames) });
    if (!chunk) throw new Error("codemode chunk missing");
    const m = /Shadowed now: ([^.]+)\./.exec(chunk.content);
    if (!m) throw new Error(`no shadow inventory in chunk: ${chunk.content}`);
    const names = m[1]!.split(", ");
    expect(names).toEqual(["bash", "fetch", "grep", "read", "srv__tool_x"]);
    // Declared-but-kept tools are NOT named as shadowed.
    for (const kept of ["question", "handoff", "delegate_task", "load_skill", "contract_out", "codemode"]) {
      expect(names).not.toContain(kept);
    }
    // And the substitution rule rides right next to the inventory.
    expect(chunk.content).toContain("tools.<name>({...})");
  });

  it("falls back to the bare rule when the agent double exposes no getToolDefs", async () => {
    const { core } = await bootCodemode();
    const chunk = await runCodemodeChunk(core, {});
    if (!chunk) throw new Error("codemode chunk missing");
    expect(chunk.content).toContain("tools.<name>({...})");
    expect(chunk.content).not.toContain("Shadowed now:");
  });

  it("disappears on unload (present iff loaded, both directions)", async () => {
    const { core, loader } = await bootCodemode();
    await loader.unload("codemode");
    expect(core.toolRegistry.has("codemode")).toBe(false);
    const chunk = await runCodemodeChunk(core, { getToolDefs: async () => [] });
    expect(chunk).toBeUndefined();
  });
});

describe("codemode description budget pass (B5, §5 final shape)", () => {
  async function bootFleet(toolCount: number) {
    const { core, tool } = await bootCodemode();
    const domains = ["files", "network", "utility", "system"];
    for (let i = 0; i < toolCount; i++) {
      const name = `fleet${i}`;
      core.toolRegistry.register(
        name,
        makeFixtureTool(name, { tags: [domains[i % domains.length]!] }),
      );
    }
    const def = await tool.toToolDef();
    if (!def) throw new Error("codemode returned no def");
    return def.function.description;
  }

  it("shape: intro + async-body + globals one-liners (incl. searchTools/describeTool) + options line + index tail", async () => {
    const desc = await bootFleet(0);
    expect(desc.startsWith("Run a JavaScript program that calls tools")).toBe(true);
    expect(desc).toContain("body of an async function");
    expect(desc).toContain("top-level `await` and `return`");
    // One line per global; "resolves to a string; rejects on failure" said once.
    expect(desc).toContain("`await tools.<name>({...})` (resolves to a string; rejects on failure)");
    expect(desc.match(/resolves to/g) ?? []).toHaveLength(1);
    expect(desc).toContain("`searchTools(query)`");
    expect(desc).toContain("`describeTool(name)`");
    expect(desc).toContain("`text(v)`");
    expect(desc).toContain("`console.log(...)`");
    expect(desc).toContain("`exit()`");
    expect(desc).toContain("`store(key, value)` / `load(key)`");
    // Calls apply as dispatched (the batch is not atomic): one sentence, no
    // new promises.
    expect(desc).toContain("a mid-script failure does not roll back");
    // Options line: tighten-only, clamped, never loosened.
    expect(desc).toContain("Options `timeout_ms` and `max_output_chars` tighten the host defaults");
    expect(desc).toContain("clamped");
    expect(desc).toContain("never loosened");
    // The compact domain index closes the description.
    expect(desc).toMatch(/Domains: .+untagged\(\d+\)\. searchTools\("<domain>"\).*describeTool\(name\).*arguments\.$/);
  });

  it("budget: total description stays under one honest cap and constant-size across fleets", async () => {
    const small = await bootFleet(10);
    const big = await bootFleet(200);
    // Budget: 960 chars (~240 est-tok at chars/4) -- the index is
    // constant-size, so the whole description is fleet-independent up to
    // digit widths (5 buckets x at most 1 char).
    expect(small.length).toBeLessThanOrEqual(960);
    expect(big.length).toBeLessThanOrEqual(960);
    expect(big.length - small.length).toBeLessThanOrEqual(5);
  });
});
