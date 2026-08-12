import fsPromises from "node:fs/promises";
import path from "node:path";
import { WorkflowState } from "./types.ts";

export class WorkflowStateManager {
  private readonly statePath: string;

  constructor(configDir: string) {
    this.statePath = path.join(configDir, ".hotdog/workflow_state.json");
  }

  async load(): Promise<WorkflowState | null> {
    try {
      const content = await fsPromises.readFile(this.statePath, "utf-8");
      return JSON.parse(content) as WorkflowState;
    } catch {
      return null;
    }
  }

  async save(state: WorkflowState): Promise<void> {
    try {
      await fsPromises.mkdir(path.dirname(this.statePath), { recursive: true });
      await fsPromises.writeFile(this.statePath, JSON.stringify(state, null, 2), "utf-8");
    } catch (e) {
      console.error(`Failed to save workflow state: ${e}`);
    }
  }

  async clear(): Promise<void> {
    try {
      await fsPromises.unlink(this.statePath);
    } catch {
      // Ignore if file doesn't exist
    }
  }
}
