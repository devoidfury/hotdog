// End-to-end pin for the sink's diff posture: the REAL EditTool through the
// REAL ToolExecutor into the REAL CliOutputSink, with the display seam
// resolved from the real registry exactly as ui-interactive-cli wires it.
//
// Why this file exists: the posture's unit tests hand in parts, and the shape
// one of them invented (`{status:"failure", error:"…"}`) turned out to be the
// only failure that gate recognized -- while the executor emits
// `{status:"error", error:null, output:<failure text>}` for a thrown tool
// error, a gate block and a handled verdict, and bare strings for its harness
// failures. Driving the real pipeline is what pins "a write that did not
// happen never prints its diff", for every shape in between.

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { createToolExecutor, type ToolExecutorDeps } from "@core/tool-executor.ts";
import { createToolRegistry } from "@core/extensions/tool-registry.ts";
import { createHooks } from "@core/hooks.ts";
import { EVENT_NAME_MAP } from "@core/context/output.ts";
import type { ToolCall } from "@core/context/message.ts";
import { CliOutputSink } from "@utils/cli/cli.ts";
import { ColorPalette } from "@utils/cli/colors.ts";
import { EditTool } from "@extensions/core-tools/edit.ts";
import { tmpDir, cleanupDir } from "../../mocks/io.ts";

const ORIGINAL = `export function answer() {\n  return 42;\n}\n`;

let writes: string[] = [];

/**
 * The pipeline as the interactive CLI runs it: registry (with the metadata
 * core-tools registers), executor emitting the tool_result event, sink
 * rendering it through the same `display` seam. Returns the committed text.
 */
async function runEdit(root: string, args: Record<string, unknown>): Promise<string> {
  const registry = createToolRegistry();
  const tool = new EditTool({ maxEditInputSize: 100_000 });
  tool.metadata = {
    ...tool.metadata,
    // The declaration src/extensions/core-tools/index.ts attaches.
    display: [{ kind: "diff", oldArg: "oldString", newArg: "newString", pathArg: "path" }],
    headerKeys: ["replace_all"],
  };
  registry.register(EditTool.TOOL_NAME, tool);

  const outputs: Array<{ type: string; data: Record<string, unknown> }> = [];
  const deps = {
    toolRegistry: registry,
    hooks: createHooks(),
    emitOutput: (type: string, data: Record<string, unknown>) => outputs.push({ type, data }),
    workspaceRoots: [root],
    workspaceDeny: null,
    maxRetries: 0,
    toolRetryDelay: 0,
    isRestoring: () => false,
    agent: {
      sessionId: "test",
      addMessage: () => {},
      getToolDefs: async () => [tool.toToolDef()],
    },
  } as unknown as ToolExecutorDeps;

  await createToolExecutor(deps).execute([
    { id: "call-1", type: "function", function: { name: "edit", arguments: JSON.stringify(args) } } as ToolCall,
  ]);

  const emitted = outputs.find((o) => o.type === "tool_result");
  expect(emitted).toBeDefined();

  const sink = new CliOutputSink({
    palette: new ColorPalette({ use_colors: false }),
    toolOutputFmt: "----\n{}\n----",
    showTokenUse: false,
    display: (name) => registry.getMetadata(name)?.display,
  });
  // Only the result row: the call line above it is untouched by this feature.
  // The executor names its events; the agent's seam maps the name to the enum
  // the sink switches on, so the test rides the same mapping.
  sink.emit({ ...emitted!.data, type: EVENT_NAME_MAP[emitted!.type] } as never);
  return writes.join("");
}

describe("the committed diff never claims a write that did not happen", () => {
  let root = "";

  beforeEach(() => {
    writes = [];
    spyOn(process.stdout, "write").mockImplementation((s: string) => {
      writes.push(String(s));
      return true;
    });
  });

  afterEach(() => {
    (process.stdout.write as never as { mockRestore: () => void }).mockRestore();
    if (root) cleanupDir(root);
    root = "";
  });

  async function setup(fileContent: string): Promise<string> {
    root = tmpDir();
    await fs.writeFile(path.join(root, "app.ts"), fileContent, "utf-8");
    return root;
  }

  it("renders the diff for an edit that landed, numbered from the file", async () => {
    const dir = await setup(ORIGINAL);
    const text = await runEdit(dir, {
      path: "app.ts",
      oldString: "  return 42;",
      newString: "  return 999;",
      replace_all: false,
    });
    expect(text).toContain("app.ts +1 \u22121");
    expect(text).toContain("-   2   return 42;");
    expect(text).toContain("+   2   return 999;");
    // The tool's own answer rides as the envelope line under the block.
    expect(text).toContain("Successfully edited 'app.ts', found 1 match");
    // What the transcript shows is what happened.
    expect(await fs.readFile(path.join(dir, "app.ts"), "utf-8")).toContain("999");
  });

  it("renders nothing that looks like a change for an edit that threw", async () => {
    const dir = await setup(ORIGINAL);
    const text = await runEdit(dir, {
      path: "app.ts",
      oldString: "  return 41; // not in the file",
      newString: "  return 999; // NEVER WRITTEN",
      replace_all: false,
    });
    expect(text).toContain("Error executing tool edit");
    expect(text).toContain("HINT:"); // the tool's guidance stays in the generic posture
    expect(text).not.toContain("NEVER WRITTEN");
    expect(text).not.toContain("app.ts +1");
    expect(text).not.toMatch(/^[+-]\s*\d/m); // no signed row at all
    expect(await fs.readFile(path.join(dir, "app.ts"), "utf-8")).toBe(ORIGINAL);
  });

  it("renders nothing that looks like a change when validation rejects the call (bare string result)", async () => {
    const dir = await setup(ORIGINAL);
    const text = await runEdit(dir, { path: "app.ts", newString: "  return 999; // NEVER WRITTEN" });
    expect(text).toContain("Parameter validation error:");
    expect(text).not.toContain("NEVER WRITTEN");
    expect(text).not.toMatch(/^[+-]\s*\d/m);
    expect(await fs.readFile(path.join(dir, "app.ts"), "utf-8")).toBe(ORIGINAL);
  });
});
