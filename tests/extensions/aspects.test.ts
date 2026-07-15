import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { create } from "../../src/extensions/aspects/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("aspects extension", () => {
  let tmpDir: string;
  let aspectsDir: string;
  let profilesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aspects-test-"));
    aspectsDir = path.join(tmpDir, "aspects");
    profilesDir = path.join(tmpDir, "profiles");
    fs.mkdirSync(aspectsDir);
    fs.mkdirSync(profilesDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates extension with systemPrompt:build hook", () => {
    const core = { config: {}, resolved: {} } as any;
    const extension = create(core);
    expect(extension).toBeDefined();
    expect(extension.hooks).toBeDefined();
    expect(extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!).toBeInstanceOf(Function);
  });

  it("hook returns guidelines chunk with priority 200", async () => {
    // Create an aspect file
    await fsPromises.writeFile(
      path.join(aspectsDir, "coding.aspect.md"),
      "# Coding\n\nWrite clean code."
    );

    // Create a profile that references the aspect
    await fsPromises.writeFile(
      path.join(profilesDir, "default.profile.md"),
      "---\naspects:\n  - coding\n---\n\nDefault profile."
    );

    const core = {
      config: {},
      resolved: {
        configDir: tmpDir,
        profilesPath: profilesDir,
        profileName: "default",
      },
    } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({} as any);
    expect((result as any).name).toBe("guidelines");
    expect((result as any).priority).toBe(200);
    expect(typeof (result as any).content).toBe("string");
  });

  it("hook includes aspect content when aspect file exists", async () => {
    await fsPromises.writeFile(
      path.join(aspectsDir, "coding.aspect.md"),
      "# Coding Guidelines\n\nAlways write tests."
    );

    await fsPromises.writeFile(
      path.join(profilesDir, "default.profile.md"),
      "---\naspects:\n  - coding\n---\n\nDefault profile."
    );

    const core = {
      config: {},
      resolved: {
        configDir: tmpDir,
        profilesPath: profilesDir,
        profileName: "default",
      },
    } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({} as any);
    expect((result as any).content).toContain("Coding Guidelines");
    expect((result as any).content).toContain("Always write tests");
  });

  it("hook returns empty content when no aspects are configured", async () => {
    const core = {
      config: {},
      resolved: {
        configDir: tmpDir,
        profilesPath: profilesDir,
        profileName: "default",
      },
    } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({} as any);
    expect((result as any).name).toBe("guidelines");
    expect((result as any).priority).toBe(200);
  });

  it("hook resolves aspects from config when profile has none", async () => {
    await fsPromises.writeFile(
      path.join(aspectsDir, "concise.aspect.md"),
      "# Concise\n\nBe brief."
    );

    // Profile without aspects in front matter
    await fsPromises.writeFile(
      path.join(profilesDir, "default.profile.md"),
      "---\n---\n\nDefault profile without aspects."
    );

    const core = {
      config: { aspects: ["concise"] },
      resolved: {
        configDir: tmpDir,
        profilesPath: profilesDir,
        profileName: "default",
      },
    } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({} as any);
    expect((result as any).content).toContain("Concise");
  });

  it("profile front matter aspects take priority over config aspects", async () => {
    await fsPromises.writeFile(
      path.join(aspectsDir, "profile-aspect.aspect.md"),
      "# Profile Aspect"
    );
    await fsPromises.writeFile(
      path.join(aspectsDir, "config-aspect.aspect.md"),
      "# Config Aspect"
    );

    await fsPromises.writeFile(
      path.join(profilesDir, "default.profile.md"),
      "---\naspects:\n  - profile-aspect\n---\n\nProfile."
    );

    const core = {
      config: { aspects: ["config-aspect"] },
      resolved: {
        configDir: tmpDir,
        profilesPath: profilesDir,
        profileName: "default",
      },
    } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({} as any);
    expect((result as any).content).toContain("Profile Aspect");
    expect((result as any).content).not.toContain("Config Aspect");
  });

  it("handles missing profile file gracefully", async () => {
    const core = {
      config: {},
      resolved: {
        configDir: tmpDir,
        profilesPath: profilesDir,
        profileName: "nonexistent",
      },
    } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({} as any);
    expect((result as any).name).toBe("guidelines");
    expect((result as any).priority).toBe(200);
  });

  it("handles multiple aspects", async () => {
    await fsPromises.writeFile(
      path.join(aspectsDir, "coding.aspect.md"),
      "# Coding\n\nWrite tests."
    );
    await fsPromises.writeFile(
      path.join(aspectsDir, "concise.aspect.md"),
      "# Concise\n\nBe brief."
    );

    await fsPromises.writeFile(
      path.join(profilesDir, "default.profile.md"),
      "---\naspects:\n  - coding\n  - concise\n---\n\nProfile."
    );

    const core = {
      config: {},
      resolved: {
        configDir: tmpDir,
        profilesPath: profilesDir,
        profileName: "default",
      },
    } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({} as any);
    expect((result as any).content).toContain("Coding");
    expect((result as any).content).toContain("Concise");
  });
});
