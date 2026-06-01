// Info-Show-Prompt Extension
// Provides CLI subcommands (info, show-prompt) that run outside the agent loop.
// Registers subcommands via the cli:subcommandsRegister hook.
// Capability declared in extension.json metadata file.

import { LlmClient } from "../../core/llm_client/client.js";
import { SkillsLoader } from "../skills/loader.js";
import { DEFAULT_SKILLS_PATH } from "../../core/config.js";
import { Agent } from "../../core/agent.js";

/**
 * Run the info subcommand.
 */
async function runInfo(cli, config, buildConfig) {
  const { resolved, modelRegistry, providers } = await buildConfig(cli);
  const rawConfig = await (
    await import("../../src/core/config.js")
  ).loadConfig(cli.config);

  // Check connectivity
  const client = new LlmClient({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    stream: false,
    chatTimeoutSecs: resolved.chatTimeout,
    providers: rawConfig.providers || [],
  });

  let connectivity;
  try {
    if (client.ping) await client.ping();
    connectivity = { reachable: true, error: null };
  } catch (e) {
    connectivity = { reachable: false, error: e.message };
  }

  const skillsLoader = new SkillsLoader(
    cli.skillsPath || rawConfig.skillsPath || DEFAULT_SKILLS_PATH,
  );
  skillsLoader.loadSkills();

  if (cli.wantsJson) {
    printInfoJson(
      resolved,
      modelRegistry,
      providers,
      skillsLoader,
      connectivity,
      rawConfig,
    );
  } else {
    printInfoText(
      resolved,
      modelRegistry,
      providers,
      skillsLoader,
      connectivity,
      rawConfig,
    );
  }
}

function printInfoText(
  resolved,
  modelRegistry,
  providers,
  skillsLoader,
  connectivity,
  config,
) {
  console.log("=== Agent Harness Info ===");
  console.log();
  console.log("Configuration:");
  console.log(`  AI URL:          ${resolved.baseUrl}`);
  console.log(`  Default Model:   ${resolved.model}`);
  console.log(
    `  Skills Path:     ${config?.skillsPath || DEFAULT_SKILLS_PATH}`,
  );
  console.log(`  Chat Timeout:    ${resolved.chatTimeout}s`);
  console.log(`  Profile:         ${resolved.profileName}`);
  if (resolved.profile?.whitelistTools) {
    console.log(
      `  Whitelist Tools: ${resolved.profile.whitelistTools.join(", ")}`,
    );
  }
  if (resolved.profile?.blacklistTools?.length > 0) {
    console.log(
      `  Blacklist Tools: ${resolved.profile.blacklistTools.join(", ")}`,
    );
  }

  if (providers.length > 0) {
    console.log();
    console.log("Providers:");
    for (const p of providers) {
      const isActive = resolved.activeProvider === p.name;
      const isDefault = config?.defaultProvider === p.name;
      const marker = isActive ? " (active)" : isDefault ? " (default)" : "";
      const modelNames = (p.models || []).map((m) => m.name).join(", ");
      console.log(`  ${p.name}${marker} → ${p.url}  [${modelNames}]`);
    }
    if (resolved.activeProvider) {
      console.log();
      console.log(`Active Provider: ${resolved.activeProvider}`);
    }
  }

  console.log();
  console.log(`Models (${Object.keys(modelRegistry).length}):`);
  for (const name of Object.keys(modelRegistry)) {
    const m = modelRegistry[name];
    const tagStr = (m.tags || []).length > 0 ? m.tags.join(", ") : "no tags";
    console.log(`  ${name} [${tagStr}]`);
  }
  console.log();
  console.log(`Skills: ${skillsLoader.activeSkills().length} loaded`);

  const mcpServers = config?.mcpServers || [];
  if (mcpServers.length > 0) {
    console.log();
    console.log("MCP Servers:");
    for (const server of mcpServers) {
      const enabled = server.enabled !== false ? "enabled" : "disabled";
      const transport = server.url
        ? `HTTP (${server.url})`
        : server.command
          ? `stdio (${server.command})`
          : "unknown";
      console.log(`  ${server.name}: ${transport} [${enabled}]`);
    }
  }

  console.log();
  console.log("Connectivity:");
  if (connectivity.reachable) {
    console.log(`  ${resolved.baseUrl} - reachable`);
  } else {
    console.log(`  ${resolved.baseUrl} - unreachable: ${connectivity.error}`);
  }
}

function printInfoJson(
  resolved,
  modelRegistry,
  providers,
  skillsLoader,
  connectivity,
  config,
) {
  const providersConfigured = providers.map((p) => ({
    name: p.name,
    url: p.url,
    models: (p.models || []).map((m) => m.name),
  }));

  const models = Object.keys(modelRegistry).map((name) => {
    const m = modelRegistry[name];
    return { name, tags: m.tags || [] };
  });

  const json = {
    config: {
      ai_url: resolved.baseUrl,
      default_model: resolved.model,
      chat_timeout_secs: resolved.chatTimeout,
      skills_path: config?.skillsPath || DEFAULT_SKILLS_PATH,
      profile: resolved.profileName,
      profile_whitelist: resolved.profile?.whitelistTools || null,
      profile_blacklist: resolved.profile?.blacklistTools || [],
    },
    providers: {
      configured: providersConfigured,
      active: resolved.activeProvider || null,
    },
    models,
    skills_loaded: skillsLoader.activeSkills(),
    mcp_servers: (config?.mcpServers || []).map((s) => ({
      name: s.name,
      enabled: s.enabled !== false,
      url: s.url || null,
      command: s.command || null,
    })),
    connectivity: {
      url: resolved.baseUrl,
      reachable: connectivity.reachable,
      error: connectivity.error || null,
    },
  };
  console.log(JSON.stringify(json, null, 2));
}

// ── Show-Prompt Subcommand ───────────────────────────────────────────────────

/**
 * Run the show-prompt subcommand.
 * Creates a real agent, ensures the system prompt is built via hooks,
 * and outputs the actual system prompt.
 */
async function runShowPrompt(cli, core, config, buildConfig) {
  const { resolved } = await buildConfig(cli);

  // Create an agent with the same config that a real agent would get.
  // Use the hooks from earlyCore (which already has CLI extensions loaded
  // including skills, which contributes to the system prompt via hooks).
  const agent = new Agent({
    hooks: core.hooks,
    toolRegistry: core.toolRegistry,
    llmClient: null, // Not needed — we only want the system prompt
    model: resolved.model || "",
    profileName: resolved.profileName || "default",
    role: resolved.role || "",
    profileBody: resolved.profileBody || "",
    config,
  });

  // Build the system prompt via the real hook mechanism
  await agent.ensureSystemPrompt();

  // Output the actual system prompt
  console.log(agent.systemPrompt);
}

// ── Extension Entry Point ───────────────────────────────────────────────────

/**
 * Create the info-show-prompt extension.
 * Registers subcommands via the cli:subcommandsRegister hook.
 */
export function create(core) {
  // Register subcommands if the registry is available
  if (core.cliSubcommandRegistry) {
    core.cliSubcommandRegistry.register("info", {
      description: "Show system info and diagnostics",
      requiresConfig: true,
      handler: async (cli, core) => {
        const { config, buildConfig } = core;
        await runInfo(cli, config, buildConfig);
      },
    });

    core.cliSubcommandRegistry.register("show-prompt", {
      description: "Show rendered system prompt with tool definitions",
      requiresConfig: true,
      handler: async (cli, core) => {
        const { config, buildConfig } = core;
        await runShowPrompt(cli, core, config, buildConfig);
      },
    });
  }

  return {
    hooks: core.hooks ? {} : undefined,
  };
}
