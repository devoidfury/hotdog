import { describe, it, expect } from "bun:test";
import { HOOKS } from "../../src/core/hooks.ts";
import { createMockCore } from "../helpers.js";

// ── Extension Creation ──────────────────────────────────────────────────────
// parseCommand tests are in commands.test.js
// AsyncInteractiveCliInput tests are in interactive-cli-input.test.js
// handleSlashCommand tests are in interactive-cli-extended.test.js

describe("Interactive CLI - create function", () => {
  it("registers cli subcommand via CLI_SUBCOMMANDS_REGISTER hook", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-interactive-cli/index.js");
    const ext = create(core);

    expect(ext).not.toBeNull();
    expect(ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER]).toBeDefined();

    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    expect(core.cliSubcommandRegistry.has("cli")).toBe(true);
    const def = core.cliSubcommandRegistry.get("cli");
    expect(def.handler).toBeDefined();
  });

  it("cli subcommand has correct description", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-interactive-cli/index.js");
    const ext = create(core);

    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("cli");
    expect(def.description).toContain("Interactive");
  });

  it("registers AGENT_TOOL_CONTEXT hook", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-interactive-cli/index.js");
    const ext = create(core);

    expect(ext.hooks[HOOKS.AGENT_TOOL_CONTEXT]).toBeDefined();
  });

  it("has cleanup function", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-interactive-cli/index.js");
    const ext = create(core);

    expect(ext.cleanup).toBeDefined();
    expect(typeof ext.cleanup).toBe("function");
  });
});
