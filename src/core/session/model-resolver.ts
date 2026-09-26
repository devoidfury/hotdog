/**
 * Spawn model resolution & placement planning
 *
 * Precedence: explicit pin > model group > requirements > copy-expansion (chain
 * default) > caller fallback. Progressive enhancement: standard catalog fields
 * (contextLimit, vision, toolCalling) are always usable; the annotation-derived
 * toolDifficulty tier filters only models that actually carry the annotation.
 *
 * planSpawn returns an ORDERED candidate list, not a pick: placement (TaskManager
 * #admit) takes the first candidate whose provider lane has capacity. Ordering:
 * loaded-model preference (llama-swap `/running` peek; cache warmth beats all),
 * then group-member declaration order, then difficulty desc, then provider,
 * then key -- ties always break deterministically.
 *
 * Expansion rules:
 * - pin / provider-qualified explicit values: strict, exactly one candidate.
 * - group members: bare names expand across every catalog provider holding them
 *   (copies within a member); qualified members pin one machine.
 * - chain expansion (`expand`): the bare model name of the chain winner fans out
 *   across providers. The winner's own provider is always eligible; other
 *   providers marked `noSpread` are not.
 */

import type { ModelConfig, ProviderDef } from "@core/config/providers.ts";
import { hotdogFetch } from "@utils/fetch.ts";

export interface ModelRequirements {
  ctx?: number;
  vision?: boolean;
  toolCalls?: boolean;
  toolDifficulty?: number;
}

export interface SpawnPin {
  provider?: string;
  model?: string;
}

/** Lane key for a resolved "provider/model" string; bare model names share one conservative lane keyed by "". */
export function laneKeyOf(model: string): string {
  const i = model.indexOf("/");
  return i > 0 ? model.slice(0, i) : "";
}

/** Resolved per-lane concurrency caps; see makeLaneCaps. */
export interface LaneCaps {
  /** Concurrent turns allowed on `lane`; POSITIVE_INFINITY means unlimited (no coordination). */
  capOf(lane: string): number;
}

/**
 * Shared lane-cap resolution for every slot consumer (TaskManager admissions
 * and top-level session turns): `globalCap` (taskLanesPerProvider) is the
 * fleet default, a provider def's numeric `taskLanes` overrides it for that
 * lane alone. Values below 1 normalize to unlimited, on either knob.
 */
export function makeLaneCaps(
  globalCap: number | undefined,
  providerDefs: readonly { name: string; taskLanes?: unknown }[],
): LaneCaps {
  const normalize = (n: number): number => (n >= 1 ? Math.floor(n) : Number.POSITIVE_INFINITY);
  const overrides = new Map<string, number>(
    providerDefs
      .filter((p) => typeof p.taskLanes === "number")
      .map((p) => [p.name, normalize(p.taskLanes as number)]),
  );
  const fallback =
    typeof globalCap === "number" ? normalize(globalCap) : Number.POSITIVE_INFINITY;
  return { capOf: (lane: string) => overrides.get(lane) ?? fallback };
}

/** The bare model-name part of a registry key (bare keys pass through). */
function bareNameOf(key: string): string {
  const lane = laneKeyOf(key);
  return lane ? key.slice(lane.length + 1) : key;
}

/**
 * `group:<name>` reference form, accepted wherever a model string is
 * (worker_model, and the workflow node `group` key lands here via options).
 */
export function parseGroupRef(value?: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v.startsWith("group:") || v.length <= 6) return undefined;
  return v.slice(6).trim() || undefined;
}

/**
 * Whether an explicit model value resolves to a catalog entry: exact registry key when provider-qualified,
 * any provider's copy when bare. An empty or default-pseudo-key-only registry means "no catalog": everything resolves.
 */
export function modelInCatalog(
  registry: Record<string, ModelConfig>,
  value: string,
): boolean {
  const entries = Object.keys(registry).filter((k) => typeof registry[k] === "object");
  if (entries.length === 0) return true;
  if (value.includes("/")) return entries.includes(value);
  const suffix = `/${value}`;
  return entries.some((k) => k === value || k.endsWith(suffix));
}

export interface SpawnCandidate {
  /** Registry-key form to build the agent with ("provider/model"). */
  key: string;
  /** Provider lane this candidate would occupy ("" for bare keys). */
  provider: string;
  /** Group member rank (0 for pins, copies, and requirements-only plans). */
  member: number;
}

export interface PlanInput {
  registry: Record<string, ModelConfig>;
  pin?: SpawnPin;
  /** Model-group name (no prefix); members come from modelGroups. */
  group?: string;
  requires?: ModelRequirements;
  /** Legacy chain (workerModel / profile model / delegating parent session model / registry default). Used when neither pin, group, nor requires is given; never validated. */
  fallback?: string;
  /**
   * Copy-expand a chain winner's bare name across catalog providers.
   * Zero copies found -> a single unvalidated candidate (legacy passthrough),
   * never an error. Never combine with pin/group/requires.
   */
  expand?: string;
  /** Resolved config modelGroups: name -> members (bare or provider-qualified). */
  modelGroups?: Record<string, string[]>;
  /** Providers marked noSpread: excluded from UNQUALIFIED expansion only. */
  noSpread?: Set<string>;
  /** Skip the /running peek (cold order; placement re-sorts warm before granting). */
  cold?: boolean;
  /** Loaded llama-swap model ids per provider. Injected in tests. */
  peekLoaded?: (provider: string) => Promise<Set<string>>;
}

export type PlanResult =
  | { ok: true; intent: string; candidates: SpawnCandidate[] }
  | { ok: false; error: string };

function requirementsViolations(
  requires: ModelRequirements,
  entry: ModelConfig,
): string[] {
  const bad: string[] = [];
  if (requires.ctx && (entry.contextLimit ?? 0) < requires.ctx) {
    bad.push(`ctx>=${requires.ctx} (model ctx ${entry.contextLimit ?? 0})`);
  }
  if (requires.vision && entry.capabilities?.vision !== true) {
    bad.push("vision");
  }
  if (requires.toolCalls && entry.capabilities?.toolCalling !== true) {
    bad.push("tool-calls");
  }
  if (requires.toolDifficulty) {
    if (entry.maxToolDifficulty == null) {
      bad.push(`tool-difficulty>=${requires.toolDifficulty} (model has no annotation)`);
    } else if (entry.maxToolDifficulty < requires.toolDifficulty) {
      bad.push(`tool-difficulty>=${requires.toolDifficulty} (model ${entry.maxToolDifficulty})`);
    }
  }
  return bad;
}

/** Constraint summary for "nothing matches" errors. */
function describeRequires(r: ModelRequirements): string {
  const parts: string[] = [];
  if (r.ctx) parts.push(`ctx>=${r.ctx}`);
  if (r.vision) parts.push("vision");
  if (r.toolCalls) parts.push("tool-calls");
  if (r.toolDifficulty) parts.push(`tool-difficulty>=${r.toolDifficulty}`);
  return parts.join(",");
}

/** All registry keys carrying `bare` as their model name. `originProvider`
 *  (the chain winner's own provider) stays eligible even when noSpread. */
function copyKeys(
  registry: Record<string, ModelConfig>,
  bare: string,
  noSpread?: Set<string>,
  originProvider?: string,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(registry)) {
    if (bareNameOf(key) !== bare) continue;
    const p = laneKeyOf(key);
    if (p && p !== originProvider && noSpread?.has(p)) continue;
    out.push(key);
  }
  return out;
}

/**
 * Sort by the placement contract: warm first, then group-member declaration
 * order, then difficulty desc, then provider, then key. Array#sort is stable,
 * so an all-false isLoaded keeps the incoming (declaration) order.
 */
function sortCandidates(
  candidates: SpawnCandidate[],
  registry: Record<string, ModelConfig>,
  isLoaded: (c: SpawnCandidate) => boolean,
): void {
  candidates.sort((a, b) => {
    const load = Number(isLoaded(b)) - Number(isLoaded(a));
    if (load !== 0) return load;
    if (a.member !== b.member) return a.member - b.member;
    const diff =
      (registry[b.key]?.maxToolDifficulty ?? -1) - (registry[a.key]?.maxToolDifficulty ?? -1);
    if (diff !== 0) return diff;
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/**
 * Re-sort a candidate list by CURRENT cache warmth (the peek has a 2s TTL
 * cache, so repeated placement passes are cheap). Used by TaskManager at
 * placement time: a task queued behind a busy fleet re-ranks against reality,
 * not against the warmth snapshot taken when it was spawned.
 */
export async function warmSortCandidates(
  registry: Record<string, ModelConfig>,
  candidates: SpawnCandidate[],
  peekLoaded?: (provider: string) => Promise<Set<string>>,
): Promise<SpawnCandidate[]> {
  const out = [...candidates];
  if (!peekLoaded) {
    sortCandidates(out, registry, () => false);
    return out;
  }
  const providers = [...new Set(out.map((c) => c.provider))];
  const sets = await Promise.all(providers.map((p) => peekLoaded(p)));
  const loaded = new Map(providers.map((p, i) => [p, sets[i]!]));
  sortCandidates(out, registry, (c) => loaded.get(c.provider)?.has(bareNameOf(c.key)) === true);
  return out;
}

/**
 * Build the ordered placement plan for a spawn. Returns candidates, not a pick;
 * capacity is a placement-time fact, unknown here.
 */
export async function planSpawn(input: PlanInput): Promise<PlanResult> {
  const { registry, pin, group, requires, fallback, expand } = input;
  const registryKnown = Object.keys(registry).length > 0;
  const single = (key: string): PlanResult => ({
    ok: true,
    intent: key,
    candidates: [{ key, provider: laneKeyOf(key), member: 0 }],
  });

  // --- explicit pin: strict, exactly one candidate ---
  if (pin?.model) {
    if (!registryKnown) {
      // No catalog (bare baseUrl setups): pass the pin through unvalidated.
      return single(pin.model);
    }

    // Resolve to the actual registry key (suffix match for bare names).
    let key: string | undefined = registry[pin.model] ? pin.model : undefined;
    if (!key && !pin.model.includes("/")) {
      const suffix = `/${pin.model}`;
      key = Object.keys(registry).find(
        (k) => k.endsWith(suffix) && (!pin.provider || laneKeyOf(k) === pin.provider),
      );
    }
    if (!key) {
      // Qualified names must match a registry key exactly; only bare names
      // get the suffix match above. A miss here is a hard error by design.
      return { ok: false, error: `pinned model '${pin.model}' is not in the model catalog` };
    }
    const entry = registry[key]!;
    if (pin.provider && laneKeyOf(key) !== pin.provider) {
      return {
        ok: false,
        error: `pinned model '${pin.model}' lives on provider '${laneKeyOf(key)}', not '${pin.provider}'`,
      };
    }
    if (requires) {
      const bad = requirementsViolations(requires, entry);
      if (bad.length) {
        return { ok: false, error: `pinned model '${key}' violates requirements: ${bad.join(", ")}` };
      }
    }
    return { ok: true, intent: pin.model, candidates: [{ key, provider: laneKeyOf(key), member: 0 }] };
  }

  // --- provider-only pin: narrow to it ---
  if (pin?.provider) {
    if (!registryKnown) {
      return {
        ok: false,
        error: "model requirements cannot be resolved without a model catalog (configure providers/fetchModels)",
      };
    }
    let candidates: SpawnCandidate[] = Object.keys(registry)
      .filter((k) => laneKeyOf(k) === pin.provider)
      .map((k) => ({ key: k, provider: pin.provider!, member: 0 }));
    if (requires) candidates = candidates.filter((c) => requirementsViolations(requires, registry[c.key]!).length === 0);
    if (candidates.length === 0) {
      const req = requires ? describeRequires(requires) : "provider pin";
      return { ok: false, error: `no catalog model satisfies ${req} on provider '${pin.provider}'` };
    }
    return finishPlan(input, `provider:${pin.provider}`, candidates);
  }

  // --- model group: declared interchangeability ---
  if (group) {
    if (!registryKnown) {
      return {
        ok: false,
        error: `model group '${group}' cannot be resolved without a model catalog (configure providers/fetchModels)`,
      };
    }
    const members = input.modelGroups?.[group];
    if (!members || members.length === 0) {
      const known = Object.keys(input.modelGroups ?? {});
      return {
        ok: false,
        error: `unknown model group '${group}'${known.length ? ` (known: ${known.join(", ")})` : " (config modelGroups is empty)"}`,
      };
    }
    const seen = new Set<string>();
    const candidates: SpawnCandidate[] = [];
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      if (m.includes("/")) {
        // Qualified member: its machine is intentional; a miss is a config bug.
        if (!registry[m]) {
          return { ok: false, error: `group '${group}' member '${m}' is not in the model catalog` };
        }
        if (!seen.has(m)) {
          seen.add(m);
          candidates.push({ key: m, provider: laneKeyOf(m), member: i });
        }
      } else {
        for (const k of copyKeys(registry, m, input.noSpread)) {
          if (!seen.has(k)) {
            seen.add(k);
            candidates.push({ key: k, provider: laneKeyOf(k), member: i });
          }
        }
      }
    }
    const filtered = requires
      ? candidates.filter((c) => requirementsViolations(requires, registry[c.key]!).length === 0)
      : candidates;
    if (filtered.length === 0) {
      const req = requires ? ` satisfying ${describeRequires(requires)}` : "";
      return { ok: false, error: `no catalog model in group '${group}'${req}` };
    }
    return finishPlan(input, `group:${group}`, filtered);
  }

  // --- requirements-only: every catalog model that qualifies ---
  if (requires) {
    if (!registryKnown) {
      return {
        ok: false,
        error: "model requirements cannot be resolved without a model catalog (configure providers/fetchModels)",
      };
    }
    const candidates: SpawnCandidate[] = Object.entries(registry)
      .filter(([, entry]) => requirementsViolations(requires, entry).length === 0)
      .map(([k]) => ({ key: k, provider: laneKeyOf(k), member: 0 }));
    if (candidates.length === 0) {
      return { ok: false, error: `no catalog model satisfies ${describeRequires(requires)}` };
    }
    return finishPlan(input, describeRequires(requires), candidates);
  }

  // --- chain copy-expansion: fan the winner's name across providers ---
  if (expand) {
    if (!registryKnown) return single(expand);
    const copies = copyKeys(registry, bareNameOf(expand), input.noSpread, laneKeyOf(expand));
    if (copies.length === 0) {
      // No catalog presence at all: legacy unvalidated passthrough.
      return single(expand);
    }
    return finishPlan(
      input,
      expand,
      copies.map((k) => ({ key: k, provider: laneKeyOf(k), member: 0 })),
    );
  }

  if (fallback) return single(fallback);
  return { ok: false, error: "no model pinned, required, or available" };
}

/** Deterministically order a successful plan: warm first unless cold (then member
 *  declaration order and the remaining tie-breaks; never raw insertion order). */
async function finishPlan(
  input: PlanInput,
  intent: string,
  candidates: SpawnCandidate[],
): Promise<PlanResult> {
  if (input.cold || !input.peekLoaded || candidates.length <= 1) {
    sortCandidates(candidates, input.registry, () => false);
    return { ok: true, intent, candidates };
  }
  const providers = [...new Set(candidates.map((c) => c.provider))];
  const sets = await Promise.all(providers.map((p) => input.peekLoaded!(p)));
  const loaded = new Map(providers.map((p, i) => [p, sets[i]!]));
  sortCandidates(candidates, input.registry, (c) =>
    loaded.get(c.provider)?.has(bareNameOf(c.key)) === true,
  );
  return { ok: true, intent, candidates };
}

// ---------------------------------------------------------------------------
// /running peek
// ---------------------------------------------------------------------------

const RUNNING_TTL_MS = 2000;

/**
 * Cached llama-swap `/running` peeker. Failures degrade to an empty set: hint
 * for cache-warm preference, not a gate.
 */
export function makeRunningPeeker(
  providers: ProviderDef[],
  globals?: { baseUrl?: string; apiKey?: string },
): (provider: string) => Promise<Set<string>> {
  const cache = new Map<string, { at: number; models: Set<string> }>();
  return async (provider: string): Promise<Set<string>> => {
    const hit = cache.get(provider);
    if (hit && Date.now() - hit.at < RUNNING_TTL_MS) return hit.models;

    const models = new Set<string>();
    const def = providers.find((p) => p.name === provider);
    const baseUrl = def?.url || globals?.baseUrl;
    if (def && baseUrl) {
      // String concat matches how llm-client builds request paths (new URL()
      // drops path-prefixed bases).
      const url = `${baseUrl.replace(/\/+$/, "")}/running`;
      const headers: Record<string, string> = {};
      const apiKey = def.apiKey || globals?.apiKey;
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await hotdogFetch(url, { headers, signal: controller.signal });
        if (response.ok) {
          const json = (await response.json()) as { running?: Array<{ model?: string }> };
          for (const r of json.running ?? []) {
            if (r.model) models.add(r.model);
          }
        }
      } catch {
        // Hint only: treat as nothing loaded.
      } finally {
        clearTimeout(timeoutId);
      }
    }
    cache.set(provider, { at: Date.now(), models });
    return models;
  };
}
