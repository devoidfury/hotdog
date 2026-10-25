import { describe, it, expect } from "bun:test";
import { validate, validateParams, parseOrThrow } from "@utils/json-schema.ts";
import { makeRng, type Rng } from "../fuzz/prng.ts";

// Fuzz suite for the lightweight JSON-Schema validator in src/utils/json-schema.ts.
//
// SUPPORTED SUBSET (read from the source; the intent corpus stays inside it):
//   type (single string; unknown names or array values are skipped by the validator),
//   enum (JSON-stringify equality), const, default (checks skipped when the value stringify-matches),
//   minLength/maxLength (UTF-16 code units), pattern (JS RegExp source; an invalid pattern yields a
//   validation error, never a throw -- regression pinned below),
//   minimum/maximum/exclusiveMinimum/exclusiveMaximum,
//   required, properties (listed keys only), additionalProperties (strictly === false),
//   items (single schema), minItems/maxItems.
// OUTSIDE THE SUBSET (silently ignored by the validator; only never-crash + pinned-current-behavior
// assertions, see the hostile/out-of-subset section): anyOf, oneOf, allOf, not, if/then/else, $ref,
// format, uniqueItems, array-valued type, tuple items, non-object schemas.
//
// Pinned quirks of this subset (asserted, deliberately not "fixed"):
//   - enum/const compare via JSON.stringify: -0 equals 0, NaN equals null, "1" never equals 1.
//   - required/properties membership uses `in`, so prototype-chain names are visible on plain objects.
//   - The intent generator uses only "kN" property names; prototype-named shapes get their own pinned table.

// ── Seeded generator: schema + conforming instance + per-rule near-miss mutations ──

interface Bad {
  value: unknown;
  rule: string;
}

interface Gen {
  schema: Record<string, unknown>;
  conform: (rng: Rng) => unknown;
  bad: (rng: Rng) => Bad; // near-miss replacing THIS node's value, violating a named rule
  children: () => Array<{ key: string | number; gen: Gen }>;
}

const PATTERN_POOL: Array<{ p: string; ok: string; not: string }> = [
  { p: "^[a-z]+$", ok: "abc", not: "ABC9" },
  { p: "^[0-9]{2,4}$", ok: "1234", not: "abcd" },
  { p: "^[A-Za-z0-9._-]{3,10}$", ok: "a_b-c.1", not: "!!!" },
  { p: "^\\d{4}-\\d{2}$", ok: "2026-10", not: "26-1" },
];

function genString(rng: Rng): Gen {
  const pat = rng.bool(0.4) ? rng.pick(PATTERN_POOL) : null;
  // bounds keep room for a conforming sample of every pool entry (ok len >= 3, <= 7)
  const minL = rng.bool(0.5) ? 1 + rng.int(2) : undefined; // 1..2
  const maxL = rng.bool(0.5) ? 7 + rng.int(3) : undefined; // 7..9
  const schema: Record<string, unknown> = { type: "string" };
  if (minL !== undefined) schema.minLength = minL;
  if (maxL !== undefined) schema.maxLength = maxL;
  if (pat !== null) schema.pattern = pat.p;
  return {
    schema,
    conform: () => (pat === null ? "alpha" : pat.ok), // 5/3..7 units: inside every declared bound
    bad: (r) => {
      const opts: Bad[] = [{ value: 42, rule: "type" }, { value: true, rule: "type" }];
      if (minL !== undefined) opts.push({ value: "x".repeat(minL - 1), rule: "minLength" });
      if (maxL !== undefined) opts.push({ value: "x".repeat(maxL + 1), rule: "maxLength" });
      if (pat !== null) opts.push({ value: pat.not + "z".repeat(12), rule: "pattern" });
      return r.pick(opts);
    },
    children: () => [],
  };
}

function genNumber(rng: Rng): Gen {
  const integer = rng.bool(0.5);
  const hasMin = rng.bool(0.6);
  const hasMax = rng.bool(0.6);
  const hasExcl = rng.bool(0.4);
  const lo = hasMin ? 5 + rng.int(15) : undefined; // 5..19
  const hi = hasMax ? 60 + rng.int(30) : undefined; // 60..89
  const schema: Record<string, unknown> = { type: integer ? "integer" : "number" };
  if (lo !== undefined) schema.minimum = lo;
  if (hi !== undefined) schema.maximum = hi;
  if (hasExcl) schema.exclusiveMinimum = 0;
  return {
    schema,
    conform: (r) => {
      const a = lo ?? (hasExcl ? 1 : 0);
      const b = hi ?? 100;
      return a + r.int(b - a + 1); // integer, inside every declared bound, > 0 when exclusive
    },
    bad: (r) => {
      const opts: Bad[] = [{ value: "5", rule: "type" }, { value: NaN, rule: "type" }];
      if (lo !== undefined) opts.push({ value: lo - 1, rule: "minimum" });
      if (hi !== undefined) opts.push({ value: hi + 1, rule: "maximum" });
      if (hasExcl) opts.push({ value: 0, rule: "exclusiveMinimum" });
      if (integer) opts.push({ value: 0.5, rule: "integer" });
      return r.pick(opts);
    },
    children: () => [],
  };
}

function genBoolean(_rng: Rng): Gen {
  return {
    schema: { type: "boolean" },
    conform: (r) => r.bool(),
    bad: () => ({ value: "true", rule: "type" }), // the STRING "true", not the boolean
    children: () => [],
  };
}

function genNull(_rng: Rng): Gen {
  return {
    schema: { type: "null" },
    conform: () => null,
    bad: () => ({ value: 0, rule: "type" }), // 0 is not null (null-type check is strict)
    children: () => [],
  };
}

function genEnum(rng: Rng): Gen {
  const numeric = rng.bool(0.5);
  const enumVals: unknown[] = numeric ? [0, 1, 2] : ["red", "green", "blue"];
  return {
    schema: { type: numeric ? "number" : "string", enum: enumVals },
    conform: (r) => enumVals[r.int(enumVals.length)]!,
    bad: (r) => ({ value: numeric ? r.pick([99, -1, 7]) : r.pick(["zz-miss", "", "RED"]), rule: "enum" }),
    children: () => [],
  };
}

function genConst(rng: Rng): Gen {
  const v: unknown = rng.pick(["fixed", 7, true]);
  return {
    schema: { const: v },
    conform: () => v,
    bad: () => ({ value: v === "fixed" ? "other" : "fixed", rule: "const" }), // stringify-distinct
    children: () => [],
  };
}

const LEAVES: Array<(rng: Rng) => Gen> = [genString, genString, genNumber, genNumber, genBoolean, genNull, genEnum, genConst];

function genNode(rng: Rng, depth: number): Gen {
  if (depth >= 5) return rng.pick(LEAVES)(rng);
  const roll = rng.float();
  if (roll < 0.28) return genObject(rng, depth);
  if (roll < 0.42) return genArray(rng, depth);
  return rng.pick(LEAVES)(rng);
}

function genObject(rng: Rng, depth: number): Gen {
  const nProps = 1 + rng.int(3);
  const props: Record<string, Gen> = {};
  for (let i = 0; i < nProps; i++) props[`k${i}`] = genNode(rng, depth + 1);
  const keys = Object.keys(props);
  const required = keys.filter(() => rng.bool(0.5));
  const closed = rng.bool(0.4);
  const schema: Record<string, unknown> = {
    type: "object",
    properties: Object.fromEntries(Object.entries(props).map(([k, g]) => [k, g.schema])),
    required,
  };
  if (closed) schema.additionalProperties = false;
  const full = (r: Rng): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    for (const [k, g] of Object.entries(props)) obj[k] = g.conform(r); // superset: always satisfies required
    return obj;
  };
  return {
    schema,
    conform: (r) => full(r),
    bad: (r) => {
      const opts: Bad[] = [{ value: [1], rule: "type" }, { value: null, rule: "type" }];
      if (required.length > 0) {
        const drop = required[r.int(required.length)]!;
        const without = full(r);
        delete without[drop];
        opts.push({ value: without, rule: "required" });
      }
      if (closed) {
        const extra = full(r);
        extra.z_extra_9 = 1; // not in properties and not in required
        opts.push({ value: extra, rule: "additionalProperties" });
      }
      return r.pick(opts);
    },
    children: () => Object.entries(props).map(([key, g]) => ({ key, gen: g })),
  };
}

function genArray(rng: Rng, depth: number): Gen {
  const item = genNode(rng, depth + 1);
  const minI = rng.bool(0.4) ? 1 + rng.int(2) : undefined; // 1..2
  const maxI = rng.bool(0.6) ? 3 : undefined;
  const schema: Record<string, unknown> = { type: "array", items: item.schema };
  if (minI !== undefined) schema.minItems = minI;
  if (maxI !== undefined) schema.maxItems = maxI;
  return {
    schema,
    conform: (r) => {
      const lo = minI ?? 1;
      const hi = Math.max(lo, maxI ?? 3);
      const n = lo + r.int(hi - lo + 1);
      return Array.from({ length: n }, () => item.conform(r));
    },
    bad: (r) => {
      const opts: Bad[] = [{ value: {}, rule: "type" }, { value: "arr", rule: "type" }];
      if (maxI !== undefined) {
        opts.push({ value: Array.from({ length: maxI + 1 }, () => item.conform(r)), rule: "maxItems" });
      }
      if (minI !== undefined) opts.push({ value: [], rule: "minItems" });
      const rest = Array.from({ length: Math.max(0, (minI ?? 1) - 1) }, () => item.conform(r));
      opts.push({ value: [item.bad(r).value, ...rest], rule: "items" }); // first element violates the item schema
      return r.pick(opts);
    },
    children: () => [{ key: 0, gen: item }],
  };
}

// Every mutation candidate: replace the value at `path` with a near-miss for that node.
interface Candidate {
  path: Array<string | number>;
  make: (rng: Rng) => Bad;
}

function collectCandidates(gen: Gen, path: Array<string | number>, out: Candidate[]): void {
  out.push({ path: [...path], make: (rng) => gen.bad(rng) });
  for (const { key, gen: child } of gen.children()) collectCandidates(child, [...path, key], out);
}

function setAtPath(root: unknown, path: Array<string | number>, value: unknown): unknown {
  if (path.length === 0) return value;
  const copy = JSON.parse(JSON.stringify(root)) as Record<string | number, unknown>; // conforming values are JSON-safe
  let cur = copy;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]!] as Record<string | number, unknown>;
  cur[path[path.length - 1]!] = value;
  return copy;
}

// ── Intent corpus: the generator knows the expected verdict per case ─────────

describe("json-schema fuzz: intent corpus", () => {
  const ITERS = 1500;

  it(`conforming instances validate clean and near-misses reject (${ITERS} cases)`, () => {
    const rng = makeRng(0x5eed17);
    const failures: string[] = [];

    for (let i = 0; i < ITERS && failures.length < 3; i++) {
      const root = genObject(rng, 0);
      const instance = root.conform(rng);

      // conforming => accept, and validate/validateParams/parseOrThrow agree
      const errs = validate(instance, root.schema);
      if (errs.length !== 0) {
        failures.push(`iter ${i} CONFORM rejected: ${errs[0]}\nschema: ${JSON.stringify(root.schema)}\ninstance: ${JSON.stringify(instance)}`);
      }
      const vp = validateParams(instance, root.schema);
      if (!vp.valid || JSON.stringify(vp.errors) !== JSON.stringify(errs)) {
        failures.push(`iter ${i} validateParams disagrees: valid=${vp.valid} ${JSON.stringify(vp.errors)} vs ${JSON.stringify(errs)}`);
      }
      try {
        parseOrThrow(instance, root.schema);
      } catch (e) {
        failures.push(`iter ${i} parseOrThrow threw on conform: ${(e as Error).message}`);
      }

      // one near-miss => reject (valid false + errors non-empty), targeting the rule it names
      const cands: Candidate[] = [];
      collectCandidates(root, [], cands);
      const cand = rng.pick(cands);
      const bad = cand.make(rng);
      const mutated = setAtPath(instance, cand.path, bad.value);
      const badRes = validateParams(mutated, root.schema);
      if (badRes.valid || badRes.errors.length === 0) {
        failures.push(
          `iter ${i} MUTATION ACCEPTED (target ${bad.rule} at /${cand.path.join("/")}):\nschema: ${JSON.stringify(root.schema)}\nmutated: ${JSON.stringify(mutated)}`,
        );
      }
      const directErrs = validate(mutated, root.schema);
      if (directErrs.length === 0) {
        failures.push(`iter ${i} validate() accepted mutation (${bad.rule}): ${JSON.stringify(mutated)}`);
      }
      try {
        parseOrThrow(mutated, root.schema);
        failures.push(`iter ${i} parseOrThrow accepted mutation (${bad.rule}): ${JSON.stringify(mutated)}`);
      } catch (e) {
        if (!(e instanceof TypeError)) failures.push(`iter ${i} parseOrThrow threw non-TypeError: ${String(e)}`);
      }
    }

    expect(failures).toEqual([]);
  });
});

// ── Hostile pairs: junk values x (generated + nonsense) schemas, never throws ─

const JUNK: unknown[] = [
  "", "x", "1", "-0", "01", "9".repeat(400), "\x00\x1f", "\ud800", "\u2028",
  "\u{1f468}\u200d\u{1f469}\u200d\u{1f466}", "constructor", "__proto__", "toString",
  0, -0, NaN, Infinity, -Infinity, 2 ** 53 + 1, -1e308,
  true, false, null, undefined,
  [], [1], [null], [[]], Array(200).fill(0),
  { a: 1 }, JSON.parse('{"__proto__": {"p": 1}}'), [1, "a", {}, [], null],
  new Map([["k", 1]]), new Set([1]), new Date(0),
  JSON.parse("[" + "[".repeat(150) + "]".repeat(150) + "]"),
];

const NONSENSE_SCHEMAS: unknown[] = [
  null, undefined, 42, "str", true, [], [1, 2],
  { type: "wat" }, { type: ["string", "null"] }, { type: 123 },
  { required: "x" }, { required: [1] }, { properties: "x" }, { properties: [1] },
  { additionalProperties: "yes" }, { items: [] }, { items: true },
  { minLength: "a" }, { minimum: "x" }, { maxItems: -3 },
  { pattern: "[" }, { pattern: "(?<" }, { enum: "x" }, { const: undefined },
  { anyOf: [{ type: "string" }] }, { oneOf: [{}] }, { allOf: [{ type: "string" }] },
  { not: { type: "string" } }, { $ref: "#/x" },
  (() => {
    let s: Record<string, unknown> = { type: "number" };
    for (let i = 0; i < 400; i++) s = { items: s };
    return s;
  })(),
];

describe("json-schema fuzz: hostile pairs", () => {
  it("junk x nonsense schema never throws", () => {
    const thrown: string[] = [];
    for (const junk of JUNK) {
      for (const schema of NONSENSE_SCHEMAS) {
        try {
          const errs = validate(junk, schema);
          if (!Array.isArray(errs)) thrown.push(`non-array errors for schema ${JSON.stringify(schema) ?? String(schema)}`);
          const vp = validateParams(junk, schema);
          if (typeof vp.valid !== "boolean" || !Array.isArray(vp.errors)) thrown.push(`bad ValidationResult for schema ${JSON.stringify(schema) ?? String(schema)}`);
        } catch (e) {
          thrown.push(`${(e as Error).constructor.name}: ${(e as Error).message} | junk ${String(junk).slice(0, 20)} | schema ${JSON.stringify(schema) ?? String(schema)}`);
        }
      }
    }
    expect(thrown).toEqual([]);
  });

  it("junk x random generated schema never throws, bounded time", () => {
    const rng = makeRng(0x405d10);
    const thrown: string[] = [];
    const t0 = performance.now();
    for (let i = 0; i < 150; i++) {
      const schema: unknown = rng.bool() ? genObject(rng, 0).schema : NONSENSE_SCHEMAS[rng.int(NONSENSE_SCHEMAS.length)];
      for (const junk of JUNK) {
        try {
          validate(junk, schema);
          validateParams(junk, schema);
        } catch (e) {
          thrown.push(`${(e as Error).constructor.name}: ${(e as Error).message} | iter ${i}`);
        }
      }
    }
    expect(thrown).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(2000); // hang guard, ~20x measured headroom on dev hw
  });

  it("out-of-subset constructs are IGNORED (accept) -- pinned current behavior", () => {
    expect(validate(5, { anyOf: [{ type: "string" }] })).toEqual([]);
    expect(validate(5, { oneOf: [{ type: "string" }] })).toEqual([]);
    expect(validate(5, { allOf: [{ type: "string" }] })).toEqual([]);
    expect(validate(5, { not: { type: "number" } })).toEqual([]);
    expect(validate(5, { type: ["string", "null"] })).toEqual([]); // array-valued type skipped
    expect(validate([1, 1], { items: [{ type: "string" }] })).toEqual([]); // tuple items ignored (array has no keywords)
    expect(validate("x", { format: "email" })).toEqual([]);
    expect(validate([1, 1], { uniqueItems: true })).toEqual([]);
    expect(validate("x", { default: "y" })).toEqual([]); // default-only schema imposes nothing
    expect(validate(5, { default: 5, type: "string" })).toEqual([]); // default stringify-match SKIPS all checks
  });
});

// ── pattern: regex-hostile instances ─────────────────────────────────────────

describe("json-schema fuzz: pattern hostiles", () => {
  const HOSTILE_STRINGS = [
    "a".repeat(50000), // long run through a linear engine walk, no catastrophic backtracking pool
    "\n".repeat(1000), // $ without /m: newline is not an end anchor here
    "\u2028\u2029x", // JS line separators are not $ boundaries
    "x".repeat(20000) + "\ud800",
    "null", "undefined", "0e-0", "1e999",
    "*".repeat(5000), "$1$2$3", "\\", "\\d\\w", "[", "\x00a",
  ];

  it("pattern matching survives hostile strings", () => {
    for (const s of HOSTILE_STRINGS) {
      const t0 = performance.now();
      expect(() => validate(s, { type: "string", pattern: "^a+$" })).not.toThrow();
      expect(() => validate(s, { type: "string", pattern: "^[\\w.-]{1,32}$" })).not.toThrow();
      expect(() => validate(s, { type: "string", pattern: "^x" })).not.toThrow();
      expect(performance.now() - t0).toBeLessThan(250);
    }
    // anchor pins: JS regex semantics, no /m flag ever supplied
    expect(validate("a".repeat(100), { type: "string", pattern: "^a+$" })).toEqual([]);
    expect(validate("a".repeat(100) + "!", { type: "string", pattern: "^a+$" })).not.toEqual([]);
    expect(validate("x\n", { type: "string", pattern: "^x$" })).not.toEqual([]);
    expect(validate("x\u2028", { type: "string", pattern: "^x$" })).not.toEqual([]);
  });

  it("invalid pattern regex: validation error, never a throw (regression)", () => {
    expect(validate("abc", { type: "string", pattern: "[" })).toEqual(['root: invalid pattern regex "["']);
    expect(validate("abc", { type: "string", pattern: "(?<" })).not.toEqual([]);
    expect(validateParams({ p: "abc" }, { properties: { p: { pattern: "*" } } }).errors.join(" ")).toContain("invalid pattern");
  });
});

// ── enum identity: 0 vs -0 and "1" vs 1, pinned stringify-equality ──────────

describe("json-schema fuzz: enum identity shapes", () => {
  it("pins JSON.stringify equality semantics", () => {
    expect(validate(-0, { enum: [0] })).toEqual([]); // -0 and 0 both stringify to "0"
    expect(validate(0, { enum: [-0] })).toEqual([]);
    expect(validate(0, { const: -0 })).toEqual([]);
    expect(validate("1", { enum: [1] })).not.toEqual([]); // "1" != 1
    expect(validate(1, { enum: ["1"] })).not.toEqual([]);
    expect(validate("1", { const: 1 })).not.toEqual([]);
    expect(validate(1, { type: "number", enum: [1, 2] })).toEqual([]);
    expect(validate(NaN, { enum: [null] })).toEqual([]); // NaN stringifies to null: considered IN the enum -- pinned
    expect(validate([1, 2], { enum: [[1, 2]] })).toEqual([]); // deep stringify equality for array members
  });
});

// ── deep instances: 1000+ must not overflow; ceiling measured, not asserted ──

describe("json-schema fuzz: deep instances", () => {
  const DEPTH = 1500; // 1000+ per the deep-nesting brief; measured on bun/JSC: 10k passes, ~50k RangeErrors (native recursion, no explicit cap). Recorded, deliberately not asserted near.

  const deepArray = (n: number, leaf: unknown): unknown => {
    let v = leaf;
    for (let i = 0; i < n; i++) v = [v];
    return v;
  };
  const deepItemsSchema = (n: number): unknown => {
    let s: unknown = { type: "number" };
    for (let i = 0; i < n; i++) s = { items: s };
    return s;
  };
  const deepObject = (n: number, leaf: unknown): unknown => {
    let v = leaf;
    for (let i = 0; i < n; i++) v = { k: v };
    return v;
  };
  const deepPropsSchema = (n: number): unknown => {
    let s: unknown = { type: "number" };
    for (let i = 0; i < n; i++) s = { type: "object", properties: { k: s } };
    return s;
  };

  it("deep conforming chains validate clean (arrays and objects)", () => {
    expect(validate(deepArray(DEPTH, 1), deepItemsSchema(DEPTH))).toEqual([]);
    expect(validate(deepObject(DEPTH, 1), deepPropsSchema(DEPTH))).toEqual([]);
  });

  it("deep instances against mismatched schemas reject, not crash", () => {
    expect(validate(deepArray(DEPTH, 1), { type: "array", items: { type: "number" } })).not.toEqual([]);
    expect(validate(deepObject(DEPTH, 1), { type: "object", properties: { k: { type: "number" } } })).not.toEqual([]);
    // the enum error message embeds JSON.stringify(value) -- must still complete at this depth
    const errs = validate(deepArray(1200, 1), { enum: [1] });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]!.startsWith("root: value ")).toBe(true);
  });
});

// ── __proto__ / constructor: no pollution, verdicts pinned ──────────────────

describe("json-schema fuzz: prototype-named keys", () => {
  const protoSnapshot = Object.getOwnPropertyNames(Object.prototype).join(",");

  it("pinned verdict table", () => {
    const evilInstance = JSON.parse('{"__proto__": {"p": 1}}'); // an OWN property: JSON.parse never routes through the setter
    const evilSchemaProps = JSON.parse('{"type":"object","required":["__proto__"],"additionalProperties":false,"properties":{"__proto__":{"type":"object"}}}');
    // own "__proto__" present, listed, closed schema: accepted
    expect(validate(evilInstance, evilSchemaProps)).toEqual([]);
    // same instance against a closed schema that does NOT list it: rejected as additional
    expect(validate(evilInstance, { type: "object", additionalProperties: false, properties: { path: { type: "string" } } }))
      .toEqual(["__proto__: additional property not allowed"]);
    // `in`-based required: the prototype chain satisfies it -- pinned quirk
    expect(validate({}, { type: "object", required: ["__proto__"] })).toEqual([]);
    expect(validate({}, { type: "object", required: ["toString"] })).toEqual([]);
    // `in`-based properties: validate() descends into the inherited function value -- pinned quirk
    expect(validate({}, { type: "object", properties: { constructor: { type: "number" } } }))
      .toEqual(["constructor: expected number, got function"]);
    // constructor as a real own key validates like any other name
    expect(validate(JSON.parse('{"constructor": 5}'), { type: "object", properties: { constructor: { type: "number" } } })).toEqual([]);
  });

  it("prototype stays untouched across a hostile proto battery", () => {
    const polluters = [
      JSON.parse('{"__proto__": {"polluted": 1, "x": {"y": [1,2]}}}'),
      JSON.parse('{"constructor": {"prototype": {"polluted2": 1}}}'),
      JSON.parse('{"__proto__": "string-proto"}'),
    ];
    const protoSchemas = [
      JSON.parse('{"type":"object","properties":{"__proto__":{}},"required":["__proto__"],"additionalProperties":false}'),
      { type: "object", additionalProperties: false },
      { type: "object" },
      JSON.parse('{"properties":{"constructor":{"type":"object","additionalProperties":false}}}'),
    ];
    for (const inst of polluters) {
      for (const sc of protoSchemas) {
        expect(() => validate(inst, sc)).not.toThrow();
        expect(() => validateParams(inst, sc)).not.toThrow();
      }
    }
    expect(Object.getOwnPropertyNames(Object.prototype).join(",")).toBe(protoSnapshot);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(Object.getPrototypeOf([])).toBe(Array.prototype);
  });
});
