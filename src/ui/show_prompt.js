// Show-prompt subcommand — render system prompt with tool definitions.
// Extracted from main.js to mirror Rust's ui/show_prompt.rs.

import { join } from "node:path";
import { Agent } from "../agent/agent.js";
import { LlmClient } from "../llm_client/client.js";
import { CliOutputSink } from "./cli.js";
import { NoopSink } from "../context/output.js";
import { SkillsLoader } from "../skills/loader.js";
import { PromptsLoader } from "../prompts/loader.js";
import { disabledSessionLog } from "../session_log.js";
import { buildConfig } from "../init/resolution.js";
import { loadConfig, getProfile } from "../config.js";

/**
 * Run the show-prompt subcommand.
 */
export async function runShowPrompt(cli) {
  const { resolved, modelRegistry } = await buildConfig(cli);
  const config = await loadConfig(cli.config);

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

  // Load prompts
  const promptsLoader = new PromptsLoader(
    cli.promptsPath || config.promptsPath,
  );
  promptsLoader.loadPrompts();

  // Create client and sink
  const client = new LlmClient({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    stream: false,
    chatTimeoutSecs: resolved.chatTimeout,
    providers: config.providers || [],
  });

  const sink = new CliOutputSink({
    ...resolved,
    stream: false,
  });

  // Create agent
  const agent = new Agent({
    client,
    model: resolved.model,
    modelRegistry,
    sink,
    hideTools: resolved.hideTools,
    compactDebug: resolved.compactDebug,
    showTokenUse: false,
    role: resolved.role,
    profileBody: resolved.profileBody,
    stream: false,
    profileName: resolved.profileName,
    compaction: config.compaction,
    _config: config,
    skillsLoader,
    promptsLoader,
    skills: skillsLoader.activeSkills(),
    allSkills: skillsLoader.agentViewableSkills(),
    skillDirectories: skillsLoader.directories(),
    sessionLog: disabledSessionLog(),
  });

  // Render and print system prompt
  agent.ensureSystemPrompt();
  const systemPrompt = agent.context.systemMessages[0]?.content || "";
  console.log(systemPrompt);

  // Build tool registry so we can display tools
  const profile = getProfile(agent._config || {}, agent.profileName);
  agent._currentTools = await agent.buildToolRegistry(
    profile.whitelistTools || null,
    profile.blacklistTools || null,
    profile.manager || false,
  );

  // Print tools section
  if (agent._currentTools) {
    const tools = agent._currentTools.getAll();
    if (tools.length > 0) {
      console.log("\n--- Tools ---\n");
      for (const [name, tool] of tools) {
        const def = tool?.toToolDef?.();
        if (def) {
          console.log(`${def.function.name}`);
          console.log(`\n${def.function.description}`);
          console.log("---------\n");
        }
      }
    }
  }
}
