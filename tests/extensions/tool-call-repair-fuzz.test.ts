import { describe, it, expect } from "bun:test";
import { repairCallsInText } from "@extensions/tool-call-repair/grammar.ts";
import { create as createRepairExtension } from "@extensions/tool-call-repair/index.ts";
import { findBlocked } from "@extensions/tool-call-repair/block-proxy-artifacts.ts";
import { HOOKS } from "@core/hooks.ts";
import { ToolRegistry } from "@core/extensions/tool-registry.ts";
import { makeRng, type Rng } from "../fuzz/prng.ts";

// Fuzz suite for the tool-call repair grammar (grammar.ts) driven through the REAL registry seam:
// a tiny known tool set (read + edit with schemas) plus deliberately-unknown names, and the real
// TOOL_CALL artifact fence. Repair only ever fires on untrusted model output, so EVERY generated
// input must satisfy:
//   1. repairCallsInText never throws.
//   2. Load-bearing, asserted PER CALL (never just a count): every call surfaced as executable has
//      arguments that JSON.parse accepts into a plain object; anything ambiguous is reported
//      unrepaired with the input text byte-identical (no partial mutation).
//   3. No phantom tool names: every surfaced name is literally present in the input and matches
//      the grammar's own name charset.
//   4. Idempotence: repairing the repaired visible body yields zero calls and identical bytes;
//      repairing the same input twice yields the identical (name, args) sequence.
//   5. Surfaced args and unknown names pass through the real ToolRegistry.validateToolArgs and the
//      real TOOL_CALL gate without throwing; the gate blocks exactly when findBlocked hits.

// ── Token builders ───────────────────────────────────────────────────────────
// Same construction discipline as grammar.ts: a literal special token in this file's bytes can
// re-trigger the backend bug under test.

const LT = "<";
const GT = ">";
const T = (name: string): string => `${LT}|${name}|`;

/** Hermes-style block: pipe-delimited tokens, name after the head. */
function hermes(
  fn: string,
  params: Array<[string, string]>,
  opts: { closeFunc?: boolean; closeCall?: boolean } = {},
): string {
  const { closeFunc = true, closeCall = true } = opts;
  let s = T("tool_call") + GT + "\n";
  s += `${T("function")}${GT}=${fn}${GT}\n`;
  for (const [name, value] of params) {
    s += `${T("parameter")}${GT}=${name}${GT}\n${value}\n${T("/parameter")}${GT}\n`;
  }
  if (closeFunc) s += `${T("/function")}${GT}\n`;
  if (closeCall) s += LT + "/tool-call" + GT;
  return s;
}

/** XML/antml-style block: bare tags, name inside the head. */
function xml(
  fn: string,
  params: Array<[string, string]>,
  opts: { closeFunc?: boolean; closeCall?: boolean } = {},
): string {
  const { closeFunc = true, closeCall = true } = opts;
  let s = LT + "tool-call" + GT;
  s += `${LT}function=${fn}${GT}`;
  for (const [name, value] of params) {
    s += `${LT}parameter=${name}${GT}${value}${LT}/parameter${GT}`;
  }
  if (closeFunc) s += LT + "/function" + GT;
  if (closeCall) s += LT + "/tool-call" + GT;
  return s;
}

// ── Registry seam ────────────────────────────────────────────────────────────

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const def = (name: string, parameters: Record<string, unknown>) => ({
    metadata: { sideEffects: false, difficulty: 1 },
    toToolDef() {
      return { type: "function" as const, function: { name, description: name, parameters } };
    },
    execute: async () => "ok",
  });
  registry.register("read", def("read", {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  }));
  registry.register("edit", def("edit", {
    type: "object",
    properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  }));
  return registry;
}

function mockCore() {
  return {
    hooks: new (class {})(),
    config: { toolCallRepair: { enabled: true, maxRepairsPerTurn: -1 } },
    resolved: {},
    toolRegistry: { getAll: () => [], register: () => {}, has: () => false, remove: () => {} },
    extensions: { get: () => undefined },
  } as any;
}

function loadGate(): (toolName: string, input: string, sessionId: string) => string | null {
  const ext = createRepairExtension(mockCore());
  const gate = ((ext.hooks as any) ?? {})[HOOKS.TOOL_CALL] as (p: any) => { action: string; result: string } | undefined;
  return (toolName, input, sessionId) => {
    const out = gate({ toolName, input, agent: { sessionId, cancelled: false } });
    return out ? out.result : null;
  };
}

// ── Hostile fragment pools ───────────────────────────────────────────────────

const KNOWN_NAMES = ["read", "edit"];
const UNKNOWN_NAMES = ["frobnicate", "no_such_tool", "delete_everything", "Read", "read.v2", "tool:x", "a-b", "__proto__", "constructor", "toString"];
const BAD_NAMES = ["rea\u0000d", "\u00e9dit", "re\u200bd", "r\u0007ead", "\u4e2d\u6587", ""];

const HOSTILE_VALUES = [
  '{"path": "sr', // truncated JSON arg
  '{"a": {"b": {"c": [1,2,', // truncated nested JSON
  '{"a":"{\\"b\\":{\\"c\\":1}}"}', // nested braces inside JSON strings
  "{".repeat(3000), // thousands-deep brace run (raw data, never parsed)
  "}".repeat(1500) + '{"x":1}',
  "```\n{\"path\": \"x\"}\n```", // fenced JSON as a value
  "line1\n\nline2\u0001\u0007\t", // C0 controls + blank runs
  "\u0000\u001fzero",
  "\ud83d\ude00 cjk \u4e2d\u6587 \u0631\u0635\u064a\u062f",
  "\ud800lone-surrogate\udfff", // lone surrogates
  `pre ${LT}/parameter${GT} post`, // fake close token as data
  "true", "50", "-0", "0123", "", " ",
];

const PREFIXES = ["", "Let me check that.\n", "Sure!", T("think") + GT + " ", LT + "think" + GT, "```\n", "\n\n  ", "x"];
const SUFFIXES = ["", "\n", "```\n", ",  ", "\nand then we ship it", " done", T("/tool_call") + GT + "tail prose", LT + "/tool-call" + GT + "\n```\n, ", T("tool_call") + GT];

function genBlock(rng: Rng): string {
  const style = rng.pick([hermes, xml]);
  const name = rng.bool(0.55) ? rng.pick(KNOWN_NAMES) : rng.bool(0.8) ? rng.pick(UNKNOWN_NAMES) : rng.pick(BAD_NAMES);
  const nParams = rng.int(3);
  const params: Array<[string, string]> = [];
  for (let i = 0; i < nParams; i++) {
    const pname = rng.bool(0.85) ? rng.pick(["path", "old", "new", "pattern", "mode"]) : rng.pick(["__proto__", "constructor", "a\u0001b", "p.q", ""]);
    params.push([pname, rng.pick(HOSTILE_VALUES)]);
  }
  const opts = { closeFunc: rng.bool(0.8), closeCall: rng.bool(0.8) };
  let block = style(name, params, opts);
  if (rng.bool(0.15)) block = "```" + block; // fence glued before a block
  if (rng.bool(0.1)) block = block + "```";
  return block;
}

function genDoc(rng: Rng): string {
  const nBlocks = 1 + rng.int(3);
  const blocks: string[] = [];
  for (let i = 0; i < nBlocks; i++) blocks.push(genBlock(rng));
  // adjacent blocks with no separator (50%), junk separator, or an open token spliced between
  const sep = rng.bool(0.5) ? "" : rng.pick(["\n", " ", "```\n,\n"]);
  let doc = rng.pick(PREFIXES) + blocks.join(sep);
  if (rng.bool(0.2)) doc = doc.slice(0, Math.floor(doc.length / 2) + rng.int(20)); // truncate mid-stream
  doc += rng.pick(SUFFIXES);
  if (rng.bool(0.1)) doc += genBlock(rng); // duplicated trailing block
  return doc;
}

// ── Invariant audit ──────────────────────────────────────────────────────────

const NAME_CHARS = /^[A-Za-z0-9_.:-]+$/;

function audit(input: string, registry: ToolRegistry, gate: ReturnType<typeof loadGate>): string[] {
  const violations: string[] = [];
  let r;
  try {
    r = repairCallsInText(input);
  } catch (e) {
    return [`threw: ${(e as Error).constructor.name}: ${(e as Error).message}`];
  }

  if (!r.repaired) {
    if (r.calls.length !== 0) violations.push("repaired=false but calls surfaced");
    if (r.text !== input) violations.push("repaired=false but text mutated");
  }

  // Per-call load-bearing checks (the point of this suite: never a count).
  for (const call of r.calls) {
    const label = `call(${JSON.stringify(call.function.name).slice(0, 40)})`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.function.arguments);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        violations.push(`${label}: arguments parse to non-object: ${call.function.arguments.slice(0, 60)}`);
      }
    } catch {
      violations.push(`${label}: arguments NOT parseable: ${JSON.stringify(call.function.arguments.slice(0, 80))}`);
      continue;
    }
    if (typeof call.function.name !== "string" || call.function.name === "") {
      violations.push(`surfaced call with empty/non-string name`);
    } else {
      if (!input.includes(call.function.name)) violations.push(`${label}: phantom name, not in input`);
      if (!NAME_CHARS.test(call.function.name)) violations.push(`${label}: name outside grammar charset`);
    }
    if (!call.id.startsWith("call_")) violations.push(`${label}: forged id malformed`);
    if (call.type !== "function") violations.push(`${label}: wrong type`);
    if (registry.has(call.function.name)) {
      if (!KNOWN_NAMES.includes(call.function.name)) violations.push(`${label}: registry claims known non-seam name`);
    }
    // Gate equivalence: the fence fires exactly when findBlocked hits the serialized args.
    const gateMsg = gate(call.function.name, call.function.arguments, "fuzz-session");
    if ((gateMsg !== null) !== (findBlocked(call.function.arguments) !== null)) {
      violations.push(`${label}: gate verdict disagrees with findBlocked`);
    }
  }

  // Idempotence: the visible body must be call-free and byte-stable.
  try {
    const r2 = repairCallsInText(r.text);
    if (r2.repaired) violations.push("re-repair of visible body re-repaired (expected zero calls)");
    if (r2.calls.length !== 0) violations.push("re-repair of visible body surfaced calls");
    if (r2.text !== r.text) violations.push("re-repair mutated the visible body");
  } catch (e) {
    violations.push(`re-repair threw: ${(e as Error).message}`);
  }

  // Determinism: same input twice -> same (name, args) sequence (ids are random by design).
  const again = repairCallsInText(input);
  const sig = (x: typeof r) => x.calls.map((c) => `${c.function.name}\u0000${c.function.arguments}`).join("\u0001");
  if (sig(r) !== sig(again)) violations.push("non-deterministic repair signature");

  return violations;
}

// ── Randomized fuzz ──────────────────────────────────────────────────────────

describe("tool-call-repair grammar fuzz", () => {
  const SEED = 0x66757a7a; // fixed; three identical runs per CI job must agree
  const ITERS = 1200;

  it(`generated leaked-call docs (${ITERS}) hold every repair invariant`, () => {
    const rng = makeRng(SEED);
    const registry = makeRegistry();
    const gate = loadGate();
    const failures: { iter: number; input: string; problems: string[] }[] = [];

    for (let i = 0; i < ITERS; i++) {
      const doc = genDoc(rng);
      const problems = audit(doc, registry, gate);
      if (problems.length > 0) failures.push({ iter: i, input: doc.slice(0, 400), problems: problems.slice(0, 5) });
      if (failures.length >= 3) break;
    }

    expect(failures).toEqual([]);
  });

  it("registry seam: surfaced calls validate without throwing", async () => {
    const rng = makeRng(0x5eed01);
    const registry = makeRegistry();
    for (let i = 0; i < 400; i++) {
      const doc = genDoc(rng);
      const r = repairCallsInText(doc);
      for (const call of r.calls) {
        // Unknown names must report unknown; known names must validate cleanly or with a schema
        // error -- never throw, never hand malformed JSON downstream.
        const outcome = await registry.validateToolArgs(call.function.name, call.function.arguments);
        if (outcome !== null && typeof outcome !== "string") {
          expect(outcome).toBeTypeOf("string");
        }
      }
    }
    expect(true).toBe(true); // the invariant is "no throw"; explicit anchor for the reader
  });
});

// ── Targeted grammar fixtures (task-specified shapes) ────────────────────────

describe("tool-call-repair fuzz fixtures", () => {
  const registry = makeRegistry();
  const gate = loadGate();
  for (const [label, input] of [
    ["adjacent no-separator", hermes("read", [["path", "a"]]) + hermes("edit", [["path", "b"]])],
    ["truncated json arg", xml("read", [["path", '{"a": "trunc']])],
    ["nested braces in string value", hermes("read", [["path", '{"b":"{c}"}']])],
    ["thousands-deep braces", hermes("read", [["deep", "{".repeat(5000)]])],
    ["fenced wrapper", "```json\n" + hermes("read", [["path", "x"]]) + "\n```"],
    ["duplicated open tokens", T("tool_call") + GT + T("tool_call") + GT + `${T("function")}${GT}=read${GT}\n${T("parameter")}${GT}=path${GT}\nv\n${T("/parameter")}${GT}${T("/function")}${GT}${T("/tool_call")}${GT}`],
    ["nested call inside value", xml("read", [["path", T("tool_call") + GT + "x"]])],
    ["c0 in name and value", xml("rea\u0000d", [["p\u0007q", "a\u0000b"]])],
    ["unicode name", xml("\u4e2d\u6587", [["path", "x"]])],
    ["proto param name", hermes("read", [["__proto__", "5"], ["path", "b"]])],
    ["constructor param name", hermes("read", [["constructor", "5"], ["path", "b"]])],
  ] as ReadonlyArray<readonly [string, string]>) {
    it(`fixture: ${label}`, () => {
      expect(audit(input, registry, gate)).toEqual([]);
    });
  }

  it("proto/constructor params are preserved in surfaced args (regression: silent drop)", () => {
    const r = repairCallsInText(hermes("read", [["__proto__", "5"], ["path", "b"], ["constructor", "7"]]));
    expect(r.repaired).toBe(true);
    const args = JSON.parse(r.calls[0]!.function.arguments);
    expect(Object.prototype.hasOwnProperty.call(args, "__proto__")).toBe(true);
    expect(args.__proto__).toBe(5); // coerceScalar turns "5" into the number, as for any plain-numeric value
    expect(args.path).toBe("b");
    expect(args.constructor).toBe(7);
    // and no pollution anywhere:
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("huge pathological inputs finish fast (linear scans)", () => {
    const input = (T("tool_call") + GT).repeat(30000);
    const t0 = performance.now();
    const r = repairCallsInText(input);
    const ms = performance.now() - t0;
    expect(r.repaired).toBe(false);
    expect(ms).toBeLessThan(1000);
    const deep = hermes("read", [["deep", "{".repeat(200000) + "}"]]);
    const t1 = performance.now();
    repairCallsInText(deep);
    expect(performance.now() - t1).toBeLessThan(1000);
  });
});

// ── block-proxy-artifacts: seeded decision table through the real gate ──────
// Hosts are assembled from fragments so this file's own bytes never match the blocklist
// (same discipline as block-proxy-artifacts.test.ts).

describe("block-proxy-artifacts decision table (seeded)", () => {
  const LABEL_SG = "routify" + "-file-proxy-sg";
  const LABEL_OVERSEA = "routify" + "-file-oversea";
  const LABEL_PLAIN = "routify" + "-file";
  const EP_PUBLIC = ".oss-ap-southeast-1" + ".aliyuncs.com";
  const EP_DUAL = ".ap-southeast-1.oss" + ".aliyuncs.com";
  const EP_ACCEL = ".oss-accelerate" + ".aliyuncs.com";
  const EP_IO = ".oss-ap-southeast-1" + ".aliyuncs.io";
  const EP_OTHER = ".oss-cn-hangzhou" + ".aliyuncs.com";

  // expected: true => TOOL_CALL gate blocks; false => gate abstains (call proceeds).
  const TABLE: Array<[string, boolean]> = [
    [LABEL_SG + EP_PUBLIC, true], // rule 1: incident host
    [LABEL_SG + EP_PUBLIC.toUpperCase(), true], // case-insensitive
    [LABEL_OVERSEA + EP_DUAL, true], // rule 2 dual-stack
    [LABEL_OVERSEA + EP_ACCEL, true], // rule 2 proxy-less accelerate
    [LABEL_SG + EP_IO, true], // rule 2 io TLD
    [LABEL_PLAIN + EP_PUBLIC, true], // rule 2 bare label
    ["routify" + "x".repeat(12) + "file" + EP_PUBLIC, true], // gap at the 12-char cap
    ["routifyFile" + EP_PUBLIC, true], // zero gap
    ["routify" + "x".repeat(13) + "file" + EP_PUBLIC, false], // gap beyond cap
    [LABEL_PLAIN + "-y".repeat(57) + EP_PUBLIC, false], // tail beyond 56-char budget
    [LABEL_SG + EP_OTHER, true], // rule 2 any region
    [LABEL_SG + ".example.com", false], // label off aliyuncs
    [`grep -rn ${LABEL_SG} src/`, false], // bare mention, no endpoint
    ["my-bucket" + EP_OTHER, false], // legitimate third-party bucket
    ["cdn" + EP_PUBLIC, false], // endpoint without routify label
    [LABEL_SG + EP_PUBLIC + ".evil.io", true], // prefix saturation: substring rules block
    [LABEL_SG + ".oss-ap-southeast-1" + ".aliyuncs.co", false], // truncated TLD
    [LABEL_SG + ".oss-ap-southeast-1" + ".aliyuncsiocom", false], // TLD dot mandatory
  ];

  it("gate block/pass decisions match the pinned table", () => {
    const gate = loadGate();
    const mismatched: string[] = [];
    const rng = makeRng(0xda7ab1e); // seeded visit order; decisions themselves are fixed
    const order = TABLE.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (const i of order) {
      const [host, expected] = TABLE[i]!;
      const input = `https://${host}/proxy_temp_file/production/trace_210184/9296a87?Expires=1814047991`;
      const session = `dt-${i}`;
      const blocked = gate("fetch", input, session) !== null;
      if (blocked !== expected) mismatched.push(`${JSON.stringify(host.slice(0, 48))}: expected ${expected ? "block" : "pass"}, got ${blocked ? "block" : "pass"}`);
    }
    expect(mismatched).toEqual([]);
  });

  it("cross the fuzz corpus: gate fires exactly on findBlocked hits", () => {
    const rng = makeRng(0xc0ffee01);
    const gate = loadGate();
    let blockedCount = 0;
    for (let i = 0; i < 600; i++) {
      const doc = genDoc(rng);
      const r = repairCallsInText(doc);
      for (const call of r.calls) {
        const msg = gate(call.function.name, call.function.arguments, `x-${i}`);
        const hit = findBlocked(call.function.arguments);
        if ((msg !== null) !== (hit !== null)) {
          expect(msg !== null).toBe(hit !== null);
        }
        if (msg !== null) {
          blockedCount++;
          expect(msg).toContain("Do NOT retry");
        }
        // Blocked or not, args that reached here are parseable (invariant 2 holds pre-gate too).
        expect(() => JSON.parse(call.function.arguments)).not.toThrow();
      }
    }
    expect(blockedCount).toBe(0); // corpus carries no routify shapes; fence never false-fires
  });
});
