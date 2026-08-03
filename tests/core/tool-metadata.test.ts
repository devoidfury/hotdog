// Tests for ToolMetadata, filtering methods, and sandbox mode.

import { describe, it, expect, beforeEach } from "bun:test";
import { ToolRegistry, Tool, ToolMetadata } from "../../src/core/extensions/tool-registry.ts";

// ── Test Tool Implementations ───────────────────────────────────────────────

class TestTool implements Tool {
  constructor(
    public name: string,
    public metadata: ToolMetadata,
  ) {}

  toToolDef() {
    return {
      type: "function",
      function: {
        name: this.name,
        description: `Test tool: ${this.name}`,
        parameters: { type: "object", properties: {}, required: [] },
      },
    };
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return `${this.name}(${input})`;
  }

  async execute(_input: string | Record<string, unknown> | null): Promise<unknown> {
    return { executed: this.name };
  }
}


describe("ToolRegistry metadata methods", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register("safe-simple", new TestTool("safe-simple", { sideEffects: false, difficulty: 1 }));
    registry.register("safe-medium", new TestTool("safe-medium", { sideEffects: false, difficulty: 3 }));
    registry.register("safe-hard", new TestTool("safe-hard", { sideEffects: false, difficulty: 5 }));
    registry.register("write-simple", new TestTool("write-simple", { sideEffects: true, difficulty: 1 }));
    registry.register("write-hard", new TestTool("write-hard", { sideEffects: true, difficulty: 4 }));
  });

  it("getMetadata returns metadata for a tool", () => {
    const meta = registry.getMetadata("safe-simple");
    expect(meta).toEqual({ sideEffects: false, difficulty: 1 });
  });

  it("getMetadata returns undefined for unknown tool", () => {
    const meta = registry.getMetadata("unknown");
    expect(meta).toBeUndefined();
  });

  it("getAllWithMetadata returns all tools with their metadata", () => {
    const all = registry.getAllWithMetadata();
    expect(all.length).toBe(5);

    const safeSimple = all.find((t) => t.name === "safe-simple");
    expect(safeSimple?.metadata).toEqual({ sideEffects: false, difficulty: 1 });
  });
});

describe("ToolRegistry.register metadata validation", () => {
  it("rejects tools without metadata", () => {
    const registry = new ToolRegistry();
    expect(() => {
      registry.register("no-meta", {
        toToolDef() {
          return {
            type: "function",
            function: {
              name: "no-meta",
              description: "test",
              parameters: { type: "object", properties: {}, required: [] },
            },
          };
        },
        callDisplay() { return "no-meta()"; },
        execute: async () => "ok",
      } as any);
    }).toThrow('Tool "no-meta" is missing required metadata');
  });

  it("rejects tools with invalid sideEffects", () => {
    const registry = new ToolRegistry();
    expect(() => {
      registry.register("bad-side-effects", {
        metadata: { sideEffects: undefined as any, difficulty: 1 },
        toToolDef() {
          return {
            type: "function",
            function: {
              name: "bad-side-effects",
              description: "test",
              parameters: { type: "object", properties: {}, required: [] },
            },
          };
        },
        callDisplay() { return "bad-side-effects()"; },
        execute: async () => "ok",
      });
    }).toThrow('Tool "bad-side-effects" metadata.sideEffects must be explicitly defined as true or false');
  });

  it("rejects tools with difficulty out of range", () => {
    const registry = new ToolRegistry();
    expect(() => {
      registry.register("bad-difficulty", {
        metadata: { sideEffects: false, difficulty: 6 },
        toToolDef() {
          return {
            type: "function",
            function: {
              name: "bad-difficulty",
              description: "test",
              parameters: { type: "object", properties: {}, required: [] },
            },
          };
        },
        callDisplay() { return "bad-difficulty()"; },
        execute: async () => "ok",
      });
    }).toThrow('Tool "bad-difficulty" metadata.difficulty must be between 1 and 5');
  });
});

describe("ToolRegistry.filterByDifficulty", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register("easy", new TestTool("easy", { sideEffects: false, difficulty: 1 }));
    registry.register("medium", new TestTool("medium", { sideEffects: false, difficulty: 3 }));
    registry.register("hard", new TestTool("hard", { sideEffects: true, difficulty: 5 }));
  });

  it("filters tools by maximum difficulty", () => {
    const filtered = registry.filterByDifficulty(2);
    expect(filtered.has("easy")).toBe(true);
    expect(filtered.has("medium")).toBe(false);
    expect(filtered.has("hard")).toBe(false);
  });

  it("includes tools at exactly the max difficulty", () => {
    const filtered = registry.filterByDifficulty(3);
    expect(filtered.has("easy")).toBe(true);
    expect(filtered.has("medium")).toBe(true);
    expect(filtered.has("hard")).toBe(false);
  });

  it("includes all tools when maxDifficulty is 5", () => {
    const filtered = registry.filterByDifficulty(5);
    expect(filtered.has("easy")).toBe(true);
    expect(filtered.has("medium")).toBe(true);
    expect(filtered.has("hard")).toBe(true);
  });

  it("returns empty registry when maxDifficulty is 0", () => {
    const filtered = registry.filterByDifficulty(0);
    expect(filtered.getAll().length).toBe(0);
  });
});

describe("ToolRegistry.filterBySideEffects", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register("safe", new TestTool("safe", { sideEffects: false, difficulty: 1 }));
    registry.register("unsafe", new TestTool("unsafe", { sideEffects: true, difficulty: 1 }));
  });

  it("returns all tools when allowSideEffects is true", () => {
    const filtered = registry.filterBySideEffects(true);
    expect(filtered.has("safe")).toBe(true);
    expect(filtered.has("unsafe")).toBe(true);
  });

  it("returns only safe tools when allowSideEffects is false", () => {
    const filtered = registry.filterBySideEffects(false);
    expect(filtered.has("safe")).toBe(true);
    expect(filtered.has("unsafe")).toBe(false);
  });
});

describe("ToolRegistry.filterByMetadata", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register("safe-easy", new TestTool("safe-easy", { sideEffects: false, difficulty: 1 }));
    registry.register("safe-hard", new TestTool("safe-hard", { sideEffects: false, difficulty: 5 }));
    registry.register("unsafe-easy", new TestTool("unsafe-easy", { sideEffects: true, difficulty: 1 }));
    registry.register("unsafe-hard", new TestTool("unsafe-hard", { sideEffects: true, difficulty: 5 }));
  });

  it("filters by difficulty only", () => {
    const filtered = registry.filterByMetadata({ maxDifficulty: 2 });
    expect(filtered.has("safe-easy")).toBe(true);
    expect(filtered.has("safe-hard")).toBe(false);
    expect(filtered.has("unsafe-easy")).toBe(true);
    expect(filtered.has("unsafe-hard")).toBe(false);
  });

  it("filters by side effects only", () => {
    const filtered = registry.filterByMetadata({ allowSideEffects: false });
    expect(filtered.has("safe-easy")).toBe(true);
    expect(filtered.has("safe-hard")).toBe(true);
    expect(filtered.has("unsafe-easy")).toBe(false);
    expect(filtered.has("unsafe-hard")).toBe(false);
  });

  it("filters by both difficulty and side effects", () => {
    const filtered = registry.filterByMetadata({
      maxDifficulty: 2,
      allowSideEffects: false,
    });
    expect(filtered.has("safe-easy")).toBe(true);
    expect(filtered.has("safe-hard")).toBe(false);
    expect(filtered.has("unsafe-easy")).toBe(false);
    expect(filtered.has("unsafe-hard")).toBe(false);
  });

  it("returns a new registry (not this) when no options provided", () => {
    const filtered = registry.filterByMetadata();
    expect(filtered).not.toBe(registry);
    expect(filtered.has("safe-easy")).toBe(true);
    expect(filtered.has("safe-hard")).toBe(true);
    expect(filtered.has("unsafe-easy")).toBe(true);
    expect(filtered.has("unsafe-hard")).toBe(true);
  });
});

