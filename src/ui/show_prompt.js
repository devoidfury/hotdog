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
import { loadConfig, DEFAULT_SKILLS_PATH, DEFAULT_PROMPTS_PATH } from "../config.js";

/**
 * Run the show-prompt subcommand.
 */
export async function runShowPrompt(cli) {
  const { resolved, modelRegistry } = await buildConfig(cli);
  const config = await loadConfig(cli.config);

  // Load skills
  const skillsLoader = new SkillsLoader(
    cli.skillsPath || config.skillsPath || DEFAULT_SKILLS_PATH,
  );
  skillsLoader.loadSkills();
  skillsLoader.autoActivate([
    "bash", "read", "write", "edit", "grep", "find",
    "fetch", "question", "pager", "model", "load_skill",
  ]);

  // Preload skills
  const preloadSkills =
    cli.preloadSkills.length > 0
      ? cli.preloadSkills
      : resolved.profile?.preloadSkills || [];
  const skills =
    preloadSkills.length > 0
      ? preloadSkills
          .map((name) => {
            const skill = skillsLoader.allSkills().find((s) => s.name === name);
            if (skill) { skill.loaded = true; return skill; }
            return null;
          })
          .filter(Boolean)
      : [];
  const allSkills = skillsLoader
    .allSkills()
    .filter((s) => !s.disableModelInvocation);
  const skillDirectories = skillsLoader.directories();

  // Load prompts
  const promptsLoader = new PromptsLoader(
    cli.promptsPath || config.promptsPath || DEFAULT_PROMPTS_PATH,
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
    stream: false,
    thinkerFormat: resolved.thinkerFormat,
    toolFormat: resolved.toolFormat,
    toolOutputFormat: resolved.toolOutputFmt,
    hideTools: resolved.hideTools,
    hideThinking: resolved.hideThinking,
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
    skills,
    allSkills,
    skillDirectories,
    sessionLog: disabledSessionLog(),
  });

  // Render and print system prompt
  agent.ensureSystemPrompt();
  const systemPrompt = agent.context.systemMessages[0]?.content || "";
  console.log(systemPrompt);

  // Print tools section
  const toolDefs = agent._currentTools || {};
  const toolNames = Object.keys(toolDefs);
  if (toolNames.length > 0) {
    console.log("\n--- Tools ---\n");
    for (const name of toolNames) {
      const tool = toolDefs[name];
      const def = tool?.toToolDef?.();
      if (def) {
        console.log(`${def.function.name}`);
        console.log(`\n${def.function.description}`);
        console.log("---------\n");
      }
    }
  }
}
