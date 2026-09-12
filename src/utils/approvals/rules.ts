// Tool-call approval rules -- the pure decision layer behind the user-gate
// extension (docs/config-reference.md "userGate").
//
// Grammar: `tool` or `tool.param=glob`. `*` works in the tool part
// (`mcp__*`). The param part names a target as the extractor produces it:
// `cmd` for a bash command basename, `path` for a bash path argument,
// `paths` for the file tools' path params, and the tool's own param name
// otherwise (`url`, `query`).
//
// Path-shaped values are matched with Workspace's own rule matcher (the
// `workspace.deny` dialect -- component sequences matched at any depth,
// `*`/`?` within a component) against BOTH the resolved absolute path and
// the workspace-relative form. Everything else matches as a plain `*`/`?`
// glob over the value. There is deliberately no second glob dialect.
//
// Precedence: deny > allow > userGate.default, where default is "ask"
// (interactive), "allow" (permissive) or "deny" (allowlist-only, never
// prompts). A deny is never prompted and cannot be overridden from a prompt.
//
// This layer is convenience triage for honest mistakes. It is NOT an
// enforcement boundary -- quoting tricks exist; the sysbox fence (or
// nothing) is what enforces.

import { ConfigError } from "@core/error.ts";
import { pathMatchesRule } from "@utils/workspace.ts";

export type ApprovalVerdict = "allow" | "deny" | "ask";

/** One value a rule can be matched against. */
export interface ApprovalTarget {
  /** Rule param name: "cmd", "path", "paths", "url", "query", "arg", ... */
  param: string;
  /** The value; absolute for path-shaped targets. */
  value: string;
  /** Workspace-relative form, when the value sits inside a root. */
  relative?: string;
  /** Match with Workspace path semantics instead of a value glob. */
  pathy?: boolean;
  /** Deny-matchable only: an unmatched denyOnly target never demands an allow. */
  denyOnly?: boolean;
}

/** Everything one tool call contributes to a decision. */
export interface ApprovalCall {
  tool: string;
  /** Known to the extractor (built-in table, path-shaped param heuristic, or userGate.tools). */
  recognized: boolean;
  targets: ApprovalTarget[];
  /** Args/command could not be analyzed safely: ASK, with the reason. */
  bailReason?: string;
}

export interface ApprovalRule {
  /** The raw config entry, for messages and hints. */
  raw: string;
  toolGlob: string;
  /** null for a tool-level rule (`tool`). */
  param: string | null;
  /** null for a tool-level rule. */
  valueGlob: string | null;
}

export type ApprovalDefault = "ask" | "allow" | "deny";

export interface ApprovalRules {
  /**
   * What an unmatched call does. `deny` is the allowlist-only mode: nothing
   * prompts, so it is the shape that works headless (one-shot, CI) -- and the
   * shape where a forgotten tool is a failed call rather than a question.
   */
  default: ApprovalDefault;
  /** userGate.tools: extra recognized tools + which of their params are targets. */
  tools: Array<{ glob: string; params: string[] }>;
  allow: ApprovalRule[];
  deny: ApprovalRule[];
}

export interface ApprovalDecision {
  verdict: ApprovalVerdict;
  /** Raw rule entries that matched. */
  matched: string[];
  /** Human/model-readable lines -- the block text is built from these. */
  reasons: string[];
  /** On a deny: whether a deny rule said so (no in-session remedy) or the
   * default did (the allow-list line is the fix, so it is worth printing). */
  deniedBy?: "rule" | "default";
}

/** The raw `userGate` config shape (defaults live in extension.json). */
export interface UserGateConfig {
  enabled?: boolean;
  default?: ApprovalDefault;
  tools?: Record<string, string[]>;
  allow?: string[];
  deny?: string[];
}

/** `*` = anything, `?` = one char, everything else literal. Shared with the
 * extractor so `userGate.tools` patterns and rule tool-parts mean one thing. */
export function matchesGlob(glob: string, value: string): boolean {
  return globToRegExp(glob).test(value);
}

function globToRegExp(glob: string): RegExp {
  let rx = "^";
  for (const ch of glob) {
    if (ch === "*") rx += "[\\s\\S]*";
    else if (ch === "?") rx += "[\\s\\S]";
    else rx += ch.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${rx}$`);
}

/**
 * Parse one `tool` | `tool.param=glob` entry.
 * @throws ConfigError on anything else -- a malformed rule must fail at load,
 *   never be silently ignored (a silently dropped deny is worse than a crash).
 */
export function parseRule(entry: string): ApprovalRule {
  if (typeof entry !== "string" || entry.trim() === "") {
    throw new ConfigError(`userGate rule must be a non-empty string, got: ${JSON.stringify(entry)}`);
  }
  const raw = entry.trim();
  if (raw.startsWith("!")) {
    throw new ConfigError(`userGate rules do not support '!' negation: '${raw}'`);
  }
  const eq = raw.indexOf("=");
  if (eq === -1) {
    // A dotted name with no `=glob` is a truncated `tool.param=glob` -- the
    // kind of typo that would otherwise sit there matching nothing.
    if (raw.includes(".")) {
      throw new ConfigError(`userGate rule must be 'tool' or 'tool.param=glob', got: '${raw}'`);
    }
    return { raw, toolGlob: raw, param: null, valueGlob: null };
  }

  const lhs = raw.slice(0, eq);
  const valueGlob = raw.slice(eq + 1);
  const dot = lhs.lastIndexOf(".");
  if (dot <= 0 || dot === lhs.length - 1 || valueGlob === "") {
    throw new ConfigError(`userGate rule must be 'tool' or 'tool.param=glob', got: '${raw}'`);
  }
  return { raw, toolGlob: lhs.slice(0, dot), param: lhs.slice(dot + 1), valueGlob };
}

function asRuleList(value: unknown, key: "allow" | "deny"): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`userGate.${key} must be an array of rule strings`);
  }
  return value;
}

/** Validate + compile the raw config. Throws ConfigError on anything malformed. */
export function compileApprovalRules(cfg: UserGateConfig | undefined | null): ApprovalRules {
  const def = cfg?.default ?? "ask";
  if (def !== "ask" && def !== "allow" && def !== "deny") {
    throw new ConfigError(`userGate.default must be "ask", "allow" or "deny", got: ${JSON.stringify(cfg?.default)}`);
  }

  const tools: Array<{ glob: string; params: string[] }> = [];
  if (cfg?.tools !== undefined) {
    if (typeof cfg.tools !== "object" || cfg.tools === null || Array.isArray(cfg.tools)) {
      throw new ConfigError("userGate.tools must be an object mapping tool patterns to param-name lists");
    }
    for (const [glob, params] of Object.entries(cfg.tools)) {
      if (glob.trim() === "") throw new ConfigError("userGate.tools keys must be non-empty strings");
      if (!Array.isArray(params) || params.some((p) => typeof p !== "string" || p.trim() === "")) {
        throw new ConfigError(`userGate.tools['${glob}'] must be an array of non-empty param names`);
      }
      tools.push({ glob: glob.trim(), params: (params as string[]).map((p) => p.trim()) });
    }
  }

  return {
    default: def,
    tools,
    allow: asRuleList(cfg?.allow, "allow").map((e) => parseRule(e as string)),
    deny: asRuleList(cfg?.deny, "deny").map((e) => parseRule(e as string)),
  };
}

function targetMatches(rule: ApprovalRule, target: ApprovalTarget): boolean {
  if (rule.param === null || rule.valueGlob === null) return false;
  if (rule.param !== target.param) return false;
  if (!target.pathy) return globToRegExp(rule.valueGlob).test(target.value);
  if (pathMatchesRule(target.value.split("/").filter(Boolean), rule.valueGlob)) return true;
  return (
    !!target.relative && pathMatchesRule(target.relative.split("/").filter(Boolean), rule.valueGlob)
  );
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * deny > allow > default.
 *
 * - a tool-level deny (`deny: ["bash"]`) blocks the whole call, no parse needed;
 * - a param deny that matches any target blocks, whatever else matches;
 * - a tool-level allow (`allow: ["bash"]`) allows the whole call, even a command
 *   the parser refused to analyze (the human said yes to the tool);
 * - otherwise every non-denyOnly target needs an allow; leftovers fall to
 *   `userGate.default` -- ask, allow, or (allowlist mode) deny. A bail or an
 *   unrecognized tool denies under "deny" instead of asking: unverifiable is
 *   not allowed.
 */
export function decide(call: ApprovalCall, rules: ApprovalRules): ApprovalDecision {
  const forTool = (list: ApprovalRule[]) => list.filter((r) => globToRegExp(r.toolGlob).test(call.tool));

  const denyTool = forTool(rules.deny).find((r) => r.param === null);
  if (denyTool) {
    return {
      verdict: "deny",
      deniedBy: "rule",
      matched: [denyTool.raw],
      reasons: [`tool '${call.tool}' is denied by the userGate rule '${denyTool.raw}'`],
    };
  }

  const denyRules = forTool(rules.deny).filter((r) => r.param !== null);
  const deniedHits = denyRules.flatMap((rule) =>
    call.targets.filter((t) => targetMatches(rule, t)).map((t) => ({ rule, t })),
  );
  if (deniedHits.length > 0) {
    return {
      verdict: "deny",
      deniedBy: "rule",
      matched: uniq(deniedHits.map((h) => h.rule.raw)),
      reasons: deniedHits.map((h) => `${h.t.param} '${h.t.value}' matches the deny rule '${h.rule.raw}'`),
    };
  }

  const allowTool = forTool(rules.allow).find((r) => r.param === null);
  if (allowTool) {
    return {
      verdict: "allow",
      matched: [allowTool.raw],
      reasons: [`tool '${call.tool}' is allowed by '${allowTool.raw}'`],
    };
  }

  if (call.bailReason) {
    // Under an allowlist, "could not verify" is not "allowed".
    return rules.default === "deny"
      ? {
          verdict: "deny",
          deniedBy: "default",
          matched: [],
          reasons: [`could not verify the call (${call.bailReason}) and userGate.default is "deny"`],
        }
      : {
          verdict: "ask",
          matched: [],
          reasons: [`could not analyze the call safely: ${call.bailReason}`],
        };
  }

  const allowRules = forTool(rules.allow).filter((r) => r.param !== null);
  const unmatched = call.targets.filter(
    (t) => !t.denyOnly && !allowRules.some((r) => targetMatches(r, t)),
  );
  const matched = uniq(call.targets.flatMap((t) => allowRules.filter((r) => targetMatches(r, t)).map((r) => r.raw)));

  if (unmatched.length === 0 && call.targets.length > 0) {
    return {
      verdict: "allow",
      matched,
      reasons: [`allowed by ${matched.map((m) => `'${m}'`).join(", ")}`],
    };
  }

  // Either nothing needed covering (no targets at all) or something was left
  // over: unrecognized tools always ask, recognized ones fall to the default.
  const naming = unmatched.length > 0 ? unmatched.map((t) => `${t.param} '${t.value}'`).join(", ") : `'${call.tool}'`;
  if (!call.recognized) {
    // Unrecognized + default deny: the tool was never allowlisted, which under
    // an allowlist IS the answer (asking instead would swallow the mode whole,
    // since most unrecognized tools are MCP tools nobody has listed yet).
    return rules.default === "deny"
      ? {
          verdict: "deny",
          deniedBy: "default",
          matched,
          reasons: [`tool '${call.tool}' is not recognized and no userGate.allow entry names it (userGate.default is "deny")`],
        }
      : {
          verdict: "ask",
          matched,
          reasons: [`tool '${call.tool}' is not recognized by the approvals layer (${naming})`],
        };
  }
  if (rules.default === "allow") {
    return { verdict: "allow", matched, reasons: [`userGate.default is "allow"`] };
  }
  if (rules.default === "deny") {
    return {
      verdict: "deny",
      deniedBy: "default",
      matched,
      reasons: [`no userGate.allow rule covers ${naming} and userGate.default is "deny"`],
    };
  }
  return {
    verdict: "ask",
    matched,
    reasons:
      unmatched.length > 0
        ? [`no userGate.allow rule covers ${naming} and userGate.default is "ask"`]
        : [`no userGate.allow rule covers '${call.tool}' and userGate.default is "ask"`],
  };
}
