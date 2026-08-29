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
      agent: { model: "gpt-4", profileName: "default" } as any,
    });
    expect((result as any).content).toContain("gpt-4");
  });

  it("hook renders profile name in content", async () => {
    const extension = create();
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({
      agent: { model: "test", profileName: "custom-profile" } as any,
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
    // The hook reads the date at call time; guard against the rare case of
    // a UTC midnight rollover between the two reads.
    const before = new Date().toISOString().slice(0, 10);
    const result = await hook({
      agent: { model: "test" } as any,
    });
    const after = new Date().toISOString().slice(0, 10);
    const content = (result as any).content as string;
    expect(content.includes(before) || content.includes(after)).toBe(true);
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

describe("environment extension — workspace roots", () => {
  const extension = create();
  const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;

  it("lists the roots when more than one is configured", async () => {
    const result = await hook({
      agent: {
        model: "test",
        config: { workspaceRoots: ["/a/root", "/b/root", "/c/root"] },
      } as any,
    });
    expect((result as any).content).toContain("Workspace roots: /a/root, /b/root, /c/root");
  });

  it("does not mention roots when only the default single root is configured", async () => {
    const result = await hook({
      agent: {
        model: "test",
        config: { workspaceRoots: [process.cwd()] },
      } as any,
    });
    expect((result as any).content).not.toContain("Workspace roots");
  });

  it("does not mention roots when config is absent", async () => {
    const result = await hook({
      agent: { model: "test" } as any,
    });
    expect((result as any).content).not.toContain("Workspace roots");
  });
});
