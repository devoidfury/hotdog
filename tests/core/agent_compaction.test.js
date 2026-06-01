import { describe, it, expect, beforeEach } from "bun:test";
import { Agent } from "../../src/core/agent.js";
import { NoopSink } from "../../src/context/output.js";
import { Message } from "../../src/context/message.js";
import { createHooks } from "../../src/hooks.js";

describe("Agent.compaction behavior", () => {
  let hooks;

  beforeEach(() => {
    hooks = createHooks();
  });

  it("creates with compaction config", () => {
    const agent = new Agent({
      hooks,
      compaction: { enabled: true, keepRecentMessages: 10 },
      sink: new NoopSink(),
    });
    expect(agent._compaction.enabled).toBe(true);
    expect(agent._compaction.keepRecentMessages).toBe(10);
  });

  it("creates with compaction disabled", () => {
    const agent = new Agent({
      hooks,
      compaction: { enabled: false, keepRecentMessages: 1 },
      sink: new NoopSink(),
    });
    expect(agent._compaction.enabled).toBe(false);
  });

  it("has hideTools default true", () => {
    const agent = new Agent({
      hooks,
      sink: new NoopSink(),
    });
    expect(agent.hideTools).toBe(true);
  });

  it("has hideThinking default false", () => {
    const agent = new Agent({
      hooks,
      sink: new NoopSink(),
    });
    expect(agent.hideThinking).toBe(false);
  });

  it("toggles hideTools via property setter", () => {
    const agent = new Agent({
      hooks,
      sink: new NoopSink(),
    });
    expect(agent.hideTools).toBe(true);
    agent.hideTools = false;
    expect(agent.hideTools).toBe(false);
    agent.hideTools = true;
    expect(agent.hideTools).toBe(true);
  });

  it("toggles hideThinking via property setter", () => {
    const agent = new Agent({
      hooks,
      sink: new NoopSink(),
    });
    expect(agent.hideThinking).toBe(false);
    agent.hideThinking = true;
    expect(agent.hideThinking).toBe(true);
    agent.hideThinking = false;
    expect(agent.hideThinking).toBe(false);
  });

  it("clearContext clears context and resets iteration", () => {
    const agent = new Agent({
      hooks,
      sink: new NoopSink(),
    });
    agent._context.push({ role: "user", content: "hello" });
    agent._iterationCount = 5;
    agent.clearContext();
    expect(agent._context.length).toBe(0);
    expect(agent._iterationCount).toBe(0);
    expect(agent._systemPrompt).toBeNull();
  });

  it("cancel sets cancelled flag", () => {
    const agent = new Agent({
      hooks,
      sink: new NoopSink(),
    });
    expect(agent.cancelled).toBe(false);
    agent.cancel(true);
    expect(agent.cancelled).toBe(true);
    agent.cancel(false);
    expect(agent.cancelled).toBe(false);
  });

  it("model getter/setter works", () => {
    const agent = new Agent({
      hooks,
      model: "test-model",
      sink: new NoopSink(),
    });
    expect(agent.model).toBe("test-model");
    agent.model = "new-model";
    expect(agent.model).toBe("new-model");
  });

  it("sessionId is set on construction", () => {
    const agent = new Agent({
      hooks,
      sink: new NoopSink(),
    });
    expect(agent.sessionId).toBeDefined();
    expect(typeof agent.sessionId).toBe("string");
  });

  it("sessionId can be passed explicitly", () => {
    const agent = new Agent({
      hooks,
      sessionId: "my-session-123",
      sink: new NoopSink(),
    });
    expect(agent.sessionId).toBe("my-session-123");
  });

  it("context is an array", () => {
    const agent = new Agent({
      hooks,
      sink: new NoopSink(),
    });
    expect(Array.isArray(agent.context)).toBe(true);
  });

  it("iterationCount starts at 0", () => {
    const agent = new Agent({
      hooks,
      sink: new NoopSink(),
    });
    expect(agent.iterationCount).toBe(0);
  });
});

describe("Agent executeCommand (core commands)", () => {
  let agent;

  beforeEach(() => {
    const hooks = createHooks();
    agent = new Agent({
      hooks,
      model: "test-model",
      modelRegistry: {
        "test-model": { name: "test-model" },
        "gpt-4": { name: "gpt-4", tags: ["fast"] },
      },
      sink: new NoopSink(),
    });
  });

  it("clear command clears context", async () => {
    agent._context.push({ role: "user", content: "hello" });
    const result = await agent.executeCommand({ type: "clear", value: null });
    expect(result).toEqual({ content: "Context cleared." });
    expect(agent._context.length).toBe(0);
  });

  it("quit command returns UI error", async () => {
    const result = await agent.executeCommand({ type: "quit", value: null });
    expect(result).toEqual({ error: "UI command: quit" });
  });

  it("help command returns UI error", async () => {
    const result = await agent.executeCommand({ type: "help", value: null });
    expect(result).toEqual({ error: "UI command: help" });
  });

  it("model command lists models when no value", async () => {
    const result = await agent.executeCommand({ type: "model", value: null });
    expect(result.content).toContain("test-model");
    expect(result.content).toContain("gpt-4");
  });

  it("model command switches model", async () => {
    const result = await agent.executeCommand({
      type: "model",
      value: "gpt-4",
    });
    expect(result.content).toBe("Switched to model: gpt-4");
    expect(agent.model).toBe("gpt-4");
  });

  it("unknown command returns error", async () => {
    const result = await agent.executeCommand({ type: "foobar", value: null });
    expect(result).toEqual({ error: "Unknown command: foobar" });
  });

  it("tools command toggles hideTools", async () => {
    expect(agent.hideTools).toBe(true);
    const result = await agent.executeCommand({ type: "tools", value: null });
    expect(result.content).toContain("shown");
    expect(agent.hideTools).toBe(false);
  });

  it("thinking command toggles hideThinking", async () => {
    expect(agent.hideThinking).toBe(false);
    const result = await agent.executeCommand({
      type: "thinking",
      value: null,
    });
    expect(result.content).toContain("hidden");
    expect(agent.hideThinking).toBe(true);
  });
});

describe("Agent serialize/deserialize", () => {
  it("serializes agent state", () => {
    const hooks = createHooks();
    const agent = new Agent({
      hooks,
      model: "test-model",
      sessionId: "test-session",
      sink: new NoopSink(),
    });
    agent._context.push(new Message({ role: "user", content: "hello" }));
    agent._iterationCount = 5;

    const serialized = agent.serialize();
    expect(serialized.sessionId).toBe("test-session");
    expect(serialized.model).toBe("test-model");
    expect(serialized.iterationCount).toBe(5);
    expect(serialized.context).toHaveLength(1);
  });

  it("deserializes agent state", () => {
    const hooks = createHooks();
    const agent = new Agent({
      hooks,
      model: "old-model",
      sessionId: "old-session",
      sink: new NoopSink(),
    });
    agent._iterationCount = 10;

    const data = {
      sessionId: "new-session",
      model: "new-model",
      context: [{ role: "user", content: "hi" }],
      iterationCount: 3,
    };
    agent.deserialize(data);
    expect(agent.sessionId).toBe("new-session");
    expect(agent.model).toBe("new-model");
    expect(agent._iterationCount).toBe(3);
    expect(agent._context).toHaveLength(1);
  });
});
