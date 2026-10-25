// Fuzz suite for parseArgs (src/core/cli.ts).
// Untrusted input: argv from shells, scripts, and tool invocations.
//
// Pinned contracts (read from source):
//   1. NO "--" terminator: "--" hits the unknown-flag branch and throws
//      CliError.UnknownFlag with flag === "--"; nothing after it parses as
//      flag or positional.
//   2. "--flag=value" is not a syntax: the whole token is looked up and, if
//      unknown, is fatal. Combined shorts ("-lm") likewise fatal. Bare "-"
//      is fatal (no stdin convention).
//   3. A hasValue flag consumes the next argv token unconditionally, even if
//      it looks like a flag ("--model --loud" sets model="--loud", loud stays
//      false). Missing value at the end -> "requires a value".
//   4. Negative numbers: standalone "-1"/"-0" are unknown flags; as flag
//      values they pass through verbatim (string flags) or parseInt ("--max-
//      tokens -1" -> -1, "12abc" -> 12, "abc" -> "requires a numeric value").
//   5. Repeated flags: last assignment wins. Booleans are idempotent true.
//   6. Positional logic: the first non-dash token must be a known subcommand;
//      afterwards non-dash tokens go to args, but KNOWN FLAGS ARE STILL PARSED
//      post-subcommand and unknown dashes still throw.
//   7. Errors are always CliError (type "cli"); unknown flag/subcommand carry
//      the offending token in .flag / .subcommand.

import { describe, it, expect } from "bun:test";
import { parseArgs } from "@core/cli.ts";
import { CliError } from "@core/error.ts";
import { makeRng, type Rng } from "../fuzz/prng.ts";

function withArgs(args: string[], fn: () => void) {
  const origArgv = process.argv;
  process.argv = ["bun", "hotdog", ...args];
  try {
    fn();
  } finally {
    process.argv = origArgv;
  }
}

const SUBS = ["info", "sessions", "prompt", "show-prompt"];

// Mirrors the STRUCTURAL_FLAGS table plus the test registry below.
const REGISTRY = {
  buildDefaults: () => ({}),
  getCliFlags: () => [
    { long: "--profile", type: "string", description: "" },
    { long: "--max-tokens", type: "number", description: "" },
    { long: "--tags", type: "array", description: "" },
    { long: "--verbose", type: "boolean", description: "" },
    { long: "--prompt", short: "-p", type: "string", description: "", isSubcommand: true },
  ],
} as any;

const VALUE_FLAGS = new Set([
  "-f", "--config", "-d", "--config-dir", "-m", "--model", "--ai-url", "-k", "--api-key",
  "--profile", "--max-tokens", "--tags", "-p", "--prompt",
]);
const BOOL_FLAGS = new Set(["-l", "--loud", "--json", "-v", "--version", "-h", "--help", "--verbose"]);

// ── Independent oracle for the flag-free-value corpus ───────────────
// Walks argv with the real consumption rules, minus number validation (the
// oracle corpus never feeds invalid values to --max-tokens).
type Prediction = { ok: true } | { ok: false; kind: "flag" | "sub"; token: string };

function predict(argv: string[]): Prediction {
  let i = 0;
  let subSet = false;
  while (i < argv.length) {
    const t = argv[i]!;
    if (VALUE_FLAGS.has(t)) {
      if (i + 1 >= argv.length) return { ok: false, kind: "flag", token: t }; // missing value
      // -p/--prompt is declared isSubcommand: selecting it also sets the subcommand,
      // so later positional tokens go to args instead of tripping UnknownSubcommand.
      if (t === "-p" || t === "--prompt") subSet = true;
      i += 2;
      continue;
    }
    if (BOOL_FLAGS.has(t)) {
      i++;
      continue;
    }
    if (t.startsWith("-")) return { ok: false, kind: "flag", token: t };
    if (!subSet) {
      if (SUBS.includes(t)) {
        subSet = true;
        i++;
      } else {
        return { ok: false, kind: "sub", token: t };
      }
      continue;
    }
    i++;
  }
  return { ok: true };
}

// ── Token pools ─────────────────────────────────────────────────────

const KNOWN_FLAGS = [...VALUE_FLAGS, ...BOOL_FLAGS];
const MALFORMED = ["--", "-", "---", "--=", "--model=gpt", "--config=", "-lm", "-ml", "-fv", "--prompt=x", "--MODEL", "-p=x", "--verbose=1"];
const NEAR_TYPOS = ["--modl", "--hepl", "--confg", "--tag", "--profil", "--pro"];
const UNKNOWN_FLAGS = ["--zzz", "--x", "-Z", "-0", "-1", "-42", "--9lives"];
const VALUES = [
  "v1", "gpt-4", "explorer", "x y", "", " ", "\t",
  "--loud", "--model", "--", "-1", "0", "-0", "-3.7",
  "\u{1f32d}", "\u00e9\u0301", "a\u0000b", "x".repeat(300),
];
const POS = ["file.txt", "some arg", "\u65e5\u672c", "\u{1f32d}", ""];

function genArgv(rng: Rng, withTypedFlags: boolean): string[] {
  const len = 1 + rng.int(30);
  const out: string[] = [];
  for (let i = 0; i < len; i++) {
    const roll = rng.float();
    if (roll < 0.3) {
      let f = rng.pick(KNOWN_FLAGS);
      // oracle corpus: never let --max-tokens grab an invalid value at a flag position
      if (!withTypedFlags && f === "--max-tokens") f = "--profile";
      out.push(f);
    } else if (roll < 0.5) out.push(rng.pick(VALUES));
    else if (roll < 0.62) out.push(rng.pick(MALFORMED));
    else if (roll < 0.7) out.push(rng.pick(NEAR_TYPOS));
    else if (roll < 0.78) out.push(rng.pick(UNKNOWN_FLAGS));
    else if (roll < 0.9) out.push(rng.pick(SUBS));
    else out.push(rng.pick(POS));
  }
  return out;
}

// ── Structural invariants on every successful parse ─────────────────

function checkResult(argv: string[], r: ReturnType<typeof parseArgs>): string[] {
  const problems: string[] = [];
  if (!Array.isArray(r.args)) problems.push(`args not an array for ${JSON.stringify(argv)}`);
  else {
    for (const a of r.args) {
      if (typeof a !== "string") problems.push(`non-string arg for ${JSON.stringify(argv)}`);
      else if (a.startsWith("-")) problems.push(`dash token reached positional args: ${JSON.stringify(a)} in ${JSON.stringify(argv)}`);
    }
    if (r.args.length > 0 && r.subcommand === null) problems.push(`positional args without subcommand: ${JSON.stringify(argv)}`);
  }
  for (const k of ["loud", "wantsJson", "version", "help"] as const) {
    if (typeof r[k] !== "boolean") problems.push(`${k} not boolean for ${JSON.stringify(argv)}`);
  }
  if (r.verbose !== undefined && typeof r.verbose !== "boolean") problems.push(`verbose not boolean for ${JSON.stringify(argv)}`);
  if (r.maxTokens !== undefined && typeof r.maxTokens !== "number") problems.push(`maxTokens not number for ${JSON.stringify(argv)}`);
  if (r.tags !== undefined && !(Array.isArray(r.tags) && r.tags.every((x: unknown) => typeof x === "string"))) {
    problems.push(`tags not string[] for ${JSON.stringify(argv)}`);
  }
  if (r.subcommand !== null && typeof r.subcommand !== "string") problems.push(`subcommand not string for ${JSON.stringify(argv)}`);
  return problems;
}

// ── Seeded fuzz ─────────────────────────────────────────────────────

describe("cli-args fuzz", () => {
  it("general corpus: only CliError or a structurally valid result, deterministic", () => {
    const rng = makeRng(0x6172_6776); // "argv"
    const failures: string[] = [];
    for (let iter = 0; iter < 300; iter++) {
      const argv = genArgv(rng, true);
      let r1: unknown;
      let e1: unknown;
      try {
        withArgs(argv, () => {
          r1 = parseArgs(REGISTRY, SUBS);
        });
      } catch (e) {
        e1 = e;
      }
      if (e1 !== undefined) {
        if (!(e1 instanceof CliError)) failures.push(`iter ${iter} threw non-CliError: ${String(e1)}`);
        else if (e1.type !== "cli") failures.push(`iter ${iter} CliError.type=${e1.type}`);
        continue;
      }
      failures.push(...checkResult(argv, r1 as ReturnType<typeof parseArgs>));
      // determinism: same argv -> same result
      withArgs(argv, () => {
        const r2 = parseArgs(REGISTRY, SUBS);
        if (JSON.stringify(r2) !== JSON.stringify(r1)) failures.push(`iter ${iter} nondeterministic result`);
      });
      if (failures.length >= 5) break;
    }
    expect(failures).toEqual([]);
  });

  it("oracle corpus (no number-typed values): predictions match flags, subcommands, and the -- rule", () => {
    const rng = makeRng(0x6f72_6163); // "orac"
    const failures: string[] = [];
    for (let iter = 0; iter < 300; iter++) {
      const argv = genArgv(rng, false);
      const pred = predict(argv);
      let err: unknown;
      let ok = false;
      try {
        withArgs(argv, () => {
          parseArgs(REGISTRY, SUBS);
          ok = true;
        });
      } catch (e) {
        err = e;
      }
      if (pred.ok) {
        if (!ok) failures.push(`iter ${iter}: oracle expected success, got ${(err as Error).message} for ${JSON.stringify(argv)}`);
      } else {
        if (ok) failures.push(`iter ${iter}: oracle expected ${pred.kind} throw on ${JSON.stringify(pred.token)}, parse succeeded for ${JSON.stringify(argv)}`);
        else if (!(err instanceof CliError)) failures.push(`iter ${iter} non-CliError: ${String(err)}`);
        else {
          const msg = (err as Error).message;
          if (pred.kind === "flag") {
            if (pred.token === "--") {
              if (!msg.includes("Unknown flag: --") || (err as CliError).flag !== "--") {
                failures.push(`iter ${iter}: "--" must be a fatal unknown flag; msg=${JSON.stringify(msg)} argv=${JSON.stringify(argv)}`);
              }
            } else if ((err as CliError).flag !== undefined) {
              // exact-token match whenever the error carries a flag field
              if ((err as CliError).flag !== pred.token) {
                failures.push(`iter ${iter}: flagged ${(err as CliError).flag}, oracle expected ${pred.token} argv=${JSON.stringify(argv)}`);
              }
            } else if (!msg.startsWith(`${pred.token} requires `)) {
              // MissingValue/InvalidValue set no flag field; their messages
              // still attribute the offending token verbatim -- require that
              // instead of tolerating any message when the field is absent.
              failures.push(`iter ${iter}: flagless error ${JSON.stringify(msg)}, oracle expected token ${pred.token} argv=${JSON.stringify(argv)}`);
            }
          } else {
            if (!msg.includes("Unknown subcommand")) failures.push(`iter ${iter}: expected Unknown subcommand, got ${JSON.stringify(msg)} argv=${JSON.stringify(argv)}`);
            if ((err as CliError).subcommand !== pred.token) failures.push(`iter ${iter}: subcommand field ${(err as CliError).subcommand} != ${pred.token}`);
          }
        }
      }
      if (failures.length >= 5) break;
    }
    expect(failures).toEqual([]);
  });

  it("vectors containing -- either throw or every -- sat in a value slot (never a terminator)", () => {
    const rng = makeRng(0x2d2d_2020); // "-- "
    const failures: string[] = [];
    for (let iter = 0; iter < 200; iter++) {
      const argv = genArgv(rng, true);
      if (!argv.includes("--")) continue;
      let err: unknown;
      let r: ReturnType<typeof parseArgs> | undefined;
      try {
        withArgs(argv, () => {
          r = parseArgs(REGISTRY, SUBS);
        });
      } catch (e) {
        err = e;
      }
      if (err === undefined) {
        failures.push(...checkResult(argv, r as ReturnType<typeof parseArgs>));
        // success is only legal if EVERY "--" occurrence sat in a value slot:
        // i.e. each is immediately preceded by an active value flag. The
        // oracle walk says so exactly (typed flags: accept numeric-valid only).
        const pred = predict(argv);
        if (!pred.ok) failures.push(`iter ${iter}: parse succeeded but oracle expected ${pred.kind} throw on ${JSON.stringify(pred.token)} argv=${JSON.stringify(argv)}`);
      } else if (!(err instanceof CliError)) {
        failures.push(`iter ${iter} non-CliError: ${String(err)}`);
      }
      if (failures.length >= 5) break;
    }
    expect(failures).toEqual([]);
  });
});

// ── Pinned fixtures: the real contract in detail ────────────────────

describe("cli-args fixtures", () => {
  it("-- is a fatal unknown flag, never a terminator", () => {
    withArgs(["--"], () => {
      try {
        parseArgs(REGISTRY, SUBS);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CliError);
        expect((e as CliError).flag).toBe("--");
        expect((e as Error).message).toContain("Unknown flag: --");
      }
    });
    withArgs(["--", "file.txt"], () => {
      expect(() => parseArgs(REGISTRY, SUBS)).toThrow(/Unknown flag: --/);
    });
    withArgs(["info", "x", "--", "y"], () => {
      expect(() => parseArgs(REGISTRY, SUBS)).toThrow(/Unknown flag: --/);
    });
  });

  it("-- can be consumed as a value by a value flag (still never a terminator)", () => {
    withArgs(["info", "-m", "--"], () => {
      const r = parseArgs(REGISTRY, SUBS);
      expect(r.subcommand).toBe("info");
      expect(r.model).toBe("--");
      expect(r.args).toEqual([]);
    });
  });

  it("--flag=value and combined shorts are unknown flags", () => {
    withArgs(["--model=gpt-4"], () => expect(() => parseArgs(REGISTRY, SUBS)).toThrow(/Unknown flag: --model=gpt-4/));
    withArgs(["-lm", "x"], () => expect(() => parseArgs(REGISTRY, SUBS)).toThrow(/Unknown flag: -lm/));
    withArgs(["-"], () => expect(() => parseArgs(REGISTRY, SUBS)).toThrow(/Unknown flag: -/));
  });

  it("value flags swallow flag-shaped values", () => {
    withArgs(["-m", "--loud", "--json"], () => {
      const r = parseArgs(REGISTRY, SUBS);
      expect(r.model).toBe("--loud");
      expect(r.loud).toBe(false);
      expect(r.wantsJson).toBe(true);
    });
    withArgs(["--ai-url", "--help"], () => {
      const r = parseArgs(REGISTRY, SUBS);
      expect(r.aiUrl).toBe("--help");
      expect(r.help).toBe(false);
    });
  });

  it("negative numbers: flags standalone, verbatim values after value flags", () => {
    withArgs(["-1"], () => expect(() => parseArgs(REGISTRY, SUBS)).toThrow(/Unknown flag: -1/));
    withArgs(["-0"], () => expect(() => parseArgs(REGISTRY, SUBS)).toThrow(/Unknown flag: -0/));
    withArgs(["-m", "-1"], () => expect(parseArgs(REGISTRY, SUBS).model).toBe("-1"));
    withArgs(["--max-tokens", "-1"], () => expect(parseArgs(REGISTRY, SUBS).maxTokens).toBe(-1));
    withArgs(["--max-tokens", "12abc"], () => expect(parseArgs(REGISTRY, SUBS).maxTokens).toBe(12));
    withArgs(["--max-tokens", "abc"], () => expect(() => parseArgs(REGISTRY, SUBS)).toThrow(/requires a numeric value/));
  });

  it("repeated flags: last wins; booleans idempotent", () => {
    withArgs(["-m", "a", "-m", "b"], () => expect(parseArgs(REGISTRY, SUBS).model).toBe("b"));
    withArgs(["--profile", "one", "--profile", "two"], () => expect(parseArgs(REGISTRY, SUBS).profile).toBe("two"));
    withArgs(["--loud", "--loud"], () => expect(parseArgs(REGISTRY, SUBS).loud).toBe(true));
  });

  it("post-subcommand: known flags still parse, unknown dashes still throw", () => {
    withArgs(["info", "--json", "a", "-l"], () => {
      const r = parseArgs(REGISTRY, SUBS);
      expect(r.subcommand).toBe("info");
      expect(r.wantsJson).toBe(true);
      expect(r.loud).toBe(true);
      expect(r.args).toEqual(["a"]);
    });
    withArgs(["info", "x", "-y"], () => expect(() => parseArgs(REGISTRY, SUBS)).toThrow(/Unknown flag: -y/));
  });

  it("isSubcommand flag: selects subcommand, consumes value, rest is positional", () => {
    withArgs(["-p", "hi", "extra1", "extra2"], () => {
      const r = parseArgs(REGISTRY, SUBS);
      expect(r.subcommand).toBe("prompt");
      expect(r.prompt).toBe("hi");
      expect(r.args).toEqual(["extra1", "extra2"]);
    });
    withArgs(["prompt", "-p", "hi"], () => {
      const r = parseArgs(REGISTRY, SUBS);
      expect(r.subcommand).toBe("prompt");
      expect(r.prompt).toBe("hi");
    });
  });

  it("array flag splits on commas verbatim", () => {
    withArgs(["--tags", "a,,b,"], () => expect(parseArgs(REGISTRY, SUBS).tags).toEqual(["a", "", "b", ""]));
    withArgs(["--tags", ","], () => expect(parseArgs(REGISTRY, SUBS).tags).toEqual(["", ""]));
  });

  it("empty argv yields pure defaults", () => {
    withArgs([], () => {
      const r = parseArgs(REGISTRY, SUBS);
      expect(r.subcommand).toBeNull();
      expect(r.args).toEqual([]);
      expect(r.model).toBeNull();
      expect(r.loud).toBe(false);
    });
  });

  it("unicode, NUL, and empty-string values survive verbatim", () => {
    withArgs(["-m", "\u{1f32d}\u00e9 a\u0000b"], () => expect(parseArgs(REGISTRY, SUBS).model).toBe("\u{1f32d}\u00e9 a\u0000b"));
    withArgs(["-m", ""], () => expect(parseArgs(REGISTRY, SUBS).model).toBe(""));
    withArgs(["info", "\u{1f32d}", "a\u0000b"], () => expect(parseArgs(REGISTRY, SUBS).args).toEqual(["\u{1f32d}", "a\u0000b"]));
  });

  it("missing value at end of argv is fatal", () => {
    withArgs(["--model"], () => expect(() => parseArgs(REGISTRY, SUBS)).toThrow(/--model requires a value/));
    withArgs(["info", "-m"], () => expect(() => parseArgs(REGISTRY, SUBS)).toThrow(/requires a value/));
    withArgs(["-p"], () => expect(() => parseArgs(REGISTRY, SUBS)).toThrow(/requires a value/));
  });

  it("1000-arg vectors parse fast and stay in contract", () => {
    const argv = ["info", ...Array.from({ length: 999 }, (_, i) => (i % 3 === 0 ? `\u{1f32d}pos${i}` : `pos${i}`))];
    const t0 = performance.now();
    withArgs(argv, () => {
      const r = parseArgs(REGISTRY, SUBS);
      expect(r.args.length).toBe(999);
    });
    argv.length = 0;
    for (let i = 0; i < 500; i++) argv.push("--loud");
    for (let i = 0; i < 500; i++) argv.push(`p${i}`);
    argv.unshift("sessions");
    withArgs(argv, () => {
      const r = parseArgs(REGISTRY, SUBS);
      expect(r.loud).toBe(true);
      expect(r.args.length).toBe(500);
    });
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
