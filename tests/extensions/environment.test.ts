import { describe, it, expect } from "bun:test";
import { create } from "../../src/extensions/environment/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";

describe("environment extension", () => {
  it("creates extension with systemPrompt:build hook", () => {
    const extension = create();
    expect(extension).toBeDefined();
    expect(extension.hooks).toBeDefined();
    expect(extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!).toBeInstanceOf(Function);
  });

  it("hook returns info chunk with priority 100", async () => {
    const extension = create();
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({
      agent: { model: "test-model", _profileName: "test-profile" } as any,
    });
    expect((result as any).name).toBe("info");
    expect((result as any).priority).toBe(100);
    expect(typeof (result as any).content).toBe("string");
  });

  it("hook renders model name in content", async () => {
    const extension = create();
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({
      agent: { model: "gpt-4", _profileName: "default" } as any,
    });
    expect((result as any).content).toContain("gpt-4");
  });

  it("hook renders profile name in content", async () => {
    const extension = create();
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({
      agent: { model: "test", _profileName: "custom-profile" } as any,
    });
    expect((result as any).content).toContain("custom-profile");
  });

  it("hook renders platform in content", async () => {
    const extension = create();
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({
      agent: { model: "test" } as any,
    });
    // Should contain the current platform (linux, darwin, win32)
    const platform = process.platform;
    expect((result as any).content).toContain(platform);
  });

  it("hook renders session date in content", async () => {
    const extension = create();
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({
      agent: { model: "test" } as any,
    });
    // Should contain today's date in YYYY-MM-DD format
    const today = new Date().toISOString().slice(0, 10);
    expect((result as any).content).toContain(today);
  });

  it("hook handles agent with no model", async () => {
    const extension = create();
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({
      agent: {} as any,
    });
    expect((result as any).name).toBe("info");
    expect(typeof (result as any).content).toBe("string");
  });

  it("hook handles agent with no profile name", async () => {
    const extension = create();
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({
      agent: { model: "test" } as any,
    });
    expect((result as any).content).toContain("default");
  });

  it("hook renders cwd in content", async () => {
    const extension = create();
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({
      agent: { model: "test" } as any,
    });
    expect((result as any).content).toContain(process.cwd());
  });
});
