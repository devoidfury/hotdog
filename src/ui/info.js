// Info subcommand — display system info, config, models, skills, connectivity.
// Extracted from main.js to mirror Rust's ui/info.rs.

import { LlmClient } from "../llm_client/client.js";
import { SkillsLoader } from "../skills/loader.js";
import { DEFAULT_SKILLS_PATH } from "../config.js";
import { buildConfig } from "../init/resolution.js";

/**
 * Run the info subcommand.
 */
export async function runInfo(cli) {
  const { resolved, modelRegistry, providers } = await buildConfig(cli);
  const config = await import("../config.js").then(m => m.default || m);
  const rawConfig = await (await import("../config.js")).loadConfig(cli.config);

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
    client.ping ? await client.ping() : null;
    connectivity = { reachable: true, error: null };
  } catch (e) {
    connectivity = { reachable: false, error: e.message };
  }

  const skillsLoader = new SkillsLoader(
    cli.skillsPath || rawConfig.skillsPath || DEFAULT_SKILLS_PATH,
  );
  skillsLoader.loadSkills();
  const skillCount = skillsLoader.allSkills().filter((s) => s.loaded).length;

  if (cli.wantsJson) {
    printInfoJson(resolved, modelRegistry, providers, skillsLoader, skillCount, connectivity, rawConfig);
  } else {
    printInfoText(resolved, modelRegistry, providers, skillsLoader, skillCount, connectivity, rawConfig);
  }
}

function printInfoText(resolved, modelRegistry, providers, skillsLoader, skillCount, connectivity, config) {
  const DEFAULT_SKILLS_PATH = "/skills";
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
  console.log(`Skills: ${skillCount} loaded`);

  // MCP servers
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

function printInfoJson(resolved, modelRegistry, providers, skillsLoader, skillCount, connectivity, config) {
  const DEFAULT_SKILLS_PATH = "/skills";
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
    skills_loaded: skillCount,
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
