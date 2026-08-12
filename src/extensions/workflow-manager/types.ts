export interface WorkflowNode {
  profile: string;
  label: string;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  trigger: "deterministic" | "agentic";
  condition?: string;
}

export interface WorkflowDefinition {
  id: string;
  start_node: string;
  nodes: Record<string, WorkflowNode>;
  edges: WorkflowEdge[];
  fallback: "agentic" | "deterministic";
}

export interface WorkflowState {
  workflowId: string;
  cursor: string;
  blackboard: Record<string, any>;
  history: Array<{
    timestamp: string;
    from: string;
    to: string;
    reason: string;
    data?: any;
  }>;
}
