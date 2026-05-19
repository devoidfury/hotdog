// Interactive CLI session — readline loop, slash command dispatch, SIGINT handling.
// Extracted from main.js to mirror Rust's ui/cli/session.rs.

import readline from "node:readline";
import { spawn } from "node:child_process";
import { parseCommand, isUiCommand, Command } from "../agent/commands.js";
import { Agent } from "../agent/agent.js";
import { lspClientCache } from "../lsp/client-cache.js";

const HELP_TEXT = `
Commands:
  /quit, /exit  - Exit
  /help         - Show help
  /clear        - Clear context
  /model <name> - Switch model
  /models       - List available models
  /tokens       - Show token usage
  /tools        - Toggle tool call display
  /compact [n] [--compact-debug]  - Compact context
  /compact:strategy [name]        - Manage compaction strategies
  /cancel       - Cancel current run
  /prompt:name [args] - Execute saved prompt
  /skill        - List skills
  /skill:<name> - Activate skill
  /thinking     - Toggle thinking display
  /theme <name> - Set theme (dark, light, monochrome)
  /regenerate   - Regenerate system prompt
  /sh <command> - Run a shell command and display output
  :!<command>  - Vim-like alias for shell commands (e.g., :!ls)
`;

/**
 * Create and run an interactive CLI session.
 * @param {object} options
 * @param {readline.Interface} rl - readline interface
 * @param {import("../agent/session_manager.js").SessionManager} sessionManager - Session manager
 * @param {import("../agent/message_bus.js").MessageBus} bus - The MessageBus instance
 * @param {import("../context/output.js").OutputSink} sink - The CliOutputSink instance
 * @param {object} resolved - resolved agent config (from buildConfig().resolved)
 * @param {Function} [setPromptFn] - Optional callback to set the prompt function for onMessageProcessed
 */
export function runInteractiveSession({ rl, sessionManager, bus, sink, resolved, setPromptFn }) {
  // Set the prompt function so the bus can call it after each message
  if (setPromptFn) {
    setPromptFn(() => rl.prompt());
  }

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
      handleSlashCommand(cmd, sessionManager, bus, sink, resolved, rl);
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
    // Quick cleanup: force-kill all LSP clients synchronously
    for (const [, client] of lspClientCache) {
      if (client.process && client.process.kill) {
        try { client.process.kill("SIGKILL"); } catch {}
      }
    }
    lspClientCache.clear();
    process.exit(0);
  });
}

function handleSlashCommand(cmd, sessionManager, bus, sink, resolved, rl) {
  const parsed = parseCommand(cmd);

  // Handle UI-level commands
  if (isUiCommand(parsed.type)) {
    dispatchUiCommand(parsed, sessionManager, sink, rl);
    return;
  }

  // Handle agent-level commands
  dispatchAgentCommand(parsed, sessionManager, sink, bus, resolved, rl);
}

function dispatchUiCommand(cmd, sessionManager, sink, rl) {
  const agent = sessionManager.getAgent();
  switch (cmd.type) {
    case Command.Help:
      console.log(HELP_TEXT);
      rl.prompt();
      break;

    case Command.Quit:
      console.log("Goodbye!");
      rl.close();
      process.exit(0);
      break;

    case Command.Tools:
      agent.hideTools = !agent.hideTools;
      sink.hideTools = agent.hideTools;
      console.log(`Tool display: ${agent.hideTools ? "hidden" : "shown"}\n`);
      rl.prompt();
      break;

    case Command.Thinking:
      agent.hideThinking = !agent.hideThinking;
      sink.hideThinking = agent.hideThinking;
      console.log(`Thinking display: ${agent.hideThinking ? "hidden" : "shown"}\n`);
      rl.prompt();
      break;

    case Command.Shell:
      if (!cmd.value) {
        console.log("Usage: /sh <command>\n");
      } else {
        console.log(`\n$ ${cmd.value}\n`);
        const proc = spawn(cmd.value, [], {
          shell: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        proc.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        proc.on("close", (code) => {
          const output = [stdout, stderr].filter(Boolean).join("\n");
          console.log(output);
          if (output) console.log("\n");
          console.log(`[exited with code ${code}]\n`);
          rl.prompt();
        });
        proc.on("error", (err) => {
          console.log(`Error: ${err.message}\n`);
          rl.prompt();
        });
      }
      break;

    default:
      console.log(`Unknown command: ${cmd.value}\n`);
      rl.prompt();
  }
}

function dispatchAgentCommand(cmd, sessionManager, sink, bus, resolved, rl) {
  const agent = sessionManager.getAgent();

  switch (cmd.type) {
    case "clear":
      if (cmd.value) {
        // clear <profile> — profile switching via session manager
        if (resolved.profiles && resolved.profiles[cmd.value]) {
          const profile = resolved.profiles[cmd.value];
          (async () => {
            try {
              const newAgent = await sessionManager.swapAgent(async (builder) => {
                const agent = await builder.buildAgent(sink);
                agent.role = profile.role || agent.role;
                agent.profileBody = profile.body || "";
                agent.profileName = cmd.value;
                return agent;
              });
              console.log(`Cleared context and switched to profile: ${cmd.value}\n`);
            } catch (e) {
              console.log(`Profile switch failed: ${e.message}\n`);
            }
            rl.prompt();
          })();
        } else {
          console.log(`Profile '${cmd.value}' not found.\n`);
        }
      } else {
        agent.context.clear();
        agent.context.systemMessages = [];
        agent.sessionLog.writeReset();
        console.log("Context cleared.\n");
      }
      rl.prompt();
      break;

    case "model":
      if (cmd.value) {
        agent.model = cmd.value;
        agent.context.clear();
        agent.context.systemMessages = [];
        console.log(`Switched to model: ${cmd.value}\n`);
      } else {
        console.log(`Available models: ${Object.keys(agent.modelRegistry).join(", ")}\n`);
      }
      rl.prompt();
      break;

    case "models": {
      const models = Object.keys(agent.modelRegistry);
      if (models.length === 0) {
        console.log("No models configured. Add providers to your config file.\n");
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
      break;
    }

    case "tokens":
      console.log(agent.tokenStatsDisplay() + "\n");
      rl.prompt();
      break;

    case "compact":
      if (cmd.value) {
        (async () => {
          try {
            const summary = await agent.compactMessages(cmd.value.keep);
            if (summary) {
              console.log(`Compacted. Summary: ${summary.slice(0, 200)}...\n`);
            } else {
              console.log("Not enough messages to compact.\n");
            }
            if (cmd.value.debug) agent.writeCompactionDebugFile();
          } catch (e) {
            console.log(`Compaction failed: ${e.message}\n`);
          }
          rl.prompt();
        })();
      } else {
        console.log("Usage: /compact [n] [--compact-debug]\n");
        rl.prompt();
      }
      break;

    case "compactStrategy": {
      const registry = agent.compactionStrategyRegistry;
      const { action, name } = cmd.value;

      switch (action) {
        case "list": {
          const strategies = registry.getAll();
          const current = agent.compactionStrategy || 'summarize';
          console.log("\nCompaction Strategies:\n");
          for (const s of strategies) {
            const marker = s.name === current ? ' (current)' : '';
            console.log(`  ${s.name}${marker} — ${s.description}`);
          }
          console.log(`\nCurrent strategy: ${current}\n`);
          break;
        }
        case "set": {
          if (!name) {
            console.log('Usage: /compact:strategy <name>\n');
            break;
          }
          if (!registry.has(name)) {
            const available = registry.getAll().map(s => s.name).join(', ');
            console.log(`Unknown strategy '${name}'. Available: ${available}\n`);
            break;
          }
          agent.compactionStrategy = name;
          console.log(`Compaction strategy set to: ${name}\n`);
          break;
        }
        case "help": {
          if (!name) {
            // Show help for all strategies
            const strategies = registry.getAll();
            console.log('\nCompaction Strategies:\n');
            for (const s of strategies) {
              console.log(`  ${s.name} — ${s.description}`);
            }
            console.log('\nUsage:');
            console.log('  /compact:strategy              — List strategies');
            console.log('  /compact:strategy <name>       — Set strategy');
            console.log('  /compact:strategy help         — Show help');
            console.log('  /compact:strategy help <name>  — Show strategy details\n');
          } else if (registry.has(name)) {
            const strategy = registry.get(name);
            console.log(`\nStrategy: ${strategy.name}\n`);
            console.log(`Description: ${strategy.description}\n`);
          } else {
            console.log(`Unknown strategy '${name}'.\n`);
          }
          break;
        }
        default:
          console.log(`Unknown action: ${action}\n`);
      }
      rl.prompt();
      break;
    }

    case "prompt":
      if (cmd.value) {
        (async () => {
          try {
            await bus.executePromptAndEnqueue(cmd.value);
            console.log(`Prompt '${cmd.value.name}' executed.\n`);
          } catch (e) {
            console.log(`Error: ${e.message}\n`);
          }
        })();
      } else {
        console.log("Usage: /prompt:<name> [args]\n");
        rl.prompt();
      }
      break;

    case "regenerate":
      agent.regenerateSystemPrompt();
      console.log("System prompt regenerated.\n");
      rl.prompt();
      break;

    case "skill":
      if (!cmd.value) {
        // List skills
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
        const result = agent.activateSkill(cmd.value);
        if (result.success) {
          console.log(`Skill '${cmd.value}' activated. System prompt updated.\n`);
        } else {
          console.log(`Error: ${result.error}\n`);
        }
      }
      rl.prompt();
      break;

    case "cancel":
      bus.cancel();
      console.log("Cancelled.\n");
      rl.prompt();
      break;

    case "unknown":
      console.log(`Unknown command: ${cmd.value}\n`);
      rl.prompt();
      break;

    default:
      console.log(`Unknown command: ${cmd.value}\n`);
      rl.prompt();
  }
}
