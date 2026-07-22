// Tests for tool:call and tool:result hooks, and CONTEXT hook via runHookPipeline.
// Note: General runHookPipeline behavior is tested in core-hooks.test.ts.
// This file focuses on tool-specific hook patterns.

import { describe, test, expect } from "bun:test";
import { HookSystem, HOOKS } from "../../src/core/hooks.ts";
import type { Agent } from "../../src/core/agent.ts";
import { Message } from "../../src/core/context/message.ts";

const mockAgent = {} as Agent;

describe("tool:call hook", () => {
  test("hook can block tool execution", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_CALL, (({ toolName }: { toolName: string }) => {
      if (toolName === "dangerous-tool") {
        return { action: "block", result: "Blocked for safety" };
      }
      return { action: "continue" };
    }) as (data: unknown) => unknown);

    const { lastResult: blockResult } = await hooks.runHookPipeline(HOOKS.TOOL_CALL, {
      toolCallId: "1",
      toolName: "dangerous-tool",
      input: '{"cmd": "rm -rf /"}',
      agent: mockAgent,
    });
    expect((blockResult as Record<string, unknown>).action).toBe("block");

    const { lastResult: allowResult } = await hooks.runHookPipeline(HOOKS.TOOL_CALL, {
      toolCallId: "2",
      toolName: "safe-tool",
      input: '{"path": "/tmp/test"}',
      agent: mockAgent,
    });
    expect((allowResult as Record<string, unknown>).action).toBe("continue");
  });

  test("hook can modify tool input", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_CALL, (({ toolName, input }: { toolName: string; input: string }) => {
      if (toolName === "bash") {
        const args = JSON.parse(input);
        args.command = `set -euo pipefail; ${args.command}`;
        return { action: "modify", input: JSON.stringify(args) };
      }
      return { action: "continue" };
    }) as (data: unknown) => unknown);

    const { lastResult } = await hooks.runHookPipeline(HOOKS.TOOL_CALL, {
      toolCallId: "1",
      toolName: "bash",
      input: '{"command": "ls"}',
      agent: mockAgent,
    });

    expect((lastResult as Record<string, unknown>).action).toBe("modify");
    expect(JSON.parse((lastResult as Record<string, unknown>).input as string).command).toBe("set -euo pipefail; ls");
  });

  test("multiple handlers can chain modifications via data mutation", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_CALL, ((data: { toolName: string; input: string }) => {
      if (data.toolName === "read") {
        const args = JSON.parse(data.input);
        args.cwd = "/workspace";
        data.input = JSON.stringify(args);
      }
      return { action: "continue" };
    }) as (data: unknown) => unknown);

    hooks.on(HOOKS.TOOL_CALL, ((data: { toolName: string; input: string }) => {
      if (data.toolName === "read") {
        const args = JSON.parse(data.input);
        args.path = args.path.startsWith("/") ? args.path : `${args.cwd}/${args.path}`;
        data.input = JSON.stringify(args);
      }
      return { action: "continue" };
    }) as (data: unknown) => unknown);

    const data = {
      toolCallId: "1",
      toolName: "read",
      input: '{"path": "test.txt"}',
      agent: mockAgent,
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

    hooks.on(HOOKS.TOOL_RESULT, (({ result }: { result: string }) => {
      if (typeof result === "string" && result.includes("sk-")) {
        return { result: result.replace(/sk-[a-zA-Z0-9]+/g, "[REDACTED]") };
      }
      return { result };
    }) as (data: unknown) => unknown);

    const { lastResult } = await hooks.runHookPipeline(HOOKS.TOOL_RESULT, {
      toolCallId: "1",
      toolName: "bash",
      result: "API key is sk-abc123def456",
      input: '{"command": "cat .env"}',
      success: true,
      agent: mockAgent,
    });

    expect((lastResult as Record<string, unknown>).result).toBe("API key is [REDACTED]");
  });

  test("hook can truncate large results", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.TOOL_RESULT, (({ result }: { result: string }) => {
      if (typeof result === "string") {
        const lines = result.split("\n");
        if (lines.length > 100) {
          return {
            result: lines.slice(0, 100).join("\n") + `\n... [${lines.length - 100} more lines]`,
          };
        }
      }
      return { result };
    }) as (data: unknown) => unknown);

    const bigResult = Array(200).fill("line").join("\n");
    const { lastResult } = await hooks.runHookPipeline(HOOKS.TOOL_RESULT, {
      toolCallId: "1",
      toolName: "bash",
      result: bigResult,
      input: "{}",
      success: true,
      agent: mockAgent,
    });

    expect((lastResult as Record<string, unknown>).result).toContain("[100 more lines]");
    expect(((lastResult as Record<string, unknown>).result as string).split("\n").length).toBe(101);
  });
});

describe("CONTEXT hook via runHookPipeline", () => {
  test("handlers can filter messages", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.CONTEXT, (({ messages }: { messages: { content: string }[] }) => {
      return { messages: messages.filter((m: { content: string }) => m.content?.length > 0) };
    }) as (data: unknown) => unknown);

    const { lastResult } = await hooks.runHookPipeline(HOOKS.CONTEXT, {
      messages: [
        new Message({ role: "user", content: "hello" }),
        new Message({ role: "assistant", content: "" }),
        new Message({ role: "user", content: "world" }),
      ],
      agent: mockAgent,
    });

    expect((lastResult as Record<string, unknown>).messages).toHaveLength(2);
    expect(((lastResult as Record<string, unknown>).messages as { content: string }[])[0]!.content).toBe("hello");
    expect(((lastResult as Record<string, unknown>).messages as { content: string }[])[1]!.content).toBe("world");
  });

  test("handlers can inject messages", async () => {
    const hooks = new HookSystem();

    hooks.on(HOOKS.CONTEXT, (({ messages }: { messages: { role: string; content: string }[] }) => {
      return {
        messages: [
          { role: "system", content: "You are helpful." },
          ...messages,
        ],
      };
    }) as (data: unknown) => unknown);

    const { lastResult } = await hooks.runHookPipeline(HOOKS.CONTEXT, {
      messages: [new Message({ role: "user", content: "hi" })],
      agent: mockAgent,
    });

    expect((lastResult as Record<string, unknown>).messages).toHaveLength(2);
    expect(((lastResult as Record<string, unknown>).messages as { role: string }[])[0]!.role).toBe("system");
    expect(((lastResult as Record<string, unknown>).messages as { content: string }[])[1]!.content).toBe("hi");
  });
});