import { describe, it, expect } from "bun:test";
import {
  CORE_TOOL_NAMES,
  createToolFactory,
} from "../../extensions/core-tools/index.js";
import { SUBAGENT_TOOL_NAMES } from "../../extensions/subagents/index.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";

describe("CORE_TOOL_NAMES", () => {
  it("contains all expected core tools", () => {
    // project_info is included but disabled by default
    // load_skill is registered by the skills extension, not core-tools
    // review is registered by the session-review extension, not core-tools
    const expected = [
      "bash",
      "write",
      "read",
      "question",
      "pager",
      "explore",
      "find",
      "grep",
      "fetch",
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
  it("creates bash tool", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("bash", {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe("function");
    expect(typeof tool.toToolDef).toBe("function");
  });

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

  it("creates fetch tool", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("fetch", {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe("function");
  });

  it("creates question tool", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("question", {});
    expect(tool).not.toBeNull();
    expect(typeof tool.execute).toBe("function");
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
    const tool = factory.createTool("bash", {}, ["bash", "write"]);
    expect(tool).not.toBeNull();
    const otherTool = factory.createTool("read", {}, ["bash", "write"]);
    expect(otherTool).toBeNull();
  });

  it("handles project_info as disabled descriptor", () => {
    const factory = createToolFactory();
    // project_info is disabled by default (descriptor.disabled = true)
    const tool = factory.createTool("project_info", {});
    expect(tool).toBeNull();
  });

  it("enables disabled tools when in whitelist", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("project_info", {}, ["project_info"]);
    expect(tool).not.toBeNull();
  });

  it("enables disabled tools when in whitelist", () => {
    const factory = createToolFactory();
    const tool = factory.createTool("project_info", {}, ["project_info"]);
    expect(tool).not.toBeNull();
  });
});

describe("createToolFactory - createAndRegister", async () => {
  it("registers tool in registry", async () => {
    const factory = createToolFactory();
    const registry = new ToolRegistry();
    await factory.createAndRegister("bash", registry, {});
    expect(registry.has("bash")).toBe(true);
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
    await factory.createAndRegister("bash", registry, {}, ["bash"]);
    expect(registry.has("bash")).toBe(true);
    expect(registry.has("write")).toBe(false);
  });

  it("skips disabled tools when not in whitelist or manager", async () => {
    const factory = createToolFactory();
    const registry = new ToolRegistry();
    await factory.createAndRegister("project_info", registry, {});
    expect(registry.has("project_info")).toBe(false);
  });
});
