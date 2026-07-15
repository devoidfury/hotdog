// Tests for tool:call and tool:result hooks, and CONTEXT hook via runHookPipeline.
// Note: General runHookPipeline behavior is tested in core-hooks.test.ts.
// This file focuses on tool-specific hook patterns.

import { describe, test, expect } from "bun:test";
import { HookSystem, HOOKS } from "../../src/core/hooks.ts";

describe("tool:call hook", () => {
  test("hook can block tool execution", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_CALL, ({ toolName }) => {
      if (toolName === "dangerous-tool") {
        return { action: "block", result: "Blocked for safety" };
      }
      return { action: "continue" };
    });

    const { lastResult: blockResult } = await hooks.runHookPipeline(HOOKS.TOOL_CALL, {
      toolCallId: "1",
      toolName: "dangerous-tool",
      input: '{"cmd": "rm -rf /"}',
      agent: null,
    });
    expect(blockResult.action).toBe("block");

    const { lastResult: allowResult } = await hooks.runHookPipeline(HOOKS.TOOL_CALL, {
      toolCallId: "2",
      toolName: "safe-tool",
      input: '{"path": "/tmp/test"}',
      agent: null,
    });
    expect(allowResult.action).toBe("continue");
  });

  test("hook can modify tool input", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_CALL, ({ toolName, input }) => {
      if (toolName === "bash") {
        const args = JSON.parse(input);
        args.command = `set -euo pipefail; ${args.command}`;
        return { action: "modify", input: JSON.stringify(args) };
      }
      return { action: "continue" };
    });

    const { lastResult } = await hooks.runHookPipeline(HOOKS.TOOL_CALL, {
      toolCallId: "1",
      toolName: "bash",
      input: '{"command": "ls"}',
      agent: null,
    });

    expect(lastResult.action).toBe("modify");
    expect(JSON.parse(lastResult.input).command).toBe("set -euo pipefail; ls");
  });

  test("multiple handlers can chain modifications via data mutation", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_CALL, (data) => {
      if (data.toolName === "read") {
        const args = JSON.parse(data.input);
        args.cwd = "/workspace";
        data.input = JSON.stringify(args);
      }
      return { action: "continue" };
    });

    hooks.on(HOOKS.TOOL_CALL, (data) => {
      if (data.toolName === "read") {
        const args = JSON.parse(data.input);
        args.path = args.path.startsWith("/") ? args.path : `${args.cwd}/${args.path}`;
        data.input = JSON.stringify(args);
      }
      return { action: "continue" };
    });

    const data = {
      toolCallId: "1",
      toolName: "read",
      input: '{"path": "test.txt"}',
      agent: null,
    };
    await hooks.runHookPipeline(HOOKS.TOOL_CALL, data);

    const finalArgs = JSON.parse(data.input);
    expect(finalArgs.cwd).toBe("/workspace");
    expect(finalArgs.path).toBe("/workspace/test.txt");
  });
});

describe("tool:result hook", () => {
  test("hook can redact sensitive data in results", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_RESULT, ({ result }) => {
      if (typeof result === "string" && result.includes("sk-")) {
        return { result: result.replace(/sk-[a-zA-Z0-9]+/g, "[REDACTED]") };
      }
      return { result };
    });

    const { lastResult } = await hooks.runHookPipeline(HOOKS.TOOL_RESULT, {
      toolCallId: "1",
      toolName: "bash",
      result: "API key is sk-abc123def456",
      input: '{"command": "cat .env"}',
      agent: null,
    });

    expect(lastResult.result).toBe("API key is [REDACTED]");
  });

  test("hook can truncate large results", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_RESULT, ({ result }) => {
      if (typeof result === "string") {
        const lines = result.split("\n");
        if (lines.length > 100) {
          return {
            result: lines.slice(0, 100).join("\n") + `\n... [${lines.length - 100} more lines]`,
          };
        }
      }
      return { result };
    });

    const bigResult = Array(200).fill("line").join("\n");
    const { lastResult } = await hooks.runHookPipeline(HOOKS.TOOL_RESULT, {
      toolCallId: "1",
      toolName: "bash",
      result: bigResult,
      input: "{}",
      agent: null,
    });

    expect(lastResult.result).toContain("[100 more lines]");
    expect(lastResult.result.split("\n").length).toBe(101);
  });
});

describe("CONTEXT hook via runHookPipeline", () => {
  test("handlers can filter messages", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.CONTEXT, ({ messages }) => {
      return { messages: messages.filter((m) => m.content?.length > 0) };
    });

    const { lastResult } = await hooks.runHookPipeline(HOOKS.CONTEXT, {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "" },
        { role: "user", content: "world" },
      ],
      agent: null,
    });

    expect(lastResult.messages).toHaveLength(2);
    expect(lastResult.messages[0].content).toBe("hello");
    expect(lastResult.messages[1].content).toBe("world");
  });

  test("handlers can inject messages", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.CONTEXT, ({ messages }) => {
      return {
        messages: [
          { role: "system", content: "You are helpful." },
          ...messages,
        ],
      };
    });

    const { lastResult } = await hooks.runHookPipeline(HOOKS.CONTEXT, {
      messages: [{ role: "user", content: "hi" }],
      agent: null,
    });

    expect(lastResult.messages).toHaveLength(2);
    expect(lastResult.messages[0].role).toBe("system");
    expect(lastResult.messages[1].content).toBe("hi");
  });
});
