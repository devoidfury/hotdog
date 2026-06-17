import { describe, it, expect } from "bun:test";
import {
  CORE_TOOL_NAMES,
  createToolFactory,
} from "../../src/extensions/core-tools/index.js";
import { SUBAGENT_TOOL_NAMES } from "../../src/extensions/subagents/index.js";
import { ToolRegistry } from "../../src/core/extensions/tool-registry.js";

describe("CORE_TOOL_NAMES", () => {
  it("contains all expected core tools", () => {
    // project_info is included but disabled by default
    // load_skill is registered by the skills extension, not core-tools
    // review is registered by the session-review extension, not core-tools
    // bash is registered by the bash-tool extension, not core-tools
    // fetch is registered by the fetch-tool extension, not core-tools
    // question is registered by the question-tool extension, not core-tools
    const expected = [
      "write",
      "read",
      "pager",
      "explore",
      "find",
      "grep",
      "project_info",
      "edit",
    ];
    expect(CORE_TOOL_NAMES).toEqual(expected);
  });

  it("does not include subagent tools", () => {
    expect(CORE_TOOL_NAMES).not.toContain("delegate_task");
    expect(CORE_TOOL_NAMES).not.toContain("task_status");
  });
});

describe("SUBAGENT_TOOL_NAMES", () => {
  it("contains all expected subagent tools", () => {
    const expected = [
      "delegate_task",
      "task_status",
      "task_followup",
      "task_interrupt",
      "plan_status",
      "complete_task",
      "wait",
    ];
    expect(SUBAGENT_TOOL_NAMES).toEqual(expected);
  });
});

describe("createToolFactory", () => {
  it("creates write tool", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("write", {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe("function");
  });

  it("creates read tool", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("read", {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe("function");
  });

  it("creates edit tool", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("edit", {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe("function");
  });

  it("creates grep tool", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("grep", {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe("function");
  });

  it("creates find tool", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("find", {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe("function");
  });

  // question is registered by the question-tool extension, not core-tools
  it("returns null for question (registered by question-tool extension)", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("question", {});
    expect(tool).toBeNull();
  });

  it("creates pager tool", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("pager", {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe("function");
  });

  // model is registered by the model-switch extension, not core-tools
  it("returns null for model (registered by model-switch extension)", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("model", {});
    expect(tool).toBeNull();
  });

  // load_skill is registered by the skills extension, not the core-tools factory
  it("returns null for load_skill (registered by skills extension)", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("load_skill", {});
    expect(tool).toBeNull();
  });

  // review is registered by the session-review extension, not core-tools
  it("returns null for review (registered by session-review extension)", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("review", {});
    expect(tool).toBeNull();
  });

  it("returns null for unknown tool", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("nonexistent-tool", {});
    expect(tool).toBeNull();
  });

  it("respects whitelist", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("write", {}, ["write", "read"]);
    expect(tool).not.toBeNull();
    const otherTool = factory.createTool("edit", {}, ["write", "read"]);
    expect(otherTool).toBeNull();
  });

  it("handles project_info as enabled by default", () => {
    const factory = createToolFactory();
    // project_info is enabled by default (descriptor.disabled = false)
    const tool = factory.createTool("project_info", {});
    expect(tool).not.toBeNull();
  });

  it("handles explore as disabled by default", () => {
    const factory = createToolFactory();
    // explore is disabled by default (descriptor.disabled = true)
    const tool = factory.createTool("explore", {});
    expect(tool).toBeNull();
  });

  it("enables disabled tools when in whitelist", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("explore", {}, ["explore"]);
    expect(tool).not.toBeNull();
  });
});

describe("createToolFactory - createAndRegister", async () => {
  it("registers tool in registry", async () => {
    const factory = createToolFactory();
    const registry = new ToolRegistry();
    await factory.createAndRegister("write", registry, {});
    expect(registry.has("write")).toBe(true);
  });

  it("skips tool when creation fails", async () => {
    const factory = createToolFactory();
    const registry = new ToolRegistry();
    await factory.createAndRegister("nonexistent-tool", registry, {});
    expect(registry.has("nonexistent-tool")).toBe(false);
  });

  it("respects whitelist in createAndRegister", async () => {
    const factory = createToolFactory();
    const registry = new ToolRegistry();
    await factory.createAndRegister("write", registry, {}, ["write"]);
    expect(registry.has("write")).toBe(true);
    expect(registry.has("read")).toBe(false);
  });

  it("skips disabled tools when not in whitelist or manager", async () => {
    const factory = createToolFactory();
    const registry = new ToolRegistry();
    // explore is disabled by default
    await factory.createAndRegister("explore", registry, {});
    expect(registry.has("explore")).toBe(false);
  });
});
