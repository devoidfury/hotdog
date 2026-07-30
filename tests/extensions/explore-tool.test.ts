import { describe, it, expect, beforeEach } from "bun:test";
import { ExploreTool, SpawnFn } from "../../src/extensions/core-tools/explore.ts";
import { ToolContext } from "../../src/core/extensions/tool-context.ts";
import { resultStr } from "../helpers.ts";

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
    const spawnFn: SpawnFn = (cmd, args, opts) => {
      capturedArgs = [cmd, args || [], opts || {}];
      return mockProc;
    };

    const tool = new ExploreTool(spawnFn);
    const result = await tool.execute(
      JSON.stringify({ path: "/tmp/test", outline: "check structure" }),
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
    expect(options.cwd).toBe("/tmp/test");

    // Verify result
    const output = resultStr(result);
    expect(output).toBe("Explorer output line 1\nExplorer output line 2");
    expect((result as any).metadata).toBeInstanceOf(Map);
    expect((result as any).metadata.get("path")).toBe("/tmp/test");
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
      JSON.stringify({ path: "/tmp/test", outline: "check structure" }),
      new ToolContext(),
    );

    const output = resultStr(result);
    expect(output).toBe("Error: command not found");
    expect((result as any).metadata.get("exit_code")).toBe("1");
    expect((result as any).metadata.get("path")).toBe("/tmp/test");
  });

  it("returns error with exit code message when stderr is empty", async () => {
    const tool = new ExploreTool(createMockSpawn({ exitCode: 2 }));
    const result = await tool.execute(
      JSON.stringify({ path: "/tmp/test", outline: "check" }),
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
      JSON.stringify({ path: "/tmp", outline: "test" }),
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
      JSON.stringify({ path: "/tmp", outline: "test" }),
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
    const spawnFn: SpawnFn = (cmd, args, opts) => {
      capturedArgs = [cmd, args || [], opts || {}];
      return mockProc;
    };

    const tool = new ExploreTool(spawnFn);
    const result = await tool.execute(
      JSON.stringify({ path: "/tmp", outline: "test" }),
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
      JSON.stringify({ path: "/tmp", outline: "test" }),
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
      { path: "/project", outline: "find tests" },
      new ToolContext(),
    );

    const output = resultStr(result);
    expect(output).toBe("ok");
  });
});
