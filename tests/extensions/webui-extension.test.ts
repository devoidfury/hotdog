// Tests for webui/index.ts — WebUI extension creation and subcommand registration.

import { describe, it, expect } from "bun:test";
import { create } from "../../src/extensions/webui/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { createMockCore, createMockRegistry } from "../test-helpers.ts";

describe("WebUI Extension", () => {
  it("registers the 'webui' subcommand with correct metadata", async () => {
    const core = createMockCore() as any;
    const ext = create(core);

    const registry = createMockRegistry() as any;
    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(registry);

    expect(registry.registeredName).toBe("webui");
    expect(registry.registeredOpts!.description).toContain("WebUI");
    expect(registry.registeredOpts!.description).toContain("WebSocket");
    expect(typeof registry.registeredOpts!.handler).toBe("function");
  });

});
