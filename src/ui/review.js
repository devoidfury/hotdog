import { CliOutputSink } from "./cli.js";
import { loadConfig } from "../config.js";

import { readSessionEntries } from "../session_log.js";
import { readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Subcommand: review ───────────────────────────────────────────────────────

export async function runReview(cli) {
  const config = await loadConfig(cli.config);
  const sessionsDirPath = join(homedir(), ".cache", "oa-agent", "sessions");

  // Resolve color palette for review
  const palette = CliOutputSink.resolve(
    cli.theme,
    config.colors || null,
    cli.colors,
  );

  const sessionId = cli.sessionId;
  if (sessionId) {
    // Review a specific session
    reviewSession(sessionId, cli.wantsJson, cli.reviewToolIndex, palette);
  } else if (cli.reviewToolIndex) {
    // --review --tool-index without --session-id: show tool index for most recent session
    const files = readdirSync(sessionsDirPath).filter((f) =>
      f.endsWith(".jsonl"),
    );
    if (files.length === 0) {
      console.log("No sessions found.");
      return;
    }
    // Get most recent session
    const mostRecent = files
      .map((f) => ({
        name: f.replace(/\.jsonl$/, ""),
        path: join(sessionsDirPath, f),
      }))
      .sort(
        (a, b) =>
          statSync(b.path).mtime.getTime() - statSync(a.path).mtime.getTime(),
      )[0];
    const entries = readSessionEntries(mostRecent.name);
    printToolIndex(entries, cli.wantsJson);
  } else {
    // List sessions
    listSessions(cli.wantsJson, sessionsDirPath, palette);
  }
}

export function listSessions(json, sessionsDirPath, palette) {
  const dir = sessionsDirPath;
  if (!existsSync(dir)) {
    if (json) {
      console.log("[]");
    } else {
      console.log("No log entries found.");
    }
    return;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) {
    if (json) {
      console.log("[]");
    } else {
      console.log("No log entries found.");
    }
    return;
  }

  const sessions = [];
  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, "");
    const path = join(dir, file);
    const metadata = statSync(path);
    const entries = readSessionEntries(sessionId);

    // Filter out sessions with only 1 entry
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
    if (json) {
      console.log("[]");
    } else {
      console.log("No log entries found.");
    }
    return;
  }

  // Sort by mtime, keep last 10
  sessions.sort((a, b) => a.mtime - b.mtime);
  const start = Math.max(0, sessions.length - 10);
  const recent = sessions.slice(start);

  if (json) {
    console.log(
      JSON.stringify(
        recent.map((s) => ({
          id: s.id,
          last_modified: s.last_modified,
          entry_count: s.entry_count,
        })),
        null,
        2,
      ),
    );
  } else {
    console.log("Last 10 sessions:");
    for (const s of recent) {
      console.log(`  ${s.id}  ${s.last_modified}  (${s.entry_count} entries)`);
    }
  }
}

export function reviewSession(sessionId, json, toolIndex, palette) {
  const entries = readSessionEntries(sessionId);

  if (entries.length === 0) {
    console.error(`No log entries found for session '${sessionId}'`);
    process.exit(1);
  }

  if (toolIndex) {
    printToolIndex(entries, json);
  } else if (json) {
    for (const entry of entries) {
      console.log(JSON.stringify(entry));
    }
  } else {
    console.log(`Session: ${sessionId}`);
    console.log(`Entries: ${entries.length}`);
    console.log("─".repeat(60));

    for (const entry of entries) {
      renderEntry(entry, palette);
    }
  }
}

export function printToolIndex(entries, json) {
  const indexEntries = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.tool_calls) {
      for (const tc of entry.tool_calls) {
        const args = tc.function?.arguments || "";
        const truncated =
          args.length > 500 ? args.slice(0, 500) + "\u2026" : args;
        indexEntries.push({
          index: i,
          tool_name: tc.function?.name || "",
          arguments: truncated,
        });
      }
    }
  }

  if (indexEntries.length === 0) {
    if (json) {
      console.log("[]");
    } else {
      console.log("No tool calls in this session.");
    }
    return;
  }

  if (json) {
    console.log(JSON.stringify(indexEntries, null, 2));
  } else {
    const maxIdx = String(indexEntries.length - 1).length;
    const maxName = Math.max(...indexEntries.map((e) => e.tool_name.length), 4);

    console.log(`=== Tool Calls (${indexEntries.length} total) ===`);
    console.log();
    console.log(
      `  ${"IDX".padEnd(maxIdx + 1)}  ${"TOOL".padEnd(maxName + 1)}  ARGS`,
    );
    console.log(
      `  ${"-".repeat(maxIdx + 1)}  ${"-".repeat(maxName + 1)}  ----`,
    );

    for (const e of indexEntries) {
      const argsDisplay =
        e.arguments.length > 80
          ? e.arguments.slice(0, 80) + "\u2026"
          : e.arguments;
      console.log(
        `  ${String(e.index).padEnd(maxIdx + 1)}  ${e.tool_name.padEnd(maxName + 1)}  ${argsDisplay}`,
      );
    }
  }
}

function renderEntry(entry, palette) {
  if (!palette) palette = CliOutputSink.resolve(null, null, true, null);

  const sourceColorMap = {
    system_prompt: "bold_black",
    input: "cyan",
    llm: "bold_white",
    tool_result: "green",
    reset: "bold_red",
    prompt: "magenta",
    compaction: "blue",
  };
  const sourceLabel =
    {
      system_prompt: "SYSTEM",
      input: "USER",
      llm: "ASSISTANT",
      tool_result: "TOOL",
      reset: "RESET",
      prompt: "PROMPT",
      compaction: "COMPACT",
    }[entry.source] || "UNKNOWN";

  const sourceColor = sourceColorMap[entry.source] || "white";
  const header = `[${entry.ts}] ${sourceLabel}`;
  console.log(applyColor(header, sourceColor, palette.use_colors));

  switch (entry.source) {
    case "system_prompt": {
      const truncated =
        entry.content.length > 200
          ? entry.content.slice(0, 200) + "\u2026"
          : entry.content;
      console.log(`  ${applyThinking(truncated, palette)}`);
      break;
    }
    case "input": {
      if (entry.content.length === 0) {
        console.log("  (empty input)");
      } else {
        for (const line of entry.content.split("\n")) {
          console.log(`  ${applyFinalResponse(line, palette)}`);
        }
      }
      break;
    }
    case "llm": {
      if (
        entry.reasoning_content &&
        entry.reasoning_content.trim().length > 0
      ) {
        console.log(`  ${applyThinking(entry.reasoning_content, palette)}`);
      }
      if (entry.content.length > 0) {
        for (const line of entry.content.split("\n")) {
          console.log(`  ${applyFinalResponse(line, palette)}`);
        }
      }
      if (entry.tool_calls) {
        for (const tc of entry.tool_calls) {
          const tcHeader = `     \ud83d\udd27 [${applyToolCall(tc.type, palette)}] ${applyToolCall(tc.function.name, palette)} (id: ${tc.id})`;
          console.log(tcHeader);
          console.log(
            `     ${applyToolResult(tc.function.arguments, palette)}`,
          );
        }
      }
      break;
    }
    case "tool_result": {
      if (entry.tool_name) {
        console.log(
          `     \ud83d\udd27 Tool: ${applyToolCall(entry.tool_name, palette)}`,
        );
      }
      if (entry.tool_call_id) {
        console.log(`     (id: ${entry.tool_call_id})`);
      }
      const truncated =
        entry.content.length > 500
          ? entry.content.slice(0, 500) + "\u2026"
          : entry.content;
      for (const line of truncated.split("\n")) {
        console.log(
          `     ${applyColor(line, palette.tool_result, palette.use_colors)}`,
        );
      }
      break;
    }
    case "reset": {
      console.log(
        `  ${applyColor("(session reset)", sourceColor, palette.use_colors)}`,
      );
      break;
    }
    case "prompt": {
      for (const line of entry.content.split("\n")) {
        console.log(`  ${applyFinalResponse(line, palette)}`);
      }
      break;
    }
    case "compaction": {
      console.log(`  [Compacted ${entry.content}]`);
      break;
    }
  }

  console.log();
}
