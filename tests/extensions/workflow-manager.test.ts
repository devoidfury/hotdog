import { describe, it, expect, beforeEach, mock } from "bun:test";
import { WorkflowEngine } from "../../src/extensions/workflow-manager/engine.ts";
import { WorkflowStateManager } from "../../src/extensions/workflow-manager/state.ts";
import { WorkflowNodeRegistry } from "../../src/extensions/workflow-manager/registry.ts";
import { create } from "../../src/extensions/workflow-manager/index.ts";
import { WorkflowDefinition, WorkflowState } from "../../src/extensions/workflow-manager/types.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("WorkflowManager Unit Tests", () => {
  let tempDir: string;
  let stateManager: WorkflowStateManager;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "workflow-test-"));
    stateManager = new WorkflowStateManager(tempDir);
  });

  describe("WorkflowStateManager", () => {
    it("should save and load state", async () => {
      const state: WorkflowState = {
        workflowId: "test-wf",
        cursor: "node1",
        blackboard: { key: "value" },
        history: [],
      };
      await stateManager.save(state);
      const loaded = await stateManager.load();
      expect(loaded).toEqual(state);
    });

    it("should clear state", async () => {
      const state: WorkflowState = {
        workflowId: "test-wf",
        cursor: "node1",
        blackboard: {},
        history: [],
      };
      await stateManager.save(state);
      await stateManager.clear();
      const loaded = await stateManager.load();
      expect(loaded).toBeNull();
    });
  });

  describe("WorkflowEngine", () => {
    let engine: WorkflowEngine;

    beforeEach(() => {
      engine = new WorkflowEngine(stateManager, tempDir);
    });

    it("should load a workflow from disk", async () => {
      const wf: WorkflowDefinition = {
        id: "test-wf",
        start_node: "node1",
        nodes: { node1: { profile: "p1", label: "L1" } },
        edges: [],
        fallback: "agentic",
      };
      const wfDir = path.join(tempDir, ".hotdog/workflows");
      await fsPromises.mkdir(wfDir, { recursive: true });
      await fsPromises.writeFile(path.join(wfDir, "test-wf.json"), JSON.stringify(wf));

      const loaded = await engine.loadWorkflow("test-wf");
      expect(loaded).toEqual(wf);
    });

    it("should determine next node deterministically", async () => {
      const wf: WorkflowDefinition = {
        id: "test-wf",
        start_node: "node1",
        nodes: { 
          node1: { profile: "p1", label: "L1" },
          node2: { profile: "p2", label: "L2" },
        },
        edges: [
          { from: "node1", to: "node2", trigger: "deterministic", condition: "status == 'success'" },
        ],
        fallback: "agentic",
      };
      const state: WorkflowState = {
        workflowId: "test-wf",
        cursor: "node1",
        blackboard: {},
        history: [],
      };

      const result = await engine.determineNextNode(state, wf, { status: "success" });
      expect(result).toEqual({ nextNodeId: "node2", isAgentic: false });

      const resultFail = await engine.determineNextNode(state, wf, { status: "failure" });
      expect(resultFail).toEqual({ nextNodeId: null, isAgentic: true });
    });

    it("should handle agentic fallback when no deterministic edge matches", async () => {
      const wf: WorkflowDefinition = {
        id: "test-wf",
        start_node: "node1",
        nodes: { node1: { profile: "p1", label: "L1" } },
        edges: [],
        fallback: "agentic",
      };
      const state: WorkflowState = {
        workflowId: "test-wf",
        cursor: "node1",
        blackboard: {},
        history: [],
      };

      const result = await engine.determineNextNode(state, wf, {});
      expect(result).toEqual({ nextNodeId: null, isAgentic: true });
    });
  });

  describe("WorkflowNodeRegistry", () => {
    it("should scan profiles and find nodes", () => {
      const registry = new WorkflowNodeRegistry();
      const profiles: any = {
        nodeA: { name: "nodeA", description: "Desc A", node: "typeA" },
        nodeB: { name: "nodeB", description: "Desc B" }, // no node field
        nodeC: { name: "nodeC", description: "Desc C", node: "typeC" },
      };
      registry.scan(profiles);
      const nodes = registry.getAvailableNodes();
      expect(nodes).toHaveLength(2);
      expect(nodes.find(n => n.name === "nodeA")).toBeDefined();
      expect(nodes.find(n => n.name === "nodeC")).toBeDefined();
    });
  });
});

describe("WorkflowManager Integration Tests", () => {
  let tempDir: string;
  let mockCore: any;
  let mockAgent: any;
  let extension: any;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "workflow-int-"));
    
    mockAgent = {
      profileName: "start",
      clearContext: mock().mockResolvedValue(undefined),
      ensureSystemPrompt: mock().mockResolvedValue(undefined),
      enqueue: mock(),
    };

    const profileDefs = {
      node1: { name: "node1", description: "N1", node: "type1", body: "profile body 1" },
      node2: { name: "node2", description: "N2", node: "type2", body: "profile body 2" },
      researcher: { name: "researcher", description: "Research node", node: "research", body: "researcher body" },
    };

    mockCore = {
      resolved: {
        configDir: tempDir,
        profileManager: {
          getAllProfiles: () => profileDefs,
          getProfile: (name: string) => profileDefs[name] || null,
        },
      },
    };

    extension = create(mockCore);
  });

  it("should transition to node via TransitionToTool in TURN_END", async () => {
    const toolResults = [
      {
        toolName: "transition_to",
        input: JSON.stringify({ nodeId: "node2", reason: "Moving on" }),
        result: "Success",
      },
    ];

    await extension.hooks[HOOKS.TURN_END]({
      stopped: true,
      cancelled: false,
      agent: mockAgent,
      toolResults,
    });

    expect(mockAgent.profileName).toBe("node2");
    expect(mockAgent.clearContext).toHaveBeenCalled();
    expect(mockAgent.ensureSystemPrompt).toHaveBeenCalled();
    expect(mockAgent.enqueue).toHaveBeenCalledWith(expect.stringContaining("transitioned to node: **node2**"));
  });

  it("should persist the cursor and reject invalid nodes via TransitionToTool", async () => {
    // Setup workflow + state
    const wf: WorkflowDefinition = {
      id: "test-wf",
      start_node: "node1",
      nodes: {
        node1: { profile: "p1", label: "L1" },
        node2: { profile: "p2", label: "L2" },
      },
      edges: [],
      fallback: "agentic",
    };
    const wfDir = path.join(tempDir, ".hotdog/workflows");
    await fsPromises.mkdir(wfDir, { recursive: true });
    await fsPromises.writeFile(path.join(wfDir, "test-wf.json"), JSON.stringify(wf));

    const state: WorkflowState = {
      workflowId: "test-wf",
      cursor: "node1",
      blackboard: {},
      history: [],
    };
    await extension.stateManager.save(state);

    // Invalid node is rejected before any state mutation
    const invalidResult = await extension.tools.transitionTo.execute(
      JSON.stringify({ nodeId: "nope" }),
      { agent: mockAgent } as any,
    );
    expect(invalidResult.success).toBe(false);
    const afterInvalid = await extension.stateManager.load();
    expect(afterInvalid?.cursor).toBe("node1");

    // Valid node persists the new cursor and records history
    const result = await extension.tools.transitionTo.execute(
      JSON.stringify({ nodeId: "node2", reason: "Moving on" }),
      { agent: mockAgent } as any,
    );
    expect(result.success).toBe(true);
    const loaded = await extension.stateManager.load();
    expect(loaded?.cursor).toBe("node2");
    expect(loaded?.history.at(-1)?.to).toBe("node2");
    expect(loaded?.history.at(-1)?.from).toBe("node1");

    // TURN_END then moves the agent using the persisted cursor
    const toolResults = [
      {
        toolName: "transition_to",
        input: JSON.stringify({ nodeId: "node2", reason: "Moving on" }),
        result: "Success",
      },
    ];
    await extension.hooks[HOOKS.TURN_END]({
      stopped: true,
      cancelled: false,
      agent: mockAgent,
      toolResults,
    });
    expect(mockAgent.profileName).toBe("node2");
    const finalState = await extension.stateManager.load();
    expect(finalState?.cursor).toBe("node2");
  });

  it("should load the node's declared profile name and body on transition", async () => {
    // Setup workflow where node id differs from profile name
    const wf: WorkflowDefinition = {
      id: "research-wf",
      start_node: "research-node",
      nodes: {
        "research-node": { profile: "researcher", label: "Research" },
        "done-node": { profile: "node2", label: "Done" },
      },
      edges: [],
      fallback: "agentic",
    };
    const wfDir = path.join(tempDir, ".hotdog/workflows");
    await fsPromises.mkdir(wfDir, { recursive: true });
    await fsPromises.writeFile(path.join(wfDir, "research-wf.json"), JSON.stringify(wf));

    const state: WorkflowState = {
      workflowId: "research-wf",
      cursor: "research-node",
      blackboard: {},
      history: [],
    };
    await extension.stateManager.save(state);

    const toolResults = [
      {
        toolName: "start_workflow",
        input: JSON.stringify({ id: "research-wf" }),
        result: "Success",
      },
    ];
    await extension.hooks[HOOKS.TURN_END]({
      stopped: true,
      cancelled: false,
      agent: mockAgent,
      toolResults,
    });

    // Node id "research-node" maps to profile "researcher" with its body.
    expect(mockAgent.profileName).toBe("researcher");
    expect(mockAgent.profileBody).toBe("researcher body");
    expect(mockAgent.enqueue).toHaveBeenCalledWith(expect.stringContaining("node: **research-node**"));
  });

  it("should transition deterministically via SubmitResultTool in TURN_END", async () => {
    // Setup workflow
    const wf: WorkflowDefinition = {
      id: "test-wf",
      start_node: "node1",
      nodes: { 
        node1: { profile: "p1", label: "L1" },
        node2: { profile: "p2", label: "L2" },
      },
      edges: [
        { from: "node1", to: "node2", trigger: "deterministic", condition: "res == 'ok'" },
      ],
      fallback: "agentic",
    };
    const wfDir = path.join(tempDir, ".hotdog/workflows");
    await fsPromises.mkdir(wfDir, { recursive: true });
    await fsPromises.writeFile(path.join(wfDir, "test-wf.json"), JSON.stringify(wf));

    // Setup state
    const state: WorkflowState = {
      workflowId: "test-wf",
      cursor: "node1",
      blackboard: {},
      history: [],
    };
    await extension.stateManager.save(state);

    // Simulate agent calling submit_result tool (tool does state management)
    await extension.tools.submitResult.execute(
      JSON.stringify({ data: { res: "ok" } }),
      { agent: mockAgent } as any,
    );

    const toolResults = [
      {
        toolName: "submit_result",
        input: JSON.stringify({ data: { res: "ok" } }),
        result: "Result submitted. Transitioned to node: node2",
      },
    ];

    await extension.hooks[HOOKS.TURN_END]({
      stopped: true,
      cancelled: false,
      agent: mockAgent,
      toolResults,
    });

    expect(mockAgent.profileName).toBe("node2");
    expect(mockAgent.enqueue).toHaveBeenCalledWith(expect.stringContaining("transitioned to node: **node2**"));
    
    const loadedState = await extension.stateManager.load();
    expect(loadedState?.cursor).toBe("node2");
    expect(loadedState?.blackboard.res).toBe("ok");
  });

  it("should remain in current node and update blackboard on agentic fallback", async () => {
    const wf: WorkflowDefinition = {
      id: "test-wf",
      start_node: "node1",
      nodes: { node1: { profile: "p1", label: "L1" } },
      edges: [],
      fallback: "agentic",
    };
    const wfDir = path.join(tempDir, ".hotdog/workflows");
    await fsPromises.mkdir(wfDir, { recursive: true });
    await fsPromises.writeFile(path.join(wfDir, "test-wf.json"), JSON.stringify(wf));

    const state: WorkflowState = {
      workflowId: "test-wf",
      cursor: "node1",
      blackboard: {},
      history: [],
    };
    await extension.stateManager.save(state);

    // Simulate agent calling submit_result tool (tool does state management)
    await extension.tools.submitResult.execute(
      JSON.stringify({ data: { res: "something" } }),
      { agent: mockAgent } as any,
    );

    const toolResults = [
      {
        toolName: "submit_result",
        input: JSON.stringify({ data: { res: "something" } }),
        result: "Result submitted. Remaining in current node (agentic mode).",
      },
    ];

    await extension.hooks[HOOKS.TURN_END]({
      stopped: true,
      cancelled: false,
      agent: mockAgent,
      toolResults,
    });

    expect(mockAgent.profileName).toBe("start"); // No transition
    const loadedState = await extension.stateManager.load();
    expect(loadedState?.cursor).toBe("node1");
    expect(loadedState?.blackboard.res).toBe("something");
  });

  it("should transition to start_node when start_workflow is called", async () => {
    // Setup workflow
    const wf: WorkflowDefinition = {
      id: "test-wf",
      start_node: "node1",
      nodes: {
        node1: { profile: "p1", label: "L1" },
        node2: { profile: "p2", label: "L2" },
      },
      edges: [],
      fallback: "agentic",
    };
    const wfDir = path.join(tempDir, ".hotdog/workflows");
    await fsPromises.mkdir(wfDir, { recursive: true });
    await fsPromises.writeFile(path.join(wfDir, "test-wf.json"), JSON.stringify(wf));

    // Call start_workflow tool (simulates agent invoking it)
    const startTool = extension.hooks[HOOKS.TOOLS_REGISTER];
    // We need to get the actual tool instance - access via extension services
    // Instead, directly test TURN_END handling of start_workflow result
    const state: WorkflowState = {
      workflowId: "test-wf",
      cursor: "node1",
      blackboard: { initial: "data" },
      history: [],
    };
    await extension.stateManager.save(state);

    const toolResults = [
      {
        toolName: "start_workflow",
        input: JSON.stringify({ id: "test-wf", initialData: { initial: "data" } }),
        result: "Success",
      },
    ];

    await extension.hooks[HOOKS.TURN_END]({
      stopped: true,
      cancelled: false,
      agent: mockAgent,
      toolResults,
    });

    expect(mockAgent.profileName).toBe("node1");
    expect(mockAgent.clearContext).toHaveBeenCalled();
    expect(mockAgent.ensureSystemPrompt).toHaveBeenCalled();
    expect(mockAgent.enqueue).toHaveBeenCalledWith(
      expect.stringContaining("transitioned to node: **node1**"),
    );
    expect(mockAgent.enqueue).toHaveBeenCalledWith(
      expect.stringContaining("Workflow 'test-wf' started"),
    );
  });
});

describe("WorkflowManager Extension Metadata", () => {
  it("declares the --workflow CLI flag under 'cli:flags' (loader reads this key)", async () => {
    const raw = JSON.parse(
      await fsPromises.readFile(
        path.join(import.meta.dirname, "../../src/extensions/workflow-manager/extension.json"),
        "utf-8",
      ),
    );
    expect(raw["cli:flags"]).toBeDefined();
    expect(Array.isArray(raw["cli:flags"])).toBe(true);
    expect(raw["cli:flags"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ long: "--workflow" })]),
    );
    // The loader only reads meta["cli:flags"], so a camelCase "cliFlags" key is inert.
    expect(raw.cliFlags).toBeUndefined();
  });
});
