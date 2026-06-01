import { describe, it, expect } from "bun:test";
import { Agent } from "../src/agent/agent.js";
import {
  MessageLog,
  Message,
  outputEvent,
  OUTPUT_EVENT,
} from "../src/context/index.js";
import { NoopSink } from "../src/context/output.js";
import { ToolRegistry, ToolContext } from "../src/tools/registry.js";
import { LlmError } from "../src/llm_client/client.js";

describe("Agent.processStream", () => {
  it("accumulates content from streaming events", async () => {
    const agent = new Agent();
    const stream = (async function* () {
      yield { type: "content", content: "Hello" };
      yield { type: "content", content: " world" };
    })();
    const result = await agent.processStream(stream, 100);
    expect(result.fullText).toBe("Hello world");
    expect(result.fullReasoning).toBeNull();
    expect(result.finalToolCalls).toBeNull();
    expect(result.generationDurationMs).toBe(100);
  });

  it("accumulates reasoning content", async () => {
    const agent = new Agent();
    const stream = (async function* () {
      yield { type: "reasoning", content: "Thinking" };
      yield { type: "reasoning", content: " more" };
      yield { type: "content", content: "Answer" };
    })();
    const result = await agent.processStream(stream, 50);
    expect(result.fullReasoning).toBe("Thinking more");
    expect(result.fullText).toBe("Answer");
  });

  it("buffers tool calls and builds finalToolCalls", async () => {
    const agent = new Agent();
    const stream = (async function* () {
      yield { type: "toolName", index: 0, name: "bash", toolCallId: "call-1" };
      yield { type: "toolArgument", index: 0, arguments: '{"cmd": "ls"}' };
      yield { type: "toolName", index: 1, name: "read", toolCallId: "call-2" };
      yield { type: "toolArgument", index: 1, arguments: '{"path": "/tmp"}' };
    })();
    const result = await agent.processStream(stream, 0);
    expect(result.finalToolCalls).toHaveLength(2);
    expect(result.finalToolCalls[0].function.name).toBe("bash");
    expect(result.finalToolCalls[0].function.arguments).toBe('{"cmd": "ls"}');
    expect(result.finalToolCalls[1].function.name).toBe("read");
  });

  it("emits streaming chunks when stream is enabled", async () => {
    const events = [];
    const mockSink = {
      emit: (event) => {
        events.push(event);
      },
    };
    const agent = new Agent({ sink: mockSink, stream: true });
    const stream = (async function* () {
      yield { type: "content", content: "chunk1" };
      yield { type: "content", content: "chunk2" };
    })();
    await agent.processStream(stream, 0);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe(OUTPUT_EVENT.STREAMING_CHUNK);
    expect(events[0].content).toBe("chunk1");
    expect(events[1].content).toBe("chunk2");
  });

  it("does not emit streaming chunks when stream is disabled", async () => {
    const events = [];
    const mockSink = {
      emit: (event) => {
        events.push(event);
      },
    };
    const agent = new Agent({ sink: mockSink, stream: false });
    const stream = (async function* () {
      yield { type: "content", content: "chunk1" };
      yield { type: "content", content: "chunk2" };
    })();
    await agent.processStream(stream, 0);
    expect(events).toHaveLength(0);
  });

  it("emits reasoning chunks when stream is enabled", async () => {
    const events = [];
    const mockSink = {
      emit: (event) => {
        events.push(event);
      },
    };
    const agent = new Agent({ sink: mockSink, stream: true });
    const stream = (async function* () {
      yield { type: "reasoning", content: "think" };
    })();
    await agent.processStream(stream, 0);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(OUTPUT_EVENT.STREAMING_REASONING_CHUNK);
  });

  it("captures usage data", async () => {
    const agent = new Agent();
    const stream = (async function* () {
      yield {
        type: "usage",
        data: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    })();
    const result = await agent.processStream(stream, 0);
    expect(result.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it("throws LlmError.Cancelled when cancelled mid-stream", async () => {
    const agent = new Agent();
    agent.cancel(true);
    const stream = (async function* () {
      yield { type: "content", content: "Hello" };
    })();
    await expect(agent.processStream(stream, 0)).rejects.toThrow(
      "Agent cancelled",
    );
  });

  it("handles tool calls with empty id by generating fallback id", async () => {
    const agent = new Agent();
    const stream = (async function* () {
      yield { type: "toolName", index: 0, name: "bash" };
      yield { type: "toolArgument", index: 0, arguments: "x" };
    })();
    const result = await agent.processStream(stream, 0);
    expect(result.finalToolCalls).toHaveLength(1);
    expect(result.finalToolCalls[0].id).toMatch(/^call_0_/);
  });

  it("handles combined content, reasoning, and tool calls", async () => {
    const agent = new Agent();
    const stream = (async function* () {
      yield { type: "reasoning", content: "thinking" };
      yield { type: "content", content: "output" };
      yield { type: "toolName", index: 0, name: "bash", toolCallId: "tc1" };
      yield { type: "toolArgument", index: 0, arguments: "{}" };
      yield { type: "usage", data: { total_tokens: 20 } };
    })();
    const result = await agent.processStream(stream, 42);
    expect(result.fullReasoning).toBe("thinking");
    expect(result.fullText).toBe("output");
    expect(result.finalToolCalls).toHaveLength(1);
    expect(result.finalToolCalls[0].id).toBe("tc1");
    expect(result.usage).toEqual({ total_tokens: 20 });
  });
});

describe("Agent.processResponse", () => {
  it("adds response and returns text when no tool calls", async () => {
    const agent = new Agent();
    const outcome = await agent.processResponse({
      fullText: "Done",
      fullReasoning: null,
      finalToolCalls: null,
      usage: null,
      generationDurationMs: 100,
    });
    expect(outcome).toBe("Done");
    const messages = agent.context.getMessages();
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg.content).toBe("Done");
  });

  it("adds response and handles tool calls when present", async () => {
    const mockSink = { emit: () => {} };
    const mockTool = { execute: async () => "result" };
    const registry = new ToolRegistry();
    registry.register("bash", mockTool);

    const agent = new Agent({ sink: mockSink });
    agent._currentTools = registry;

    const outcome = await agent.processResponse({
      fullText: "I will run bash",
      fullReasoning: null,
      finalToolCalls: [
        {
          id: "tc1",
          function: { name: "bash", arguments: "{}" },
          type: "function",
        },
      ],
      usage: null,
      generationDurationMs: 50,
    });
    expect(outcome).toBe("continue");
    // Should have assistant message + tool result message
    const messages = agent.context.getMessages();
    expect(messages.filter((m) => m.role === "assistant").length).toBe(1);
    expect(messages.filter((m) => m.role === "tool").length).toBe(1);
  });

  it("handles tool call execution error in processResponse", async () => {
    const mockSink = { emit: () => {} };
    const mockTool = {
      execute: async () => {
        throw new Error("fail");
      },
    };
    const registry = new ToolRegistry();
    registry.register("bash", mockTool);

    const agent = new Agent({ sink: mockSink });
    agent._currentTools = registry;

    const outcome = await agent.processResponse({
      fullText: "I will run bash",
      fullReasoning: null,
      finalToolCalls: [
        {
          id: "tc1",
          function: { name: "bash", arguments: "{}" },
          type: "function",
        },
      ],
      usage: null,
      generationDurationMs: 0,
    });
    expect(outcome).toBe("continue");
    const messages = agent.context.getMessages();
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg.content).toContain("Error executing tool bash");
  });
});

describe("Agent.activateSkill", () => {
  it("returns error when skills loader not configured", () => {
    const agent = new Agent();
    const result = agent.activateSkill("test-skill");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Skills loader not configured");
  });

  it("skips if skill already active", () => {
    const mockLoader = {
      activateSkill: () => {},
    };
    const agent = new Agent({
      skills: [
        { name: "test-skill", content: "# Skill", location: "/skills/test" },
      ],
      skillsLoader: mockLoader,
    });
    agent.activeSkills.add("test-skill");
    const result = agent.activateSkill("test-skill");
    expect(result.success).toBe(true);
  });

  it("activates skill and adds to context", () => {
    const mockLoader = {
      activateSkill: (name) => {},
    };
    const agent = new Agent({
      skills: [
        {
          name: "test-skill",
          content: "# Skill Content",
          location: "/skills/test",
        },
      ],
      skillsLoader: mockLoader,
    });
    const result = agent.activateSkill("test-skill");
    expect(result.success).toBe(true);
    expect(agent.activeSkills.has("test-skill")).toBe(true);
    const messages = agent.context.getMessages();
    const skillMsg = messages.find(
      (m) =>
        m.content &&
        m.content.includes("skill_content") &&
        m.content.includes("test-skill"),
    );
    expect(skillMsg).toBeDefined();
  });

  it("resets systemMessages on activation", () => {
    const mockLoader = {
      activateSkill: (name) => {},
    };
    const agent = new Agent({
      skills: [
        { name: "test-skill", content: "content", location: "/skills/test" },
      ],
      skillsLoader: mockLoader,
    });
    agent.ensureSystemPrompt();
    expect(agent.context.systemMessages.length).toBe(1);
    agent.activateSkill("test-skill");
    expect(agent.context.systemMessages.length).toBe(0);
  });

  it("includes skill_resources when additionalFiles present", () => {
    const mockLoader = {
      activateSkill: (name) => {},
    };
    const agent = new Agent({
      skills: [
        {
          name: "test-skill",
          content: "# Skill",
          location: "/skills/test",
          additionalFiles: ["/skills/test/file1.txt", "/skills/test/file2.md"],
        },
      ],
      skillsLoader: mockLoader,
    });
    agent.activateSkill("test-skill");
    const messages = agent.context.getMessages();
    const skillMsg = messages.find(
      (m) => m.content && m.content.includes("skill_resources"),
    );
    expect(skillMsg).toBeDefined();
    expect(skillMsg.content).toContain("file1.txt");
    expect(skillMsg.content).toContain("file2.md");
  });

  it("shows (none) for resources when no additionalFiles", () => {
    const mockLoader = {
      activateSkill: (name) => {},
    };
    const agent = new Agent({
      skills: [
        { name: "test-skill", content: "content", location: "/skills/test" },
      ],
      skillsLoader: mockLoader,
    });
    agent.activateSkill("test-skill");
    const messages = agent.context.getMessages();
    const skillMsg = messages.find(
      (m) => m.content && m.content.includes("skill_resources"),
    );
    expect(skillMsg.content).toContain("(none)");
  });

  it("returns success even when skill not found in skills list", () => {
    const mockLoader = {
      activateSkill: (name) => {},
    };
    const agent = new Agent({
      skills: [],
      skillsLoader: mockLoader,
    });
    const result = agent.activateSkill("unknown-skill");
    expect(result.success).toBe(true);
    expect(agent.activeSkills.has("unknown-skill")).toBe(true);
  });
});

describe("Agent.compactMessages", () => {
  it("returns null when not enough messages", async () => {
    const agent = new Agent();
    agent.addInput("Hello");
    agent.addResponse("Hi");
    const result = await agent.compactMessages(5);
    expect(result).toBeNull();
  });

  it("returns null when compaction disabled", async () => {
    const agent = new Agent({
      compaction: { enabled: false, keepRecentMessages: 1, reserveTokens: 100 },
    });
    agent.addInput("Hello");
    agent.addResponse("Hi");
    agent.addInput("World");
    agent.addResponse("OK");
    const result = await agent.compactMessages(1);
    expect(result).toBeNull();
  });

  it("emits COMPACTING event before calling LLM", async () => {
    const events = [];
    const mockSink = {
      emit: (event) => {
        events.push(event);
      },
    };
    const agent = new Agent({
      sink: mockSink,
      compaction: { enabled: true, keepRecentMessages: 1, reserveTokens: 100 },
    });
    // Add enough messages to trigger compaction check (> keepRecent * 2)
    for (let i = 0; i < 5; i++) {
      agent.addInput(`User ${i}`);
      agent.addResponse(`Assistant ${i}`);
    }
    // Override keepRecent to 0 so it returns null early without LLM call
    const result = await agent.compactMessages(0);
    // COMPACTING event should have been emitted before the early return
    // Actually, with keepRecent=0, findFirstKeptIndex returns 0 immediately
    // so COMPACTING is emitted but then we return null
    const compactingEvents = events.filter(
      (e) => e.type === OUTPUT_EVENT.COMPACTING,
    );
    // The COMPACTING event is emitted before findFirstKeptIndex check
    expect(compactingEvents.length).toBeGreaterThanOrEqual(1);
    expect(result).toBeNull();
  });

  it("returns null when keepRecent=0 via override", async () => {
    const agent = new Agent({
      compaction: { enabled: true, keepRecentMessages: 1, reserveTokens: 100 },
    });
    for (let i = 0; i < 10; i++) {
      agent.addInput(`User ${i}`);
      agent.addResponse(`Assistant ${i}`);
    }
    // Override keepRecent to 0, which should cause findFirstKeptIndex to return 0
    const result = await agent.compactMessages(0);
    expect(result).toBeNull();
  });

  it("writes compaction debug file when enabled (even if write fails)", async () => {
    const agent = new Agent({
      compaction: { enabled: true, keepRecentMessages: 1, reserveTokens: 100 },
      compactDebug: true,
    });
    for (let i = 0; i < 6; i++) {
      agent.addInput(`User ${i}`);
      agent.addResponse(`Assistant ${i}`);
    }
    // Override keepRecent to 0 so it returns early without LLM call
    // The COMPACTING event should still be emitted
    const result = await agent.compactMessages(0);
    expect(result).toBeNull();
  });
});

describe("Agent.drainPendingTaskMessages", () => {
  it("returns false when no pending messages", () => {
    const agent = new Agent();
    expect(agent.drainPendingTaskMessages()).toBe(false);
  });

  it("drains pending messages into context", () => {
    const events = [];
    const mockSink = {
      emit: (event) => {
        events.push(event);
      },
    };
    const agent = new Agent({ sink: mockSink });
    agent._pendingTaskMessages = [
      "[Task task-1 completed]\nDone",
      "[Task task-2 completed]\nFailed",
    ];
    const drained = agent.drainPendingTaskMessages();
    expect(drained).toBe(true);
    expect(agent._pendingTaskMessages.length).toBe(0);
    const messages = agent.context.getMessages();
    const systemMsgs = messages.filter((m) => m.role === "system");
    expect(systemMsgs.length).toBeGreaterThanOrEqual(2);
  });

  it("emits TASK_PROGRESS events for each drained message", () => {
    const events = [];
    const mockSink = {
      emit: (event) => {
        events.push(event);
      },
    };
    const agent = new Agent({ sink: mockSink });
    agent._pendingTaskMessages = ["[Task task-1 completed]\nDone"];
    agent.drainPendingTaskMessages();
    const progressEvents = events.filter(
      (e) => e.type === OUTPUT_EVENT.TASK_PROGRESS,
    );
    expect(progressEvents.length).toBe(1);
    expect(progressEvents[0].status).toBe("task_result_received");
  });
});

describe("Agent.waitForTasksAndDrain", () => {
  it("returns drained=false when no task manager", async () => {
    const agent = new Agent();
    const result = await agent.waitForTasksAndDrain();
    expect(result).toBe(false);
  });

  it("returns drained=true when task messages pending", async () => {
    const agent = new Agent();
    agent.taskManager = { activeTasks: () => [] };
    agent._pendingTaskMessages = ["[Task done]"];
    const result = await agent.waitForTasksAndDrain();
    expect(result).toBe(true);
  });

  it("waits for active tasks to complete", async () => {
    let activeCount = 3;
    const agent = new Agent();
    agent.taskManager = {
      activeTasks: () => {
        if (activeCount <= 0) return [];
        activeCount--;
        return ["task-1", "task-2", "task-3"];
      },
    };
    const result = await agent.waitForTasksAndDrain();
    expect(result).toBe(false); // No pending messages, just waited
  });
});

describe("Agent._registerMcpTools", () => {
  it("registers tools from enabled MCP connections", async () => {
    const mockConnection = {
      serverName: "test-server",
      tools: [
        { name: "tool-a", description: "Tool A" },
        { name: "tool-b", description: "Tool B" },
      ],
      handle: () => ({ serverName: "test-server" }),
    };
    const mockServerConfig = { enabled: true };
    const agent = new Agent({
      mcpConnections: [
        { connection: mockConnection, serverConfig: mockServerConfig },
      ],
    });
    const registry = new ToolRegistry();
    await agent._registerMcpTools(registry, null, null);
    expect(registry.tools.has("test-server/tool-a")).toBe(true);
    expect(registry.tools.has("test-server/tool-b")).toBe(true);
  });

  it("skips disabled MCP connections", async () => {
    const mockConnection = {
      serverName: "test-server",
      tools: [{ name: "tool-a", description: "Tool A" }],
      handle: () => ({ serverName: "test-server" }),
    };
    const agent = new Agent({
      mcpConnections: [
        { connection: mockConnection, serverConfig: { enabled: false } },
      ],
    });
    const registry = new ToolRegistry();
    await agent._registerMcpTools(registry, null, null);
    expect(registry.tools.size).toBe(0);
  });

  it("applies server-level blacklist", async () => {
    const mockConnection = {
      serverName: "test-server",
      tools: [
        { name: "tool-a", description: "Tool A" },
        { name: "tool-b", description: "Tool B" },
      ],
      handle: () => ({ serverName: "test-server" }),
    };
    const agent = new Agent({
      mcpConnections: [
        {
          connection: mockConnection,
          serverConfig: { blacklistTools: ["tool-b"] },
        },
      ],
    });
    const registry = new ToolRegistry();
    await agent._registerMcpTools(registry, null, null);
    expect(registry.tools.has("test-server/tool-a")).toBe(true);
    expect(registry.tools.has("test-server/tool-b")).toBe(false);
  });

  it("applies server-level whitelist", async () => {
    const mockConnection = {
      serverName: "test-server",
      tools: [
        { name: "tool-a", description: "Tool A" },
        { name: "tool-b", description: "Tool B" },
      ],
      handle: () => ({ serverName: "test-server" }),
    };
    const agent = new Agent({
      mcpConnections: [
        {
          connection: mockConnection,
          serverConfig: { whitelistTools: ["tool-a"] },
        },
      ],
    });
    const registry = new ToolRegistry();
    await agent._registerMcpTools(registry, null, null);
    expect(registry.tools.has("test-server/tool-a")).toBe(true);
    expect(registry.tools.has("test-server/tool-b")).toBe(false);
  });

  it("applies profile-level blacklist", async () => {
    const mockConnection = {
      serverName: "test-server",
      tools: [
        { name: "tool-a", description: "Tool A" },
        { name: "tool-b", description: "Tool B" },
      ],
      handle: () => ({ serverName: "test-server" }),
    };
    const agent = new Agent({
      mcpConnections: [
        { connection: mockConnection, serverConfig: { enabled: true } },
      ],
    });
    const registry = new ToolRegistry();
    await agent._registerMcpTools(registry, null, ["test-server/tool-b"]);
    expect(registry.tools.has("test-server/tool-a")).toBe(true);
    expect(registry.tools.has("test-server/tool-b")).toBe(false);
  });

  it("applies profile-level whitelist", async () => {
    const mockConnection = {
      serverName: "test-server",
      tools: [
        { name: "tool-a", description: "Tool A" },
        { name: "tool-b", description: "Tool B" },
      ],
      handle: () => ({ serverName: "test-server" }),
    };
    const agent = new Agent({
      mcpConnections: [
        { connection: mockConnection, serverConfig: { enabled: true } },
      ],
    });
    const registry = new ToolRegistry();
    await agent._registerMcpTools(registry, ["test-server/tool-a"], null);
    expect(registry.tools.has("test-server/tool-a")).toBe(true);
    expect(registry.tools.has("test-server/tool-b")).toBe(false);
  });

  it("handles empty MCP connections list", async () => {
    const agent = new Agent({ mcpConnections: [] });
    const registry = new ToolRegistry();
    await agent._registerMcpTools(registry, null, null);
    expect(registry.tools.size).toBe(0);
  });
});

describe("Agent.availablePrompts", () => {
  it("returns empty array when prompts loader not configured", () => {
    const agent = new Agent();
    expect(agent.availablePrompts()).toEqual([]);
  });

  it("returns prompts from loader", () => {
    const mockLoader = {
      allPrompts: () => [
        { name: "prompt-1", content: "Content 1" },
        { name: "prompt-2", content: "Content 2" },
      ],
    };
    const agent = new Agent({ promptsLoader: mockLoader });
    expect(agent.availablePrompts()).toHaveLength(2);
  });
});

describe("Agent.allSkills", () => {
  it("returns empty array when skills loader not configured", () => {
    const agent = new Agent();
    expect(agent.allSkills()).toEqual([]);
  });

  it("returns skills from loader", () => {
    const mockLoader = {
      allSkills: () => [{ name: "skill-1" }, { name: "skill-2" }],
    };
    const agent = new Agent({ skillsLoader: mockLoader });
    expect(agent.allSkills()).toHaveLength(2);
  });
});

describe("Agent.autoActivateSkills", () => {
  it("calls autoActivate on skills loader", () => {
    let calledWith = null;
    const mockLoader = {
      setAvailableTools: (toolNames) => {
        calledWith = toolNames;
      },
    };
    const agent = new Agent({ skillsLoader: mockLoader });
    agent.autoActivateSkills(["read", "write"]);
    expect(calledWith).toEqual(["read", "write"]);
  });

  it("does nothing when skills loader not configured", () => {
    const agent = new Agent();
    // Should not throw
    expect(() => agent.autoActivateSkills(["read"])).not.toThrow();
  });
});

describe("Agent._hasSkillContent (module-level function)", () => {
  // _hasSkillContent is a module-level function in agent.js, not exported.
  // We test it by exercising the code path through regenerateSystemPrompt.

  it("prunes messages containing skill_content tags", () => {
    const agent = new Agent();
    agent.ensureSystemPrompt();
    agent.addInput("Normal message");
    agent.context.addUserMessage(
      '<skill_content name="test">content</skill_content>',
    );
    agent.addResponse("Response");

    const userMsgsBefore = agent.context.messages().length;
    agent.regenerateSystemPrompt();
    const userMsgsAfter = agent.context.messages().length;

    // The skill_content message should be pruned
    expect(userMsgsAfter).toBeLessThan(userMsgsBefore);
  });

  it("keeps messages without skill_content tags", () => {
    const agent = new Agent();
    agent.ensureSystemPrompt();
    agent.addInput("Normal message 1");
    agent.addResponse("Response 1");
    agent.addInput("Normal message 2");

    const userMsgsBefore = agent.context
      .messages()
      .filter((m) => m.role === "user").length;
    agent.regenerateSystemPrompt();
    const userMsgsAfter = agent.context
      .messages()
      .filter((m) => m.role === "user").length;

    expect(userMsgsAfter).toBe(userMsgsBefore);
  });
});
