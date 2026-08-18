import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import fsSync from "node:fs";
import path from "node:path";
import { ExploreTool, SpawnFn } from "../../src/extensions/core-tools/explore.ts";
import { ToolContext } from "../../src/core/extensions/tool-context.ts";
import { resultStr, tmpDir, cleanupDir, toolCtx } from "../helpers.ts";

// The tool validates that the target is an existing directory, so tests
// that reach the spawn call need a real directory to point at.
let dir: string;

beforeAll(() => {
  dir = tmpDir();
});

afterAll(() => {
  cleanupDir(dir);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a mock spawn function that returns a controllable child process. */
function createMockSpawn(config: {
  stdoutData?: Buffer[];
  stderrData?: Buffer[];
  exitCode: number;
  stdoutCallback?: (cb: (chunk: Buffer) => void) => void;
}): SpawnFn {
  return () => {
    const stdoutCb: ((chunk: Buffer) => void)[] = [];
    const stderrCb: ((chunk: Buffer) => void)[] = [];

    if (config.stdoutCallback) {
      config.stdoutCallback((chunk) => {
        for (const cb of stdoutCb) cb(chunk);
      });
    }

    const proc: any = {
      stdout: {
        on: function (event: string, cb: Function) {
          if (event === "data") {
            stdoutCb.push(cb as (chunk: Buffer) => void);
            if (config.stdoutData) {
              for (const data of config.stdoutData) cb(data);
            }
          }
        },
      },
      stderr: {
        on: function (event: string, cb: Function) {
          if (event === "data") {
            stderrCb.push(cb as (chunk: Buffer) => void);
            if (config.stderrData) {
              for (const data of config.stderrData) cb(data);
            }
          }
        },
      },
      on: function (event: string, cb: Function) {
        if (event === "close") {
          setImmediate(() => cb(config.exitCode));
        }
        return proc;
      },
    };
    return proc;
  };
}

// ── Basic tests ─────────────────────────────────────────────────────────────

describe("ExploreTool", () => {
  it("has correct TOOL_NAME", () => {
    expect(ExploreTool.TOOL_NAME).toBe("explore");
  });

  it("has valid tool definition", () => {
    const tool = new ExploreTool();
    const def = tool.toToolDef();
    expect(def.function.name).toBe("explore");
    expect(def.function.description.length).toBeGreaterThan(0);
    expect(def.function.parameters.properties).toHaveProperty("path");
    expect(def.function.parameters.properties).toHaveProperty("outline");
    expect(def.function.parameters.required).toEqual(["path", "outline"]);
  });
});

describe("ExploreTool > callDisplay", () => {
  const tool = new ExploreTool();

  it("returns path=. for empty input", () => {
    expect(tool.callDisplay("")).toBe("path=.");
    expect(tool.callDisplay("  ")).toBe("path=.");
    expect(tool.callDisplay(null)).toBe("path=.");
  });

  it("formats path and outline", () => {
    expect(
      tool.callDisplay(JSON.stringify({ path: "/tmp", outline: "src files" })),
    ).toBe("path=/tmp -> src files");
  });

  it("handles malformed JSON gracefully", () => {
    const result = tool.callDisplay("not-json");
    expect(result).toBe("not-json");
  });

  it("handles object input for callDisplay", () => {
    expect(
      tool.callDisplay({ path: "/project", outline: "find tests" }),
    ).toBe("path=/project -> find tests");
  });
});

// ── Input parsing tests ─────────────────────────────────────────────────────

describe("ExploreTool > execute input parsing", () => {
  let mockSpawn: SpawnFn;

  beforeEach(() => {
    mockSpawn = createMockSpawn({ exitCode: 0 });
  });

  it("rejects empty input (defaults to path=., no outline)", async () => {
    const tool = new ExploreTool(mockSpawn);
    const result = await tool.execute("", new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });

  it("accepts malformed JSON as outline (path defaults to .)", async () => {
    const tool = new ExploreTool(mockSpawn);
    const result = await tool.execute("not valid json", new ToolContext());
    expect((result as any).metadata.get("path")).toBe(".");
    expect((result as any).metadata.get("outline")).toBe("not valid json");
  });

  it("rejects null input", async () => {
    const tool = new ExploreTool(mockSpawn);
    const result = await tool.execute(null, new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });

  it("rejects input with non-string path (falls back to path=.)", async () => {
    const tool = new ExploreTool(mockSpawn);
    const result = await tool.execute({ path: 123 }, new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });
});

// ── Execute tests (with mock spawn) ─────────────────────────────────────────

describe("ExploreTool > execute", () => {
  beforeEach(() => {
    // No global state to clean up
  });

  it("rejects missing outline", async () => {
    const tool = new ExploreTool(createMockSpawn({ exitCode: 0 }));
    const result = await tool.execute(
      JSON.stringify({ path: "/tmp" }),
      new ToolContext(),
    );
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });

  it("rejects empty input", async () => {
    const tool = new ExploreTool(createMockSpawn({ exitCode: 0 }));
    const result = await tool.execute("", new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });

  it("handles null input", async () => {
    const tool = new ExploreTool(createMockSpawn({ exitCode: 0 }));
    const result = await tool.execute(null, new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });

  it("handles whitespace-only outline", async () => {
    const tool = new ExploreTool(createMockSpawn({ exitCode: 0 }));
    const result = await tool.execute(
      JSON.stringify({ path: "/tmp", outline: "   " }),
      new ToolContext(),
    );
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });

  it("handles object input with missing outline", async () => {
    const tool = new ExploreTool(createMockSpawn({ exitCode: 0 }));
    const result = await tool.execute({ path: "/tmp" }, new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });

  it("returns success result when explorer exits with code 0", async () => {
    const mockProc: any = {
      stdout: {
        on: function (event: string, cb: Function) {
          if (event === "data")
            cb(Buffer.from("Explorer output line 1\nExplorer output line 2"));
        },
      },
      stderr: { on: function () {} },
      on: function (event: string, cb: Function) {
        if (event === "close") {
          setImmediate(() => cb(0));
        }
        return mockProc;
      },
    };

    let capturedArgs: [string, string[], Record<string, unknown>] | null = null;
    const spawnFn = ((cmd: string, args: readonly string[] | undefined, opts: unknown) => {
      capturedArgs = [cmd, (args || []) as string[], (opts || {}) as Record<string, unknown>];
      return mockProc;
    }) as SpawnFn;

    const tool = new ExploreTool(spawnFn);
    const result = await tool.execute(
      JSON.stringify({ path: dir, outline: "check structure" }),
      new ToolContext(),
    );

    // Verify spawn was called with correct arguments
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs![0]).toBe("bun");
    const args = capturedArgs![1] as string[];
    expect(args).toContain("-c");
    expect(args).toContain("--profile");
    expect(args).toContain("explorer");
    expect(args).toContain("--hide-tools");
    expect(args).toContain("--hide-thinking");

    // Verify cwd option
    const options = capturedArgs![2] as Record<string, unknown>;
    expect(options.cwd).toBe(dir);

    // Verify result
    const output = resultStr(result);
    expect(output).toBe("Explorer output line 1\nExplorer output line 2");
    expect((result as any).metadata).toBeInstanceOf(Map);
    expect((result as any).metadata.get("path")).toBe(dir);
    expect((result as any).metadata.get("exit_code")).toBe("0");
  });

  it("returns error result when explorer exits with non-zero code", async () => {
    const tool = new ExploreTool(
      createMockSpawn({
        stderrData: [Buffer.from("Error: command not found")],
        exitCode: 1,
      }),
    );
    const result = await tool.execute(
      JSON.stringify({ path: dir, outline: "check structure" }),
      new ToolContext(),
    );

    const output = resultStr(result);
    expect(output).toBe("Error: command not found");
    expect((result as any).metadata.get("exit_code")).toBe("1");
    expect((result as any).metadata.get("path")).toBe(dir);
  });

  it("returns error with exit code message when stderr is empty", async () => {
    const tool = new ExploreTool(createMockSpawn({ exitCode: 2 }));
    const result = await tool.execute(
      JSON.stringify({ path: dir, outline: "check" }),
      new ToolContext(),
    );

    const output = resultStr(result);
    expect(output).toContain("Explorer exited with code 2");
  });

  it("accumulates multiple stdout chunks", async () => {
    let stdoutCb: ((chunk: Buffer) => void) | null = null;
    const mockProc: any = {
      stdout: {
        on: function (event: string, cb: Function) {
          if (event === "data") {
            stdoutCb = cb as (chunk: Buffer) => void;
          }
        },
      },
      stderr: { on: function () {} },
      on: function (event: string, cb: Function) {
        if (event === "close") {
          setImmediate(() => {
            if (stdoutCb) {
              stdoutCb(Buffer.from("chunk1"));
              stdoutCb(Buffer.from("chunk2"));
              stdoutCb(Buffer.from("chunk3"));
            }
            cb(0);
          });
        }
        return mockProc;
      },
    };

    const tool = new ExploreTool(() => mockProc);
    const result = await tool.execute(
      JSON.stringify({ path: dir, outline: "test" }),
      new ToolContext(),
    );

    const output = resultStr(result);
    expect(output).toBe("chunk1chunk2chunk3");
  });

  it("includes content_length in success result entries", async () => {
    const tool = new ExploreTool(
      createMockSpawn({ stdoutData: [Buffer.from("12345")], exitCode: 0 }),
    );
    const result = await tool.execute(
      JSON.stringify({ path: dir, outline: "test" }),
      new ToolContext(),
    );

    expect((result as any).metadata.get("content_length")).toBe("5");
  });

  it("includes command in result entries", async () => {
    const mockProc: any = {
      stdout: {
        on: function (event: string, cb: Function) {
          if (event === "data") cb(Buffer.from("ok"));
        },
      },
      stderr: { on: function () {} },
      on: function (event: string, cb: Function) {
        if (event === "close") {
          setImmediate(() => cb(0));
        }
        return mockProc;
      },
    };

    let capturedArgs: [string, string[], Record<string, unknown>] | null = null;
    const spawnFn = ((cmd: string, args: readonly string[] | undefined, opts: unknown) => {
      capturedArgs = [cmd, (args || []) as string[], (opts || {}) as Record<string, unknown>];
      return mockProc;
    }) as SpawnFn;

    const tool = new ExploreTool(spawnFn);
    const result = await tool.execute(
      JSON.stringify({ path: dir, outline: "test" }),
      new ToolContext(),
    );

    const command = (result as any).metadata.get("command");
    expect(command).toContain("-c");
    expect(command).toContain("explorer");
    expect(command).toContain("--hide-tools");
  });

  it("trims output whitespace", async () => {
    const tool = new ExploreTool(
      createMockSpawn({
        stdoutData: [Buffer.from("  output with spaces  \n")],
        exitCode: 0,
      }),
    );
    const result = await tool.execute(
      JSON.stringify({ path: dir, outline: "test" }),
      new ToolContext(),
    );

    const output = resultStr(result);
    expect(output).toBe("output with spaces");
  });

  it("accepts object input (not JSON string)", async () => {
    const tool = new ExploreTool(
      createMockSpawn({ stdoutData: [Buffer.from("ok")], exitCode: 0 }),
    );
    const result = await tool.execute(
      { path: dir, outline: "find tests" },
      new ToolContext(),
    );

    const output = resultStr(result);
    expect(output).toBe("ok");
  });
});

// ── Workspace boundary ──────────────────────────────────────────────────────

describe("ExploreTool > execute — workspace boundary", () => {
  /** Spawn that fails loudly if it is ever called (boundary cases must not spawn). */
  function failSpawn(): SpawnFn {
    const fn = (_cmd: string, _args: readonly string[] | undefined, _opts: unknown): never => {
      throw new Error("spawn should not have been called");
    };
    return fn as unknown as SpawnFn;
  }

  beforeAll(() => {
    fsSync.mkdirSync(path.join(dir, "proj"), { recursive: true });
  });

  afterAll(() => {
    fsSync.rmSync(path.join(dir, "file.txt"), { force: true });
  });

  it("resolves a relative path against the workspace root", async () => {
    const tool = new ExploreTool(
      createMockSpawn({ stdoutData: [Buffer.from("ok")], exitCode: 0 }),
    );
    const result = await tool.execute(
      { path: "proj", outline: "check" },
      toolCtx({ workspaceRoot: dir }),
    );

    expect(resultStr(result)).toBe("ok");
  });

  it("passes the resolved absolute path as cwd", async () => {
    let lastCwd: string | null = null;
    const mockProc: any = {
      stdout: {
        on: function (event: string, cb: Function) {
          if (event === "data") cb(Buffer.from("ok"));
        },
      },
      stderr: { on: function () {} },
      on: function (event: string, cb: Function) {
        if (event === "close") setImmediate(() => cb(0));
        return mockProc;
      },
    };
    const spawn = ((cmd: string, args: readonly string[] | undefined, opts: unknown) => {
      lastCwd = ((opts || {}) as Record<string, unknown>).cwd as string | null;
      return mockProc;
    }) as SpawnFn;
    const result = await new ExploreTool(spawn).execute(
      { path: "proj", outline: "check" },
      toolCtx({ workspaceRoot: dir }),
    );

    expect(lastCwd as string | null).toBe(path.join(dir, "proj"));
    expect(resultStr(result)).toBe("ok");
  });

  it("allows an absolute path inside the workspace", async () => {
    const tool = new ExploreTool(
      createMockSpawn({ stdoutData: [Buffer.from("ok")], exitCode: 0 }),
    );
    const result = await tool.execute(
      { path: dir, outline: "check" },
      toolCtx({ workspaceRoot: dir }),
    );
    expect(resultStr(result)).toBe("ok");
  });

  it("rejects a relative path that escapes the workspace", async () => {
    const tool = new ExploreTool(failSpawn());
    const result = await tool.execute(
      JSON.stringify({ path: "../../etc", outline: "check" }),
      toolCtx({ workspaceRoot: dir }),
    );
    expect(resultStr(result)).toContain("Path escape rejected");
  });

  it("rejects an absolute path outside the workspace", async () => {
    const tool = new ExploreTool(failSpawn());
    const result = await tool.execute(
      JSON.stringify({ path: "/etc", outline: "check" }),
      toolCtx({ workspaceRoot: dir }),
    );
    expect(resultStr(result)).toContain("Path escape rejected");
  });

  it("rejects a non-existent directory", async () => {
    const tool = new ExploreTool(failSpawn());
    const result = await tool.execute(
      { path: "does-not-exist", outline: "check" },
      toolCtx({ workspaceRoot: dir }),
    );
    expect(resultStr(result)).toContain("Directory not found");
  });

  it("rejects a file path (not a directory)", async () => {
    const file = path.join(dir, "file.txt");
    fsSync.writeFileSync(file, "hi");

    const tool = new ExploreTool(failSpawn());
    const result = await tool.execute(
      { path: "file.txt", outline: "check" },
      toolCtx({ workspaceRoot: dir }),
    );
    expect(resultStr(result)).toContain("Not a directory");
  });
});
