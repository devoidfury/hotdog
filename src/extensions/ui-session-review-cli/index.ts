// Session Review Extension
// Provides the `sessions` CLI subcommand for managing session logs.
// Registers subcommands via the cli:subcommandsRegister hook.
// Also registers the `review` tool via tools:register hook.

import { HOOKS } from "../../core/hooks.ts";
import { CliOutputSink } from "../../utils/cli/cli.ts";
import { ColorPalette, type PaletteOptions } from "../../utils/cli/colors.ts";
import { readSessionEntries, sessionsDir as getSessionsDir } from "../session-log/index.ts";
import { readdir, access, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ReviewTool } from "./review.ts";
import { CoreContext, ExtensionInstance, ToolsRegisterPayload } from "../../core/extensions/types.ts";
import readline from "node:readline";

// ── Types ──────────────────────────────────────────────────────────────────

interface CliArgs {
  theme?: string;
  colors?: boolean;
  sessionId?: string;
  wantsJson?: boolean;
  toolIndex?: boolean;
  olderThan?: number;
  yes?: boolean;
  args?: string[];
  [key: string]: unknown;
}

interface SessionInfo {
  id: string;
  last_modified: string;
  entry_count: number;
  mtime: number;
}

interface LogEntry {
  ts?: string;
  source?: string;
  role?: string;
  content?: string;
  result?: string;
  tool_name?: string;
  [key: string]: unknown;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Prompt user for confirmation. Resolves true if yes, false otherwise.
 */
function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      // Non-interactive: default to no
      resolve(false);
      return;
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${prompt} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

// ── Sessions Subcommand ────────────────────────────────────────────────────

/**
 * Run the sessions subcommand dispatcher.
 * Routes to show, delete, or cleanup based on the first positional arg.
 */
async function runSessions(
  cli: CliArgs,
  config: Record<string, unknown>,
): Promise<number> {
  const action = (cli.args as string[] | undefined)?.[0] || "show";

  switch (action) {
    case "show":
      return await runShow(cli, config);
    case "delete":
      return await runDelete(cli, config);
    case "cleanup":
      return await runCleanup(cli, config);
    default:
      console.error(`Unknown sessions action: ${action}`);
      console.error(`Available actions: show, delete, cleanup`);
      return 1;
  }
}

/**
 * `sessions show` — display session entries (replaces old `review` subcommand).
 */
async function runShow(
  cli: CliArgs,
  config: Record<string, unknown>,
): Promise<number> {
  const sessionsDir = getSessionsDir();

  const palette = await CliOutputSink.resolve(
    cli.colors ?? true,
    cli.theme,
    (config.colors as PaletteOptions) || null,
  );

  const sessionId = cli.sessionId;
  if (sessionId) {
    return await reviewSession(
      sessionId,
      cli.wantsJson ?? false,
      cli.toolIndex ?? false,
      palette,
    );
  }
  if (cli.toolIndex) {
    const files = (await readdir(sessionsDir)).filter((f: string) =>
      f.endsWith(".jsonl"),
    );
    if (files.length === 0) {
      console.log("No sessions found.");
      return 1;
    }
    const fileInfos = await Promise.all(
      files.map(async (f: string) => ({
        name: f.replace(/\.jsonl$/, ""),
        path: join(sessionsDir, f),
        mtime: (await stat(join(sessionsDir, f))).mtime.getTime(),
      })),
    );
    fileInfos.sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
    const mostRecent = fileInfos[0] as { name: string };
    const entries = await readSessionEntries(mostRecent.name);
    return printToolIndex(entries as LogEntry[], cli.wantsJson ?? false);
  }
  return listSessions(cli.wantsJson ?? false, sessionsDir, palette);
}

/**
 * `sessions delete <id>` — delete a specific session.
 */
async function runDelete(
  cli: CliArgs,
  _config: Record<string, unknown>,
): Promise<number> {
  const sessionId = (cli.args as string[] | undefined)?.[1];

  if (!sessionId) {
    console.error("Usage: hotdog sessions delete <session-id>");
    return 1;
  }

  const filePath = join(getSessionsDir(), `${sessionId}.jsonl`);

  try {
    await access(filePath);
  } catch {
    console.error(`Session '${sessionId}' not found.`);
    return 1;
  }

  if (!cli.yes) {
    const ok = await confirm(`Delete session '${sessionId}'?`);
    if (!ok) {
      console.log("Aborted.");
      return 0;
    }
  }

  await unlink(filePath);
  console.log(`Deleted session '${sessionId}'.`);
  return 0;
}

/**
 * `sessions cleanup [--older-than <days>]` — remove sessions older than N days.
 */
async function runCleanup(
  cli: CliArgs,
  _config: Record<string, unknown>,
): Promise<number> {
  const olderThanDays = cli.olderThan ?? 30;
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const sessionsDir = getSessionsDir();

  try {
    await access(sessionsDir);
  } catch {
    console.log("No sessions directory found. Nothing to clean up.");
    return 0;
  }

  const files = (await readdir(sessionsDir)).filter((f: string) =>
    f.endsWith(".jsonl"),
  );

  const toDelete: Array<{ id: string; last_modified: string }> = [];

  for (const file of files) {
    const filePath = join(sessionsDir, file);
    const metadata = await stat(filePath);
    if (metadata.mtime.getTime() < cutoffMs) {
      toDelete.push({
        id: file.replace(/\.jsonl$/, ""),
        last_modified: new Date(metadata.mtime).toISOString(),
      });
    }
  }

  if (toDelete.length === 0) {
    console.log(`No sessions older than ${olderThanDays} days.`);
    return 0;
  }

  if (!cli.yes) {
    console.log(`Found ${toDelete.length} session(s) older than ${olderThanDays} days:`);
    for (const s of toDelete) {
      console.log(`  ${s.id}  (${s.last_modified})`);
    }
    const ok = await confirm("Delete these sessions?");
    if (!ok) {
      console.log("Aborted.");
      return 0;
    }
  }

  let deleted = 0;
  for (const s of toDelete) {
    try {
      await unlink(join(sessionsDir, `${s.id}.jsonl`));
      deleted++;
    } catch {
      // Skip files that can't be deleted
    }
  }

  console.log(`Deleted ${deleted} session(s).`);
  return 0;
}

// ── Shared Functions ───────────────────────────────────────────────────────

async function listSessions(
  json: boolean,
  dir: string,
  palette: ColorPalette,
): Promise<number> {
  try {
    await access(dir);
  } catch {
    if (json) console.log("[]");
    else console.log("No log entries found.");
    return 1;
  }

  const files = (await readdir(dir)).filter((f: string) => f.endsWith(".jsonl"));
  if (files.length === 0) {
    if (json) console.log("[]");
    else console.log("No log entries found.");
    return 1;
  }

  const sessions: SessionInfo[] = [];
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

async function reviewSession(
  sessionId: string,
  json: boolean,
  toolIndex: boolean,
  palette: ColorPalette,
): Promise<number> {
  const entries = await readSessionEntries(sessionId);
  if (entries.length === 0) {
    if (json) console.log("{}");
    else console.log(`Session '${sessionId}' not found or empty.`);
    return 1;
  }

  if (toolIndex) {
    return printToolIndex(entries as LogEntry[], json);
  }

  if (json) {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  console.log(`=== Session: ${sessionId} ===`);
  console.log(`Entries: ${(entries as unknown[]).length}\n`);

  for (const entry of entries as LogEntry[]) {
    const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : "unknown";
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

function printToolIndex(entries: LogEntry[], json: boolean): number {
  const toolUsage = new Map<string, number>();

  for (const entry of entries) {
    if (entry.source === "tool_result" && entry.tool_name) {
      const count = toolUsage.get(entry.tool_name) || 0;
      toolUsage.set(entry.tool_name, count + 1);
    }
  }

  if (json) {
    const result: Record<string, number> = {};
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

// ── Extension Entry Point ──────────────────────────────────────────────────

/**
 * Create the session-review extension.
 * Registers CLI subcommands and the review tool.
 */
export function create(core: CoreContext): ExtensionInstance {
  return {
    hooks: core.hooks
      ? {
          // Register CLI subcommand via hook
          [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (
            registry: { register: (name: string, opts: Record<string, unknown>) => void },
          ) => {
            registry.register("sessions", {
              description: "Manage session logs (show, delete, cleanup)",
              handler: async (cli: CliArgs, core: CoreContext) => {
                const { config } = core;
                return await runSessions(cli, config as Record<string, unknown>);
              },
            });
          },

          // Register the review tool
          [HOOKS.TOOLS_REGISTER]: async (registry: ToolsRegisterPayload) => {
            const tool = new ReviewTool();
            registry.register("review", tool);
          },
        }
      : undefined,
  };
}
