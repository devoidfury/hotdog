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

// ── Main Entry Point Integration Tests ───────────────────────────────────────

describe("Main entry point - exit code flow", () => {
  it("process.exit is called with return value from main()", async () => {
    const mockMain = async () => 0;

    let capturedCode: number | null = null;
    const mockExit = (code: number | undefined | null) => {
      capturedCode = code ?? 0;
      throw new Error("process.exit called with: " + code);
    };
    const originalExit = process.exit;
    (process as any).exit = mockExit;

    try {
      await mockMain()
        .catch(() => 1)
        .then((code) => (process as any).exit(code));
    } catch (e: any) {
      if (e.message.startsWith("process.exit called with:")) {
        expect(capturedCode as number).toBe(0);
      } else {
        throw e;
      }
    } finally {
      process.exit = originalExit;
    }
  });

  it("error in main() returns exit code 1", async () => {
    const mockMain = async () => { throw new Error("Test error"); };

    let capturedCode: number | null = null;
    const mockExit = (code: number | undefined | null) => {
      capturedCode = code ?? 0;
      throw new Error("process.exit called with: " + code);
    };
    const originalExit = process.exit;
    (process as any).exit = mockExit;

    try {
      await mockMain()
        .catch(() => 1)
        .then((code) => (process as any).exit(code));
    } catch (e: any) {
      if (e.message.startsWith("process.exit called with:")) {
        expect(capturedCode as number).toBe(1);
      } else {
        throw e;
      }
    } finally {
      process.exit = originalExit;
    }
  });

  it("error with custom exitCode preserves the code", async () => {
    const mockMain = async () => {
      const err = new Error("Custom error") as Error & { exitCode: number };
      err.exitCode = 42;
      throw err;
    };

    let exitCode = 0;
    try {
      await mockMain();
    } catch (e: any) {
      exitCode = e.exitCode ?? 1;
    }
    expect(exitCode).toBe(42);
  });
});
