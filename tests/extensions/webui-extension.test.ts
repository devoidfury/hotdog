// Tests for webui/index.ts — WebUI extension creation and subcommand registration.

import { describe, it, expect } from "bun:test";
import { create } from "../../src/extensions/webui/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { createMockCore, createMockRegistry } from "../test-helpers.ts";

describe("WebUI Extension", () => {
  it("registers the 'webui' subcommand with correct metadata", async () => {
    const core = createMockCore();
    const ext = create(core);

    const registry = createMockRegistry();
    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(registry);

    expect(registry.registeredName).toBe("webui");
    expect(registry.registeredOpts!.description).toContain("WebUI");
    expect(registry.registeredOpts!.description).toContain("WebSocket");
    expect(typeof registry.registeredOpts!.handler).toBe("function");
  });

  it("returns extension without hooks when core has no hooks", () => {
    const core = createMockCore({ hooks: null });
    const ext = create(core);
    expect(ext.hooks).toBeUndefined();
  });

  it.each([null, undefined])("handles missing hooks (%s)", (hooks) => {
    const core = { hooks } as any;
    const ext = create(core);
    expect(ext.hooks).toBeUndefined();
  });
});
