// Info-Show-Prompt Extension
// Provides CLI subcommands (info, show-prompt) that run outside the agent loop.
// Registers subcommands via the cli:subcommandsRegister hook.

import { HOOKS } from "../../src/hooks.js";
import { LlmClient } from "../../src/llm_client/client.js";
import { SkillsLoader } from "../skills/loader.js";
import { DEFAULT_SKILLS_PATH } from "../../src/config.js";
import { CliOutputSink } from "../../src/ui/cli.js";
import { readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Run the info subcommand.
 */
async function runInfo(cli, config, buildConfig) {
  const { resolved, modelRegistry, providers } = await buildConfig(cli);
  const rawConfig = await (
    await import("../../src/config.js")
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
 */
async function runShowPrompt(cli, config, buildConfig) {
  const { resolved, modelRegistry } = await buildConfig(cli);

  // Load skills
  const skillsLoader = new SkillsLoader(cli.skillsPath || config.skillsPath);
  skillsLoader.loadSkills();
  skillsLoader.setAvailableTools([
    "bash",
    "read",
    "write",
    "edit",
    "grep",
    "find",
    "fetch",
    "question",
    "pager",
    "model",
    "load_skill",
  ]);
  skillsLoader.preloadSkills(resolved.preloadSkills);

  // Create client
  const client = new LlmClient({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    stream: false,
    chatTimeoutSecs: resolved.chatTimeout,
    providers: config.providers || [],
  });

  // Build system prompt (simplified version)
  const systemPrompt = buildSystemPrompt(resolved, skillsLoader, config);
  console.log(systemPrompt);
}

function buildSystemPrompt(resolved, skillsLoader, config) {
  const profile = resolved.profile || {};
  const skills = skillsLoader.allSkills();

  let prompt = "";

  // Role
  if (resolved.role) {
    prompt += resolved.role + "\n\n";
  }

  // Profile body
  if (resolved.profileBody) {
    prompt += resolved.profileBody + "\n\n";
  }

  prompt += skillsLoader.buildSkillsPreamble();

  // Environment marker
  prompt += `<m_fy6az93w38i7eahj>\n`;
  prompt += `  Agent: oa-agent (Model: ${resolved.model}) (Profile: ${resolved.profileName})\n`;
  prompt += `  CWD: ${process.cwd()}\n`;
  prompt += `  Platform: ${process.platform}\n`;
  prompt += `  Session: ${new Date().toISOString().slice(0, 10)}\n`;
  prompt += `</m_fy6az93w38i7eahj>\n`;

  return prompt;
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
        await runShowPrompt(cli, config, buildConfig);
      },
    });
  }

  return {
    hooks: core.hooks
      ? {
          // Register via hook as well for backward compatibility
          [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry) => {
            registry.register("info", {
              description: "Show system info and diagnostics",
              requiresConfig: true,
              handler: async (cli, core) => {
                const { config, buildConfig } = core;
                await runInfo(cli, config, buildConfig);
              },
            });

            registry.register("show-prompt", {
              description: "Show rendered system prompt with tool definitions",
              requiresConfig: true,
              handler: async (cli, core) => {
                const { config, buildConfig } = core;
                await runShowPrompt(cli, config, buildConfig);
              },
            });
          },
        }
      : undefined,
  };
}
