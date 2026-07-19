import { describe, it, expect } from "bun:test";
import { HOOKS } from "../../src/core/hooks.ts";
import { createMockCore } from "../helpers.ts";
import type { CoreContext } from "../../src/core/extensions/types.ts";

describe("One-Shot Extension - CLI_ARGS_PARSED hook", () => {
  it("sets subcommand when --prompt is truthy", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const ext = create(createMockCore() as unknown as CoreContext);

    const cli1: Record<string, unknown> = { prompt: "test prompt" };
    (ext.hooks![HOOKS.CLI_ARGS_PARSED] as Function)({ cli: cli1 });
    expect(cli1.subcommand).toBe("prompt");

    const cli2: Record<string, unknown> = { prompt: "  hello  " };
    (ext.hooks![HOOKS.CLI_ARGS_PARSED] as Function)({ cli: cli2 });
    expect(cli2.subcommand).toBe("prompt");
  });

  it("does not set subcommand when --prompt is falsy", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const ext = create(createMockCore() as unknown as CoreContext);

    for (const value of [null, "", 0]) {
      const cli: Record<string, unknown> = { prompt: value };
      (ext.hooks![HOOKS.CLI_ARGS_PARSED] as Function)({ cli });
      expect(cli.subcommand).toBeUndefined();
    }
  });
});

describe("One-Shot Extension - prompt subcommand registration", () => {
  it("registers prompt subcommand with correct description", async () => {
    const core = createMockCore() as unknown as CoreContext;
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const ext = create(core);

    expect(ext).not.toBeNull();
    expect(ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]).toBeDefined();

    await (ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER] as Function)(core.cliSubcommandRegistry);

    expect(core.cliSubcommandRegistry.has("prompt")).toBe(true);
    const def = core.cliSubcommandRegistry.get("prompt")!;
    expect(typeof def.handler).toBe("function");
    expect(def.description).toContain("One-shot");
    expect(def.description).toContain("single prompt");
  });
});

describe("One-Shot Extension - create function", () => {
  it("returns object with hooks when core.hooks exists", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const ext = create(createMockCore() as unknown as CoreContext);

    expect(ext.hooks).toBeDefined();
    expect(ext.hooks![HOOKS.CLI_ARGS_PARSED]).toBeDefined();
    expect(ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]).toBeDefined();
  });

  it("returns object with undefined hooks when core.hooks is null", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const ext = create({ hooks: null! } as unknown as CoreContext);
    expect(ext.hooks).toBeUndefined();
  });
});
