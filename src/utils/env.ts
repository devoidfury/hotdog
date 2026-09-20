// Env scrubbing for child processes spawned on the agent's behalf.
//
// The bash tool and the MCP stdio transport spawn processes whose lifetime overlaps the LLM's.
// Copying the raw process env would leak the agent's own secrets (LLM API key, webui key, ...)
// into those processes, where a prompt-injected model could read them back out.
//
// The filter is a substring denylist -- a heuristic, not a boundary. It can over-filter and under-filter.
// Operators can extend it exactly (case-insensitive) via config `envScrub.extra` (see envScrubExtraKeys).
// Caller-supplied env(e.g.mcpServers[].env in config) is user-trusted and NOT scrubbed; merge it over the result.

/** Heuristic: does this env var key look like a secret? */
export function isSensitiveEnvVar(key: string): boolean {
  const KEY = key.toUpperCase();
  return (
    KEY.includes("HOTDOG") ||
    KEY.includes("_ID") ||
    KEY.includes("_URL") ||
    KEY.includes("_AUTH") ||
    KEY.includes("CRED") ||
    KEY.includes("JWT") ||
    KEY.includes("PRIVATE") ||
    KEY.includes("LOGIN") ||
    KEY.includes("SECRET") ||
    KEY.includes("KEY") ||
    KEY.includes("TOKE") ||
    KEY.includes("PASS") ||
    KEY.includes("SEED") ||
    KEY.includes("HASH") ||
    // MYSQL_PWD, ORACLE_PWD, ... -- the leading underscore keeps plain PWD (cwd) unscrubbed.
    KEY.includes("_PWD")
  );
}

/** Extract the operator-known extra key list from config: { envScrub: { extra: ["CORP_SSO_TOKEN"] } }. */
export function envScrubExtraKeys(config: Record<string, unknown> | undefined | null): string[] {
  const block = config?.envScrub as { extra?: unknown } | undefined;
  return Array.isArray(block?.extra) ? (block.extra as string[]).filter((k) => typeof k === "string") : [];
}

/**
 * Copy the source env with sensitive keys dropped. Use when spawning LLM-reachable subprocesses.
 * `extraKeys` extends the denylist with operator-known secret names the substring
 * heuristics miss (case-insensitive exact match); pass envScrubExtraKeys(config).
 */
export function copyScrubbedEnv(source: NodeJS.ProcessEnv, extraKeys?: readonly string[]): NodeJS.ProcessEnv {
  const extra = extraKeys?.length ? new Set(extraKeys.map((k) => k.toUpperCase())) : null;
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => !isSensitiveEnvVar(key) && !(extra && extra.has(key.toUpperCase())),
    ),
  );
}
