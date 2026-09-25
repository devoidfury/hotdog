/**
 * Workflow artifact module — pure: parse, validate, render. No execution, no
 * I/O, no fleet access.
 *
 * A workflow is a versioned YAML graph of worker nodes. The manager's designed
 * graphs pass through the exact same `parseWorkflow` as hand-authored files;
 * the returned errors are repair-worthy so the model can fix and resubmit.
 */

import { YAML } from "bun";

/** Defaults when no config overrides are passed via opts (configSchema
 *  defaults live in extension.json). hardMaxNodes and maxAttempts are
 *  absolute ceilings a workflow may not raise. */
export const DEFAULT_WORKFLOW_LIMITS = {
  maxNodes: 8,
  hardMaxNodes: 32,
  maxAttempts: 3,
  maxRuntimeMins: 30,
};

export const WORKFLOW_SCHEMA_VERSION = 1;

export interface WorkflowLimits {
  /** Soft cap: exceeding it warns. Overridable by config and by the workflow. */
  maxNodes: number;
  /** Hard ceiling on node count; a workflow may not raise it. */
  hardMaxNodes: number;
  /** Hard ceiling on accept.maxAttempts. */
  maxAttempts: number;
  /** Default per-node runtime cap, minutes. */
  maxRuntimeMins: number;
}

export interface NodeRequirements {
  ctx?: number;
  vision?: boolean;
  toolCalls?: boolean;
  toolDifficulty?: number;
}

export interface AcceptSpec {
  /** Relative paths the node must leave in the run dir, checked fresh. */
  files: string[];
  /** Node id used as a verdict gate after this node's files pass. */
  judge?: string;
  retryOn: ("fail" | "reject")[];
  maxAttempts: number;
}

export interface WorkflowNode {
  id: string;
  description?: string;
  profile?: string;
  requires?: NodeRequirements;
  pin?: { provider?: string; model?: string };
  /** Declared model-group fanout (config modelGroups): any member with a free lane. Mutually exclusive with pin. */
  group?: string;
  dependsOn: string[];
  /** key -> "nodes.<id>[.<field>]" data reference (braces stripped). */
  inputs: Record<string, string>;
  accept: AcceptSpec;
  maxRuntimeMins?: number;
}

export interface Workflow {
  version: number;
  name: string;
  description: string;
  limits: { maxNodes: number; maxRuntimeMins?: number };
  nodes: WorkflowNode[];
}

export interface ParseResult {
  /** Non-null only when `errors` is empty. */
  workflow: Workflow | null;
  errors: string[];
  warnings: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// "nodes.<id>" or "nodes.<id>.<field.path>" — a pure reference, no prose.
const DATA_REF_RE = /^nodes\.([a-z0-9][a-z0-9-]*)((?:\.[A-Za-z0-9_-]+)*)$/;
const RETRY_ON = new Set(["fail", "reject"]);

const TOP_KEYS = new Set(["version", "name", "description", "limits", "nodes"]);
const NODE_KEYS = new Set([
  "id", "description", "profile", "requires", "pin", "group",
  "dependsOn", "inputs", "accept", "maxRuntimeMins",
]);
const REQUIRES_KEYS = new Set(["ctx", "vision", "toolCalls", "toolDifficulty"]);
const PIN_KEYS = new Set(["provider", "model"]);
const ACCEPT_KEYS = new Set(["files", "judge", "retryOn", "maxAttempts"]);
const LIMITS_KEYS = new Set(["maxNodes", "maxRuntimeMins"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Collect unknown keys as errors — typos in a designed graph must fail loud. */
function checkKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
  errors: string[],
): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`${where}: unknown key '${k}'`);
  }
}

function parseWorkflowObject(
  root: Record<string, unknown>,
  limits: WorkflowLimits,
): { workflow: Workflow | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  checkKeys(root, TOP_KEYS, "workflow", errors);

  if (root.version !== WORKFLOW_SCHEMA_VERSION) {
    errors.push(
      `workflow: version must be ${WORKFLOW_SCHEMA_VERSION}, got ${JSON.stringify(root.version)}`,
    );
  }
  const name = root.name;
  if (typeof name !== "string" || !ID_RE.test(name)) {
    errors.push(`workflow: 'name' must match ${ID_RE}`);
  }
  const description = root.description;
  if (typeof description !== "string" || description.trim() === "") {
    errors.push("workflow: 'description' must be a non-empty string");
  }

  let softMaxNodes = limits.maxNodes;
  let maxRuntimeMins: number | undefined;
  if (root.limits !== undefined) {
    if (!isObj(root.limits)) {
      errors.push("workflow: 'limits' must be a mapping");
    } else {
      checkKeys(root.limits, LIMITS_KEYS, "workflow.limits", errors);
      const mn = root.limits.maxNodes;
      if (mn !== undefined) {
        if (typeof mn !== "number" || !Number.isInteger(mn) || mn < 1) {
          errors.push("workflow.limits: 'maxNodes' must be a positive integer");
        } else if (mn > limits.hardMaxNodes) {
          errors.push(
            `workflow.limits: 'maxNodes' ${mn} exceeds hard ceiling ${limits.hardMaxNodes}`,
          );
        } else {
          softMaxNodes = mn;
        }
      }
      const rt = root.limits.maxRuntimeMins;
      if (rt !== undefined) {
        if (typeof rt !== "number" || !Number.isInteger(rt) || rt < 1) {
          errors.push("workflow.limits: 'maxRuntimeMins' must be a positive integer");
        } else {
          maxRuntimeMins = rt;
        }
      }
    }
  }

  if (!Array.isArray(root.nodes) || root.nodes.length === 0) {
    errors.push("workflow: 'nodes' must be a non-empty array");
    return { workflow: null, errors, warnings };
  }
  if (root.nodes.length > limits.hardMaxNodes) {
    errors.push(
      `workflow: ${root.nodes.length} nodes exceeds hard ceiling ${limits.hardMaxNodes}`,
    );
  } else if (root.nodes.length > softMaxNodes) {
    warnings.push(
      `workflow: ${root.nodes.length} nodes exceeds soft cap ${softMaxNodes} (configurable via limits.maxNodes)`,
    );
  }

  const nodes: WorkflowNode[] = [];
  const seen = new Set<string>();
  root.nodes.forEach((raw, i) => {
    const where = `node[${i}]${isObj(raw) && typeof raw.id === "string" ? ` '${raw.id}'` : ""}`;
    if (!isObj(raw)) {
      errors.push(`${where}: must be a mapping`);
      return;
    }
    checkKeys(raw, NODE_KEYS, where, errors);

    const id = raw.id;
    if (typeof id !== "string" || !ID_RE.test(id)) {
      errors.push(`${where}: 'id' must match ${ID_RE}`);
      return; // unaddressable node — every later rule needs a usable id
    }
    if (seen.has(id)) {
      errors.push(`${where}: duplicate id '${id}'`);
      return;
    }
    seen.add(id);

    const node: WorkflowNode = { id, dependsOn: [], inputs: {}, accept: defaultAccept() };
    for (const key of ["description", "profile"] as const) {
      const v = raw[key];
      if (v !== undefined) {
        if (typeof v !== "string" || v.trim() === "") {
          errors.push(`${where}: '${key}' must be a non-empty string`);
        } else {
          node[key] = v;
        }
      }
    }

    if (raw.requires !== undefined) {
      if (!isObj(raw.requires)) {
        errors.push(`${where}: 'requires' must be a mapping`);
      } else {
        checkKeys(raw.requires, REQUIRES_KEYS, `${where}.requires`, errors);
        const req: NodeRequirements = {};
        const ctx = raw.requires.ctx;
        if (ctx !== undefined) {
          if (typeof ctx !== "number" || !Number.isInteger(ctx) || ctx < 1) {
            errors.push(`${where}.requires: 'ctx' must be a positive integer`);
          } else req.ctx = ctx;
        }
        for (const key of ["vision", "toolCalls"] as const) {
          const v = raw.requires[key];
          if (v !== undefined) {
            if (typeof v !== "boolean") {
              errors.push(`${where}.requires: '${key}' must be a boolean`);
            } else if (v) req[key] = true; // false == "no requirement"
          }
        }
        const td = raw.requires.toolDifficulty;
        if (td !== undefined) {
          if (typeof td !== "number" || !Number.isInteger(td) || td < 1 || td > 5) {
            errors.push(`${where}.requires: 'toolDifficulty' must be an integer 1-5`);
          } else req.toolDifficulty = td;
        }
        node.requires = req;
      }
    }

    if (raw.pin !== undefined) {
      if (!isObj(raw.pin)) {
        errors.push(`${where}: 'pin' must be a mapping`);
      } else {
        checkKeys(raw.pin, PIN_KEYS, `${where}.pin`, errors);
        const pin: { provider?: string; model?: string } = {};
        for (const key of ["provider", "model"] as const) {
          const v = raw.pin[key];
          if (v !== undefined) {
            if (typeof v !== "string" || v.trim() === "") {
              errors.push(`${where}.pin: '${key}' must be a non-empty string`);
            } else pin[key] = v;
          }
        }
        node.pin = pin;
      }
    }

    if (raw.group !== undefined) {
      const g = raw.group;
      if (typeof g !== "string" || !ID_RE.test(g)) {
        errors.push(`${where}: 'group' must be a model-group name (kebab-case id)`);
      } else if (raw.pin !== undefined) {
        errors.push(`${where}: 'pin' and 'group' are mutually exclusive`);
      } else {
        node.group = g;
      }
    }

    if (raw.dependsOn !== undefined) {
      if (!Array.isArray(raw.dependsOn) || raw.dependsOn.some((d) => typeof d !== "string")) {
        errors.push(`${where}: 'dependsOn' must be an array of node ids`);
      } else {
        node.dependsOn = raw.dependsOn as string[];
      }
    }

    if (raw.inputs !== undefined) {
      if (!isObj(raw.inputs)) {
        errors.push(`${where}: 'inputs' must be a mapping`);
      } else {
        for (const [key, val] of Object.entries(raw.inputs)) {
          if (!ID_RE.test(key)) {
            errors.push(`${where}.inputs: key '${key}' must match ${ID_RE}`);
            continue;
          }
          // Authors may wrap refs in {{ }}; strip before validating shape.
          const body =
            typeof val === "string"
              ? val.replace(/^\{\{|\}\}$/g, "").trim()
              : (val as unknown);
          if (typeof body !== "string" || !DATA_REF_RE.test(body)) {
            errors.push(
              `${where}.inputs: '${key}' must be a reference like {{nodes.<id>}} or {{nodes.<id>.<field>}}`,
            );
            continue;
          }
          node.inputs[key] = body;
        }
      }
    }

    if (raw.accept !== undefined) {
      if (!isObj(raw.accept)) {
        errors.push(`${where}: 'accept' must be a mapping`);
      } else {
        checkKeys(raw.accept, ACCEPT_KEYS, `${where}.accept`, errors);
        const acc: AcceptSpec = defaultAccept();
        if (raw.accept.files !== undefined) {
          const files = raw.accept.files;
          if (!Array.isArray(files) || files.some((f) => typeof f !== "string")) {
            errors.push(`${where}.accept: 'files' must be an array of paths`);
          } else {
            for (const f of files as string[]) {
              if (f.startsWith("/") || f.split("/").includes("..")) {
                errors.push(
                  `${where}.accept: file '${f}' must be a relative path inside the run dir`,
                );
              }
            }
            acc.files = files as string[];
          }
        }
        const judge = raw.accept.judge;
        if (judge !== undefined) {
          if (typeof judge !== "string" || !ID_RE.test(judge)) {
            errors.push(`${where}.accept: 'judge' must be a node id`);
          } else acc.judge = judge;
        }
        if (raw.accept.retryOn !== undefined) {
          const ro = raw.accept.retryOn;
          if (!Array.isArray(ro) || ro.some((r) => typeof r !== "string" || !RETRY_ON.has(r))) {
            errors.push(`${where}.accept: 'retryOn' must be an array of 'fail' / 'reject'`);
          } else {
            acc.retryOn = ro as AcceptSpec["retryOn"];
          }
        }
        const ma = raw.accept.maxAttempts;
        if (ma !== undefined) {
          if (typeof ma !== "number" || !Number.isInteger(ma) || ma < 1 || ma > limits.maxAttempts) {
            errors.push(`${where}.accept: 'maxAttempts' must be an integer 1-${limits.maxAttempts}`);
          } else acc.maxAttempts = ma;
        }
        node.accept = acc;
      }
    }

    const mrt = raw.maxRuntimeMins;
    if (mrt !== undefined) {
      if (typeof mrt !== "number" || !Number.isInteger(mrt) || mrt < 1) {
        errors.push(`${where}: 'maxRuntimeMins' must be a positive integer`);
      } else {
        node.maxRuntimeMins = mrt;
      }
    }

    nodes.push(node);
  });

  if (errors.length > 0) return { workflow: null, errors, warnings };

  // --- cross-node pass: references, combined-edge cycles, judge placement ---
  const ids = new Set(nodes.map((n) => n.id));

  // Combined ordering edges: dependsOn + data refs (data implies ordering).
  const upstream = new Map<string, Set<string>>(); // node -> its dependency ids
  for (const n of nodes) upstream.set(n.id, new Set(n.dependsOn));
  for (const n of nodes) {
    for (const [key, ref] of Object.entries(n.inputs)) {
      // refs are stored only after matching DATA_REF_RE, so exec always hits
      const target = DATA_REF_RE.exec(ref)?.[1] ?? "";
      if (target === n.id) {
        errors.push(`node '${n.id}': input '${key}' references itself`);
      } else if (!ids.has(target)) {
        errors.push(`node '${n.id}': input '${key}' references unknown node '${target}'`);
      } else {
        upstream.get(n.id)!.add(target);
      }
    }
  }
  for (const n of nodes) {
    for (const d of n.dependsOn) {
      if (d === n.id) errors.push(`node '${n.id}': dependsOn itself`);
      else if (!ids.has(d)) errors.push(`node '${n.id}': dependsOn unknown node '${d}'`);
    }
  }
  if (errors.length > 0) return { workflow: null, errors, warnings };

  const cycle = findCycle(nodes.map((n) => n.id), upstream);
  if (cycle) {
    errors.push(`cycle: ${cycle.join(" -> ")}`);
    return { workflow: null, errors, warnings };
  }

  for (const n of nodes) {
    const judge = n.accept.judge;
    if (!judge) continue;
    if (judge === n.id) {
      errors.push(`node '${n.id}': accept.judge cannot be itself`);
    } else if (!ids.has(judge)) {
      errors.push(`node '${n.id}': accept.judge references unknown node '${judge}'`);
    } else if (!ancestorsOf(judge, upstream).has(n.id)) {
      errors.push(
        `node '${n.id}': judge '${judge}' must depend (transitively) on the node it gates`,
      );
    }
  }

  // Engine gate semantics: the judge runs *before* the gated node settles
  // (its verdict decides acceptance). So a judge may gate exactly one node,
  // and no other upstream of the judge may itself wait on the gated node --
  // it would never finish while the gate is open (deadlock).
  const judgeOwners = new Map<string, string>(); // judge id -> gated node id
  for (const n of nodes) {
    const j = n.accept.judge;
    if (!j || !ids.has(j) || j === n.id) continue;
    const prev = judgeOwners.get(j);
    if (prev && prev !== n.id) {
      errors.push(`judge '${j}' gates multiple nodes ('${prev}' and '${n.id}'); a judge gates exactly one`);
    } else {
      judgeOwners.set(j, n.id);
    }
  }
  for (const [judge, gated] of judgeOwners) {
    for (const anc of ancestorsOf(judge, upstream)) {
      if (anc === gated) continue;
      if (ancestorsOf(anc, upstream).has(gated)) {
        errors.push(
          `node '${gated}': judge '${judge}' has upstream dependency '${anc}' that depends on the gated node; the judge gate would deadlock`,
        );
      }
    }
  }
  // A judge that is itself gated (declares its own accept.judge) is never
  // driven: a gate owner's #runJudge evaluates only the judge's own gate and
  // returns the verdict value, and a judge never runs its own #runNode (it is
  // gated off there). The inner judge would never terminate, so any node that
  // depends on it awaits forever and run() hangs. Reject at validation.
  for (const n of nodes) {
    if (!judgeOwners.has(n.id)) continue; // n is someone's judge
    if (n.accept.judge) {
      errors.push(
        `node '${n.id}': a judge may not itself be gated (accept.judge '${n.accept.judge}')`,
      );
    }
  }
  if (errors.length > 0) return { workflow: null, errors, warnings };

  return {
    workflow: {
      version: WORKFLOW_SCHEMA_VERSION,
      name: name as string,
      description: description as string,
      limits: { maxNodes: softMaxNodes, ...(maxRuntimeMins !== undefined ? { maxRuntimeMins } : {}) },
      nodes,
    },
    errors,
    warnings,
  };
}

function defaultAccept(): AcceptSpec {
  return { files: [], retryOn: ["fail", "reject"], maxAttempts: 1 };
}

/** Kahn's algorithm; ties broken by declaration order for determinism.
 *  Returns null when acyclic, else one concrete cycle path (a -> b -> a). */
function findCycle(ids: string[], upstream: Map<string, Set<string>>): string[] | null {
  const remaining = new Map<string, Set<string>>();
  const downstream = new Map<string, string[]>();
  for (const id of ids) {
    remaining.set(id, new Set(upstream.get(id)!));
    downstream.set(id, []);
  }
  for (const [id, deps] of remaining) {
    for (const d of deps) downstream.get(d)!.push(id);
  }
  const queue = ids.filter((id) => remaining.get(id)!.size === 0);
  let solved = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    remaining.delete(id); // solved nodes must not pollute the cycle remainder
    solved++;
    for (const next of downstream.get(id)!) {
      const deps = remaining.get(next)!;
      deps.delete(id);
      if (deps.size === 0) {
        remaining.delete(next);
        queue.push(next);
      }
    }
  }
  if (solved === ids.length) return null;

  // Extract one concrete cycle from the tangled remainder via DFS.
  const tangle = new Set(remaining.keys());
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();
  let cycle: string[] | null = null;
  const dfs = (id: string): boolean => {
    stack.push(id);
    onStack.add(id);
    for (const d of remaining.get(id) ?? upstream.get(id) ?? []) {
      if (!tangle.has(d)) continue;
      if (onStack.has(d)) {
        cycle = [...stack.slice(stack.indexOf(d)), d];
        return true;
      }
      if (!visited.has(d) && dfs(d)) return true;
    }
    stack.pop();
    onStack.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of tangle) {
    if (!visited.has(id) && dfs(id)) break;
  }
  return cycle ?? ["?"];
}

/** All strict ancestors of `start` (transitive upstream closure). */
function ancestorsOf(start: string, upstream: Map<string, Set<string>>): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    for (const d of upstream.get(queue.shift()!) ?? []) {
      if (!seen.has(d)) {
        seen.add(d);
        queue.push(d);
      }
    }
  }
  return seen;
}

/** Parse and validate a `.workflow.yaml` document. Never throws on bad input. */
export function parseWorkflow(
  text: string,
  opts: { limits?: Partial<WorkflowLimits> } = {},
): ParseResult {
  const limits: WorkflowLimits = { ...DEFAULT_WORKFLOW_LIMITS, ...opts.limits };
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (e) {
    return { workflow: null, errors: [`yaml: ${e instanceof Error ? e.message : String(e)}`], warnings: [] };
  }
  if (!isObj(parsed)) {
    return { workflow: null, errors: ["workflow: document must be a mapping"], warnings: [] };
  }
  return parseWorkflowObject(parsed, limits);
}

/** Combined ordering deps of a node: dependsOn + every data-reference upstream (declaration order). */
export function nodeDeps(n: WorkflowNode): string[] {
  const deps = new Set(n.dependsOn);
  for (const ref of Object.values(n.inputs)) {
    const t = DATA_REF_RE.exec(ref)?.[1];
    if (t) deps.add(t);
  }
  return [...deps];
}

/** Topological execution order (declaration order among ready ties).
 *  Assumes an already-validated workflow. */
export function topoOrder(wf: Workflow): string[] {
  const upstream = new Map<string, Set<string>>();
  for (const n of wf.nodes) upstream.set(n.id, new Set(nodeDeps(n)));
  const order: string[] = [];
  const done = new Set<string>();
  let progressed = true;
  while (order.length < wf.nodes.length && progressed) {
    progressed = false;
    for (const n of wf.nodes) {
      if (done.has(n.id)) continue;
      if ([...upstream.get(n.id)!].every((d) => done.has(d))) {
        order.push(n.id);
        done.add(n.id);
        progressed = true;
      }
    }
  }
  return order; // length === nodes.length for validated graphs
}

/** Deterministic plain-text rendering, byte-identical for identical inputs.
 *  For humans in `hotdog workflow render` and for the manager's eyes. */
export function renderWorkflow(wf: Workflow): string {
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  lines.push(`workflow ${wf.name} (v${wf.version})`);
  lines.push(`  ${wf.description}`);
  lines.push(
    `  limits: maxNodes ${wf.limits.maxNodes}, maxRuntime default ${wf.limits.maxRuntimeMins ?? DEFAULT_WORKFLOW_LIMITS.maxRuntimeMins}m`,
  );
  lines.push("");
  lines.push("nodes (execution order):");
  topoOrder(wf).forEach((id, i) => {
    const n = byId.get(id)!;
    lines.push(`  ${i + 1}. ${id}${n.profile ? ` [profile=${n.profile}]` : ""}`);
    if (n.description) lines.push(`     ${n.description}`);
    const reqs: string[] = [];
    if (n.requires?.ctx) reqs.push(`ctx>=${n.requires.ctx}`);
    if (n.requires?.vision) reqs.push("vision");
    if (n.requires?.toolCalls) reqs.push("tool-calls");
    if (n.requires?.toolDifficulty) reqs.push(`tool-difficulty>=${n.requires.toolDifficulty}`);
    if (reqs.length) lines.push(`     requires: ${reqs.join(", ")}`);
    if (n.pin && (n.pin.provider || n.pin.model)) {
      lines.push(`     pin: ${n.pin.provider ? `${n.pin.provider}/` : ""}${n.pin.model ?? ""}`);
    }
    if (n.group) lines.push(`     group: ${n.group}`);
    if (n.dependsOn.length) lines.push(`     depends: ${n.dependsOn.join(", ")}`);
    for (const [key, ref] of Object.entries(n.inputs)) {
      lines.push(`     input ${key} <- ${ref}`);
    }
    const acc: string[] = [];
    acc.push(n.accept.files.length ? `${n.accept.files.length} file(s)` : "verdict only");
    if (n.accept.judge) acc.push(`judge=${n.accept.judge}`);
    acc.push(
      n.accept.maxAttempts > 1
        ? `attempts=${n.accept.maxAttempts} retry-on ${n.accept.retryOn.join("|")}`
        : "attempts=1",
    );
    lines.push(`     accept: ${acc.join(", ")}`);
    if (n.maxRuntimeMins) lines.push(`     max-runtime: ${n.maxRuntimeMins}m`);
  });
  const dataEdges: string[] = [];
  for (const n of wf.nodes) {
    for (const [key, ref] of Object.entries(n.inputs)) {
      dataEdges.push(`  ${n.id}.${key} <- ${ref}`);
    }
  }
  if (dataEdges.length) {
    lines.push("");
    lines.push("data edges:");
    lines.push(...dataEdges);
  }
  return lines.join("\n") + "\n";
}
