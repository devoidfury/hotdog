// Session Review Extension
// Provides the `review` CLI subcommand for inspecting session logs.
// Registers subcommands via the cli:subcommandsRegister hook.
// Also registers the `review` tool via tools:register hook.

import { HOOKS } from "../../core/hooks.js";
import { CliOutputSink } from "../../core/ui/cli.js";
import { readSessionEntries } from "../session-log/index.js";
import { readdir, access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ReviewTool } from "./review.js";

/**
 * Create the session-review extension.
 * Registers CLI subcommands and the review tool.
 */
export function create(core) {
  return {
    hooks: core.hooks
      ? {
          // Register CLI subcommand via hook
          [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry) => {
            registry.register("review", {
              description: "Review session logs",
              handler: async (cli, core) => {
                const { config } = core;
                return await runReview(cli, config);
              },
            });
          },

          // Register the review tool
          [HOOKS.TOOLS_REGISTER]: async (registry) => {
            const tool = new ReviewTool();
            registry.register("review", tool);
          },
        }
      : undefined,
  };
}

// ── Review Subcommand ────────────────────────────────────────────────────────

/**
 * Run the review subcommand.
 */
async function runReview(cli, config) {
  const sessionsDirPath = join(homedir(), ".cache", "hotdog", "sessions");

  const palette = await CliOutputSink.resolve(
    cli.theme,
    config.colors || null,
    cli.colors,
  );

  const sessionId = cli.sessionId;
  if (sessionId) {
    return await reviewSession(
      sessionId,
      cli.wantsJson,
      cli.toolIndex,
      palette,
    );
  }
  if (cli.toolIndex) {
    const files = (await readdir(sessionsDirPath)).filter((f) =>
      f.endsWith(".jsonl"),
    );
    if (files.length === 0) {
      console.log("No sessions found.");
      return 1;
    }
    const fileInfos = await Promise.all(
      files.map(async (f) => ({
        name: f.replace(/\.jsonl$/, ""),
        path: join(sessionsDirPath, f),
        mtime: (await stat(join(sessionsDirPath, f))).mtime.getTime(),
      })),
    );
    fileInfos.sort((a, b) => b.mtime - a.mtime);
    const mostRecent = fileInfos[0];
    const entries = await readSessionEntries(mostRecent.name);
    return printToolIndex(entries, cli.wantsJson);
  }
  return listSessions(cli.wantsJson, sessionsDirPath, palette);
}

async function listSessions(json, sessionsDirPath, palette) {
  const dir = sessionsDirPath;
  try {
    await access(dir);
  } catch {
    if (json) console.log("[]");
    else console.log("No log entries found.");
    return 1;
  }

  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) {
    if (json) console.log("[]");
    else console.log("No log entries found.");
    return 1;
  }

  const sessions = [];
  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, "");
    const filePath = join(dir, file);
    const metadata = await stat(filePath);
    const entries = await readSessionEntries(sessionId);

    if (entries.length <= 1) continue;

    const lastTs = new Date(metadata.mtime).toISOString();
    sessions.push({
      id: sessionId,
      last_modified: lastTs,
      entry_count: entries.length,
      mtime: metadata.mtime.getTime(),
    });
  }

  if (sessions.length === 0) {
    if (json) console.log("[]");
    else console.log("No log entries found.");
    return 1;
  }

  sessions.sort((a, b) => b.mtime - a.mtime);

  if (json) {
    console.log(JSON.stringify(sessions, null, 2));
    return 0;
  }

  console.log("=== Sessions ===");
  for (const s of sessions) {
    console.log(`  ${s.id}  (${s.entry_count} entries, ${s.last_modified})`);
  }
  return 0;
}

async function reviewSession(sessionId, json, toolIndex, palette) {
  const entries = await readSessionEntries(sessionId);
  if (entries.length === 0) {
    if (json) console.log("{}");
    else console.log(`Session '${sessionId}' not found or empty.`);
    return 1;
  }

  if (toolIndex) {
    return printToolIndex(entries, json);
  }

  if (json) {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  console.log(`=== Session: ${sessionId} ===`);
  console.log(`Entries: ${entries.length}\n`);

  for (const entry of entries) {
    const ts = new Date(entry.ts).toLocaleTimeString();
    const role = entry.role || entry.source;
    const content = entry.content || entry.result || "";

    let max = 200;
    if (entry.source === "system_prompt") {
      console.log(`[${ts}] [SYSTEM]`);
      max = 500;
    } else if (entry.source === "input") {
      console.log(`[${ts}] [USER]`);
    } else if (entry.source === "tool_result") {
      console.log(`[${ts}] [TOOL: ${entry.tool_name}]`);
    } else if (entry.source === "llm") {
      console.log(`[${ts}] [ASSISTANT]`);
    } else {
      console.log(`[${ts}] [${role}]`);
    }
    console.log(
      content.substring(0, max) + (content.length > max ? "..." : ""),
    );
  }
  return 0;
}

function printToolIndex(entries, json) {
  const toolUsage = new Map();

  for (const entry of entries) {
    if (entry.source === "tool_result" && entry.tool_name) {
      const count = toolUsage.get(entry.tool_name) || 0;
      toolUsage.set(entry.tool_name, count + 1);
    }
  }

  if (json) {
    const result = {};
    for (const [name, count] of toolUsage) {
      result[name] = count;
    }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.log("=== Tool Usage ===");
  if (toolUsage.size === 0) {
    console.log("  No tools used.");
  } else {
    const sorted = Array.from(toolUsage.entries()).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      console.log(`  ${name}: ${count}x`);
    }
  }
  return 0;
}
