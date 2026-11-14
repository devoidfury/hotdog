// Subprocess probe for the descriptor-driven wire plane: a real agent
// session gets a fully-loaded runner with ZERO hand-passed descriptors.
//   discoverExtensions -> real ExtensionLoader (captures WIRE_TOOL_FACTORIES)
//   -> real createAgentFactory (the shared broker's collection point) ->
//   scripted LLM drives bash, read and grep -> real broker child -> real
//   runner spawn (register frame first) -> result frames in the transcript.
// Scenario "siblings": two sessions on the boot-"probe" shared broker; one
// runs the /fence toggle (dropSession) WHILE the other keeps invoking -- the
// survivor loses neither tools nor its scratch dir.
// Scenario argv: "off" asserts tool content (deterministic even where a
// nested jail cannot execute payloads); "siblings" asserts plumbing and
// scratch-dir identity only, never jail contents (an unfenced respawn may
// assert echo content).
// Runs as its own process (the shared broker is process-global state). The
// parent parses STEP: JSON lines off stdout.

import { createHooks } from "../../src/core/hooks.ts";
import { createToolRegistry } from "../../src/core/extensions/tool-registry.ts";
import { createServiceRegistry } from "../../src/core/extensions/service-registry.ts";
import { ConfigRegistry } from "../../src/core/extensions/config.ts";
import { createSubcommandRegistry } from "../../src/core/extensions/registries.ts";
import { createCompletionService } from "../../src/core/completion.ts";
import {
  ExtensionLoader,
  discoverExtensions,
  type LoaderCore,
} from "../../src/core/extensions/extensions.ts";
import { createAgentFactory } from "../../src/core/agent-factory.ts";
import {
  setExecFencePolicy,
  sharedToolExecBroker,
} from "../../src/core/tool-exec-broker.ts";
import type { WireToolConfig, WireToolResult } from "../../src/core/tool-exec-protocol.ts";
import { INTERNAL_MAX_OUTPUT_LINES } from "../../src/core/extensions/tool-utils.ts";
import { execFenceBackend } from "../../src/utils/exec-plan.ts";
import { toolContentText } from "../../src/utils/tool-content.ts";
import type { LlmClient } from "../../src/core/llm-client/client.ts";
import { MockLLMClient, buildStreamResponse } from "../mocks/llm.ts";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const scenario = process.argv[2] === "siblings" ? "siblings" : "off";

const step = (name: string, value: unknown): void => {
  process.stdout.write(`STEP:${JSON.stringify({ step: name, value })}\n`);
};

const tag = String(process.pid);
const wsRoot = join(tmpdir(), `hotdog-wire-plane-${tag}`);
mkdirSync(wsRoot, { recursive: true });
writeFileSync(join(wsRoot, "wire-e2e.txt"), "wire-needle content\nsecond line\n");

const scratchDirsFor = (session: string): string[] =>
  readdirSync(tmpdir())
    .filter((d) => d.startsWith(`hotdog-exec-${session}-`))
    .sort();

const resultText = (r: WireToolResult): string =>
  r.kind === "tool-result" ? r.output : String((r as { value?: unknown }).value);

// 1. Real loader, production load loop (same shape as main.ts): the alias
//    entries come from discovery, not from a fixture.
const hooks = createHooks();
const toolRegistry = createToolRegistry();
const configRegistry = new ConfigRegistry();
const core = {
  hooks,
  toolRegistry,
  services: createServiceRegistry(),
  completion: createCompletionService(),
  configRegistry,
  cliSubcommandRegistry: createSubcommandRegistry(),
} as unknown as LoaderCore;
const loader = new ExtensionLoader(core);
(core as unknown as { extensions: ExtensionLoader }).extensions = loader;

const discovered = await discoverExtensions(["@extensions"]);
const toLoad = ["core-tools", "bash-tool"];
const cfgBag = {
  bashTool: { bashTimeoutMs: 20000, maxTimeoutMs: 30000 },
  coreTools: {
    readToolLimit: 500,
    maxImageSize: 10485760,
    maxEditInputSize: 1000000,
    grepMaxResults: 50,
    findMaxResults: 50,
  },
};
(core as unknown as { config: Record<string, unknown> }).config = cfgBag;

for (const name of toLoad) {
  const ext = discovered.find((e) => e.name === name);
  if (!ext) throw new Error(`discovery lost the built-in extension "${name}"`);
  const instance = await loader.load(ext.name, ext.path ?? "", {
    provides: ext.provides,
    dependsOn: ext.dependsOn,
  });
  if (!instance) throw new Error(`failed to load "${name}" through the real loader`);
}

const registeredNames = toolRegistry.getAll().map(([n]) => n);
const collected = loader
  .wireToolDescriptors()
  .map((d) => `${d.tool}@${d.module.split("/").slice(-2).join("/")}`)
  .sort();
step("load", {
  registered: ["bash", "read", "grep"].every((n) => registeredNames.includes(n)),
  workerTagged: ["bash", "read", "grep"].every(
    (n) => toolRegistry.get(n)?.metadata?.execution === "worker",
  ),
  collected,
  backend: execFenceBackend(),
});

// 2. Real factory build: agent-factory mints the shared broker WITH the
//    loader-collected descriptors (nothing here mentions toolDescriptors).
const build = createAgentFactory(core as never, {
  llmClient: null as unknown as LlmClient,
  resolved: {
    toolExec: "worker",
    execFence: scenario === "siblings" ? "probe" : "off",
    envScrubbing: true,
    model: "wire-e2e-model",
    contextLimit: 200000,
    maxIterations: 8,
    maxToolCallsPerIteration: 4,
    maxEmptyRetries: 0,
    maxRetries: 0,
    toolRetryDelay: 0,
    workspaceRoots: [wsRoot],
    systemPromptTemplate: "wire plane e2e test",
  },
  config: cfgBag,
});

const toolConfig: WireToolConfig = {
  bashTool: { ...cfgBag.bashTool, maxToolOutputLines: INTERNAL_MAX_OUTPUT_LINES },
  coreTools: { ...cfgBag.coreTools, maxToolOutputLines: INTERNAL_MAX_OUTPUT_LINES },
  envScrubbing: true,
  envScrubExtra: [],
};
// IMPORTANT: the factory's build() below is the FIRST sharedToolExecBroker
// construction in this process -- it mints the singleton WITH the loader-
// collected descriptors. Reading the singleton here would pin it tool-less.
let shared: ReturnType<typeof sharedToolExecBroker> | null = null;
const getShared = () => {
  if (!shared) shared = sharedToolExecBroker();
  return shared;
};
const invoke = async (session: string, command: string): Promise<string> => {
  try {
    const r = await getShared().invoke({
      session,
      tool: "bash",
      args: { command },
      ctx: { session, workspace: { roots: [wsRoot], deny: [".env*"] }, toolConfig },
    });
    return resultText(r).trim();
  } catch (e) {
    return `ERR ${e instanceof Error ? e.message : String(e)}`;
  }
};

if (scenario === "off") {
  // Scripted LLM: one tool call per iteration across the three pool tools,
  // then a final answer. Every result frame came from a runner that built
  // its tools ONLY from the register frame.
  const mock = new MockLLMClient({
    responseSequences: [
      buildStreamResponse({
        toolCalls: [{ index: 0, name: "bash", arguments: `{"command":"echo wire-bash-${tag}"}`, id: "c1" }],
        usage: { total_tokens: 5 },
      }),
      buildStreamResponse({
        toolCalls: [{ index: 0, name: "read", arguments: `{"path":"wire-e2e.txt"}`, id: "c2" }],
        usage: { total_tokens: 5 },
      }),
      buildStreamResponse({
        toolCalls: [{ index: 0, name: "grep", arguments: `{"pattern":"wire-needle"}`, id: "c3" }],
        usage: { total_tokens: 5 },
      }),
      buildStreamResponse({ content: "all-three-routed", usage: { total_tokens: 5 } }),
    ],
  });
  const agent = await build({ sessionId: `wire-e2e-${tag}`, llmClient: mock as unknown as LlmClient });
  const completion = await agent.run("drive the three pool tools");
  const finalText =
    completion && completion.type === "completion"
      ? String(completion.content ?? "")
      : String(completion?.type);

  const toolMsgs = agent.context.log
    .getAll()
    .filter((m) => m.role === "tool")
    .map((m) => toolContentText(m.content));
  const allText = toolMsgs.join("\n---\n");
  step("agent-run", {
    final: finalText,
    toolCount: toolMsgs.length,
    bashOk: toolMsgs.some((t) => t.includes(`wire-bash-${tag}`)),
    readOk: toolMsgs.some((t) => t.includes("wire-needle content")),
    grepOk: toolMsgs.some((t) => t.includes("wire-e2e.txt") && t.includes("wire-needle")),
    notRegisteredSeen: allText.includes("not registered in the runner"),
    replacedOrCrashed:
      allText.includes("[tool-exec replaced]") || allText.includes("[tool-exec crashed]"),
  });
} else {
  // Sibling isolation on the factory-built shared broker: session B keeps
  // invoking while session A's /fence toggle runs the planner's dropSession
  // through the production entry point. Content assertions only where an
  // UNFENCED spawn backs them (see the header gate).
  const agent = await build({ sessionId: `wire-e2e-boot-${tag}` });
  void agent; // the build exists to mint the shared broker WITH descriptors
  const sessA = `wire-sib-a-${tag}`;
  const sessB = `wire-sib-b-${tag}`;
  const a1 = await invoke(sessA, `echo sib-a-1`);
  const b1 = await invoke(sessB, `echo sib-b-1`);
  const bScratchBefore = scratchDirsFor(sessB);
  const aScratchBefore = scratchDirsFor(sessA);
  // The /fence toggle path for A: setSessionFencePolicy -> dropSession(A)'s
  // memo entries AND scratch mapping.
  setExecFencePolicy(sessA, "off");
  const b2 = await invoke(sessB, `echo sib-b-2`);
  const a2 = await invoke(sessA, `echo sib-a-2`); // A keeps working, now unfenced
  const b3 = await invoke(sessB, `echo sib-b-3`);
  const bScratchAfter = scratchDirsFor(sessB);
  const lostTool = (t: string): boolean =>
    t.includes("not registered in the runner") ||
    t.includes("[tool-exec replaced]") ||
    t.includes("[tool-exec crashed]");
  step("siblings", {
    a1,
    b1,
    b2,
    a2,
    b3,
    backend: execFenceBackend(),
    bLostTool: [b1, b2, b3].some(lostTool),
    aLostTool: lostTool(a2),
    bScratchBefore,
    bScratchAfter,
    aScratchBefore,
  });
}

await getShared().close();
for (const d of readdirSync(tmpdir())) {
  if (
    d.startsWith(`hotdog-exec-wire-sib-a-${tag}-`) ||
    d.startsWith(`hotdog-exec-wire-sib-b-${tag}-`)
  ) {
    try {
      rmSync(join(tmpdir(), d), { recursive: true, force: true });
    } catch {
      // tmp policy takes them otherwise
    }
  }
}
rmSync(wsRoot, { recursive: true, force: true });
process.exit(0);
