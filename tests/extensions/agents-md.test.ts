import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { create } from "../../src/extensions/agents-md/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("agents-md extension", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-md-test-"));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates extension with systemPrompt:build hook", () => {
    const core = { config: {} } as any;
    const extension = create(core);
    expect(extension).toBeDefined();
    expect(extension.hooks).toBeDefined();
    expect(extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!).toBeInstanceOf(Function);
  });

  it("hook returns project-context chunk with priority 300", async () => {
    // Create a temporary AGENTS.md
    const agentsMdPath = path.join(tmpDir, "AGENTS.md");
    await fsPromises.writeFile(agentsMdPath, "# Test Project\n\nThis is a test project.");
    process.chdir(tmpDir);

    const core = { config: {} } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({} as any);
    expect((result as any).name).toBe("project-context");
    expect((result as any).priority).toBe(300);
    expect(typeof (result as any).content).toBe("string");
  });

  it("hook includes AGENTS.md content when file exists", async () => {
    const agentsMdPath = path.join(tmpDir, "AGENTS.md");
    await fsPromises.writeFile(agentsMdPath, "# My Project\n\nImportant context here.");
    process.chdir(tmpDir);

    const core = { config: {} } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({} as any);
    expect((result as any).content).toContain("My Project");
    expect((result as any).content).toContain("Important context here");
  });

  it("hook returns empty content when no AGENTS.md exists", async () => {
    process.chdir(tmpDir);

    const core = { config: {} } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({} as any);
    expect((result as any).name).toBe("project-context");
    expect((result as any).priority).toBe(300);
    // Content should be the template without actual AGENTS.md content
  });

  it("respects autoload: false config", async () => {
    const agentsMdPath = path.join(tmpDir, "AGENTS.md");
    await fsPromises.writeFile(agentsMdPath, "# Should Not Appear");
    process.chdir(tmpDir);

    const core = {
      config: { agentsMd: { autoload: false } },
    } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({} as any);
    expect((result as any).content).not.toContain("Should Not Appear");
  });

  it("autoloads by default when config is absent", async () => {
    const agentsMdPath = path.join(tmpDir, "AGENTS.md");
    await fsPromises.writeFile(agentsMdPath, "# Default Autoload Test");
    process.chdir(tmpDir);

    const core = { config: {} } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({} as any);
    expect((result as any).content).toContain("Default Autoload Test");
  });

  it("autoloads when autoload is explicitly true", async () => {
    const agentsMdPath = path.join(tmpDir, "AGENTS.md");
    await fsPromises.writeFile(agentsMdPath, "# Explicit Autoload Test");
    process.chdir(tmpDir);

    const core = {
      config: { agentsMd: { autoload: true } },
    } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.SYSTEM_PROMPT_BUILD]!;
    const result = await hook({} as any);
    expect((result as any).content).toContain("Explicit Autoload Test");
  });
});
