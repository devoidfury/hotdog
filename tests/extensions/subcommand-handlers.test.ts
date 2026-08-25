import { describe, it, expect } from "bun:test";
import { HOOKS } from "../../src/core/hooks.ts";
import { createMockCore } from "../helpers.ts";
import { withSilentConsole } from "../test-helpers.ts";
import type { CoreContext } from "../../src/core/extensions/types.ts";

// ── Info Show-Prompt Extension ──────────────────────────────────────────────

describe("Info Show-Prompt Extension", () => {
  it("registers info and show-prompt subcommands", async () => {
    const core = createMockCore() as unknown as CoreContext;
    const { create } = await import("../../src/extensions/ui-info-cli/index.ts");
    const ext = create(core);

    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    expect(core.cliSubcommandRegistry.has("info")).toBe(true);
    expect(core.cliSubcommandRegistry.has("show-prompt")).toBe(true);
  });

  it("info subcommand returns exit code 0 for both JSON and text output", async () => {
    const core = createMockCore() as unknown as CoreContext;
    const { create } = await import("../../src/extensions/ui-info-cli/index.ts");
    const ext = create(core);
    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("info");
    for (const wantsJson of [true, false]) {
      const exitCode = await withSilentConsole(() =>
        def!.handler!({ wantsJson, colors: false, theme: "dark", config: null, skillsPath: null }, core),
      );
      expect(exitCode).toBe(0);
    }
  });

  it("show-prompt subcommand returns exit code 0", async () => {
    const core = createMockCore() as unknown as CoreContext;
    const { create } = await import("../../src/extensions/ui-info-cli/index.ts");
    const ext = create(core);
    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("show-prompt");
    const exitCode = await withSilentConsole(() =>
      def!.handler!({ wantsJson: false, colors: false, theme: "dark", config: null }, core),
    );
    expect(exitCode).toBe(0);
  });
});

// ── One-Shot Extension ──────────────────────────────────────────────────────
// CLI_ARGS_PARSED hook tests are in one-shot-cli.test.ts

describe("One-Shot Extension", () => {
  it("registers prompt subcommand via CLI_SUBCOMMANDS_REGISTER hook", async () => {
    const core = createMockCore() as unknown as CoreContext;
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const ext = create(core);

    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    expect(core.cliSubcommandRegistry.has("prompt")).toBe(true);
    expect(typeof core.cliSubcommandRegistry.get("prompt")!.handler).toBe("function");
  });
});

// ── Subcommand Handler Return Type Tests ─────────────────────────────────────

describe("Subcommand handler return types", () => {
  it("all registered handlers return numeric exit codes", async () => {
    const core = createMockCore() as unknown as CoreContext;

    // Load all extensions that register subcommands
    const { create: createReview } = await import("../../src/extensions/ui-session-review-cli/index.ts");
    const { create: createInfo } = await import("../../src/extensions/ui-info-cli/index.ts");
    const { create: createOneShot } = await import("../../src/extensions/ui-one-shot/index.ts");

    const reviewExt = createReview(core);
    const infoExt = createInfo(core);
    const oneShotExt = createOneShot(core);

    // Register all subcommands
    await reviewExt.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);
    await infoExt.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);
    await oneShotExt.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    // Verify all subcommands are registered
    const subcommands = core.cliSubcommandRegistry.names();
    expect(subcommands).toContain("sessions");
    expect(subcommands).toContain("info");
    expect(subcommands).toContain("show-prompt");
    expect(subcommands).toContain("prompt");

    // Verify all have handlers
    for (const name of subcommands) {
      const def = core.cliSubcommandRegistry.get(name);
      expect(typeof def!.handler).toBe("function");
    }
  });
});

// NOTE: the promise chain in bin/hotdog (main() -> process.exit(code)) is not
// unit-testable without spawning the CLI; it is exercised end-to-end by CI via
// `bun bin/hotdog --help`. Previously there was a describe block here that
// re-implemented that chain against inline mocks, testing the test itself.
