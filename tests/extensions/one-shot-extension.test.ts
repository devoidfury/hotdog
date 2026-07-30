// Tests for ui-one-shot extension — CLI subcommand registration and flag handling.

import { describe, it, expect } from "bun:test";
import { create } from "../../src/extensions/ui-one-shot/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { createMockCore, createMockRegistry } from "../test-helpers.ts";

describe("One-Shot Extension", () => {
  it("registers the 'prompt' subcommand", async () => {
    const core = createMockCore();
    const ext = create(core);

    const registry = createMockRegistry();
    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(registry);

    expect(registry.registeredName).toBe("prompt");
    expect(registry.registeredOpts!.description).toContain("One-shot");
    expect(typeof registry.registeredOpts!.handler).toBe("function");
  });

  it("sets subcommand to 'prompt' when prompt flag is present", async () => {
    const core = createMockCore();
    const ext = create(core);

    const cli: any = { prompt: "Hello world" };
    await ext.hooks![HOOKS.CLI_ARGS_PARSED]!({ cli });

    expect(cli.subcommand).toBe("prompt");
  });

  it("does not set subcommand when prompt is absent or empty", async () => {
    const core = createMockCore();
    const ext = create(core);

    const cli1: any = {};
    await ext.hooks![HOOKS.CLI_ARGS_PARSED]!({ cli: cli1 });
    expect(cli1.subcommand).toBeUndefined();

    const cli2: any = { prompt: "" };
    await ext.hooks![HOOKS.CLI_ARGS_PARSED]!({ cli: cli2 });
    expect(cli2.subcommand).toBeUndefined();
  });

  it("CLI_ARGS_PARSED does not interfere with other subcommands", async () => {
    const core = createMockCore();
    const ext = create(core);

    const cli: any = { subcommand: "info" };
    await ext.hooks![HOOKS.CLI_ARGS_PARSED]!({ cli });

    expect(cli.subcommand).toBe("info");
  });

  it("CLI_ARGS_PARSED overrides existing subcommand when prompt is set", async () => {
    const core = createMockCore();
    const ext = create(core);

    const cli: any = { subcommand: "info", prompt: "Hello" };
    await ext.hooks![HOOKS.CLI_ARGS_PARSED]!({ cli });

    expect(cli.subcommand).toBe("prompt");
  });

  it.each([null, undefined])("handles missing hooks (%s)", (hooks) => {
    const core = { hooks } as any;
    const ext = create(core);
    expect(ext.hooks).toBeUndefined();
  });
});
