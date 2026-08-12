import fsPromises from "node:fs/promises";
import path from "node:path";
import { WorkflowDefinition, WorkflowState } from "./types.ts";
import { WorkflowStateManager } from "./state.ts";

export class WorkflowEngine {
  constructor(private stateManager: WorkflowStateManager, private configDir: string) {}

  async loadWorkflow(workflowId: string): Promise<WorkflowDefinition | null> {
    try {
      const filePath = path.join(this.configDir, ".hotdog/workflows", `${workflowId}.json`);
      const content = await fsPromises.readFile(filePath, "utf-8");
      return JSON.parse(content) as WorkflowDefinition;
    } catch {
      return null;
    }
  }

  /**
   * Determine the next node based on the current state and submitted data.
   */
  async determineNextNode(
    state: WorkflowState,
    workflow: WorkflowDefinition,
    submittedData: any,
  ): Promise<{ nextNodeId: string | null; isAgentic: boolean }> {
    const { cursor, workflowId } = state;
    
    // 1. Deterministic Check
    const edges = workflow.edges.filter((e) => e.from === cursor && e.trigger === "deterministic");
    
    for (const edge of edges) {
      if (this.evaluateCondition(edge.condition, submittedData)) {
        return { nextNodeId: edge.to, isAgentic: false };
      }
    }

    // 2. Agentic Fallback
    if (workflow.fallback === "agentic") {
      return { nextNodeId: null, isAgentic: true };
    }

    return { nextNodeId: null, isAgentic: false };
  }

  /**
   * Simple condition evaluator for "key == 'value'".
   * In a real system, this might be more complex (e.g., using a small expression parser).
   */
  private evaluateCondition(condition: string | undefined, data: any): boolean {
    if (!condition) return true;

    try {
      // Very basic "key == 'value'" or "key == value" parsing
      const parts = condition.split("==").map(p => p.trim());
      if (parts.length !== 2) return false;

      const [key, value] = parts;
      if (!key || value === undefined) return false;

      const actualValue = data[key];
      const expectedValue = value.replace(/^['"](.*)['"]$/, "$1");

      return String(actualValue) === expectedValue;
    } catch {
      return false;
    }
  }

  async updateState(state: WorkflowState): Promise<void> {
    await this.stateManager.save(state);
  }
}
