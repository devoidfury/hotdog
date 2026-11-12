// Workflows extension — multi-agent workflow (DAG) artifacts.
//
// Surfaces:
// - CLI: `hotdog workflow validate|render|run|list|status|reconcile|cancel`
// - Manager tools: workflow_validate (validates AND saves) / workflow_dispatch (file + optional args) / workflow_status
//   / workflow_followup (steer a running node, same seam as /followup) / workflow_control (skip | resume | cancel)
// - Slash commands: /workflow (status + cancel) and /followup <node> <msg>
//   (mid-turn steering of a node's worker)
// - Skills-style availability listing of <workflows.path>/*.workflow.yaml
//   (name + description) in manager system prompts
//
// The TaskManager is resolved lazily via the "taskManager" service (subagents
// precedent). A standalone CLI `run` has no SessionManager, so it builds its
// own TaskManager with the same seams SessionManager.create uses.

import { join } from "node:path";
import { HOOKS } from "@core/hooks.ts";
import { ACTIONS } from "@core/commands.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { createAgentFactory } from "@core/agent-factory.ts";
import { TaskManager } from "@core/session/task-manager.ts";
import type { CliArgv } from "@core/config/index.ts";
import {
  getExtensionConfig,
  type CoreContext,
  type ExtensionInstance,
} from "@core/extensions/types.ts";
import type { Agent } from "@core/agent.ts";
import { TASK_MANAGER_SERVICE } from "../subagents/index.ts";
import { markInterruptedRuns } from "./run-store.ts";
import { runWorkflowCommand, type WorkflowCliDeps } from "./workflow-cli.ts";
import {
  WORKFLOW_TOOL_CONSTRUCTORS,
  RunRegistry,
  createWorkflowScanner,
  managedRunLines,
  workflowsPreamble,
  type ManagedRun,
  type WorkflowToolOptions,
} from "./workflow-tools.ts";
import { resolveWorkflowLimits, type WorkflowLimits } from "./workflow.ts";
import { buildTaskConfigOptions } from "@core/session/index.ts";

interface WorkflowsExtensionConfig {
  maxNodes?: number;
  maxRuntimeMins?: number;
  enableRuntimeTimeouts?: boolean;
  path?: string;
}

export async function create(core: CoreContext): Promise<ExtensionInstance> {
  // B7 (§4.1/§4.3 workflows row): the create() snapshot is GONE. Every value
  // below is a reader resolved where it is used:
  //  - limits: resolved per validate/dispatch, so a raised
  //    workflows.maxNodes / maxRuntimeMins lands on the NEXT one. A run that
  //    is already going keeps its start-time limits (P8/P3 flavor): the graph
  //    parse stamps its own limits and WorkflowRun re-freezes at construction.
  //  - enableRuntimeTimeouts: read at DISPATCH -- the toggle's own doc says
  //    dispatch, and now it is true (the engine re-freezes it per run).
  //  - path: per lookup; a published change sends the next dispatch to the
  //    new dir while existing runs keep the dirs they were written to (each
  //    ManagedRun carries its own runDir). The boot durability scan below is
  //    boot machinery and reads the boot value once, as before.
  //  - modelGroups: read per group-ref resolution -- B3's scheduler precedent
  //    (a reader over the live CONFIG bag; modelGroups is a config-bag root,
  //    read exactly like task-manager.ts / websocket/server.ts do).
  const block = () => getExtensionConfig<WorkflowsExtensionConfig>(core, "workflows");

  // Only the schema-owned config fields (maxNodes, maxRuntimeMins) override;
  // the non-raisable ceilings (hardMaxNodes, maxAttempts) come from
  // workflow.ts via the normalizer.
  const currentLimits = (): WorkflowLimits => {
    const { maxNodes, maxRuntimeMins } = block();
    return resolveWorkflowLimits({
      ...(typeof maxNodes === "number" ? { maxNodes } : {}),
      ...(typeof maxRuntimeMins === "number" ? { maxRuntimeMins } : {}),
    });
  };
  const workflowsDir = (): string | null => {
    const trimmed = block().path?.trim();
    return trimmed ? trimmed : null;
  };
  const runsRoot = (): string | null => {
    const dir = workflowsDir();
    return dir ? join(dir, "runs") : null;
  };
  const runtimeTimeoutsEnabled = (): boolean => block().enableRuntimeTimeouts === true;
  const declaredModelGroups = (): Record<string, string[]> =>
    ((core.config as Record<string, unknown> | undefined)?.modelGroups as
      | Record<string, string[]>
      | undefined) ?? {};

  // Restart durability: mark runs whose owner died (warn + one `interrupted`
  // journal event each), never auto-resume -- a restart often means deliberate
  // tree changes. Cost is one readdir + small journal tail reads; nothing here
  // builds an agent. Boot machinery, unchanged: ONE read at activation.
  const bootRunsRoot = runsRoot();
  if (bootRunsRoot) {
    try {
      await markInterruptedRuns(bootRunsRoot);
    } catch (e: unknown) {
      logger.warn(`[workflows] interrupted-run scan failed: ${formatError(e)}`);
    }
  }

  // Live availability listing: rescanned (stat-gated) per system-prompt build,
  // so graphs saved mid-session reach managers without a restart. Both the dir
  // and the limits ride readers, so a published path change re-roots the
  // listing on the next build (the scanner drops its cache when the dir moves).
  const scanAvailability = createWorkflowScanner(workflowsDir, currentLimits);

  const registry = new RunRegistry();

  const taskManagerProvider = (): TaskManager | null =>
    core.services.has(TASK_MANAGER_SERVICE)
      ? (core.services.get(TASK_MANAGER_SERVICE) as TaskManager)
      : null;

  // `workflow run` in a standalone CLI process: build the TaskManager the
  // same way SessionManager.create does (parked nodes never touch a session
  // bus, so no SessionManager is needed).
  let host: { tasks: TaskManager } | null = null;
  const runHost: WorkflowCliDeps["runHost"] = () => {
    if (host) return host;
    const resolved = core.resolved;
    if (!resolved) return null;
    const llmClient = core.createLlmClient();
    host = {
      tasks: new TaskManager({
        ...buildTaskConfigOptions(resolved),
        buildAgent: createAgentFactory(core, { resolved, config: core.config, llmClient }),
        modelRegistry: resolved.modelRegistry,
        config: core.config,
        profileManager: resolved.profileManager,
      }),
    };
    return host;
  };

  // The CLI deps are rebuilt PER invocation: `hotdog workflow ...` on a live
  // host (the subcommand registry) reads limits/dir/groups/toggle as they are
  // when the verb runs, not as they were when the extension loaded.
  const cliDeps = (): WorkflowCliDeps => ({
    runsRoot: runsRoot() ?? undefined,
    limits: currentLimits(),
    enableRuntimeTimeouts: runtimeTimeoutsEnabled(),
    modelGroups: declaredModelGroups(),
    runHost,
    emit: (line) => console.log(line),
  });

  async function handleWorkflowSubcommand(cli: CliArgv): Promise<number> {
    const outcome = await runWorkflowCommand(
      ((cli as { args?: unknown }).args as string[]) ?? [],
      cliDeps(),
    );
    for (const line of outcome.out) console.log(line);
    for (const line of outcome.err) console.error(line);
    return outcome.code;
  }

  // -- slash commands --------------------------------------------------------

  function workflowCommand(argText: string): { content?: string; error?: string } {
    const text = argText.trim();

    if (text === "") {
      const runs = registry.all();
      if (runs.length === 0) return { content: "No workflow runs in this process." };
      return {
        content: runs
          .map((m) =>
            m.finished
              ? `${m.runId}  ${m.workflow}  ${m.finished.outcome}`
              : m.error
                ? `${m.runId}  ${m.workflow}  crashed (${m.error})`
                : `${m.runId}  ${m.workflow}  active`,
          )
          .join("\n"),
      };
    }

    if (text.startsWith("cancel ")) {
      const runId = text.slice(7).trim();
      const m = registry.get(runId);
      if (!m) {
        return {
          error: `Unknown run '${runId}'. This process owns: ${
            registry.all().map((r) => r.runId).join(", ") || "(none)"
          }. A run owned by another process must be stopped there (Ctrl-C).`,
        };
      }
      if (m.finished) return { content: `run ${runId}: already ${m.finished.outcome}` };
      if (m.error) return { content: `run ${runId}: already crashed` };
      m.run.cancel();
      return { content: `Cancel requested for run ${runId}.` };
    }

    const m = registry.get(text);
    if (!m) return { error: `Unknown run '${text}'. /workflow lists the runs this process owns.` };
    return { content: managedRunLines(m).join("\n") };
  }

  function followupCommand(argText: string): { content?: string; error?: string } {
    let rest = argText.trim();
    let run: ManagedRun | null = null;

    const head = rest.split(/\s+/)[0] ?? "";
    const explicit = head ? registry.get(head) : null;
    if (explicit) {
      run = explicit;
      rest = rest.slice(head.length).trim();
    } else {
      const active = registry.active();
      if (active.length === 0) return { error: "No active workflow run to steer." };
      if (active.length > 1) {
        return {
          error: `Multiple active runs — use '/followup <run-id> <node> <message>' (${active
            .map((r) => r.runId)
            .join(", ")}).`,
        };
      }
      run = active[0]!;
    }

    const sp = rest.indexOf(" ");
    const nodeId = sp === -1 ? rest : rest.slice(0, sp);
    const message = sp === -1 ? "" : rest.slice(sp + 1).trim();
    if (!nodeId || !message) {
      return { error: `Usage: /followup <node> <message>${explicit ? "" : " (or /followup <run-id> <node> <message>)"}` };
    }
    if (run!.run.steer(nodeId, message)) {
      return { content: `Steering sent to node '${nodeId}' of run ${run!.runId}.` };
    }
    return {
      error: `Node '${nodeId}' of run ${run!.runId} is not mid-turn — steering reaches only a live worker turn.`,
    };
  }

  return {
    hooks: {
      [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry_: {
        register: (name: string, def: { description: string; handler: (cli: CliArgv) => Promise<number> }) => void;
      }) => {
        registry_.register("workflow", {
          description:
            "Workflow artifacts: 'workflow validate|render <file>' | 'workflow run <file>' | 'workflow list' | 'workflow status|reconcile|cancel <run-id>'",
          handler: handleWorkflowSubcommand,
        });
      },

      [HOOKS.TOOLS_REGISTER]: async (toolRegistry) => {
        // Readers all the way down (B7): each validate/dispatch/status call
        // resolves dir, limits, the timeout toggle and the group bag against
        // the CURRENT generation.
        const opts: WorkflowToolOptions = {
          taskManagerProvider,
          getRunsRoot: runsRoot,
          getWorkflowsDir: workflowsDir,
          limits: currentLimits,
          enableRuntimeTimeouts: runtimeTimeoutsEnabled,
          getModelGroups: declaredModelGroups,
          registry,
        };
        for (const [name, ctor] of Object.entries(WORKFLOW_TOOL_CONSTRUCTORS)) {
          try {
            toolRegistry.register(name, ctor(opts));
          } catch (e: unknown) {
            logger.error(`[workflows] failed to create tool '${name}': ${formatError(e)}`);
          }
        }
      },

      /** Manager-facing availability listing (skills-style): saved workflow graphs by name + description. */
      [HOOKS.SYSTEM_PROMPT_BUILD]: async ({ agent }: { agent?: Agent }) => {
        if (!agent?.managerProfile) return;
        const availability = await scanAvailability();
        const content = workflowsPreamble(availability);
        if (content) return { name: "workflows", priority: 410, content };
      },

      [HOOKS.COMMANDS_REGISTER]: async ({ registry: cmdRegistry }) => {
        cmdRegistry.register("workflow", {
          description: "Workflow runs: /workflow (list) | /workflow <run-id> | /workflow cancel <run-id>",
          matches: (cmd: string) => cmd === "workflow" || cmd.startsWith("workflow "),
          handler: async (_agent: Agent, value: string | null) => {
            const argText = (value ?? "").slice("workflow".length);
            const r = workflowCommand(argText);
            return r.error
              ? { action: ACTIONS.ERROR, error: r.error }
              : { action: ACTIONS.DISPLAY, content: r.content ?? "" };
          },
        });

        cmdRegistry.register("followup", {
          description: "Steer a running workflow node mid-turn (/followup [<run-id>] <node> <message>)",
          matches: (cmd: string) => cmd === "followup" || cmd.startsWith("followup "),
          handler: async (_agent: Agent, value: string | null) => {
            const argText = (value ?? "").slice("followup".length);
            const r = followupCommand(argText);
            return r.error
              ? { action: ACTIONS.ERROR, error: r.error }
              : { action: ACTIONS.DISPLAY, content: r.content ?? "" };
          },
        });
      },
    },

    // Expose for external use and tests (skills exposes its loader likewise).
    runs: registry,
  };
}
