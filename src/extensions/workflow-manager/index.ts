import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import { CoreContext, ExtensionInstance } from "../../core/extensions/types.ts";
import { HOOKS } from "../../core/hooks.ts";
import { WorkflowNodeRegistry } from "./registry.ts";
import { WorkflowStateManager } from "./state.ts";
import { WorkflowEngine } from "./engine.ts";
import {
  ListWorkflowNodesTool,
  SaveWorkflowTool,
  LoadWorkflowTool,
  StartWorkflowTool,
  SubmitResultTool,
  TransitionToTool,
} from "./tools.ts";
import { WorkflowDefinition } from "./types.ts";

export function create(core: CoreContext): ExtensionInstance {
  const configDir = core.resolved!.configDir!;
  const stateManager = new WorkflowStateManager(configDir);
  const nodeRegistry = new WorkflowNodeRegistry();
  const engine = new WorkflowEngine(stateManager, configDir);

  if (core.resolved?.profileManager) {
    const profiles = core.resolved.profileManager.getAllProfiles();
    nodeRegistry.scan(profiles);
  }

  const tools = {
    listNodes: new ListWorkflowNodesTool(configDir, stateManager, nodeRegistry),
    saveWorkflow: new SaveWorkflowTool(configDir, stateManager, nodeRegistry),
    loadWorkflow: new LoadWorkflowTool(configDir, stateManager, nodeRegistry),
    startWorkflow: new StartWorkflowTool(configDir, stateManager, nodeRegistry),
    submitResult: new SubmitResultTool(configDir, stateManager, nodeRegistry, engine),
    transitionTo: new TransitionToTool(configDir, stateManager, nodeRegistry, engine),
  };

  /**
   * Helper to perform the actual agent transition to a new node.
   *
   * Resolves the workflow node's declared profile (nodes[nodeId].profile),
   * loads its profile body, and switches the agent to that profile so the
   * system prompt actually reflects the new node's instructions.
   */
  async function transitionToNode(
    agent: any,
    workflow: WorkflowDefinition | null,
    nodeId: string,
    reason: string,
    blackboard: any,
  ) {
    // Resolve the node's profile. Falls back to using the node ID directly
    // when no workflow/profile mapping is available (e.g., ad-hoc transitions).
    let profileName = nodeId;
    let profileBody: string | undefined;

    const node = workflow?.nodes?.[nodeId];
    if (node?.profile) {
      const profile = core.resolved?.profileManager?.getProfile?.(node.profile);
      if (profile) {
        profileName = node.profile;
        profileBody = profile.body;
      }
    }

    agent.profileName = profileName;
    if (profileBody !== undefined) {
      agent.profileBody = profileBody;
    }
    await agent.clearContext();
    await agent.ensureSystemPrompt();

    const prompt = `## Workflow Transition\n\n` +
      `You have transitioned to node: **${nodeId}**\n` +
      `Reason: ${reason}\n\n` +
      `### Current Blackboard State\n` +
      `\`\`\`json\n${JSON.stringify(blackboard, null, 2)}\n\`\`\`\n\n` +
      `Please proceed with your task based on the current state.`;

    agent.enqueue(prompt);
  }

  /**
   * Initialize a workflow when a session is created with a workflow ID.
   * This is the central entry point -- any interface (CLI, one-shot, webui)
   * that passes `workflow` in the session config will get workflow behavior.
   */
  async function handleSessionCreate(data: any) {
    const config = data?.config as Record<string, unknown> | undefined;
    const session = data?.session;
    if (!config || !session) return;

    const workflowId = config.workflow as string | undefined;
    if (!workflowId) return;

    const workflow = await engine.loadWorkflow(workflowId);
    if (!workflow) {
      console.error(`Workflow '${workflowId}' not found.`);
      return;
    }

    if (!(workflow.start_node in workflow.nodes)) {
      console.error(`Workflow '${workflowId}' has invalid start_node '${workflow.start_node}'.`);
      return;
    }

    const state = {
      workflowId: workflow.id,
      cursor: workflow.start_node,
      blackboard: (config.initialData as Record<string, any>) || {},
      history: [],
    };
    await stateManager.save(state);

    const agent = session.getAgent();
    if (!agent) return;

    await transitionToNode(agent, workflow, workflow.start_node, "Workflow started", state.blackboard);
    console.log(`Started workflow: ${workflowId} at node ${workflow.start_node}`);
  }

  return {
    stateManager,
    nodeRegistry,
    hooks: {
      [HOOKS.SESSION_CREATE]: handleSessionCreate,

      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        registry.register(ListWorkflowNodesTool.TOOL_NAME, tools.listNodes);
        registry.register(SaveWorkflowTool.TOOL_NAME, tools.saveWorkflow);
        registry.register(LoadWorkflowTool.TOOL_NAME, tools.loadWorkflow);
        registry.register(StartWorkflowTool.TOOL_NAME, tools.startWorkflow);
        registry.register(SubmitResultTool.TOOL_NAME, tools.submitResult);
        registry.register(TransitionToTool.TOOL_NAME, tools.transitionTo);
      },

      [HOOKS.TURN_END]: async ({ toolResults, agent, stopped, cancelled }) => {
        if (!stopped || cancelled || !agent || !toolResults) return;

        // 1. Check for manual transition
        const transitionTool = toolResults.find(tr => tr.toolName === TransitionToTool.TOOL_NAME);
        if (transitionTool) {
          const args = parseToolInput(transitionTool.input) as Record<string, any>;
          if (args?.nodeId) {
            const state = await stateManager.load();
            // The tool already validated and persisted the new cursor.
            const workflow = state?.workflowId
              ? await engine.loadWorkflow(state.workflowId)
              : null;
            await transitionToNode(
              agent,
              workflow,
              state?.cursor ?? args.nodeId,
              args.reason || "Manual transition",
              state?.blackboard || {},
            );
            return;
          }
        }

        // 2. Check for workflow start
        const startTool = toolResults.find(tr => tr.toolName === StartWorkflowTool.TOOL_NAME);
        if (startTool) {
          const state = await stateManager.load();
          if (!state) return;

          const workflow = await engine.loadWorkflow(state.workflowId);
          if (!workflow) return;

          await transitionToNode(
            agent,
            workflow,
            workflow.start_node,
            `Workflow '${workflow.id}' started`,
            state.blackboard,
          );
          return;
        }

        // 3. Check for result submission — the tool already performed state management,
        //    so we just check if the cursor changed and trigger the agent transition.
        const submitTool = toolResults.find(tr => tr.toolName === SubmitResultTool.TOOL_NAME);
        if (submitTool) {
          const state = await stateManager.load();
          if (!state) return;

          const prevCursor = (state as any).__prevCursor;
          if (prevCursor !== undefined && state.cursor !== prevCursor) {
            const workflow = await engine.loadWorkflow(state.workflowId);
            await transitionToNode(
              agent,
              workflow,
              state.cursor,
              "Deterministic transition",
              state.blackboard,
            );
          }
        }
      },
    },
    tools,
    // Expose as a service so other extensions can trigger workflow starts
    services: {
      workflowManager: {
        stateManager,
        nodeRegistry,
        engine,
        transitionToNode,
      },
    },
  };
}
