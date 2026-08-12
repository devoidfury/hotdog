import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import type { ToolMetadata } from "../../core/extensions/tool-registry.ts";
import type { ToolContext } from "../../core/extensions/tool-context.ts";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { WorkflowDefinition, WorkflowState } from "./types.ts";
import { WorkflowStateManager } from "./state.ts";
import { WorkflowNodeRegistry } from "./registry.ts";
import type { Tool } from "../../core/extensions/tool-registry.ts";

abstract class BaseWorkflowTool implements Tool {
  metadata: ToolMetadata = { sideEffects: false, difficulty: 1 };

  constructor(
    protected configDir: string,
    protected stateManager: WorkflowStateManager,
    protected nodeRegistry: WorkflowNodeRegistry,
  ) {}

  abstract toToolDef(): any;
  abstract execute(input: string | Record<string, unknown> | null, ctx: ToolContext): Promise<ToolResult>;

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(
      input,
      (args: Record<string, unknown>) => {
        return `${this.constructor.name.replace("Tool", "").toLowerCase()}: ${JSON.stringify(args)}`;
      },
      { fallback: `executing ${this.constructor.name}...` },
    );
  }
}

export class ListWorkflowNodesTool extends BaseWorkflowTool {
  static readonly TOOL_NAME = "list_workflow_nodes";
  override metadata: ToolMetadata = { sideEffects: false, difficulty: 1 };

  toToolDef() {
    return toolDef(
      ListWorkflowNodesTool.TOOL_NAME,
      "List all profiles that have a 'node' field in their frontmatter and can be used as nodes in a workflow.",
      {},
    );
  }

  async execute(): Promise<ToolResult> {
    const nodes = this.nodeRegistry.getAvailableNodes();
    return ToolResult.ok(`Available workflow nodes:\n\n${JSON.stringify(nodes, null, 2)}`);
  }

  override callDisplay(input: string | Record<string, unknown> | null): string {
    return "listing available workflow nodes...";
  }
}

export class SaveWorkflowTool extends BaseWorkflowTool {
  static readonly TOOL_NAME = "save_workflow";
  override metadata: ToolMetadata = { sideEffects: true, difficulty: 3 };

  toToolDef() {
    return toolDef(
      SaveWorkflowTool.TOOL_NAME,
      "Save a workflow definition to disk. Use this to persist a designed graph of nodes and transitions.",
      {
        properties: {
          workflow: param(
            "object",
            "The workflow definition object. Must follow the WorkflowDefinition schema (id, start_node, nodes, edges, fallback).",
          ),
        },
        required: ["workflow"],
      },
    );
  }

  async execute(input: string | Record<string, unknown> | null): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args || !args.workflow || typeof args.workflow !== "object") {
      return ToolResult.err("save_workflow requires a workflow object");
    }

    const wf = args.workflow as WorkflowDefinition;
    if (!wf.id || !wf.start_node || !wf.nodes || !wf.edges) {
      return ToolResult.err("Invalid workflow definition. Missing required fields (id, start_node, nodes, edges).");
    }

    try {
      const workflowsDir = path.join(this.configDir, ".hotdog/workflows");
      await fsPromises.mkdir(workflowsDir, { recursive: true });
      const filePath = path.join(workflowsDir, `${wf.id}.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(wf, null, 2), "utf-8");
      return ToolResult.ok(`Workflow '${wf.id}' saved successfully to ${filePath}.`);
    } catch (e: any) {
      return ToolResult.err(`Failed to save workflow: ${e.message}`);
    }
  }

  override callDisplay(input: string | Record<string, unknown> | null): string {
    const args = parseToolInput(input) as Record<string, any>;
    return `save_workflow: ${args?.workflow?.id || "unknown"}`;
  }
}

export class LoadWorkflowTool extends BaseWorkflowTool {
  static readonly TOOL_NAME = "load_workflow";
  override metadata: ToolMetadata = { sideEffects: false, difficulty: 2 };

  toToolDef() {
    return toolDef(
      LoadWorkflowTool.TOOL_NAME,
      "Load a workflow definition from disk by its ID.",
      {
        properties: {
          id: param("string", "The unique identifier of the workflow to load."),
        },
        required: ["id"],
      },
    );
  }

  async execute(input: string | Record<string, unknown> | null): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args || !args.id || typeof args.id !== "string") {
      return ToolResult.err("load_workflow requires an 'id' string");
    }

    try {
      const filePath = path.join(this.configDir, ".hotdog/workflows", `${args.id}.json`);
      const content = await fsPromises.readFile(filePath, "utf-8");
      const wf = JSON.parse(content) as WorkflowDefinition;
      return ToolResult.ok(`Workflow '${wf.id}' loaded.`);
    } catch (e: any) {
      return ToolResult.err(`Workflow '${args.id}' not found or could not be read: ${e.message}`);
    }
  }

  override callDisplay(input: string | Record<string, unknown> | null): string {
    const args = parseToolInput(input) as Record<string, any>;
    return `load_workflow: ${args?.id || "unknown"}`;
  }
}

export class StartWorkflowTool extends BaseWorkflowTool {
  static readonly TOOL_NAME = "start_workflow";
  override metadata: ToolMetadata = { sideEffects: true, difficulty: 2 };

  toToolDef() {
    return toolDef(
      StartWorkflowTool.TOOL_NAME,
      "Initialize a workflow session. This sets the cursor to the start_node and initializes the blackboard.",
      {
        properties: {
          id: param("string", "The ID of the workflow to start."),
          initialData: param(
            "object",
            "Optional initial data to put on the blackboard.",
          ),
        },
        required: ["id"],
      },
    );
  }

  async execute(input: string | Record<string, unknown> | null): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args || !args.id || typeof args.id !== "string") {
      return ToolResult.err("start_workflow requires an 'id' string");
    }

    try {
      const filePath = path.join(this.configDir, ".hotdog/workflows", `${args.id}.json`);
      const content = await fsPromises.readFile(filePath, "utf-8");
      const wf = JSON.parse(content) as WorkflowDefinition;

      const state: WorkflowState = {
        workflowId: wf.id,
        cursor: wf.start_node,
        blackboard: (args.initialData as Record<string, any>) || {},
        history: [],
      };

      await this.stateManager.save(state);

      return ToolResult.ok(
        `Workflow '${wf.id}' started. Current node: ${state.cursor}. Context will be transitioned on next turn.`,
      );
    } catch (e: any) {
      return ToolResult.err(`Failed to start workflow: ${e.message}`);
    }
  }

  override callDisplay(input: string | Record<string, unknown> | null): string {
    const args = parseToolInput(input) as Record<string, any>;
    return `start_workflow: ${args?.id || "unknown"}`;
  }
}

export class SubmitResultTool extends BaseWorkflowTool {
  static readonly TOOL_NAME = "submit_result";
  override metadata: ToolMetadata = { sideEffects: true, difficulty: 2 };

  toToolDef() {
    return toolDef(
      SubmitResultTool.TOOL_NAME,
      "Submit the results of your current task to the workflow manager. This will trigger a transition to the next node in the workflow.",
      {
        properties: {
          data: param(
            "object",
            "The results of your work. This data is added to the workflow blackboard and used to determine the next transition.",
          ),
        },
        required: ["data"],
      },
    );
  }

  async execute(input: string | Record<string, unknown> | null): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args || !args.data || typeof args.data !== "object") {
      return ToolResult.err("submit_result requires a 'data' object");
    }

    return ToolResult.ok("Result submitted. The workflow manager will now determine the next step.");
  }

  override callDisplay(input: string | Record<string, unknown> | null): string {
    return "submitting results to workflow manager...";
  }
}

export class TransitionToTool extends BaseWorkflowTool {
  static readonly TOOL_NAME = "transition_to";
  override metadata: ToolMetadata = { sideEffects: true, difficulty: 2 };

  toToolDef() {
    return toolDef(
      TransitionToTool.TOOL_NAME,
      "Manually transition the workflow to a specific node. Used by the Orchestrator (Manager) when deterministic transitions are not available.",
      {
        properties: {
          nodeId: param("string", "The ID of the node to transition to."),
          reason: param("string", "The reason for this transition."),
        },
        required: ["nodeId", "reason"],
      },
    );
  }

  async execute(input: string | Record<string, unknown> | null): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args || !args.nodeId || typeof args.nodeId !== "string") {
      return ToolResult.err("transition_to requires a 'nodeId' string");
    }

    return ToolResult.ok(`Transition to ${args.nodeId} requested. The agent will restart with the new node profile.`);
  }

  override callDisplay(input: string | Record<string, unknown> | null): string {
    const args = parseToolInput(input) as Record<string, any>;
    return `transition_to: ${args?.nodeId || "unknown"} (${args?.reason || "no reason"})`;
  }
}
