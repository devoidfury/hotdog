// The compact DOMAIN INDEX: a constant-size "domains + counts" view of the
// callable set that rides the codemode tool description.
//
// Authority rule: the index is built over the POLICY-FILTERED name set -- the
// agent.getToolDefs()-equivalent -- never over a raw registry traversal, so a
// tool removed by sandboxMode / difficulty / whitelist / blacklist appears in
// no bucket and no count. The name list is supplied by the caller; per-name
// metadata is read through an injected reader (ToolRegistry.getMetadata),
// which touches no def cache. That is what keeps the recursion trap
// unreachable: rendering NEVER calls registry.getToolDefs()/getToolDef() from
// inside toToolDef(), which would recurse into the all-defs cache being
// populated.
//
// Without an Agent handle at def-build time, `policyFilteredNames` reproduces
// the filter chain with the registry's own primitives over the legs visible
// from config; per run the bridge uses `agent.getToolDefs()`, where the real
// set is reachable.

import type { ToolMetadata, ToolRegistry } from "@core/extensions/tool-registry.ts";

/** Canonical bucket vocabulary (ToolMetadata.tags doc); extension-authored
 *  domains are first-class and render after the canonical ones, sorted. */
export const CANONICAL_DOMAINS: readonly string[] = [
  "files",
  "network",
  "utility",
  "system",
  "manager",
  "guidance",
];

const UNTAGGED_BUCKET = "untagged";

/** Same normalization as ToolRegistry.getTags: trim + lowercase, drop empty,
 *  dedupe, declaration order. Operates on the metadata object, not the
 *  registry, so it works from the injected per-name reader. */
export function normalizeMetadataTags(tags: readonly string[] | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const t = tag.trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export type MetadataReader = (name: string) => ToolMetadata | undefined;

/**
 * Render the domain index line: non-empty canonical buckets in canonical
 * order, then other domains sorted, then the `untagged` bucket (always
 * present -- MCP tools carry no tags). Size is constant in fleet size:
 * buckets carry counts, never names.
 */
export function buildDomainIndex(
  names: Iterable<string>,
  readMetadata: MetadataReader,
  selfName: string,
): string {
  const counts = new Map<string, number>();
  let untagged = 0;
  for (const name of names) {
    if (!name || name === selfName) continue;
    const tags = normalizeMetadataTags(readMetadata(name)?.tags);
    if (tags.length === 0) {
      untagged++;
      continue;
    }
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  const buckets: string[] = [];
  for (const domain of CANONICAL_DOMAINS) {
    const n = counts.get(domain);
    if (n) {
      buckets.push(`${domain}(${n})`);
      counts.delete(domain);
    }
  }
  for (const domain of [...counts.keys()].sort()) {
    buckets.push(`${domain}(${counts.get(domain)})`);
  }
  buckets.push(`${UNTAGGED_BUCKET}(${untagged})`);

  return (
    `Domains: ${buckets.join(" ")}. ` +
    `searchTools("<domain>") lists names + descriptions; describeTool(name) gives arguments.`
  );
}

/** The config legs of Agent.getToolDefs()'s filter chain that are visible
 *  without an Agent handle. */
export interface PolicyConfig {
  sandboxMode?: boolean;
  /** null = no filtering (the resolved-bag spelling); see policyFilteredNames. */
  maxToolDifficulty?: number | null;
  defaultMaxToolDifficulty?: number | null;
  blacklistTools?: string[];
}

/**
 * Policy-filtered callable names, assembled with the registry's own filter
 * primitives (reused, not re-implemented). Legs invisible without an Agent
 * handle over-include and are corrected when the run's callable table is
 * rebuilt from agent.getToolDefs(): the profile whitelist, and managerOnly
 * filtering against the ACTIVE profile (kept here, the manager-session truth;
 * a non-manager session sees manager counts until then).
 */
export function policyFilteredNames(
  registry: ToolRegistry,
  config: PolicyConfig | undefined,
): string[] {
  const cfg = config ?? {};
  // Resolved config bags carry these difficulty knobs as null (= "no
  // filtering", schema semantics, mirroring agent.ts's `!= null` guard);
  // filterByMetadata only skips on undefined, so null must normalize or the
  // index empties fleet-wide.
  const maxDifficulty = cfg.maxToolDifficulty ?? cfg.defaultMaxToolDifficulty;
  let reg = registry.filterByMetadata({
    maxDifficulty: maxDifficulty ?? undefined,
    allowSideEffects: !cfg.sandboxMode,
  });
  if (Array.isArray(cfg.blacklistTools) && cfg.blacklistTools.length > 0) {
    reg = reg.filter(null, cfg.blacklistTools);
  }
  return reg.getAll().map(([name]) => name);
}

/**
 * Keep-direct table: the tools the shadow layer never hides (human
 * channel, turn-contract tools, manager/orchestration class, the skills
 * preamble partner, session config). shadow.ts consumes this same list for
 * the PROVIDER_REQUEST filter; the prompt chunk needs it to name the
 * shadow inventory.
 */
export const KEEP_DIRECT_TOOL_NAMES: readonly string[] = [
  "question",
  "wait",
  "handoff",
  "load_skill",
  "model",
  "delegate_task",
  "task_status",
  "task_followup",
  "task_interrupt",
  "plan_status",
  "workflow_validate",
  "workflow_dispatch",
  "workflow_status",
  "workflow_followup",
  "workflow_control",
  "review",
];

/**
 * The shadow inventory: names shadowed by codemode's full-tilt posture --
 * policy set minus the keep-direct table, minus pinned tools (the pinned
 * exemption covers the shadow leg only), minus codemode itself (the entry
 * point). The filter itself lives in shadow.ts; this computes what the
 * system-prompt chunk names.
 */
export function shadowedNames(
  names: Iterable<string>,
  opts: { isPinned?: (name: string) => boolean; selfName: string },
): string[] {
  const keep = new Set<string>(KEEP_DIRECT_TOOL_NAMES);
  const out: string[] = [];
  for (const name of names) {
    if (!name || name === opts.selfName || keep.has(name)) continue;
    if (opts.isPinned?.(name)) continue;
    out.push(name);
  }
  return out.sort();
}
