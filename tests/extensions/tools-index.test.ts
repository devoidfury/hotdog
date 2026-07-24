import { describe, it, expect } from "bun:test";
import {
  CORE_TOOL_NAMES,
  createToolFactory,
} from "../../src/extensions/core-tools/index.ts";
import { SUBAGENT_TOOL_NAMES } from "../../src/extensions/subagents/index.ts";
import { ToolRegistry } from "../../src/core/extensions/tool-registry.ts";

describe("CORE_TOOL_NAMES", () => {
  it("contains all expected core tools", () => {
    // project_info is included but disabled by default
    // load_skill is registered by the skills extension, not core-tools
    // review is registered by the session-review extension, not core-tools
    // bash is registered by the bash-tool extension, not core-tools
    // fetch is registered by the fetch-tool extension, not core-tools
    // question is registered by the question-tool extension, not core-tools
    const expected = [
      "overwrite",
      "append",
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
  it("creates all expected core tools", () => {
    const factory = createToolFactory();
    for (const name of ["overwrite", "append", "read", "edit", "grep", "find", "pager", "project_info"]) {
      const tool = factory.createTool(name);
      expect(tool, `${name} tool should be created`).not.toBeNull();
      expect(typeof tool!.execute, `${name}.execute should be a function`).toBe("function");
    }
  });

  it("returns null for tools registered by other extensions", () => {
    const factory = createToolFactory();
    // question → question-tool extension
    expect(factory.createTool("question")).toBeNull();
    // model → model-switch extension
    expect(factory.createTool("model")).toBeNull();
    // load_skill → skills extension
    expect(factory.createTool("load_skill")).toBeNull();
    // review → session-review extension
    expect(factory.createTool("review")).toBeNull();
    // nonexistent
    expect(factory.createTool("nonexistent-tool")).toBeNull();
  });

  it("returns null for disabled-by-default tools", () => {
    const factory = createToolFactory();
    // explore is disabled by default (descriptor.disabled = true)
    expect(factory.createTool("explore")).toBeNull();
  });

  it("respects whitelist", () => {
    const factory = createToolFactory();
    expect(factory.createTool("overwrite", ["overwrite", "read"])).not.toBeNull();
    expect(factory.createTool("edit", ["overwrite", "read"])).toBeNull();
  });

  it("enables disabled tools when in whitelist", () => {
    const factory = createToolFactory();
    expect(factory.createTool("explore", ["explore"])).not.toBeNull();
  });
});

describe("createToolFactory - createAndRegister", () => {
  it("registers tool in registry", () => {
    const factory = createToolFactory();
    const registry = new ToolRegistry();
    factory.createAndRegister("overwrite", registry);
    expect(registry.has("overwrite")).toBe(true);
  });

  it("skips tool when creation fails", () => {
    const factory = createToolFactory();
    const registry = new ToolRegistry();
    factory.createAndRegister("nonexistent-tool", registry);
    expect(registry.has("nonexistent-tool")).toBe(false);
  });

  it("respects whitelist in createAndRegister", () => {
    const factory = createToolFactory();
    const registry = new ToolRegistry();
    factory.createAndRegister("overwrite", registry, ["overwrite"]);
    expect(registry.has("overwrite")).toBe(true);
    expect(registry.has("read")).toBe(false);
  });

  it("skips disabled tools when not in whitelist or manager", () => {
    const factory = createToolFactory();
    const registry = new ToolRegistry();
    // explore is disabled by default
    factory.createAndRegister("explore", registry);
    expect(registry.has("explore")).toBe(false);
  });
});
