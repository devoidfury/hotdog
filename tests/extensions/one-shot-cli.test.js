import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HOOKS } from "../../src/core/hooks.js";
import { createMockCore } from "../helpers.js";

describe("One-Shot Extension - CLI_ARGS_PARSED hook", () => {
  const truthyCases = [
    { value: "test prompt", expected: "prompt" },
    { value: "  hello  ", expected: "prompt" },
  ];
  const falsyCases = [
    { value: null, expected: undefined },
    { value: "", expected: undefined },
    { value: 0, expected: undefined },
  ];

  for (const { value, expected } of truthyCases) {
    it(`sets subcommand when --prompt is truthy (${JSON.stringify(value)})`, async () => {
      const { create } = await import("../../src/extensions/ui-one-shot/index.js");
      const ext = create(createMockCore());
      const cli = { prompt: value };
      ext.hooks[HOOKS.CLI_ARGS_PARSED]({ cli });
      expect(cli.subcommand).toBe(expected);
    });
  }

  for (const { value, expected } of falsyCases) {
    it(`does not set subcommand when --prompt is falsy (${JSON.stringify(value)})`, async () => {
      const { create } = await import("../../src/extensions/ui-one-shot/index.js");
      const ext = create(createMockCore());
      const cli = { prompt: value };
      ext.hooks[HOOKS.CLI_ARGS_PARSED]({ cli });
      expect(cli.subcommand).toBe(expected);
    });
  }
});

describe("One-Shot Extension - prompt subcommand registration", () => {
  it("registers prompt subcommand via CLI_SUBCOMMANDS_REGISTER hook", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-one-shot/index.js");
    const ext = create(core);

    expect(ext).not.toBeNull();
    expect(ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER]).toBeDefined();

    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    expect(core.cliSubcommandRegistry.has("prompt")).toBe(true);
    const def = core.cliSubcommandRegistry.get("prompt");
    expect(def.handler).toBeDefined();
    expect(typeof def.handler).toBe("function");
  });

  it("prompt subcommand has correct description", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-one-shot/index.js");
    const ext = create(core);

    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("prompt");
    expect(def.description).toContain("One-shot");
    expect(def.description).toContain("single prompt");
  });
});

describe("One-Shot Extension - create function", () => {
  it("returns object with hooks when core.hooks exists", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-one-shot/index.js");
    const ext = create(core);

    expect(ext.hooks).toBeDefined();
    expect(ext.hooks[HOOKS.CLI_ARGS_PARSED]).toBeDefined();
    expect(ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER]).toBeDefined();
  });

  it("returns object with undefined hooks when core.hooks is null", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.js");
    const ext = create({ hooks: null });

    expect(ext.hooks).toBeUndefined();
  });
});
