// Session Review Extension
// Provides the `review` CLI subcommand for inspecting session logs.
// Registers subcommands via the cli:subcommandsRegister hook.
// Also registers the `review` tool via tools:register hook.

import { HOOKS } from "../../core/hooks.ts";
import { CliOutputSink, PaletteOptions } from "../../utils/cli/cli.ts";
import { ColorPalette } from "../../utils/cli/colors.ts";
import { readSessionEntries } from "../session-log/index.ts";
import { readdir, access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ReviewTool } from "./review.ts";
import { CoreContext, ExtensionInstance, ToolsRegisterPayload } from "../../core/extensions/types.ts";

// ── Types ──────────────────────────────────────────────────────────────────

interface CliArgs {
  theme?: string;
  colors?: boolean;
  sessionId?: string;
  wantsJson?: boolean;
  toolIndex?: boolean;
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

// ── Review Subcommand ──────────────────────────────────────────────────────

/**
 * Run the review subcommand.
 */
async function runReview(
  cli: CliArgs,
  config: Record<string, unknown>,
): Promise<number> {
  const sessionsDirPath = join(homedir(), ".cache", "hotdog", "sessions");

  const palette = await CliOutputSink.resolve(
    cli.colors,
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
    const files = (await readdir(sessionsDirPath)).filter((f: string) =>
      f.endsWith(".jsonl"),
    );
    if (files.length === 0) {
      console.log("No sessions found.");
      return 1;
    }
    const fileInfos = await Promise.all(
      files.map(async (f: string) => ({
        name: f.replace(/\.jsonl$/, ""),
        path: join(sessionsDirPath, f),
        mtime: (await stat(join(sessionsDirPath, f))).mtime.getTime(),
      })),
    );
    fileInfos.sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
    const mostRecent = fileInfos[0] as { name: string };
    const entries = await readSessionEntries(mostRecent.name);
    return printToolIndex(entries as LogEntry[], cli.wantsJson ?? false);
  }
  return listSessions(cli.wantsJson ?? false, sessionsDirPath, palette);
}

async function listSessions(
  json: boolean,
  sessionsDirPath: string,
  palette: ColorPalette,
): Promise<number> {
  const dir = sessionsDirPath;
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
            registry.register("review", {
              description: "Review session logs",
              handler: async (cli: CliArgs, core: CoreContext) => {
                const { config } = core;
                return await runReview(cli, config as Record<string, unknown>);
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
