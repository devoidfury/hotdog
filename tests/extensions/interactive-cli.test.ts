// Tests for ui-interactive-cli — extension creation, session hooks, and module exports.
// Other areas covered elsewhere:
//   - AsyncInteractiveCliInput: interactive-cli-input.test.ts
//   - handleSlashCommand: interactive-cli-extended.test.ts

import { describe, it, expect } from "bun:test";
import { HOOKS } from "../../src/core/hooks.ts";
import { HookSystem } from "../../src/core/hooks.ts";
import { createMockCore } from "../helpers.ts";
import type { CoreContext } from "../../src/core/extensions/types.ts";
import type { Agent } from "../../src/core/agent.ts";

const mockAgent = {} as Agent;

describe("Interactive CLI - create function", () => {
  it("registers cli subcommand and hooks", async () => {
    const core = createMockCore() as unknown as CoreContext;
    const { create } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    const ext = create(core);

    expect(ext).not.toBeNull();
    expect(ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]).toBeDefined();
    expect(ext.hooks![HOOKS.AGENT_TOOL_CONTEXT]).toBeDefined();
    expect(typeof ext.cleanup).toBe("function");

    await (ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER] as (registry: unknown) => void)(core.cliSubcommandRegistry);
    expect(core.cliSubcommandRegistry.has("cli")).toBe(true);
    expect(core.cliSubcommandRegistry.get("cli")!.description).toContain("Interactive");
  });
});

describe("Interactive CLI - model change hook", () => {
  it("updates readline prompt on model change", () => {
    const hooks = new HookSystem();
    let lastPrompt: string | null = null;

    hooks.on(HOOKS.MODEL_CHANGE, (data: unknown) => {
      lastPrompt = `(${(data as { newModel: string }).newModel})> `;
    });

    hooks.notifyHooks(HOOKS.MODEL_CHANGE, { agent: mockAgent, oldModel: "old-model", newModel: "new-model" });
    expect(lastPrompt!).toBe("(new-model)> ");
  });

  it("handles multiple model changes", () => {
    const hooks = new HookSystem();
    const prompts: string[] = [];

    hooks.on(HOOKS.MODEL_CHANGE, (data: unknown) => {
      prompts.push(`(${(data as { newModel: string }).newModel})> `);
    });

    hooks.notifyHooks(HOOKS.MODEL_CHANGE, { agent: mockAgent, oldModel: "model-1", newModel: "model-2" });
    hooks.notifyHooks(HOOKS.MODEL_CHANGE, { agent: mockAgent, oldModel: "model-2", newModel: "model-3" });
    expect(prompts).toEqual(["(model-2)> ", "(model-3)> "]);
  });
});

describe("Interactive CLI - turn end hook", () => {
  it("re-prompts when stopped", async () => {
    const hooks = new HookSystem();
    let promptCalled = false;

    hooks.on(HOOKS.TURN_END, (data: unknown) => {
      if ((data as { stopped: boolean }).stopped) {
        setImmediate(() => { promptCalled = true; });
      }
    });

    hooks.notifyHooks(HOOKS.TURN_END, { turnIndex: 1, message: "Hello", toolResults: [], stopped: true, agent: mockAgent });
    expect(promptCalled).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(promptCalled).toBe(true);
  });

  it("does not re-prompt when not stopped", async () => {
    const hooks = new HookSystem();
    let promptCalled = false;

    hooks.on(HOOKS.TURN_END, (data: unknown) => {
      if ((data as { stopped: boolean }).stopped) {
        setImmediate(() => { promptCalled = true; });
      }
    });

    hooks.notifyHooks(HOOKS.TURN_END, {
      turnIndex: 1, message: "", toolResults: [{ toolName: "read", input: "{}", result: "ok" }], stopped: false, agent: mockAgent,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(promptCalled).toBe(false);
  });
});

describe("Interactive CLI - module exports", () => {
  it("exports all expected functions", async () => {
    const mod = await import("../../src/extensions/ui-interactive-cli/index.ts");
    for (const name of ["runInteractiveSession", "handleSlashCommand", "create", "AsyncInteractiveCliInput"]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
