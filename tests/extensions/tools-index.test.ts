import { describe, it, expect } from "bun:test";
import {
  CORE_TOOL_NAMES,
  createToolFactory,
} from "@extensions/core-tools/index.ts";
import { ToolRegistry } from "@core/extensions/tool-registry.ts";

// Mirrors the configSchema defaults in core-tools/extension.json
const config = {
  readToolLimit: 500,
  maxImageSize: 10485760,
  maxEditInputSize: 16000,
  grepMaxResults: 100,
  findMaxResults: 200,
};

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

describe("createToolFactory", () => {
  it("creates all expected core tools", () => {
    const factory = createToolFactory(config);
    for (const name of ["overwrite", "append", "read", "edit", "grep", "find", "project_info"]) {
      const tool = factory.createTool(name);
      expect(tool, `${name} tool should be created`).not.toBeNull();
      expect(typeof tool!.execute, `${name}.execute should be a function`).toBe("function");
    }
  });

  it("returns null for tools registered by other extensions", () => {
    const factory = createToolFactory(config);
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
    const factory = createToolFactory(config);
    // explore is disabled by default (descriptor.disabled = true)
    expect(factory.createTool("explore")).toBeNull();
  });

  it("respects whitelist", () => {
    const factory = createToolFactory(config);
    expect(factory.createTool("overwrite", ["overwrite", "read"])).not.toBeNull();
    expect(factory.createTool("edit", ["overwrite", "read"])).toBeNull();
  });

  it("enables disabled tools when in whitelist", () => {
    const factory = createToolFactory(config);
    expect(factory.createTool("explore", ["explore"])).not.toBeNull();
  });
});

describe("createToolFactory - createAndRegister", () => {
  it("registers tool in registry", () => {
    const factory = createToolFactory(config);
    const registry = new ToolRegistry();
    factory.createAndRegister("overwrite", registry);
    expect(registry.has("overwrite")).toBe(true);
  });

  it("skips tool when creation fails", () => {
    const factory = createToolFactory(config);
    const registry = new ToolRegistry();
    factory.createAndRegister("nonexistent-tool", registry);
    expect(registry.has("nonexistent-tool")).toBe(false);
  });

  it("respects whitelist in createAndRegister", () => {
    const factory = createToolFactory(config);
    const registry = new ToolRegistry();
    factory.createAndRegister("overwrite", registry, ["overwrite"]);
    expect(registry.has("overwrite")).toBe(true);
    expect(registry.has("read")).toBe(false);
  });

  it("skips disabled tools when not in whitelist or manager", () => {
    const factory = createToolFactory(config);
    const registry = new ToolRegistry();
    // explore is disabled by default
    factory.createAndRegister("explore", registry);
    expect(registry.has("explore")).toBe(false);
  });
});

describe("core tool display parts (ToolMetadata.display)", () => {
  // Rename guard: the declared *Arg values are ARG PARAMETER NAMES, so they
  // must keep matching the tools' real schema parameters. Sinks resolve the
  // names against the args JSON on the frame; a silent rename breaks the
  // webui diff/file views with no compile error anywhere else.
  const schemaProps = async (toolName: string): Promise<string[]> => {
    const tool = createToolFactory(config).createTool(toolName);
    const def = await tool!.toToolDef();
    return Object.keys((def!.function.parameters.properties ?? {}) as Record<string, unknown>);
  };

  it("read declares the file part with its real path/offset/limit params", async () => {
    const tool = createToolFactory(config).createTool("read")!;
    expect(tool.metadata.display).toEqual([
      { kind: "file", pathArg: "path", offsetArg: "offset", limitArg: "limit" },
    ]);
    const part = tool.metadata.display![0]!;
    const props = await schemaProps("read");
    expect(props).toContain(part.pathArg!);
    expect(props).toContain(part.offsetArg!);
    expect(props).toContain(part.limitArg!);
  });

  it("edit declares the diff part with its real oldString/newString/path params", async () => {
    const tool = createToolFactory(config).createTool("edit")!;
    // pathArg is the sink's path header (GitHub's file header on the diff):
    // the same rename guard covers it, so a silent path rename cannot strand
    // the header client-side.
    expect(tool.metadata.display).toEqual([
      { kind: "diff", oldArg: "oldString", newArg: "newString", pathArg: "path" },
    ]);
    const part = tool.metadata.display![0]!;
    const props = await schemaProps("edit");
    expect(props).toContain(part.oldArg!);
    expect(props).toContain(part.newArg!);
    expect(props).toContain(part.pathArg!);
  });

  it("overwrite and append declare the args-sourced file part with their real params", async () => {
    // Owner ruling (follow-up run): what an append/overwrite call wrote IS the
    // primary content, so the file part takes its body from the `content` arg
    // at call time and its header from `path`; the result envelope is a size
    // confirmation the sink demotes to a footer line. Supersedes the earlier
    // "these declare nothing" pin.
    const factory = createToolFactory(config);
    for (const name of ["overwrite", "append"]) {
      const tool = factory.createTool(name)!;
      expect(tool.metadata.display, `${name} display parts`).toEqual([
        { kind: "file", source: "args", arg: "content", pathArg: "path" },
      ]);
      const part = tool.metadata.display![0]!;
      const props = await schemaProps(name);
      expect(props, `${name} content param`).toContain(part.arg!);
      expect(props, `${name} path param`).toContain(part.pathArg!);
    }
  });

  it("the rest of core-tools declares no display parts (no speculative decoration)", () => {
    const factory = createToolFactory(config);
    // grep/find/project_info return search listings; explore is free-form LLM
    // output -- none of them has a part a sink could draw better than the
    // generic posture. The whitelist only hands disabled-by-default `explore`
    // back; the pin reads its metadata.
    for (const name of ["grep", "find", "project_info", "explore"]) {
      const tool = factory.createTool(name, [name]);
      expect(tool!.metadata.display, `${name} must declare no display parts`).toBeUndefined();
    }
  });
});
