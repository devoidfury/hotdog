import { ProfileDef } from "../../core/config/profiles.ts";

export interface NodeProfile {
  name: string;
  description: string;
  nodeType: string;
}

export class WorkflowNodeRegistry {
  private nodes: Map<string, NodeProfile> = new Map();

  /**
   * Scans all available profiles for the `node` field.
   */
  scan(profiles: Record<string, ProfileDef>): void {
    this.nodes.clear();
    for (const [name, profile] of Object.entries(profiles)) {
      if (profile.node && typeof profile.node === "string") {
        this.nodes.set(name, {
          name,
          description: profile.description,
          nodeType: profile.node,
        });
      }
    }
  }

  getAvailableNodes(): NodeProfile[] {
    return Array.from(this.nodes.values());
  }

  getNode(name: string): NodeProfile | undefined {
    return this.nodes.get(name);
  }
}
