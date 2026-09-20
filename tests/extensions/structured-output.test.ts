import { describe, it, expect } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  StructuredOutputTool,
  resolveOutputSchema,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "@extensions/ui-one-shot/structured-output.ts";
import { TOOL_STOP_LOOP } from "@core/extensions/tool-utils.ts";

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    score: { type: "number" },
  },
  required: ["answer"],
};

describe("resolveOutputSchema", () => {
  it("parses an inline JSON schema", async () => {
    const { schema, error } = await resolveOutputSchema(JSON.stringify(SCHEMA));
    expect(error).toBeUndefined();
    expect(schema).toEqual(SCHEMA);
  });

  it("reads a schema from a file path", async () => {
    const file = join(tmpdir(), `hotdog-schema-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(SCHEMA));
    try {
      const { schema, error } = await resolveOutputSchema(file);
      expect(error).toBeUndefined();
      expect(schema).toEqual(SCHEMA);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("rejects invalid JSON", async () => {
    const { schema, error } = await resolveOutputSchema("{ nope");
    expect(schema).toBeUndefined();
    expect(error).toContain("Invalid JSON schema");
  });

  it("rejects a missing file", async () => {
    const { schema, error } = await resolveOutputSchema("/nonexistent/schema.json");
    expect(schema).toBeUndefined();
    expect(error).toContain("Cannot read schema file");
  });

  it("rejects a non-object schema type", async () => {
    const { schema, error } = await resolveOutputSchema(JSON.stringify({ type: "string" }));
    expect(schema).toBeUndefined();
    expect(error).toContain('"type": "object"');
  });
});

describe("StructuredOutputTool", () => {
  it("tool def carries the user schema as parameters", () => {
    const tool = new StructuredOutputTool(SCHEMA, () => {});
    const def = tool.toToolDef();
    expect(def.function.name).toBe(STRUCTURED_OUTPUT_TOOL_NAME);
    expect(def.function.parameters).toEqual(SCHEMA);
  });

  it("a valid call captures the payload and stops the loop", async () => {
    let captured: unknown = null;
    const tool = new StructuredOutputTool(SCHEMA, (p) => { captured = p; });

    const result = await tool.execute({ answer: "42", score: 7 });

    expect(captured).toEqual({ answer: "42", score: 7 });
    expect(result.success).toBe(true);
    expect((result as unknown as Record<symbol, unknown>)[TOOL_STOP_LOOP]).toBe(true);
  });

  it("an invalid call returns validation errors and does not capture or stop", async () => {
    let captured: unknown = null;
    const tool = new StructuredOutputTool(SCHEMA, (p) => { captured = p; });

    const result = await tool.execute({ score: "high" });

    expect(captured).toBeNull();
    expect(result.success).toBe(false);
    expect(result.error).toContain("Parameter validation failed");
    // Missing "answer", wrong type on "score".
    expect(result.error).toContain("answer");
    expect((result as unknown as Record<symbol, unknown>)[TOOL_STOP_LOOP]).toBeUndefined();
  });

  it("accepts a JSON string input", async () => {
    let captured: unknown = null;
    const tool = new StructuredOutputTool(SCHEMA, (p) => { captured = p; });

    await tool.execute('{"answer": "hi"}');
    expect(captured).toEqual({ answer: "hi" });
  });

  it("a second call after capture is an error", async () => {
    let calls = 0;
    const tool = new StructuredOutputTool(SCHEMA, () => { calls++; });

    await tool.execute({ answer: "first" });
    const second = await tool.execute({ answer: "second" });

    expect(calls).toBe(1);
    expect(second.success).toBe(false);
    expect(second.error).toContain("already");
  });
});
