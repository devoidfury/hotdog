// `hotdog extension validate` -- stages, verdicts, exit codes, the JSON
// envelope, and the main() wiring. Fixtures are built in a temp dir and
// driven through the REAL discovery + loader path.

import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runExtensionValidate, type ExtensionValidateEnvelope } from "@core/extensions/validate.ts";
import { main } from "@core/main.ts";
import { resetLoggerForTesting } from "@utils/logger.ts";
import { tmpDir, cleanupDir } from "../mocks/io.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) cleanupDir(dirs.pop()!);
});

function fixture(name: string, manifest: unknown | string, indexSrc: string | null): string {
  const base = tmpDir("hotdog-validate-");
  dirs.push(base);
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  const json = typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(dir, "extension.json"), json);
  if (indexSrc !== null) fs.writeFileSync(path.join(dir, "index.ts"), indexSrc);
  return dir;
}

function manifestBase(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "validate-fixture",
    provides: ["tools"],
    loadOrder: 10,
    description: "validate fixture",
    sdk: ">=0.16",
    configSchema: {
      validateFixture: {
        type: "object",
        properties: { enabled: { type: "boolean", default: true } },
        additionalProperties: false,
        layers: [{ source: "config", key: "validateFixture" }, { default: {} }],
      },
    },
    ...over,
  };
}

const TOOL_INDEX = `
export function create(core) {
  return {
    hooks: {
      "tools:register": async (registry) => {
        registry.register("validate_fixture_tool", {
          metadata: { sideEffects: false, difficulty: 1 },
          toToolDef: () => ({
            type: "function",
            function: { name: "validate_fixture_tool", description: "fixture", parameters: { type: "object", properties: {}, required: [] } },
          }),
          execute: async () => "ok",
        });
      },
    },
  };
}
`;

/** Captures runExtensionValidate's console traffic (prose or envelope lines). */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string[]; err: string[] }> {
  const origLog = console.log;
  const origErr = console.error;
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...a: unknown[]) => {
    out.push(a.join(" "));
  };
  console.error = (...a: unknown[]) => {
    err.push(a.join(" "));
  };
  try {
    return { code: await fn(), out, err };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

function envelopeOf(lines: string[]): ExtensionValidateEnvelope {
  return JSON.parse(lines.join("\n")) as ExtensionValidateEnvelope;
}

describe("extension validate: usage and dir stage", () => {
  it("no args prints usage and fails", async () => {
    const { code, err } = await capture(() => runExtensionValidate({ args: [], json: false }));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("usage: hotdog extension validate <dir>");
  });

  it("unknown verb fails with usage", async () => {
    const { code, err } = await capture(() =>
      runExtensionValidate({ args: ["frobnicate", "."], json: false }),
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("usage:");
  });

  it("a missing directory is a dir problem (exit 1)", async () => {
    const missing = path.join(os.tmpdir(), `validate-nope-${Date.now()}`);
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", missing], json: false }),
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("[dir]");
    expect(out.join("\n")).toContain("does not exist");
  });

  it("an empty directory names what discovery needs", async () => {
    const base = tmpDir("hotdog-validate-");
    dirs.push(base);
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", base], json: false }),
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("extension.json is missing");
  });
});

describe("extension validate: a healthy extension", () => {
  it("passes every stage and dry-loads the tool", async () => {
    const dir = fixture("healthy", manifestBase(), TOOL_INDEX);
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: false }),
    );
    expect(code).toBe(0);
    const prose = out.join("\n");
    expect(prose).toContain(`sdk: ">=0.16" is compatible`);
    expect(prose).toContain("dry-load: OK - tools: validate_fixture_tool");
    expect(prose).toContain("No problems found.");
  });

  it("--json emits the full envelope with exit 0", async () => {
    const dir = fixture("healthy-json", manifestBase(), TOOL_INDEX);
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir,], json: true }),
    );
    expect(code).toBe(0);
    const env = envelopeOf(out);
    expect(env.mode).toBe("extension");
    expect(env.problems).toBe(0);
    expect(env.extensions).toHaveLength(1);
    const ext = env.extensions[0]!;
    expect(ext.name).toBe("validate-fixture");
    expect(ext.load).toBe("ok");
    expect(ext.tools).toEqual(["validate_fixture_tool"]);
    expect(ext.sdk).toEqual({ declared: ">=0.16", current: env.hotdog_version, verdict: "compatible" });
    expect(ext.config_defaults).toEqual([{ key: "validateFixture", defaults: { enabled: true } }]);
  });

  it("validates the repo's own examples bundle clean", async () => {
    const examples = path.join(import.meta.dir, "../../examples");
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", examples], json: true }),
    );
    expect(code).toBe(0);
    const env = envelopeOf(out);
    expect(env.mode).toBe("bundle");
    expect(env.extensions.map((e) => e.name).sort()).toEqual([
      "extension-redactor",
      "extension-starter",
    ]);
    expect(env.extensions.every((e) => e.load === "ok")).toBe(true);
  });
});

describe("extension validate: manifest stage", () => {
  it("broken JSON gets a line/column finding and a caret excerpt; load is skipped", async () => {
    const dir = fixture("broken", '{\n  "name": "broken",\n  "provides": ["tools"\n}\n', TOOL_INDEX);
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: false }),
    );
    expect(code).toBe(1);
    const prose = out.join("\n");
    expect(prose).toContain("PROBLEM [manifest]");
    expect(prose).toContain("not valid strict JSON");
    expect(prose).toContain("line 4");
    expect(prose).toContain("^");
    expect(prose).toContain("dry-load: SKIPPED (manifest broken)");
  });

  it("an invalid sdk range is a broken manifest (exactly one finding, fail-closed)", async () => {
    const dir = fixture("badsdk", manifestBase({ sdk: "banana" }), TOOL_INDEX);
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: true }),
    );
    expect(code).toBe(1);
    const env = envelopeOf(out);
    const ext = env.extensions[0]!;
    expect(ext.sdk.verdict).toBe("invalid");
    expect(ext.load).toBe("skipped");
    expect(env.problems).toBe(1);
  });

  it("a range the running version misses is a WARNING: loads anyway, exit 0", async () => {
    const dir = fixture("sdkmiss", manifestBase({ sdk: ">=99.0" }), TOOL_INDEX);
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: true }),
    );
    expect(code).toBe(0);
    const env = envelopeOf(out);
    const ext = env.extensions[0]!;
    expect(ext.sdk.verdict).toBe("mismatch");
    expect(ext.load).toBe("ok");
    const warn = ext.findings.find((f) => f.stage === "sdk");
    expect(warn?.severity).toBe("warning");
    expect(warn?.message).toContain("load it anyway");
  });

  it("field-type slips are warnings naming what the loader will do", async () => {
    const dir = fixture(
      "badfields",
      { provides: "tools", loadOrder: "seven", autoload: "yes" },
      `export function create() { return {}; }`,
    );
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: true }),
    );
    // Warnings do not fail the run; the load is what decides that.
    expect(code).toBe(0);
    const env = envelopeOf(out);
    const stages = env.extensions[0]!.findings.filter((f) => f.stage === "fields");
    const messages = stages.map((f) => f.message).join("\n");
    expect(messages).toContain(`"provides" not an array`);
    expect(messages).toContain(`"loadOrder" not a number`);
    expect(messages).toContain(`no usable "name"`);
    expect(messages).toContain("badfields");
    expect(env.problems).toBe(0);
    expect(env.warnings).toBeGreaterThanOrEqual(4);
  });
});

describe("extension validate: entry and discovery blind spots", () => {
  it("index.js only: discovery sees it, the entry verdict names the trap", async () => {
    const dir = fixture("jsonly", manifestBase({ name: "jsonly" }), null);
    fs.writeFileSync(path.join(dir, "index.js"), "export function create() { return {}; }\n");
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: false }),
    );
    expect(code).toBe(1);
    const prose = out.join("\n");
    expect(prose).toContain("index.js exists");
    expect(prose).toContain("dry-load: SKIPPED (entry missing)");
  });

  it("manifest without any entry: still judged (discovery would silently skip it)", async () => {
    const dir = fixture("nomanifestentry", manifestBase({ name: "lonely" }), null);
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: false }),
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("does not exist");
  });

  it("a bundle reports the healthy child AND the orphan manifest dir the loader never sees", async () => {
    const root = tmpDir("hotdog-validate-bundle-");
    dirs.push(root);
    fs.mkdirSync(path.join(root, "good"), { recursive: true });
    fs.writeFileSync(path.join(root, "good", "extension.json"), JSON.stringify(manifestBase({ name: "good" })));
    fs.writeFileSync(path.join(root, "good", "index.ts"), TOOL_INDEX);
    fs.mkdirSync(path.join(root, "silent"), { recursive: true });
    fs.writeFileSync(path.join(root, "silent", "extension.json"), JSON.stringify({ name: "silent" }));

    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", root], json: true }),
    );
    expect(code).toBe(1);
    const env = envelopeOf(out);
    expect(env.mode).toBe("bundle");
    expect(env.extensions.map((e) => e.name)).toEqual(["good"]);
    expect(
      env.findings.some(
        (f) => f.severity === "problem" && f.message.includes(path.join(root, "silent")) && f.message.includes("never reads this manifest"),
      ),
    ).toBe(true);
  });
});

describe("extension validate: load-error triage", () => {
  it("extension.json that cannot be read (a directory wearing its name) is a manifest problem", async () => {
    const base = tmpDir("hotdog-validate-");
    dirs.push(base);
    const dir = path.join(base, "eisdir");
    fs.mkdirSync(path.join(dir, "extension.json"), { recursive: true });
    fs.writeFileSync(path.join(dir, "index.ts"), `export function create() { return {}; }`);
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: false }),
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("extension.json is unreadable");
  });

  it("a manifest that parses to a non-object is a problem", async () => {
    const dir = fixture("scalar", "42\n", `export function create() { return {}; }`);
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: false }),
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("must contain a JSON object");
  });

  it("a missing module the entry imports gets the resolve-flavored load verdict", async () => {
    const dir = fixture(
      "missingdep",
      manifestBase({ name: "missingdep" }),
      // The binding must be USED: Bun's transpiler strips type-only imports,
      // and the missing specifier would never be resolved at all.
      `import { nope } from "./no-such-dep.ts";\nexport function create() { return { hooks: {}, mark: nope }; }`,
    );
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: false }),
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("could not be resolved");
  });

  it("a required service nobody provides fails the contract stage", async () => {
    const dir = fixture(
      "noservice",
      manifestBase({ name: "noservice", requires: { phantom: ["doIt"] } }),
      `export function create() { return {}; }`,
    );
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: false }),
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("[services]");
    expect(out.join("\n")).toContain("phantom");
  });

  it("create() returning null is a warning, not a crash", async () => {    const dir = fixture(
      "nullish",
      manifestBase({ name: "nullish" }),
      `export function create() { return null; }`,
    );
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: false }),
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("create() returned null");
  });

  it("an invalid sdk on the manifest-without-entry path still gets its own finding", async () => {
    // That path carries no loader manifestError (discovery never saw the dir),
    // so the validator's own sdk verdict must not go silent.
    const dir = fixture("orphan-sdk", manifestBase({ name: "orphan-sdk", sdk: "^0.16" }), null);
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: true }),
    );
    expect(code).toBe(1);
    const env = envelopeOf(out);
    const sdkFinding = env.extensions[0]!.findings.find((f) => f.stage === "sdk");
    expect(sdkFinding?.severity).toBe("problem");
    expect(sdkFinding?.message).toContain("invalid");
  });

  // The anchor story is pinned at the classifier level (message patterns):
  // this machine has a GLOBAL bun-link anchor for @read-receipt/hotdog, so a
  // tmp fixture cannot reproduce "Cannot find package" through the resolver.
  // The resolver-side behavior was verified by hand (bun link present/absent).
  it("an unanchored SDK import gets the bun link verdict", async () => {
    const dir = fixture(
      "anchor",
      manifestBase({ name: "anchor" }),
      `throw new Error("Cannot find package '@read-receipt/hotdog' imported from ${"__fixture__"}/index.ts");\nexport {};`,
    );
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: false }),
    );
    expect(code).toBe(1);
    const prose = out.join("\n");
    expect(prose).toContain("[resolve]");
    expect(prose).toContain("no anchor");
    expect(prose).toContain("bun link @read-receipt/hotdog");
  });

  it("a deep import the exports map refuses gets the doors verdict", async () => {
    const dir = fixture(
      "deep",
      manifestBase({ name: "deep" }),
      `throw new Error("Cannot find module '@read-receipt/hotdog/src/core/hooks.ts'");\nexport {};`,
    );
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: false }),
    );
    expect(code).toBe(1);
    const prose = out.join("\n");
    expect(prose).toContain("names no published door");
    expect(prose).toContain("./utils/*");
    expect(prose).toContain("./testing");
  });

  it("a create() that throws surfaces its own message", async () => {
    const dir = fixture(
      "boom",
      manifestBase({ name: "boom" }),
      `export function create() { throw new Error("create boom"); }`,
    );
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", dir], json: false }),
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("create boom");
  });
});

describe("extension validate: main() wiring", () => {
  // The point of the above-the-config seat: a BROKEN defaults.json must not
  // stop extension validation (same rescue doctrine). runMain swaps argv and
  // points HOTDOG_CONFIG_DIR at an empty dir except in the broken-config pin.
  async function runCli(args: string[], configDir?: string): Promise<{ exitCode: number; stdout: string }> {
    const origArgv = process.argv;
    const origEnv = process.env;
    process.env = { ...origEnv, HOTDOG_LOG_TARGET: "none" };
    if (configDir !== undefined) process.env.HOTDOG_CONFIG_DIR = configDir;
    else delete process.env.HOTDOG_CONFIG_DIR;
    process.argv = ["bun", "hotdog", ...args];
    let out = "";
    const origOut = process.stdout.write;
    const origLog = console.log;
    process.stdout.write = ((chunk: string | Buffer) => {
      out += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    console.log = (...a: unknown[]) => process.stdout.write(a.join(" ") + "\n");
    try {
      const exitCode = await main();
      return { exitCode, stdout: out };
    } finally {
      process.argv = origArgv;
      process.env = origEnv;
      process.stdout.write = origOut;
      console.log = origLog;
      resetLoggerForTesting();
    }
  }

  it("dispatches `extension validate` and works with an EMPTY config dir", async () => {
    const emptyConfig = tmpDir("hotdog-validate-config-");
    dirs.push(emptyConfig);
    const dir = fixture("wired", manifestBase({ name: "wired" }), TOOL_INDEX);
    const { exitCode, stdout } = await runCli(["extension", "validate", dir], emptyConfig);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("dry-load: OK - tools: validate_fixture_tool");
  });

  it("still validates with a BROKEN defaults.json (above-the-config seat)", async () => {
    const brokenConfig = tmpDir("hotdog-validate-brokencfg-");
    dirs.push(brokenConfig);
    fs.writeFileSync(path.join(brokenConfig, "defaults.json"), "{ this is not json");
    const dir = fixture("wired2", manifestBase({ name: "wired2" }), TOOL_INDEX);
    const { exitCode, stdout } = await runCli(["extension", "validate", dir], brokenConfig);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No problems found.");
  });
});
