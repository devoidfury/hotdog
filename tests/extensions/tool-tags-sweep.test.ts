// Tool domain tags sweep: boots the real tool-registering extensions and
// pins the declarations themselves, so a dropped `tags` field anywhere in
// the tree fails CI (silent drift of a domain claim is the failure mode this
// batch exists to prevent). Exact tag VALUES for core tools are pinned in
// tools-index.test.ts; this sweep covers every registered tool in the tree.
// Loader/mock-core pattern is the one in core-integration.test.ts.

import { describe, it, expect } from "bun:test";
import { HookSystem } from "@core/hooks.ts";
import { ExtensionLoader, type LoaderCore } from "@core/extensions/extensions.ts";
import { ToolRegistry } from "@core/extensions/tool-registry.ts";
import { openaiProtocol } from "@core/llm-client/openai-protocol.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { ServiceRegistry } from "@core/extensions/service-registry.ts";
import type { ConfigRegistry } from "@core/extensions/config.ts";
import type { CliSubcommandRegistry } from "@core/extensions/registries.ts";
import { createCompletionService } from "@core/completion.ts";
import { create as createCoreToolsExtension } from "@extensions/core-tools/index.ts";
import { create as createBashToolExtension } from "@extensions/bash-tool/index.ts";
import { create as createFetchToolExtension } from "@extensions/fetch-tool/index.ts";
import { create as createWebSearchExtension } from "@extensions/web-search/index.ts";
import { create as createQuestionToolExtension } from "@extensions/question-tool/index.ts";
import { create as createModelSwitchExtension } from "@extensions/model-switch/index.ts";
import { create as createSkillsExtension } from "@extensions/skills/index.ts";
import { create as createHandoffExtension } from "@extensions/handoff-tool/index.ts";
import { create as createStringLengthExtension } from "@extensions/string-length/index.ts";
import { create as createSubagentsExtension } from "@extensions/subagents/index.ts";
import { create as createWorkflowsExtension } from "@extensions/workflows/index.ts";
import { create as createSessionReviewExtension } from "@extensions/ui-session-review-cli/index.ts";
import { create as createAgentBrowserExtension } from "@experimental/agent-browser/index.ts";
import { create as createShowMeExtension } from "@experimental/show-me/index.ts";
import { McpTool } from "@extensions/mcp-client/tools.ts";

function createMockCore(): CoreContext {
  const hooks = new HookSystem();
  const toolRegistry = new ToolRegistry();
  const serviceRegistry = new ServiceRegistry();
  return {
    hooks,
    config: {
      skills: { path: "/tmp/skills-test" },
      // The `model` tool registers only when its schema flag is on; turn it
      // on so the sweep actually sees the tool.
      modelSwitch: { toolEnabled: true },
      // Schema-owned values the extensions demand at create() time.
      handoffTool: { autoIncludeFilesUnderBytes: 0 },
      showMe: { imageModel: "" },
      webSearch: {
        provider: "duckduckgo",
        maxResults: 5,
        timeout: 15,
        braveApiKey: "",
        tavilyApiKey: "",
        searxngInstanceUrl: "",
      },
      bashTool: { bashTimeoutMs: 60000 },
      fetchTool: {
        maxBodyLength: 1024,
        maxImageSize: 1024,
        fetchTimeoutMs: 1000,
        allowedSchemes: ["https"],
      },
    } as Record<string, unknown>,
    modelRegistry: {},
    toolRegistry,
    services: serviceRegistry,
    completion: createCompletionService(),
    configRegistry: {
      validateConfigByKey: (_key: string, _config: unknown) => ({ valid: true, errors: [] }),
    } as unknown as ConfigRegistry,
    cliSubcommandRegistry: {} as unknown as CliSubcommandRegistry,
    extensions: {} as unknown as ExtensionLoader,
    service: (name: string) => serviceRegistry.get(name),
  } as unknown as CoreContext;
}

function wrapFactory(factory: (core: CoreContext) => unknown) {
  return { create: factory };
}

// The tool-registering extensions a manager session boots (mcp-client is NOT
// loaded here: it synthesizes tools only for configured servers, and its
// per-remote-tool untagged case is registered explicitly below).
const TOOL_REGISTERING_EXTENSIONS: Array<[string, (core: CoreContext) => unknown]> = [
  ["core-tools", createCoreToolsExtension],
  ["bash-tool", createBashToolExtension],
  ["fetch-tool", createFetchToolExtension],
  ["web-search", createWebSearchExtension],
  ["question-tool", createQuestionToolExtension],
  ["model-switch", createModelSwitchExtension],
  ["skills", createSkillsExtension],
  ["handoff-tool", createHandoffExtension],
  ["string-length", createStringLengthExtension],
  ["subagents", createSubagentsExtension],
  ["workflows", createWorkflowsExtension],
  ["ui-session-review-cli", createSessionReviewExtension],
  ["agent-browser", createAgentBrowserExtension],
  ["show-me", createShowMeExtension],
];

async function loadAllToolRegisteringExtensions(): Promise<ToolRegistry> {
  const core = createMockCore();
  const loader = new ExtensionLoader(core as unknown as LoaderCore);
  for (const [name, factory] of TOOL_REGISTERING_EXTENSIONS) {
    await loader.load(name, wrapFactory(factory));
  }
  return core.toolRegistry;
}

describe("registry-wide tool tags sweep", () => {
  it("every registered first-party tool resolves at least one normalized tag", async () => {
    const registry = await loadAllToolRegisteringExtensions();

    // The single deliberate exception: MCP-bridged third-party tools declare
    // empty tags (no invented domains for external servers). Registered here
    // by hand because mcp-client synthesizes tools only per live server.
    const mcp = new McpTool(
      "srv",
      { name: "remote_thing", description: "d", inputSchema: { type: "object", properties: {} } } as never,
      { callTool: async () => ({ content: [] }) } as never,
    );
    registry.register(mcp.registeredName, mcp);

    const names = registry.getAll().map(([name]) => name);
    // Sanity: the boot really registered the expected breadth (14 extensions'
    // tools + the MCP case; 28+ means no extension silently no-op'd).
    expect(names.length).toBeGreaterThanOrEqual(28);

    const untagged = names.filter((name) => registry.getTags(name).length === 0);
    expect(untagged, "these registered tools lost their tag declarations").toEqual([
      mcp.registeredName,
    ]);
    // The exception itself must read empty (not junk), through the same
    // normalized read every consumer uses.
    expect(registry.getTags(mcp.registeredName)).toEqual([]);
  });

  it("first-party declarations stay inside the canonical vocabulary", async () => {
    const registry = await loadAllToolRegisteringExtensions();
    const CANONICAL = new Set(["files", "network", "utility", "system", "manager", "guidance"]);
    const offVocabulary = registry
      .getAll()
      .flatMap(([name]) => registry.getTags(name))
      .filter((tag) => !CANONICAL.has(tag));
    // Custom domains are first-class for OUT-of-tree extensions; the
    // first-party set has no reason to leave the canonical vocabulary, so
    // any drift here is a typo.
    expect(offVocabulary, "non-canonical tags in first-party declarations").toEqual([]);
  });

  it("real registered tool defs serialize to the provider without any tags", async () => {
    const registry = await loadAllToolRegisteringExtensions();
    const defs = await registry.getToolDefs();
    const req = openaiProtocol.buildRequest([], { name: "test/model" } as never, defs, true, {
      mangler: null,
      wireFormat: null,
      roleMapping: null,
    } as never);
    // Only the JSON Schema rides the wire: ToolMetadata (tags included)
    // never serializes into the provider request.
    expect(JSON.stringify(req.body)).toContain('"tools"');
    expect(JSON.stringify(req.body)).not.toContain('"tags"');
  });
});
