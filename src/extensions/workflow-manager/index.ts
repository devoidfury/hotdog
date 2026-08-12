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

export function create(core: CoreContext): ExtensionInstance {
  const configDir = core.resolved?.configDir || process.cwd();
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
    submitResult: new SubmitResultTool(configDir, stateManager, nodeRegistry),
    transitionTo: new TransitionToTool(configDir, stateManager, nodeRegistry),
  };

  /**
   * Helper to perform the actual agent transition to a new node.
   */
  async function transitionToNode(agent: any, nodeId: string, reason: string, blackboard: any) {
    agent.profileName = nodeId;
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

    const state = {
      workflowId: workflow.id,
      cursor: workflow.start_node,
      blackboard: (config.initialData as Record<string, any>) || {},
      history: [],
    };
    await stateManager.save(state);

    const agent = session.getAgent();
    if (!agent) return;

    await transitionToNode(agent, workflow.start_node, "Workflow started", state.blackboard);
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
            const blackboard = state?.blackboard || {};
            await transitionToNode(agent, args.nodeId, args.reason || "Manual transition", blackboard);
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
            workflow.start_node,
            `Workflow '${workflow.id}' started`,
            state.blackboard,
          );
          return;
        }

        // 3. Check for result submission
        const submitTool = toolResults.find(tr => tr.toolName === SubmitResultTool.TOOL_NAME);
        if (submitTool) {
          const args = parseToolInput(submitTool.input) as Record<string, any>;
          const data = args?.data;
          
          const state = await stateManager.load();
          if (!state) return;

          const workflow = await engine.loadWorkflow(state.workflowId);
          if (!workflow) return;

          const { nextNodeId, isAgentic } = await engine.determineNextNode(state, workflow, data);

          if (nextNodeId) {
            const newState = {
              ...state,
              cursor: nextNodeId,
              blackboard: { ...state.blackboard, ...data },
              history: [...state.history, {
                timestamp: new Date().toISOString(),
                from: state.cursor,
                to: nextNodeId,
                reason: "Deterministic transition",
                data,
              }],
            };
            await stateManager.save(newState);
            await transitionToNode(agent, nextNodeId, "Deterministic transition", newState.blackboard);
          } else if (isAgentic) {
            // Update blackboard even if no transition occurs
            const newState = {
              ...state,
              blackboard: { ...state.blackboard, ...data },
            };
            await stateManager.save(newState);
          }
        }
      },
    },
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
