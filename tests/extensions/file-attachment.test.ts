import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { create } from "../../src/extensions/file-attachment/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("file-attachment extension", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-attachment-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates extension with INPUT hook", () => {
    const core = { config: {} } as any;
    const extension = create(core);
    expect(extension).toBeDefined();
    expect(extension.hooks).toBeDefined();
    expect(extension.hooks![HOOKS.INPUT]!).toBeInstanceOf(Function);
  });

  it("returns continue when no file references in input", async () => {
    const core = { config: {} } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;
    const result = await hook({ text: "Hello world", agent: null } as any);
    expect((result as any).action).toBe("continue");
  });

  it("expands @filepath reference to file contents", async () => {
    const testFile = path.join(tmpDir, "test.txt");
    await fsPromises.writeFile(testFile, "Hello from file!");

    const core = { config: {} } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;
    const result = await hook({ text: "Read @test.txt please", agent: null } as any);

    expect((result as any).action).toBe("transform");
    const expanded = (result as any).text;
    // Reference stays in original text
    expect(expanded).toContain("Read @test.txt please");
    // Content appended at bottom
    expect(expanded).toContain("<file-include>");
    expect(expanded).toContain("</file-include>");
    expect(expanded).toContain("<path>test.txt</path>");
    expect(expanded).toContain("Hello from file!");
  });

  it("expands multiple file references", async () => {
    await fsPromises.writeFile(path.join(tmpDir, "a.txt"), "Content A");
    await fsPromises.writeFile(path.join(tmpDir, "b.txt"), "Content B");

    const core = { config: {} } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;
    const result = await hook(
      { text: "Compare @a.txt with @b.txt", agent: null } as any,
    );

    expect((result as any).action).toBe("transform");
    const expanded = (result as any).text;
    // References stay in original text
    expect(expanded).toContain("Compare @a.txt with @b.txt");
    // Content appended at bottom
    expect(expanded).toContain("Content A");
    expect(expanded).toContain("Content B");
  });

  it("expands files with subdirectory paths", async () => {
    const subDir = path.join(tmpDir, "src", "core");
    await fsPromises.mkdir(subDir, { recursive: true });
    await fsPromises.writeFile(path.join(subDir, "main.ts"), "console.log('hi');");

    const core = { config: {} } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;
    const result = await hook(
      { text: "Review @src/core/main.ts", agent: null } as any,
    );

    expect((result as any).action).toBe("transform");
    const expanded = (result as any).text;
    expect(expanded).toContain("Review @src/core/main.ts");
    expect(expanded).toContain("console.log('hi');");
    expect(expanded).toContain("<path>src/core/main.ts</path>");
  });

  it("adds error note for missing files", async () => {
    const core = { config: {} } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;
    const result = await hook(
      { text: "Read @nonexistent.txt", agent: null } as any,
    );

    // Missing file alone should not transform (no successful expansions)
    expect((result as any).action).toBe("continue");
  });

  it("adds error note for missing files alongside successful ones", async () => {
    await fsPromises.writeFile(path.join(tmpDir, "exists.txt"), "I exist!");

    const core = { config: {} } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;
    const result = await hook(
      {
        text: "Read @exists.txt and @missing.txt",
        agent: null,
      } as any,
    );

    expect((result as any).action).toBe("transform");
    const expanded = (result as any).text;
    expect(expanded).toContain("Read @exists.txt and @missing.txt");
    expect(expanded).toContain("I exist!");
    expect(expanded).toContain("could not read");
    expect(expanded).toContain("missing.txt");
  });

  it("skips directories", async () => {
    await fsPromises.mkdir(path.join(tmpDir, "mydir"), { recursive: true });

    const core = { config: {} } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;
    const result = await hook(
      { text: "List @mydir contents", agent: null } as any,
    );

    // Directory alone should not transform
    expect((result as any).action).toBe("continue");
  });

  it("respects maxFileSize config", async () => {
    const largeFile = path.join(tmpDir, "large.txt");
    await fsPromises.writeFile(largeFile, "x".repeat(200));

    const core = {
      config: { fileAttachment: { maxFileSize: 100 } },
    } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;
    const result = await hook({ text: "Read @large.txt", agent: null } as any);

    // File exceeds max size, should not transform
    expect((result as any).action).toBe("continue");
  });

  it("respects maxFiles config", async () => {
    for (let i = 0; i < 5; i++) {
      await fsPromises.writeFile(path.join(tmpDir, `file${i}.txt`), `Content ${i}`);
    }

    const core = {
      config: { fileAttachment: { maxFiles: 2 } },
    } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;
    const result = await hook(
      {
        text:
          "@file0.txt @file1.txt @file2.txt @file3.txt @file4.txt",
        agent: null,
      } as any,
    );

    expect((result as any).action).toBe("transform");
    const expanded = (result as any).text;
    // References stay in original text
    expect(expanded).toContain("@file0.txt @file1.txt @file2.txt @file3.txt @file4.txt");
    // Only first 2 files should be expanded at bottom
    expect(expanded).toContain("Content 0");
    expect(expanded).toContain("Content 1");
    expect(expanded).not.toContain("Content 2");
  });

  it("uses agent context for cwdBoundary", async () => {
    const workspaceDir = path.join(tmpDir, "workspace");
    await fsPromises.mkdir(workspaceDir, { recursive: true });
    await fsPromises.writeFile(path.join(workspaceDir, "config.json"), '{"key": "value"}');

    const core = { config: {} } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;

    const mockContext = {
      get: (key: string) => {
        if (key === "cwdBoundary") return workspaceDir;
        if (key === "workspaceRoot") return workspaceDir;
        return null;
      },
    };

    const result = await hook(
      {
        text: "Read @config.json",
        agent: { context: mockContext },
      } as any,
    );

    expect((result as any).action).toBe("transform");
    const expanded = (result as any).text;
    expect(expanded).toContain("Read @config.json");
    expect(expanded).toContain('{"key": "value"}');
  });

});
