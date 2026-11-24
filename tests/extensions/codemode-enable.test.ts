// codemode enablement chain: profile `codeMode` bool > global
// `codeMode.enabled` (default true). Same real machinery as
// codemode-shadow.test.ts: the shipped extension on the testing-kit double,
// real HookSystem + ToolRegistry, fixture agents driven by MockLLMClient.
// The off path runs THROUGH the PROVIDER_REQUEST hook (where core runs it),
// never a hand-rolled call.

import { describe, expect, it } from "bun:test";

import { createTestCore, ExtensionLoader } from "@read-receipt/hotdog/testing";
import { HOOKS } from "@core/hooks.ts";
import type { HookPayloads } from "@core/extensions/types.ts";
import { MockLLMClient, MockTool, buildStreamResponse, createFixture } from "../helpers.ts";

const EXT_SPEC = "@experimental/codemode/index.ts";

const SURFACE = ["codemode", "head", "tail"];

async function bootCodemode(
  config: Record<string, unknown> = {},
  profiles: Record<string, Record<string, unknown>> = {},
) {
  const core = createTestCore({ config });
  // The extension reads the profile through core.resolved.profileManager;
  // the test double ships no resolved bag, so attach a minimal one.
  (core as unknown as { resolved: unknown }).resolved = {
    profileManager: {
      getProfile: (name: string) => profiles[name] ?? null,
    },
  };
  const loader = new ExtensionLoader(core);
  const inst = await loader.load("codemode", EXT_SPEC);
  expect(inst).not.toBeNull();
  return core;
}

function registerEverything(core: ReturnType<typeof createTestCore>) {
  for (const name of ["read", "bash", "question", ...SURFACE]) {
    core.toolRegistry.register(
      name,
      new MockTool({
        name,
        metadata: { sideEffects: false, difficulty: 1, tags: [] },
        execute: async () => `${name} result`,
      }),
    );
  }
}

function wireNames(mockLLM: MockLLMClient): string[] {
  return (mockLLM.lastToolDefs ?? []).map(
    (d) => (d as { function?: { name?: string } }).function?.name ?? "",
  );
}

function textResponse(content: string) {
  return buildStreamResponse({ content, usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
}

async function wireFor(
  core: Awaited<ReturnType<typeof bootCodemode>>,
  profileName?: string,
): Promise<string[]> {
  const mockLLM = new MockLLMClient({ responseSequences: [textResponse("done")] });
  const { agent } = createFixture({
    hooks: core.hooks,
    toolRegistry: core.toolRegistry,
    mockLLM,
    ...(profileName ? { profileName } : {}),
  });
  await agent.run("hi");
  return wireNames(mockLLM);
}

async function codemodeChunk(core: Awaited<ReturnType<typeof bootCodemode>>, agent: unknown) {
  const payload = { agent } as HookPayloads["systemPrompt:build"];
  const { results } = await core.hooks.runHookPipeline(HOOKS.SYSTEM_PROMPT_BUILD, payload);
  return results
    .map((r) => r.result as { name?: string } | undefined)
    .find((r) => r && typeof r === "object" && r.name === "codemode");
}

describe("codemode enablement (global default + profile override)", () => {
  it("default on: codemode rides the wire and the shadow fires", async () => {
    const core = await bootCodemode();
    registerEverything(core);
    const wire = await wireFor(core);
    expect(wire).toContain("codemode");
    expect(wire).not.toContain("read"); // shadowed
  });

  it("codeMode.enabled=false turns the whole surface off: no codemode/head/tail, shadow silent", async () => {
    const core = await bootCodemode({ codeMode: { enabled: false } });
    registerEverything(core);
    const wire = await wireFor(core);
    for (const name of SURFACE) expect(wire).not.toContain(name);
    expect(wire).toContain("read"); // untouched direct tools
    expect(wire).toContain("question");
  });

  it("profile codeMode:true opts back in when the global default is off", async () => {
    const core = await bootCodemode(
      { codeMode: { enabled: false } },
      { on: { codeMode: true } },
    );
    registerEverything(core);
    const wire = await wireFor(core, "on");
    expect(wire).toContain("codemode");
    expect(wire).not.toContain("read"); // shadow active again
    // An agent on a profile WITHOUT the bool still follows the global off.
    const wireOff = await wireFor(core, "plain");
    expect(wireOff).not.toContain("codemode");
    expect(wireOff).toContain("read");
  });

  it("profile codeMode:false opts out while everyone else keeps codemode", async () => {
    const core = await bootCodemode({}, { strict: { codeMode: false } });
    registerEverything(core);
    const wireOff = await wireFor(core, "strict");
    for (const name of SURFACE) expect(wireOff).not.toContain(name);
    expect(wireOff).toContain("read");
    const wireOn = await wireFor(core, "plain");
    expect(wireOn).toContain("codemode");
    expect(wireOn).not.toContain("read");
  });

  it("a non-boolean profile codeMode is ignored; the global default decides", async () => {
    const core = await bootCodemode({}, { typo: { codeMode: "no" } });
    registerEverything(core);
    const wire = await wireFor(core, "typo");
    expect(wire).toContain("codemode"); // "no" must not read as false
  });

  it("no system-prompt chunk for a disabled agent; present when enabled", async () => {
    const core = await bootCodemode({}, { strict: { codeMode: false } });
    registerEverything(core);
    expect(await codemodeChunk(core, { profileName: "strict" })).toBeUndefined();
    expect(await codemodeChunk(core, { profileName: "plain" })).toBeDefined();
  });

  it("global off also suppresses the chunk for agents without a profile flag", async () => {
    const core = await bootCodemode({ codeMode: { enabled: false } });
    registerEverything(core);
    expect(await codemodeChunk(core, { profileName: "plain" })).toBeUndefined();
  });
});
