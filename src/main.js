#!/usr/bin/env bun
// oa-agent — AI agent harness with tool calling support.
// CLI entry point.

import readline from "node:readline";
import { join } from "node:path";
import { Agent } from "./agent/agent.js";
import { TaskManager } from "./agent/worker.js";
import { MessageBus } from "./agent/message_bus.js";
import { LlmClient } from "./llm_client/client.js";
import { CliOutputSink } from "./ui/cli.js";
import { runReview } from "./ui/review.js";
import {
  loadConfig,
  DEFAULT_EXIT_COMMANDS,
  DEFAULT_MODEL,
  DEFAULT_ROLE,
  DEFAULT_SKILLS_PATH,
  DEFAULT_PROFILES_PATH,
  DEFAULT_PROMPTS_PATH,
  loadProfileFile,
} from "./config.js";
import { outputEvent, OUTPUT_EVENT } from "./context/index.js";
import { PromptsLoader } from "./prompts/loader.js";
import { SkillsLoader } from "./skills/loader.js";
import { buildAgentConfig } from "./init/resolution.js";
import { SessionLog, disabledSessionLog } from "./session_log.js";

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    config: null,
    model: null,
    aiUrl: null,
    apiKey: null,
    profile: null,
    provider: null,
    role: null,
    skillsPath: null,
    promptsPath: null,
    chatTimeout: null,
    embeddingsTimeout: null,
    stream: true,
    hideTools: true,
    prompt: null,
    version: false,
    help: false,
    thinker: null,
    toolfmt: null,
    toolOutputFmt: null,
    noLog: false,
    loud: false,
    compactDebug: false,
    sessionId: null,
    tokens: false,
    theme: null,
    colors: null,
    preloadSkills: [],
    subcommand: null,
    reviewToolIndex: false,
    systemPromptTemplate: null,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "-f":
      case "--config":
        options.config = args[++i];
        break;
      case "-c":
      case "--prompt":
        options.prompt = args[++i];
        break;
      case "-m":
      case "--model":
        options.model = args[++i];
        break;
      case "--ai-url":
        options.aiUrl = args[++i];
        break;
      case "--url":
        console.warn("Warning: --url is deprecated, use --ai-url");
        options.aiUrl = args[++i];
        break;
      case "-k":
      case "--api-key":
        options.apiKey = args[++i];
        break;
      case "-p":
      case "--profile":
        options.profile = args[++i];
        break;
      case "--provider":
        options.provider = args[++i];
        break;
      case "--role":
        options.role = args[++i];
        break;
      case "--skills-path":
        options.skillsPath = args[++i];
        break;
      case "--prompts-path":
        options.promptsPath = args[++i];
        break;
      case "--chat-timeout":
        options.chatTimeout = parseInt(args[++i], 10);
        break;
      case "--embeddings-timeout":
        options.embeddingsTimeout = parseInt(args[++i], 10);
        break;
      case "--no-stream":
        options.stream = false;
        break;
      case "--show-tools":
        options.hideTools = false;
        break;
      case "-t":
      case "--thinker":
        options.thinker = args[++i];
        break;
      case "--toolfmt":
        options.toolfmt = args[++i];
        break;
      case "--tool-output-fmt":
        options.toolOutputFmt = args[++i];
        break;
      case "--no-log":
        options.noLog = true;
        break;
      case "-l":
      case "--loud":
        options.loud = true;
        break;
      case "--compact-debug":
        options.compactDebug = true;
        break;
      case "--session-id":
        options.sessionId = args[++i];
        break;
      case "--tokens":
        options.tokens = true;
        break;
      case "--theme":
        options.theme = args[++i];
        break;
      case "--colors":
        options.colors = true;
        break;
      case "--no-colors":
        options.colors = false;
        break;
      case "--preload-skills":
        options.preloadSkills.push(...args[++i].split(","));
        break;
      case "--system-prompt-template":
        options.systemPromptTemplate = args[++i];
        break;
      case "--info":
        options.subcommand = "info";
        break;
      case "--json":
        options.wantsJson = true;
        break;
      case "show-prompt":
        options.subcommand = "show-prompt";
        break;
      case "review":
        options.subcommand = "review";
        break;
      case "--tool-index":
        if (options.subcommand === "review") {
          options.reviewToolIndex = true;
        }
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        // TODO: warn arg unrecognized
        break;
    }
    i++;
  }

  return options;
}

async function main() {
  const cli = parseArgs();

  // Subcommand dispatch
  if (cli.subcommand === "info") {
    await runInfo(cli);
    return;
  }
  if (cli.subcommand === "show-prompt") {
    await runShowPrompt(cli);
    return;
  }
  if (cli.subcommand === "review") {
    await runReview(cli);
    return;
  }

  if (cli.version) {
    console.log("oa-agent 0.1.0");
    process.exit(0);
  }

  if (cli.help) {
    console.log(`oa-agent - AI agent harness with tool calling support

Usage: oa-agent [options] [prompt]
       oa-agent --info
       oa-agent --show-prompt
       oa-agent --review [--session-id <id>] [--json] [--tool-index]

Subcommands:
  --info                  Show system info and diagnostics
  --show-prompt           Show rendered system prompt with tool definitions
  --review                Review session logs

Options:
  -f, --config <path>       Config file path
  -c, --prompt <text>       One-shot prompt
  -m, --model <name>        Model name
      --ai-url <url>        AI URL (deprecated: --url)
  -k, --api-key <key>       API key
  -p, --profile <name>      Profile name
      --provider <name>     AI provider to use
      --role <text>         System prompt role
      --skills-path <path>  Skills directory path
      --prompts-path <path> Prompts directory path
      --chat-timeout <s>    Chat request timeout in seconds
      --embeddings-timeout <s> Embeddings request timeout in seconds
  --no-stream               Disable streaming
  --show-tools              Show tool calls
  -t, --thinker <fmt>       Thinking format string
  --toolfmt <fmt>           Tool call format string
  --tool-output-fmt <fmt>   Tool result format string
  --no-log                  Disable session logging
  -l, --loud                Print full JSON API responses
      --compact-debug       Write compaction output to compaction.out.json
      --session-id <id>     Resumable session ID
      --tokens              Display token usage stats
  --theme <name>            Theme (dark, light, monochrome, or file path)
  --colors                  Enable colors
  --no-colors               Disable colors
  --preload-skills <name>   Preload a skill by name
  --system-prompt-template <path> Custom system prompt template
  -v, --version             Show version
  -h, --help                Show help`);
    process.exit(0);
  }

  // Load config
  const config = await loadConfig(cli.config);

  // Build resolved agent config using init/resolution.js
  const resolved = buildAgentConfig({
    cli,
    config,
    providers: config.providers || [],
    defaultModel: DEFAULT_MODEL,
    defaultRole: DEFAULT_ROLE,
    profilesPath: cli.skillsPath
      ? join(cli.skillsPath, "..", "profiles")
      : config.profilesPath || DEFAULT_PROFILES_PATH,
  });

  // Load skills
  const skillsLoader = new SkillsLoader(
    cli.skillsPath || config.skillsPath || DEFAULT_SKILLS_PATH,
  );
  skillsLoader.loadSkills();
  skillsLoader.autoActivate([
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

  // Preload skills
  const preloadSkills =
    cli.preloadSkills.length > 0
      ? cli.preloadSkills
      : resolved.profile.preloadSkills || [];
  const skills =
    preloadSkills.length > 0
      ? preloadSkills
          .map((name) => {
            const skill = skillsLoader.allSkills().find((s) => s.name === name);
            if (skill) {
              skill.loaded = true;
              return skill;
            }
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

  // Create session log (or disabled no-op)
  const sessionLog = resolved.noLog
    ? disabledSessionLog()
    : new SessionLog(crypto.randomUUID());

  // Build model registry from config providers
  const modelRegistry = {};
  const providers = config.providers || [];
  for (const provider of providers) {
    const models = provider.models || [];
    for (const modelEntry of models) {
      const modelName = `${provider.name}/${modelEntry.name}`;
      modelRegistry[modelName] = {
        name: modelName,
        temperature: modelEntry.temperature,
        maxTokens: modelEntry.maxTokens || 32000,
      };
    }
  }

  // Create LLM client
  const client = new LlmClient({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    stream: resolved.stream,
    chatTimeoutSecs: resolved.chatTimeout,
    providers: config.providers || [],
  });

  // Create output sink with resolved format strings and color palette
  const palette = CliOutputSink.resolve(
    cli.colors ?? true,  // useColors — default to true if not specified
    cli.theme,           // theme name or file path
    config.colors || null, // config palette overrides
  );
  const sink = new CliOutputSink({
    stream: resolved.stream,
    thinkerFormat: resolved.thinkerFormat,
    toolFormat: resolved.toolFormat,
    toolOutputFormat: resolved.toolOutputFmt,
    palette,
  });

  // Create task manager for meta profile
  let taskManager = null;
  if (resolved.profile.manager) {
    // Worker agent tools: bash, read, write, edit, grep, find (same as Rust task-default profile)
    const workerTools = ["bash", "read", "write", "edit", "grep", "find"];

    // Load task-default profile for the system prompt
    const taskProfile = loadProfileFile(config, "task-default");
    const taskSystemPrompt = taskProfile
      ? `${taskProfile.role || "A focused worker that executes tasks autonomously"}\n\n${taskProfile.body}`
      : "You are a focused worker agent that executes delegated tasks autonomously.";

    taskManager = new TaskManager({
      llmClient: client,
      modelName: resolved.model,
      modelRegistry,
      managerContext: null, // Set after agent creation
      systemPrompt: taskSystemPrompt,
      allowedTools: workerTools,
    });
  }

  // Create agent
  const agent = new Agent({
    client,
    model: resolved.model,
    modelRegistry,
    sink,
    hideTools: resolved.hideTools,
    compactDebug: resolved.compactDebug,
    showTokenUse: resolved.showTokenUse,
    role: resolved.role,
    profileBody: resolved.profileBody,
    stream: resolved.stream,
    profileName: resolved.profileName,
    compaction: config.compaction,
    showTokenUse: cli.tokens || config.showTokenUse !== false,
    _config: config,
    skillsLoader,
    promptsLoader,
    skills,
    allSkills,
    skillDirectories,
    sessionLog,
    sessionId: cli.sessionId || crypto.randomUUID(),
    taskManager,
  });

  // ── MessageBus — owns the agent run loop ──────────────────────────────────
  // The bus decouples the CLI session from the agent. The CLI enqueues text;
  // the bus drains sequentially: dequeue → agent.run() → emit events → repeat.
  const bus = new MessageBus({
    agent,
    sink,
    wakeUpCallback: taskManager
      ? (taskId, result) => {
          const escaped = result.replace(/<m_/g, "&lt;m_");
          const message = `<task-result subagent="${taskId}">${escaped}</task-result>`;
          agent._pendingTaskMessages.push(message);
          sink.emit(
            outputEvent(OUTPUT_EVENT.TASK_PROGRESS, {
              taskId,
              status: "completed",
            }),
          );
        }
      : undefined,
  });

  if (taskManager) {
    taskManager.managerContext = agent.context;
    bus.wireTaskWakeUp();
  }

  // ── One-shot mode ─────────────────────────────────────────────────────────
  if (cli.prompt) {
    bus.enqueue(cli.prompt);
    try {
      await bus.runUntilCancelled();
      console.log("\n");
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // ── Interactive mode ──────────────────────────────────────────────────────
  console.log("oa-agent 0.1.0 (interactive mode)");
  console.log(`Model: ${resolved.model}`);
  console.log(`Profile: ${resolved.profileName}`);
  console.log(`Session: ${sessionLog.sessionId}`);
  console.log("Type /quit or /exit to exit.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `(${resolved.model})> `,
  });

  rl.prompt();

  process.on("SIGINT", () => {
    console.log("\nInterrupted. Cancelling...");
    bus.cancel();
    console.log("Cancelled.");
    rl.prompt();
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();

    if (trimmed.startsWith("/")) {
      const cmd = trimmed.slice(1).trim().toLowerCase();
      if (
        DEFAULT_EXIT_COMMANDS.includes(cmd) ||
        cmd === "quit" ||
        cmd === "exit"
      ) {
        console.log("Goodbye!");
        rl.close();
        process.exit(0);
      }
      if (cmd === "help") {
        console.log("Commands:");
        console.log("  /quit, /exit  - Exit");
        console.log("  /help         - Show help");
        console.log("  /clear        - Clear context");
        console.log("  /model <name> - Switch model");
        console.log("  /models       - List available models");
        console.log("  /tokens       - Show token usage");
        console.log("  /tools        - Toggle tool call display");
        console.log("  /compact [n] [--compact-debug]  - Compact context");
        console.log("  /cancel       - Cancel current run");
        console.log("  /prompt:name [args] - Execute saved prompt");
        console.log("  /skill        - List skills");
        console.log("  /skill:name   - Activate skill");
        console.log("  /thinking     - Toggle thinking display");
        console.log("  /theme <name> - Set theme (dark, light, monochrome)");
        console.log("  /regenerate   - Regenerate system prompt");
        console.log("");
        rl.prompt();
        return;
      }
      if (cmd === "clear") {
        agent.context.clear();
        agent.context.systemMessages = [];
        agent.sessionLog = disabledSessionLog();
        agent.sessionId = crypto.randomUUID();
        console.log("Context cleared.\n");
        rl.prompt();
        return;
      }
      if (cmd.startsWith("clear ")) {
        const profileName = cmd.slice(6).trim();
        if (profileName) {
          if (resolved.profiles && resolved.profiles[profileName]) {
            const sp = resolved.profiles[profileName];
            agent.context.clear();
            agent.context.systemMessages = [];
            agent.sessionId = crypto.randomUUID();
            agent.sessionLog = new SessionLog(agent.sessionId);
            agent.role = sp.role || agent.role;
            agent.profileName = profileName;
            console.log(
              `Cleared context and switched to profile: ${profileName}\n`,
            );
          } else {
            console.log(`Profile '${profileName}' not found.\n`);
          }
        } else {
          agent.context.clear();
          agent.context.systemMessages = [];
          agent.sessionId = crypto.randomUUID();
          agent.sessionLog = new SessionLog(agent.sessionId);
          console.log("Context cleared.\n");
        }
        rl.prompt();
        return;
      }
      if (cmd.startsWith("model ")) {
        const modelName = cmd.slice(6).trim();
        if (!modelName) {
          console.log(
            `Available models: ${Object.keys(agent.modelRegistry).join(", ")}\n`,
          );
        } else {
          agent.model = modelName;
          agent.context.clear();
          agent.context.systemMessages = [];
          console.log(`Switched to model: ${modelName}\n`);
        }
        rl.prompt();
        return;
      }
      if (cmd === "model") {
        console.log(
          `Available models: ${Object.keys(agent.modelRegistry).join(", ")}\n`,
        );
        rl.prompt();
        return;
      }
      if (cmd === "models") {
        const models = Object.keys(agent.modelRegistry);
        if (models.length === 0) {
          console.log(
            "No models configured. Add providers to your config file.\n",
          );
        } else {
          console.log("Available models:");
          for (const name of models) {
            const m = agent.modelRegistry[name];
            const tags = m.tags ? ` [${m.tags.join(", ")}]` : "";
            console.log(`  ${name}${tags}`);
          }
          console.log(`\nCurrently using: ${agent.model}\n`);
        }
        rl.prompt();
        return;
      }
      if (cmd === "thinking") {
        agent.hideThinking = !agent.hideThinking;
        console.log(
          `Thinking display: ${agent.hideThinking ? "hidden" : "shown"}\n`,
        );
        rl.prompt();
        return;
      }
      if (cmd.startsWith("theme ")) {
        const themeName = cmd.slice(6).trim().toLowerCase();
        const themeNames = ["dark", "light", "monochrome"];
        if (!themeNames.includes(themeName)) {
          console.log(
            `Unknown theme '${themeName}'. Available: ${themeNames.join(", ")}\n`,
          );
        } else {
          const newPalette = CliOutputSink.resolve(true, themeName, null);
          sink.setPalette(newPalette);
          console.log(`Theme set to: ${themeName}\n`);
        }
        rl.prompt();
        return;
      }
      if (cmd === "tokens") {
        console.log(agent.tokenStatsDisplay() + "\n");
        rl.prompt();
        return;
      }
      if (cmd === "tools") {
        agent.hideTools = !agent.hideTools;
        sink.hideTools = agent.hideTools;
        console.log(`Tool display: ${agent.hideTools ? "hidden" : "shown"}\n`);
        rl.prompt();
        return;
      }
      if (cmd.startsWith("prompt:")) {
        const rest = cmd.slice(7);
        const spaceIdx = rest.indexOf(" ");
        const promptName =
          spaceIdx >= 0 ? rest.slice(0, spaceIdx).trim() : rest.trim();
        const promptArgs = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : "";
        const result = agent.executePrompt(promptName, promptArgs);
        if (result.success) {
          console.log(`Prompt '${promptName}' executed.\n`);
        } else {
          console.log(`Error: ${result.error}\n`);
        }
        rl.prompt();
        return;
      }
      if (cmd === "regenerate") {
        agent.regenerateSystemPrompt();
        console.log("System prompt regenerated.\n");
        rl.prompt();
        return;
      }
      if (cmd.startsWith("skill:")) {
        const skillName = cmd.slice(6).trim();
        if (!skillName) {
          const allSkills = agent.allSkills();
          if (allSkills.length === 0) {
            console.log("No skills loaded.\n");
          } else {
            console.log("Available skills:");
            for (const s of allSkills) {
              const status = s.loaded
                ? "[loaded]"
                : s.visible
                  ? "[visible]"
                  : "[hidden]";
              console.log(`  ${status} ${s.name}: ${s.description}`);
            }
            console.log("\nUse /skill:<name> to activate a skill.\n");
          }
        } else {
          const result = agent.activateSkill(skillName);
          if (result.success) {
            console.log(
              `Skill '${skillName}' activated. System prompt updated.\n`,
            );
          } else {
            console.log(`Error: ${result.error}\n`);
          }
        }
        rl.prompt();
        return;
      }
      if (cmd.startsWith("compact")) {
        const parts = cmd.split(/\s+/);
        const keep = parts[1] ? parseInt(parts[1], 10) : null;
        const debugFlag = parts.includes("--compact-debug");
        (async () => {
          try {
            const summary = await agent.compactMessages(keep);
            if (summary) {
              console.log(`Compacted. Summary: ${summary.slice(0, 200)}...\n`);
            } else {
              console.log("Not enough messages to compact.\n");
            }
            if (debugFlag) agent.writeCompactionDebugFile();
          } catch (e) {
            console.log(`Compaction failed: ${e.message}\n`);
          }
          rl.prompt();
        })();
        return;
      }
      if (cmd === "cancel") {
        bus.cancel();
        console.log("Cancelled.\n");
        rl.prompt();
        return;
      }
      console.log(`Unknown command: ${cmd}`);
      rl.prompt();
      return;
    }

    if (!trimmed) {
      rl.prompt();
      return;
    }

    bus.enqueue(trimmed);
  });

  rl.on("close", () => {
    console.log("\nGoodbye!");
    process.exit(0);
  });

  bus.run();
}

main().catch((e) => {
  console.error(`Fatal error: ${e.message}`);
  process.exit(1);
});

// ── Subcommand: info ─────────────────────────────────────────────────────────

async function runInfo(cli) {
  const config = await loadConfig(cli.config);

  const resolved = buildAgentConfig({
    cli,
    config,
    providers: config.providers || [],
    defaultModel: DEFAULT_MODEL,
    defaultRole: DEFAULT_ROLE,
    profilesPath: cli.skillsPath
      ? join(cli.skillsPath, "..", "profiles")
      : config.profilesPath || DEFAULT_PROFILES_PATH,
  });

  // Build model registry
  const modelRegistry = {};
  const providers = config.providers || [];
  for (const provider of providers) {
    const models = provider.models || [];
    for (const modelEntry of models) {
      const modelName = `${provider.name}/${modelEntry.name}`;
      modelRegistry[modelName] = {
        name: modelName,
        tags: modelEntry.tags || [],
        temperature: modelEntry.temperature,
        maxTokens: modelEntry.maxTokens || 32000,
      };
    }
  }

  // Check connectivity
  const client = new LlmClient({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    stream: false,
    chatTimeoutSecs: resolved.chatTimeout,
    providers: config.providers || [],
  });

  let connectivity;
  try {
    // Try a simple fetch to check connectivity
    client.ping ? await client.ping() : null;
    connectivity = { reachable: true, error: null };
  } catch (e) {
    connectivity = { reachable: false, error: e.message };
  }

  // Load skills
  const skillsLoader = new SkillsLoader(
    cli.skillsPath || config.skillsPath || DEFAULT_SKILLS_PATH,
  );
  skillsLoader.loadSkills();
  const allSkills = skillsLoader.allSkills();
  const skillCount = allSkills.filter((s) => s.loaded).length;

  if (cli.wantsJson) {
    printInfoJson(
      resolved,
      modelRegistry,
      providers,
      allSkills,
      skillCount,
      connectivity,
      config,
    );
  } else {
    printInfoText(
      resolved,
      modelRegistry,
      providers,
      allSkills,
      skillCount,
      connectivity,
      config,
    );
  }
}

function printInfoText(
  resolved,
  modelRegistry,
  providers,
  allSkills,
  skillCount,
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
  console.log(`Skills: ${skillCount} loaded`);
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
  allSkills,
  skillCount,
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
    skills_loaded: skillCount,
    connectivity: {
      url: resolved.baseUrl,
      reachable: connectivity.reachable,
      error: connectivity.error || null,
    },
  };
  console.log(JSON.stringify(json, null, 2));
}

// ── Subcommand: show-prompt ──────────────────────────────────────────────────

async function runShowPrompt(cli) {
  const config = await loadConfig(cli.config);

  const resolved = buildAgentConfig({
    cli,
    config,
    providers: config.providers || [],
    defaultModel: DEFAULT_MODEL,
    defaultRole: DEFAULT_ROLE,
    profilesPath: cli.skillsPath
      ? join(cli.skillsPath, "..", "profiles")
      : config.profilesPath || DEFAULT_PROFILES_PATH,
  });

  // Load skills
  const skillsLoader = new SkillsLoader(
    cli.skillsPath || config.skillsPath || DEFAULT_SKILLS_PATH,
  );
  skillsLoader.loadSkills();
  skillsLoader.autoActivate([
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
            if (skill) {
              skill.loaded = true;
              return skill;
            }
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

  // Build model registry
  const modelRegistry = {};
  const providers = config.providers || [];
  for (const provider of providers) {
    const models = provider.models || [];
    for (const modelEntry of models) {
      const modelName = `${provider.name}/${modelEntry.name}`;
      modelRegistry[modelName] = {
        name: modelName,
        temperature: modelEntry.temperature,
        maxTokens: modelEntry.maxTokens || 32000,
      };
    }
  }

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
