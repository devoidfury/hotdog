#!/usr/bin/env bun
// oa-agent — AI agent harness with tool calling support.
// CLI entry point.

import readline from "node:readline";
import { MessageBus } from "./agent/message_bus.js";
import { SessionBuilder } from "./agent/session_builder.js";
import { SessionManager } from "./agent/session_manager.js";
import { CliOutputSink } from "./ui/cli.js";
import { runReview } from "./ui/review.js";
import { runInfo } from "./ui/info.js";
import { runShowPrompt } from "./ui/show_prompt.js";
import { runInteractiveSession } from "./ui/session.js";
import { loadConfig } from "./config.js";
import { parseArgs, HELP_TEXT } from "./cli.js";
import { buildConfig } from "./init/resolution.js";
import { formatError } from "./context/error.js";
import { OUTPUT_EVENT } from "./context/output.js";

async function main() {
  const cli = parseArgs();

  // ── Subcommand dispatch ───────────────────────────────────────────────────
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
    console.log(HELP_TEXT);
    process.exit(0);
  }

  // ── Build complete config (single entry point) ────────────────────────────
  const { resolved, modelRegistry, providers } = await buildConfig(cli);
  const config = await loadConfig(cli.config);

  // ── Session builder — owns shared resources ──────────────────────────────
  const builder = new SessionBuilder(resolved, config, modelRegistry);

  // ── Output sink ───────────────────────────────────────────────────────────
  const palette = builder.palette();
  const sink = new CliOutputSink({
    stream: resolved.stream,
    thinkerFormat: resolved.thinkerFormat,
    toolFormat: resolved.toolFormat,
    toolOutputFormat: resolved.toolOutputFmt,
    palette,
    hideTools: resolved.hideTools,
    hideThinking: resolved.hideThinking,
  });

  // ── Session manager — owns builder + current agent ────────────────────────
  const sessionManager = await SessionManager.create(builder, sink);

  // ── MessageBus — owns the dispatch loop, interacts through SessionManager ──
  let promptFn;
  const bus = new MessageBus({
    sessionManager,
    sink,
    wakeUpCallback: builder.taskManager()
      ? (taskId, result) => {
          const escaped = builder.markerMangler().escapeMarkers(result);
          const agent = sessionManager.getAgent();
          if (agent) {
            agent._pendingTaskMessages.push(
              `<m_59gt7zdgkjzdeshe subagent="${taskId}">${escaped}</m_59gt7zdgkjzdeshe>`,
            );
          }
          sink.emit({
            type: OUTPUT_EVENT.TASK_COMPLETE,
            taskId,
            status: "completed",
          });
        }
      : undefined,
    onMessageProcessed: () => {
      if (promptFn) promptFn();
    },
    markerMangler: builder.markerMangler(),
  });

  // Wire up task wake-up for meta profile
  if (builder.taskManager()) {
    const agent = sessionManager.getAgent();
    if (agent) {
      builder.taskManager().managerContext = agent.context;
    }
    bus.wireTaskWakeUp();
  }

  // ── One-shot mode ─────────────────────────────────────────────────────────
  if (cli.prompt) {
    bus.enqueue(cli.prompt);
    try {
      await bus.runUntilCancelled();
      console.log("\n");
    } catch (e) {
      console.error(formatError(e));
      process.exit(1);
    }
    process.exit(0);
  }

  // ── Interactive mode ──────────────────────────────────────────────────────
  const agent = sessionManager.getAgent();
  const sessionLog = agent.sessionLog;

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

  runInteractiveSession({
    rl,
    sessionManager,
    bus,
    sink,
    resolved,
    setPromptFn: (fn) => {
      promptFn = fn;
    },
  });
  bus.run();
}

main().catch((e) => {
  console.error(formatError(e));
  process.exit(1);
});
