import { HOOKS } from "@core/hooks.ts";
import { conversationContent, deleteSessionLog, readSessionEntries, sessionExists, sessionsDir as getSessionsDir, type LogEntry } from "@core/session/session-log.ts";
import { toolContentText, wrapperContentText } from "@utils/tool-content.ts";
import { readdir, access, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ReviewTool, listRecentSessions } from "./review.ts";
import { CoreContext, ExtensionInstance, ToolsRegisterPayload } from "@core/extensions/types.ts";
import readline from "node:readline";
import { CoreConfigWithExtensions } from "@core/config/index.ts";

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

async function runSessions(
  cli: CliArgs,
  config: CoreConfigWithExtensions,
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

async function runShow(
  cli: CliArgs,
  _config: CoreConfigWithExtensions,
): Promise<number> {
  const sessionId = cli.sessionId;
  if (sessionId) {
    return await reviewSession(
      sessionId,
      cli.wantsJson ?? false,
      cli.toolIndex ?? false,
    );
  }
  if (cli.toolIndex) {
    const mostRecent = (await listRecentSessions())[0];
    if (!mostRecent) {
      console.log("No sessions found.");
      return 1;
    }
    const entries = await readSessionEntries(mostRecent.id);
    return printToolIndex(entries, cli.wantsJson ?? false);
  }
  return listSessions(cli.wantsJson ?? false);
}

async function runDelete(
  cli: CliArgs,
  _config: CoreConfigWithExtensions,
): Promise<number> {
  const sessionId = (cli.args as string[] | undefined)?.[1];

  if (!sessionId) {
    console.error("Usage: hotdog sessions delete <session-id>");
    return 1;
  }

  if (!(await sessionExists(sessionId))) {
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

  const deleted = await deleteSessionLog(sessionId);
  if (!deleted) {
    console.error(`Session '${sessionId}' not found.`);
    return 1;
  }
  // Best-effort: the session's pass-the-baton mirror would otherwise leak.
  try {
    await unlink(join(getSessionsDir(), `${sessionId}.baton.json`));
  } catch {
    // No mirror (the common case): nothing to clean.
  }
  console.log(`Deleted session '${sessionId}'.`);
  return 0;
}

async function runCleanup(
  cli: CliArgs,
  _config: CoreConfigWithExtensions,
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

  const names = await readdir(sessionsDir);

  const toDelete: Array<{ id: string; last_modified: string }> = [];

  for (const file of names.filter((f: string) => f.endsWith(".jsonl"))) {
    const metadata = await stat(join(sessionsDir, file));
    if (metadata.mtime.getTime() < cutoffMs) {
      toDelete.push({
        id: file.replace(/\.jsonl$/, ""),
        last_modified: new Date(metadata.mtime).toISOString(),
      });
    }
  }

  // Baton mirrors (`<id>.baton.json`, written by pass-the-baton compaction,
  // unlinked when replayed or dropped): a crash between pop and replay leaks
  // them. Two rules, both age-gated by the same cutoff so a live session's
  // fresh mirror is never taken:
  //  - paired: deleting a session deletes its mirror (whatever its age);
  //  - orphaned: a mirror whose session log no longer exists is unreplayable,
  //    so once it is older than the cutoff it goes too.
  const batonNames = new Set(
    names.filter((f: string) => f.endsWith(".baton.json")),
  );
  const paired = toDelete
    .map((s) => `${s.id}.baton.json`)
    .filter((f) => batonNames.has(f));
  const orphans: Array<{ file: string; last_modified: string }> = [];
  for (const file of batonNames) {
    if (paired.includes(file)) continue;
    const stem = file.slice(0, -".baton.json".length);
    if (names.includes(`${stem}.jsonl`)) continue;
    const metadata = await stat(join(sessionsDir, file));
    if (metadata.mtime.getTime() < cutoffMs) {
      orphans.push({ file, last_modified: new Date(metadata.mtime).toISOString() });
    }
  }

  if (toDelete.length === 0 && orphans.length === 0) {
    console.log(`No sessions older than ${olderThanDays} days.`);
    return 0;
  }

  if (!cli.yes) {
    console.log(`Found ${toDelete.length} session(s) older than ${olderThanDays} days:`);
    for (const s of toDelete) {
      console.log(`  ${s.id}  (${s.last_modified})`);
    }
    if (paired.length > 0) {
      console.log(`  (+${paired.length} baton mirror(s) of the above)`);
    }
    for (const o of orphans) {
      console.log(`  ${o.file}  (orphaned baton mirror, ${o.last_modified})`);
    }
    const ok = await confirm("Delete these sessions?");
    if (!ok) {
      console.log("Aborted.");
      return 0;
    }
  }

  let deleted = 0;
  const batonsToRemove = [...orphans.map((o) => o.file)];
  for (const s of toDelete) {
    try {
      await unlink(join(sessionsDir, `${s.id}.jsonl`));
      deleted++;
      if (batonNames.has(`${s.id}.baton.json`)) {
        batonsToRemove.push(`${s.id}.baton.json`);
      }
    } catch {
      // Ignore failures; keep cleaning up the rest. The session survived,
      // so its mirror stays with it.
    }
  }

  let batons = 0;
  for (const file of batonsToRemove) {
    try {
      await unlink(join(sessionsDir, file));
      batons++;
    } catch {
      // Ignore failures; keep cleaning up the rest.
    }
  }

  console.log(`Deleted ${deleted} session(s), ${batons} baton file(s).`);
  return 0;
}

async function listSessions(json: boolean): Promise<number> {
  const sessions = await listRecentSessions();

  if (sessions.length === 0) {
    if (json) console.log("[]");
    else console.log("No log entries found.");
    return 1;
  }

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
): Promise<number> {
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
  console.log(`Entries: ${(entries as unknown[]).length}\n`);

  for (const entry of entries) {
    const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : "unknown";
    const role = entry.role || entry.source;
    // content may be raw parts (harness messages); flatten for display.
    // Bookkeeping entries (resume_attempt) degrade to empty text.
    const content =
      entry.content == null
        ? entry.result || ""
        : typeof entry.content === "string"
          ? entry.content
          : entry.source === "tool_result"
            ? toolContentText(conversationContent(entry))
            : wrapperContentText(conversationContent(entry));

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

export function create(_core: CoreContext): ExtensionInstance {
  return {
    hooks: {
      [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry) => {
        registry.register("sessions", {
          description: "Manage session logs (show, delete, cleanup)",
          handler: async (cli, core) => {
            const { config } = core;
            return await runSessions(cli, config);
          },
        });
      },

      [HOOKS.TOOLS_REGISTER]: async (registry: ToolsRegisterPayload) => {
        const tool = new ReviewTool();
        registry.register("review", tool);
      },
    },
  };
}
