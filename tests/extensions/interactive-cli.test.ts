// Tests for ui-interactive-cli -- extension creation and basic behavior.
// Other areas covered elsewhere:
//   - AsyncInteractiveCliInput: interactive-cli-input.test.ts
//   - handleSlashCommand: interactive-cli-extended.test.ts

import { describe, it, expect } from "bun:test";
import { HOOKS } from "../../src/core/hooks.ts";
import { createMockCore } from "../helpers.ts";
import type { CoreContext } from "../../src/core/extensions/types.ts";

describe("Interactive CLI", () => {
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
