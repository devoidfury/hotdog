// Env scrubbing for child processes spawned on the agent's behalf.
//
// The bash tool and the MCP stdio transport spawn processes whose lifetime
// overlaps the LLM's. Copying the raw process env would leak the agent's own
// secrets (LLM API key, webui key, ...) into those processes, where a
// prompt-injected model could read them back out.
//
// The filter is a substring denylist -- a heuristic, not a boundary. It can
// over-filter (legit vars containing "KEY"/"URL") and under-filter
// (e.g. CREDENTIALS, AUTH). Caller-supplied env (e.g. mcpServers[].env in
// config) is user-trusted and is NOT scrubbed; merge it over the result.

/** Heuristic: does this env var key look like a secret? */
export function isSensitiveEnvVar(key: string): boolean {
  const KEY = key.toUpperCase();
  return (
    KEY.includes("HOTDOG") ||
    KEY.includes("_ID") ||
    KEY.includes("_URL") ||
    KEY.includes("_AUTH") ||
    KEY.includes("_CRED") ||
    KEY.includes("JWT") ||
    KEY.includes("PRIVATE") ||
    KEY.includes("LOGIN") ||
    KEY.includes("SECRET") ||
    KEY.includes("KEY") ||
    KEY.includes("TOKE") ||
    KEY.includes("PASS") ||
    KEY.includes("SEED") ||
    KEY.includes("HASH")
  );
}

/**
 * Copy the source env with sensitive keys dropped.
 * Use as the base env when spawning LLM-reachable subprocesses.
 */
export function copyScrubbedEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !isSensitiveEnvVar(key)),
  );
}
