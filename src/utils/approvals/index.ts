// Tool-call -> approval targets, for the user-gate approvals layer.
//
// `extractTargets` knows three things and nothing else:
//   1. bash, whose command line goes through ./bash.ts (triage, not parsing);
//   2. a handful of hotdog tools whose interesting argument has a name
//      (`fetch.url`, `web_search.query`);
//   3. the path-shaped-parameter heuristic -- any tool with a `path`, `paths`,
//      `file_path`, `filePath`, `dir` or `directory` argument is a file tool,
//      which is what makes MCP/extension file tools recognized too.
//
// A call none of that covers is UNRECOGNIZED, which rules.ts turns into an
// ask unless an allow entry names the tool.
//
// Like the rest of this layer: convenience triage, not enforcement.

import { resolve as resolveAbs } from "node:path";
import type { Workspace } from "@utils/workspace.ts";
import { parseCommandline } from "./bash.ts";
import { matchesGlob } from "./rules.ts";
import type { ApprovalCall, ApprovalRules, ApprovalTarget } from "./rules.ts";

/** Parameters whose value is a filesystem path (the recognition heuristic). */
const PATH_PARAM_NAMES = new Set([
  "path",
  "paths",
  "file_path",
  "filePath",
  "dir",
  "directory",
]);

/** Tool whose arguments are a shell command line. */
const SHELL_TOOLS = new Set(["bash"]);

/** Hotdog tools whose value of interest is not a path. */
const VALUE_PARAM_BY_TOOL: Record<string, string[]> = {
  fetch: ["url"],
  web_search: ["query"],
};

/** Cap on how many targets a single ask lists (approval text stays readable). */
const MAX_LISTED_TARGETS = 6;

function isPathLikeParam(name: string): boolean {
  return PATH_PARAM_NAMES.has(name);
}

/** Extra tools declared in userGate.tools: params to treat as targets. */
function declaredParams(toolName: string, rules: ApprovalRules): string[] {
  return rules.tools.flatMap((t) => (matchesGlob(t.glob, toolName) ? t.params : []));
}

function pathTargets(workspace: Workspace, values: unknown, param: string): ApprovalTarget[] {
  const list = Array.isArray(values) ? values : [values];
  const out: ApprovalTarget[] = [];
  for (const item of list) {
    if (typeof item !== "string" || item === "") continue;
    const value = resolveAbs(workspace.root, item);
    const relative = workspace.relative(value);
    out.push({ param, value, ...(relative !== null ? { relative } : {}), pathy: true });
  }
  return out;
}

/**
 * Build the approval view of one tool call.
 *
 * @param args - the call's arguments, already JSON-parsed by the caller.
 */
export function extractTargets(
  toolName: string,
  args: Record<string, unknown>,
  workspace: Workspace,
  rules: ApprovalRules,
): ApprovalCall {
  const declared = declaredParams(toolName, rules);
  const valueParams = VALUE_PARAM_BY_TOOL[toolName] ?? [];
  const argNames = Object.keys(args);
  const heuristicPaths = argNames.filter(isPathLikeParam);

  const recognized =
    SHELL_TOOLS.has(toolName) ||
    valueParams.length > 0 ||
    heuristicPaths.length > 0 ||
    declared.length > 0;

  if (SHELL_TOOLS.has(toolName)) {
    const command = args.command ?? args.cmd;
    if (typeof command !== "string") {
      return { tool: toolName, recognized, targets: [], bailReason: "no command string to inspect" };
    }
    const parsed = parseCommandline(command, workspace);
    if (!parsed.ok) return { tool: toolName, recognized, targets: [], bailReason: parsed.reason };
    return { tool: toolName, recognized, targets: parsed.targets };
  }

  const targets: ApprovalTarget[] = [];
  const seen = new Set<string>();
  const push = (list: ApprovalTarget[]) => {
    for (const t of list) {
      const key = `${t.param}\u0000${t.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(t);
    }
  };

  // Recognized path parameters normalise to `paths` (so one rule shape covers
  // read/write/edit/append and any MCP file tool).
  for (const name of heuristicPaths) push(pathTargets(workspace, args[name], "paths"));

  // userGate.tools params keep the name the user wrote -- that is the name they
  // will write in a rule. Path-shaped ones still match with path semantics.
  for (const name of declared) {
    if (isPathLikeParam(name)) continue; // the heuristic already covers it
    const value = args[name];
    if (typeof value !== "string" || value === "") continue;
    if (/path|dir|file/i.test(name)) push(pathTargets(workspace, value, name));
    else push([{ param: name, value }]);
  }

  for (const name of valueParams) {
    const value = args[name];
    if (typeof value !== "string" || value === "") continue;
    push([{ param: name, value }]);
  }

  return { tool: toolName, recognized, targets };
}

/**
 * The config line that would have prevented the ask, for the prompt hint and
 * the denial text. Nothing here is ever written to config -- the human copies
 * it if they want the change to outlive the session.
 */
export function suggestRuleLine(call: ApprovalCall): string {
  const entries: string[] = [];
  const required = call.targets.filter((t) => !t.denyOnly);
  for (const t of required.slice(0, MAX_LISTED_TARGETS)) {
    const value = t.pathy ? (t.relative ?? t.value) : t.value;
    entries.push(`${call.tool}.${t.param}=${value}`);
  }
  if (entries.length === 0) entries.push(call.tool);
  if (required.length > MAX_LISTED_TARGETS) entries.push("...");
  return `to persist:  "userGate": { "allow": [${entries.map((e) => JSON.stringify(e)).join(", ")}] }`;
}
