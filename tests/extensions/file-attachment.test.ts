import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { create } from "../../src/extensions/file-attachment/index.ts";
import { matcher, completion } from "../../src/extensions/file-attachment/completions.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { createCompletionService } from "../../src/core/completion.ts";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Mock agent for completion tests
const mockAgent = {} as unknown as import("../../src/core/agent.ts").Agent;

describe("file-attachment completion matcher", () => {
  it("matches when typing @ at start of word", () => {
    const ctx = { line: "Read @", cursorPos: 6, agent: mockAgent } as any;
    expect(matcher(ctx)).toBe(true);
  });

  it("matches when typing @ with partial path", () => {
    const ctx = { line: "Read @src", cursorPos: 9, agent: mockAgent } as any;
    expect(matcher(ctx)).toBe(true);
  });

  it("matches when typing @ with subdirectory path", () => {
    const ctx = { line: "Read @src/core/", cursorPos: 14, agent: mockAgent } as any;
    expect(matcher(ctx)).toBe(true);
  });

  it("matches when @ is after a space", () => {
    const ctx = { line: "foo bar @test", cursorPos: 13, agent: mockAgent } as any;
    expect(matcher(ctx)).toBe(true);
  });

  it("does not match when @ is not at start of current word", () => {
    const ctx = { line: "Read test@", cursorPos: 9, agent: mockAgent } as any;
    expect(matcher(ctx)).toBe(false);
  });

  it("does not match when current word does not start with @", () => {
    const ctx = { line: "Read test.txt", cursorPos: 13, agent: mockAgent } as any;
    expect(matcher(ctx)).toBe(false);
  });

  it("does not match when line is empty", () => {
    const ctx = { line: "", cursorPos: 0, agent: mockAgent } as any;
    expect(matcher(ctx)).toBe(false);
  });

  it("does not match when cursor is before @", () => {
    const ctx = { line: "Read @test", cursorPos: 5, agent: mockAgent } as any;
    expect(matcher(ctx)).toBe(false);
  });

  it("matches when only @ is typed", () => {
    const ctx = { line: "@", cursorPos: 1, agent: mockAgent } as any;
    expect(matcher(ctx)).toBe(true);
  });

  it("matches with absolute path after @", () => {
    const ctx = { line: "Read @/etc/passwd", cursorPos: 17, agent: mockAgent } as any;
    expect(matcher(ctx)).toBe(true);
  });
});

describe("file-attachment completion handler", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-attachment-completion-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    // Create test files and directories
    fs.writeFileSync(path.join(tmpDir, "test.txt"), "content");
    fs.writeFileSync(path.join(tmpDir, "test2.txt"), "content");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "readme");
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "main.ts"), "code");
    fs.mkdirSync(path.join(tmpDir, "src", "core"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "core", "agent.ts"), "agent code");
    // Hidden files and node_modules should be skipped
    fs.writeFileSync(path.join(tmpDir, ".hidden"), "hidden");
    fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "node_modules", "package.js"), "dep");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns completions for @ prefix", async () => {
    const ctx = { line: "Read @", cursorPos: 6, agent: mockAgent } as any;
    const results = await completion(ctx);

    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    // Should include visible files and dirs
    const values = results.map((r) => r.value);
    expect(values).toContain("@test.txt");
    expect(values).toContain("@test2.txt");
    expect(values).toContain("@README.md");
    expect(values).toContain("@src/");

    // Should NOT include hidden files or node_modules
    expect(values).not.toContain("@.hidden");
    expect(values).not.toContain("@node_modules/");
  });

  it("filters completions by prefix", async () => {
    const ctx = { line: "Read @test", cursorPos: 10, agent: mockAgent } as any;
    const results = await completion(ctx);

    const values = results.map((r) => r.value);
    expect(values).toContain("@test.txt");
    expect(values).toContain("@test2.txt");
    expect(values).not.toContain("@README.md");
  });

  it("completes subdirectory paths without trailing slash", async () => {
    const ctx = { line: "Read @src", cursorPos: 9, agent: mockAgent } as any;
    const results = await completion(ctx);

    const values = results.map((r) => r.value);
    expect(values).toContain("@src/");
  });

  it("completes entries within subdirectory when prefix provided", async () => {
    const ctx = { line: "Read @src/main", cursorPos: 14, agent: mockAgent } as any;
    const results = await completion(ctx);

    const values = results.map((r) => r.value);
    expect(values).toContain("@src/main.ts");
    expect(values).not.toContain("@src/core/");
  });

  it("completes deeply nested paths", async () => {
    const ctx = { line: "Read @src/core/agent", cursorPos: 20, agent: mockAgent } as any;
    const results = await completion(ctx);

    const values = results.map((r) => r.value);
    expect(values).toContain("@src/core/agent.ts");
  });

  it("returns empty array when no matches", async () => {
    const ctx = { line: "Read @zzzzz", cursorPos: 12, agent: mockAgent } as any;
    const results = await completion(ctx);
    expect(results).toEqual([]);
  });

  it("returns empty array when not starting with @", async () => {
    const ctx = { line: "Read test.txt", cursorPos: 13, agent: mockAgent } as any;
    const results = await completion(ctx);
    expect(results).toEqual([]);
  });

  it("is case-insensitive for matching", async () => {
    const ctx = { line: "Read @TEST", cursorPos: 10, agent: mockAgent } as any;
    const results = await completion(ctx);

    const values = results.map((r) => r.value);
    // Should match test.txt even though we typed TEST
    expect(values).toContain("@test.txt");
  });

  it("uses cwdBoundary from agent config", async () => {
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "config.json"), "{}");

    const ctx = {
      line: "Read @",
      cursorPos: 6,
      agent: { config: { cwdBoundary: workspaceDir } },
    } as any;

    const results = await completion(ctx);
    const values = results.map((r) => r.value);
    expect(values).toContain("@config.json");
    expect(values).not.toContain("@test.txt"); // not in workspaceDir
  });

  it("uses workspaceRoot from agent config when cwdBoundary is not set", async () => {
    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "config.json"), "{}");

    const ctx = {
      line: "Read @",
      cursorPos: 6,
      agent: { config: { workspaceRoot: workspaceDir } },
    } as any;

    const results = await completion(ctx);
    const values = results.map((r) => r.value);
    expect(values).toContain("@config.json");
  });

  it("falls back to cwd when no agent context", async () => {
    const ctx = {
      line: "Read @",
      cursorPos: 6,
      agent: {},
    } as any;

    const results = await completion(ctx);
    const values = results.map((r) => r.value);
    // Should see files in current tmpDir
    expect(values).toContain("@test.txt");
  });

  it("handles absolute paths with prefix", async () => {
    const absPath = path.join(tmpDir, "src");
    const ctx = {
      line: `Read @${absPath}/main`,
      cursorPos: `Read @${absPath}/main`.length,
      agent: mockAgent,
    } as any;

    const results = await completion(ctx);
    const values = results.map((r) => r.value);
    expect(values).toContain(`@${absPath}/main.ts`);
  });

  it("handles absolute paths listing directory", async () => {
    const absPath = path.join(tmpDir, "src");
    // Without trailing slash - matches directory itself
    const ctx = {
      line: `Read @${absPath}`,
      cursorPos: `Read @${absPath}`.length,
      agent: mockAgent,
    } as any;

    const results = await completion(ctx);
    const values = results.map((r) => r.value);
    expect(values).toContain(`@${absPath}/`);
  });

  it("handles directory read errors gracefully", async () => {
    const ctx = {
      line: "Read @/nonexistent/path/that/does/not/exist/",
      cursorPos: 45,
      agent: mockAgent,
    } as any;

    const results = await completion(ctx);
    expect(results).toEqual([]);
  });

  it("returns completion options with value property", async () => {
    const ctx = { line: "Read @", cursorPos: 6, agent: mockAgent } as any;
    const results = await completion(ctx);

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result).toHaveProperty("value");
      expect(typeof result.value).toBe("string");
      expect(result.value.startsWith("@")).toBe(true);
    }
  });

  it("appends / to directory names", async () => {
    const ctx = { line: "Read @", cursorPos: 6, agent: mockAgent } as any;
    const results = await completion(ctx);

    const srcResult = results.find((r) => r.value.includes("src"));
    expect(srcResult).toBeDefined();
    expect(srcResult!.value).toBe("@src/");
  });
});

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
    const core = { config: { fileAttachment: { maxFileSize: 102400, maxFiles: 10 } }, completion: createCompletionService() } as any;
    const extension = create(core);
    expect(extension).toBeDefined();
    expect(extension.hooks).toBeDefined();
    expect(extension.hooks![HOOKS.INPUT]!).toBeInstanceOf(Function);
  });

  it("returns continue when no file references in input", async () => {
    const core = { config: { fileAttachment: { maxFileSize: 102400, maxFiles: 10 } }, completion: createCompletionService() } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;
    const result = await hook({ text: "Hello world", agent: null } as any);
    expect((result as any).action).toBe("continue");
  });

  it("expands @filepath reference to file contents", async () => {
    const testFile = path.join(tmpDir, "test.txt");
    await fsPromises.writeFile(testFile, "Hello from file!");

    const core = { config: { fileAttachment: { maxFileSize: 102400, maxFiles: 10 } }, completion: createCompletionService() } as any;
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

    const core = { config: { fileAttachment: { maxFileSize: 102400, maxFiles: 10 } }, completion: createCompletionService() } as any;
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

    const core = { config: { fileAttachment: { maxFileSize: 102400, maxFiles: 10 } }, completion: createCompletionService() } as any;
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
    const core = { config: { fileAttachment: { maxFileSize: 102400, maxFiles: 10 } }, completion: createCompletionService() } as any;
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

    const core = { config: { fileAttachment: { maxFileSize: 102400, maxFiles: 10 } }, completion: createCompletionService() } as any;
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

    const core = { config: { fileAttachment: { maxFileSize: 102400, maxFiles: 10 } }, completion: createCompletionService() } as any;
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
      completion: createCompletionService(),
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
      completion: createCompletionService(),
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

  it("does not expand @ in email addresses (word char before @)", async () => {
    await fsPromises.writeFile(path.join(tmpDir, "furycodes.com"), "domain content");

    const core = { config: { fileAttachment: { maxFileSize: 102400, maxFiles: 10 } }, completion: createCompletionService() } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;
    const result = await hook(
      { text: "Contact tom@furycodes.com about it", agent: null } as any,
    );

    expect((result as any).action).toBe("continue");
  });

  it("expands @ after non-word characters like parentheses", async () => {
    await fsPromises.writeFile(path.join(tmpDir, "paren.txt"), "paren content");

    const core = { config: { fileAttachment: { maxFileSize: 102400, maxFiles: 10 } }, completion: createCompletionService() } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;
    const result = await hook(
      { text: "See (@paren.txt) for details", agent: null } as any,
    );

    expect((result as any).action).toBe("transform");
    expect((result as any).text).toContain("paren content");
  });

  it("expands @ at the start of the string", async () => {
    await fsPromises.writeFile(path.join(tmpDir, "first.txt"), "first content");

    const core = { config: { fileAttachment: { maxFileSize: 102400, maxFiles: 10 } }, completion: createCompletionService() } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;
    const result = await hook(
      { text: "@first.txt", agent: null } as any,
    );

    expect((result as any).action).toBe("transform");
    expect((result as any).text).toContain("first content");
  });

  it("uses agent context for cwdBoundary", async () => {
    const workspaceDir = path.join(tmpDir, "workspace");
    await fsPromises.mkdir(workspaceDir, { recursive: true });
    await fsPromises.writeFile(path.join(workspaceDir, "config.json"), '{"key": "value"}');

    const core = { config: { fileAttachment: { maxFileSize: 102400, maxFiles: 10 } }, completion: createCompletionService() } as any;
    const extension = create(core);
    const hook = extension.hooks![HOOKS.INPUT]!;

    const result = await hook(
      {
        text: "Read @config.json",
        agent: { config: { cwdBoundary: workspaceDir, workspaceRoot: workspaceDir } },
      } as any,
    );

    expect((result as any).action).toBe("transform");
    const expanded = (result as any).text;
    expect(expanded).toContain("Read @config.json");
    expect(expanded).toContain('{"key": "value"}');
  });

});

describe("file-attachment workspace boundary (escape rejection)", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let secretFile: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-attach-boundary-"));
    workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    // A file OUTSIDE the workspace, one level up from it
    secretFile = path.join(tmpDir, "outside.txt");
    fs.writeFileSync(secretFile, "OUTSIDE-SECRET-CONTENT");
    // A legitimate file inside the workspace
    fs.writeFileSync(path.join(workspaceDir, "inside.txt"), "INSIDE-OK-CONTENT");
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeHook() {
    const core = {
      config: { fileAttachment: { maxFileSize: 102400, maxFiles: 10 } },
      completion: createCompletionService(),
    } as any;
    return create(core).hooks![HOOKS.INPUT]!;
  }

  const boundaryAgent = () => ({ config: { cwdBoundary: workspaceDir } });

  it("(a) @../outside.txt with workspace configured is NOT attached and is reported", async () => {
    const hook = makeHook();
    const result = await hook({
      text: "Please read @../outside.txt",
      agent: boundaryAgent(),
    } as any);

    const r = result as any;
    // The file outside the workspace must never leak into the prompt
    expect(r.text).not.toContain("OUTSIDE-SECRET-CONTENT");
    // And it must be reported, not silently swallowed
    expect(r.text).toContain("could not read");
    expect(r.text).toContain("../outside.txt");
  });

  it("(b) absolute path outside the workspace is NOT attached and is reported", async () => {
    const hook = makeHook();
    const result = await hook({
      text: `Please read @${secretFile}`,
      agent: boundaryAgent(),
    } as any);

    const r = result as any;
    expect(r.text).not.toContain("OUTSIDE-SECRET-CONTENT");
    expect(r.text).toContain("could not read");
    expect(r.text).toContain(secretFile);
  });

  it("(c) legitimate relative path inside the workspace still attaches", async () => {
    const hook = makeHook();
    const result = await hook({
      text: "Please read @inside.txt",
      agent: boundaryAgent(),
    } as any);

    const r = result as any;
    expect(r.action).toBe("transform");
    expect(r.text).toContain("INSIDE-OK-CONTENT");
    expect(r.text).toContain("<path>inside.txt</path>");
    expect(r.text).not.toContain("could not read");
  });

  it("attaches in-workspace files while reporting rejected escapes alongside", async () => {
    const hook = makeHook();
    const result = await hook({
      text: "Compare @inside.txt with @../outside.txt",
      agent: boundaryAgent(),
    } as any);

    const r = result as any;
    expect(r.action).toBe("transform");
    expect(r.text).toContain("INSIDE-OK-CONTENT");
    expect(r.text).not.toContain("OUTSIDE-SECRET-CONTENT");
    expect(r.text).toContain("could not read");
    expect(r.text).toContain("../outside.txt");
  });

  it("still attaches when no boundary is configured (workspace === null)", async () => {
    // No agent context: boundary unconfigured, resolves against cwd as before
    const hook = makeHook();
    const result = await hook({
      text: "Please read @workspace/inside.txt",
      agent: null,
    } as any);

    const r = result as any;
    expect(r.action).toBe("transform");
    expect(r.text).toContain("INSIDE-OK-CONTENT");
  });
});
