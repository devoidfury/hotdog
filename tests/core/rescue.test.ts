// Tests for `hotdog rescue`: the pre-config diagnostic path.
// Unit tests for the JSON scanner/repair helpers and the config-dir chain,
// plus main()-level integration through a temp config dir.

import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, peekConfigFlags } from "@core/main.ts";
import { resetLoggerForTesting } from "@utils/logger.ts";
import {
  stripJsonc,
  findJsonError,
  scanTopLevelKeys,
  lineColAt,
  diagnoseConfigFile,
  findEnumViolations,
  applyEnumRepairs,
  enumHintsFromValidationErrors,
  runRescue,
} from "@core/config/rescue.ts";
import type { ConfigParamDef } from "@core/extensions/config.ts";
import { resolveConfigDirChain, resolveConfigDir } from "@core/config/defaults.ts";
import { ConfigError } from "@core/error.ts";
import { captureConsole } from "../test-helpers.ts";

// ── stripJsonc ───────────────────────────────────────────────────────────────

describe("stripJsonc", () => {
  it("removes line and block comments with line numbers", () => {
    const src = '{\n// hey\n"a": 1 /* x */\n/* multi\nline */\n}\n';
    const { text, issues } = stripJsonc(src);
    expect(JSON.parse(text)).toEqual({ a: 1 });
    expect(text.split("\n").length).toBe(src.split("\n").length);
    expect(issues).toEqual([
      { kind: "comment", line: 2 },
      { kind: "comment", line: 3 },
      { kind: "comment", line: 4 },
    ]);
  });

  it("leaves // inside strings untouched", () => {
    const src = '{"url": "http://example.com//path"} // trailing\n';
    const { text, issues } = stripJsonc(src);
    expect(JSON.parse(text)).toEqual({ url: "http://example.com//path" });
    expect(issues).toEqual([{ kind: "comment", line: 1 }]);
  });

  it("removes trailing commas before } and ] but keeps separators", () => {
    const src = '{"a": [1, 2,], "b": {"c": 1,},}';
    const { text, issues } = stripJsonc(src);
    expect(JSON.parse(text)).toEqual({ a: [1, 2], b: { c: 1 } });
    expect(issues.map((i) => i.kind)).toEqual([
      "trailing-comma",
      "trailing-comma",
      "trailing-comma",
    ]);
  });

  it("flags a BOM", () => {
    const { text, issues } = stripJsonc('\uFEFF{"a": 1}');
    expect(JSON.parse(text)).toEqual({ a: 1 });
    expect(issues).toEqual([{ kind: "bom", line: 1 }]);
  });
});

// ── findJsonError ────────────────────────────────────────────────────────────

describe("findJsonError", () => {
  it("accepts valid JSON incl. escapes and number formats", () => {
    const ok =
      '{"a":"\\/\\u0041\\n","b":-0.5e+3,"c":[1,2,{"d":null}],"e":true,"f":false}';
    expect(findJsonError(ok)).toBeNull();
  });

  it("rejects trailing garbage after a complete value", () => {
    expect(findJsonError('{"a": 1} x')).toBe(9);
  });

  it("points at the token after a missing separator", () => {
    const src = "[1 2]";
    const idx = findJsonError(src);
    expect(idx).toBe(3); // the "2" where a comma/']' was expected
  });

  it("flags leading zeros, unterminated strings, and missing colons", () => {
    expect(findJsonError("01")).not.toBeNull();
    expect(findJsonError('{"a": "x')).not.toBeNull();
    expect(findJsonError('{"a" 1}')).not.toBeNull();
  });

  it("agrees with JSON.parse on a fuzz set", () => {
    const samples = [
      "",
      "{}",
      "[]",
      "nul",
      '{"a":}',
      '{"a":1,}',
      '[,1]',
      '"unterminated',
      '{"a": 1} ',
      '{"a":"\\"ok"}',
      "1e",
      "-",
      '{"":""}',
    ];
    for (const s of samples) {
      let parseOk = true;
      try {
        JSON.parse(s);
      } catch {
        parseOk = false;
      }
      const scanOk = findJsonError(s) === null;
      expect([s, scanOk]).toEqual([s, parseOk]);
    }
  });
});

// ── scanTopLevelKeys ─────────────────────────────────────────────────────────

describe("scanTopLevelKeys", () => {
  it("reports only depth-1 keys and ignores braces inside strings", () => {
    const src =
      '{\n  "a": 1,\n  "s": "has { and \\" and [",\n  "o": {"b": {"c": 2}},\n  "arr": [{"d": 3}]\n}\n';
    const keys = scanTopLevelKeys(src);
    expect(keys.map((k) => k.key)).toEqual(["a", "s", "o", "arr"]);
    expect(keys[1]!.line).toBe(3);
  });
});

// ── lineColAt / diagnoseConfigFile ──────────────────────────────────────────

describe("lineColAt", () => {
  it("counts lines and columns", () => {
    const t = "ab\ncde\nx";
    expect(lineColAt(t, 0)).toEqual({ line: 1, column: 1 });
    expect(lineColAt(t, 3)).toEqual({ line: 2, column: 1 });
    expect(lineColAt(t, 7)).toEqual({ line: 3, column: 1 });
  });
});

describe("diagnoseConfigFile", () => {
  it("classifies missing, ok, and fixable-broken files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-unit-"));
    try {
      const missing = await diagnoseConfigFile(path.join(dir, "nope.json"));
      expect(missing.status).toBe("missing");

      const okFile = path.join(dir, "ok.json");
      await fs.writeFile(okFile, '{"a": 1}');
      expect((await diagnoseConfigFile(okFile)).status).toBe("ok");

      const badFile = path.join(dir, "bad.json");
      await fs.writeFile(badFile, '{\n"a": 1,\n}');
      const bad = await diagnoseConfigFile(badFile);
      expect(bad.status).toBe("broken");
      expect(bad.fixable).toBe(true);
      expect(bad.jsoncIssues).toEqual([{ kind: "trailing-comma", line: 2 }]);

      const hardFile = path.join(dir, "hard.json");
      await fs.writeFile(hardFile, '{"a" 1}');
      const hard = await diagnoseConfigFile(hardFile);
      expect(hard.status).toBe("broken");
      expect(hard.fixable).toBe(false);
      expect(hard.errorIndex).not.toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── resolveConfigDirChain ────────────────────────────────────────────────────

describe("resolveConfigDirChain", () => {
  const savedEnv = process.env.HOTDOG_CONFIG_DIR;
  const restore = () => {
    if (savedEnv === undefined) delete process.env.HOTDOG_CONFIG_DIR;
    else process.env.HOTDOG_CONFIG_DIR = savedEnv;
  };

  it("the --config-dir flag wins even when the directory does not exist", () => {
    try {
      delete process.env.HOTDOG_CONFIG_DIR;
      const chain = resolveConfigDirChain("/definitely/not/here");
      expect(chain).toHaveLength(1);
      expect(chain[0]!.chosen).toBe(true);
      expect(chain[0]!.exists).toBe(false);
      expect(resolveConfigDir("/definitely/not/here")).toBe("/definitely/not/here");
    } finally {
      restore();
    }
  });

  it("env wins over cwd/etc/fallback when the flag is absent", () => {
    try {
      process.env.HOTDOG_CONFIG_DIR = os.tmpdir();
      const chain = resolveConfigDirChain(null);
      expect(chain[0]!.source).toContain("HOTDOG_CONFIG_DIR");
      expect(chain[0]!.chosen).toBe(true);
      expect(chain.filter((c) => c.chosen)).toHaveLength(1);
      expect(resolveConfigDir(null)).toBe(path.resolve(os.tmpdir()));
    } finally {
      restore();
    }
  });

  it("implicit chain falls back to the bundled examples config when nothing else exists", () => {
    // Isolate every implicit candidate: HOME -> temp (no ~/.config/hotdog),
    // and /etc/hotdog mocked absent via the fs.accessSync the dirExists helper
    // calls (it exists on dev hosts). CWD is temp too: a repo-local ./config
    // is no longer even a chain candidate.
    // Bun's os.homedir() ignores runtime HOME changes, so patch it directly.
    const savedEnv = process.env.HOTDOG_CONFIG_DIR;
    const savedCwd = process.cwd();
    const tmpHome = fsSync.mkdtempSync(path.join(os.tmpdir(), "hotdog-home-"));
    const tmpCwd = fsSync.mkdtempSync(path.join(os.tmpdir(), "hotdog-cwd-"));
    const realHomedir = os.homedir;
    const realAccessSync = fsSync.accessSync;
    try {
      delete process.env.HOTDOG_CONFIG_DIR;
      (os as { homedir: typeof os.homedir }).homedir = () => tmpHome;
      (fsSync as { accessSync: typeof fsSync.accessSync }).accessSync = ((
        p: fsSync.PathLike,
        ...rest: unknown[]
      ) => {
        if (String(p) === "/etc/hotdog") throw new Error("absent (mocked)");
        return (realAccessSync as (...args: unknown[]) => void).call(fsSync, p, ...rest);
      }) as typeof fsSync.accessSync;
      process.chdir(tmpCwd);

      const chain = resolveConfigDirChain(null);
      expect(chain.map((c) => c.source)).toEqual([
        "/etc/hotdog",
        "fallback ~/.config/hotdog",
        "bundled example fallback",
      ]);
      expect(chain.filter((c) => c.exists)).toHaveLength(1); // the bundled dir
      const chosen = chain.filter((c) => c.chosen);
      expect(chosen).toHaveLength(1);
      expect(chosen[0]!.source).toBe("bundled example fallback");
      expect(chosen[0]!.exists).toBe(true);
      expect(resolveConfigDir(null)).toBe(chosen[0]!.path);
      expect(fsSync.existsSync(path.join(chosen[0]!.path, "defaults.json"))).toBe(true);
    } finally {
      (os as { homedir: typeof os.homedir }).homedir = realHomedir;
      (fsSync as { accessSync: typeof fsSync.accessSync }).accessSync = realAccessSync;
      process.chdir(savedCwd);
      if (savedEnv === undefined) delete process.env.HOTDOG_CONFIG_DIR;
      else process.env.HOTDOG_CONFIG_DIR = savedEnv;
      fsSync.rmSync(tmpHome, { recursive: true, force: true });
      fsSync.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it("an existing ./config directory is ignored by the implicit chain", () => {
    // Removed repo-local auto-discovery, security regression test: a cloned
    // repo's config/ must never win the chain unflagged. Same isolation as the
    // bundled-fallback test, with tmpCwd/config created on disk.
    const savedEnv = process.env.HOTDOG_CONFIG_DIR;
    const savedCwd = process.cwd();
    const tmpHome = fsSync.mkdtempSync(path.join(os.tmpdir(), "hotdog-home-"));
    const tmpCwd = fsSync.mkdtempSync(path.join(os.tmpdir(), "hotdog-cwd-"));
    fsSync.mkdirSync(path.join(tmpCwd, "config"));
    const realHomedir = os.homedir;
    const realAccessSync = fsSync.accessSync;
    try {
      delete process.env.HOTDOG_CONFIG_DIR;
      (os as { homedir: typeof os.homedir }).homedir = () => tmpHome;
      (fsSync as { accessSync: typeof fsSync.accessSync }).accessSync = ((
        p: fsSync.PathLike,
        ...rest: unknown[]
      ) => {
        if (String(p) === "/etc/hotdog") throw new Error("absent (mocked)");
        return (realAccessSync as (...args: unknown[]) => void).call(fsSync, p, ...rest);
      }) as typeof fsSync.accessSync;
      process.chdir(tmpCwd);

      const chain = resolveConfigDirChain(null);
      expect(chain.map((c) => c.source)).toEqual([
        "/etc/hotdog",
        "fallback ~/.config/hotdog",
        "bundled example fallback",
      ]);
      const chosen = resolveConfigDir(null);
      expect(chosen).not.toBe(path.join(tmpCwd, "config"));
      expect(chosen).toBe(path.resolve(
        new URL("../../examples/minimal-config/config", import.meta.url).pathname,
      ));
      // The explicit opt-in path still works for trusted directories.
      expect(resolveConfigDir(path.join(tmpCwd, "config"))).toBe(path.join(tmpCwd, "config"));
    } finally {
      (os as { homedir: typeof os.homedir }).homedir = realHomedir;
      (fsSync as { accessSync: typeof fsSync.accessSync }).accessSync = realAccessSync;
      process.chdir(savedCwd);
      if (savedEnv === undefined) delete process.env.HOTDOG_CONFIG_DIR;
      else process.env.HOTDOG_CONFIG_DIR = savedEnv;
      fsSync.rmSync(tmpHome, { recursive: true, force: true });
      fsSync.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it("env still wins over the bundled fallback in the same empty environment", () => {
    // Flag/env resolution must be untouched by the new last-resort fallback.
    try {
      process.env.HOTDOG_CONFIG_DIR = os.tmpdir();
      const chain = resolveConfigDirChain(null);
      expect(chain).toHaveLength(1);
      expect(chain[0]!.source).toContain("HOTDOG_CONFIG_DIR");
      expect(chain[0]!.chosen).toBe(true);
    } finally {
      restore();
    }
  });

  it("always ends with exactly one chosen candidate, matching resolveConfigDir", () => {
    try {
      delete process.env.HOTDOG_CONFIG_DIR;
      const chain = resolveConfigDirChain(null);
      const chosen = chain.filter((c) => c.chosen);
      expect(chosen).toHaveLength(1);
      expect(resolveConfigDir(null)).toBe(chosen[0]!.path);
    } finally {
      restore();
    }
  });
});

// ── peekConfigFlags (early config-location flags) ────────────────────────────

describe("peekConfigFlags", () => {
  it("extracts -d/--config-dir and -f/--config values", () => {
    expect(peekConfigFlags(["-d", "/a", "info"])).toEqual({ config: null, configDir: "/a" });
    expect(peekConfigFlags(["--config-dir", "/a", "info"])).toEqual({
      config: null,
      configDir: "/a",
    });
    expect(peekConfigFlags(["-f", "/a.json", "info"])).toEqual({ config: "/a.json", configDir: null });
    expect(peekConfigFlags(["--config", "/a.json", "info"])).toEqual({
      config: "/a.json",
      configDir: null,
    });
  });

  it("returns nulls for empty or flagless argv, and a dangling flag without its value", () => {
    expect(peekConfigFlags([])).toEqual({ config: null, configDir: null });
    expect(peekConfigFlags(["prompt", "hello"])).toEqual({ config: null, configDir: null });
    expect(peekConfigFlags(["--config-dir"])).toEqual({ config: null, configDir: null });
  });

  it("later occurrence wins (matches parseArgs overwrite behavior)", () => {
    expect(peekConfigFlags(["-d", "/a", "-d", "/b"])).toEqual({ config: null, configDir: "/b" });
  });
});

describe("early config load respects the config-location flags", () => {
  it("a valid --config-dir overrides a broken HOTDOG_CONFIG_DIR", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-override-"));
    try {
      await fs.writeFile(path.join(dir, "defaults.json"), "{ broken\n");
      // Env carries a broken config (simulating a broken host default); the
      // flag points at the checked-in minimal config. Before the peek, the
      // early loadConfig ignored the flag and aborted the whole run.
      const { exitCode, stdout } = await runMain(
        ["--config-dir", "examples/minimal-config/config", "info"],
        { HOTDOG_CONFIG_DIR: dir },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Agent Harness Info");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── main() integration ───────────────────────────────────────────────────────

async function runMain(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const origArgv = process.argv;
  const origEnv = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === "") delete process.env[key];
    else process.env[key] = value;
  }
  process.env.HOTDOG_LOG_TARGET = "stderr";
  process.env.HOTDOG_LOG_LEVEL = "error";
  process.argv = ["bun", "hotdog", ...args];

  let out = "";
  let err = "";
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Buffer) => {
    out += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Buffer) => {
    err += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  const origLog = console.log;
  const origConsoleErr = console.error;
  // Bun's console.log/console.error bind to fd handles, so patching the
  // stream .write alone misses them; route both through the captured streams.
  console.log = (...a: unknown[]) => process.stdout.write(a.join(" ") + "\n");
  console.error = (...a: unknown[]) => process.stderr.write(a.join(" ") + "\n");

  try {
    const exitCode = await main();
    return { exitCode, stdout: out, stderr: err };
  } finally {
    process.argv = origArgv;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    console.log = origLog;
    console.error = origConsoleErr;
    process.env = origEnv;
    resetLoggerForTesting();
  }
}

describe("main rescue subcommand", () => {
  it("flags an explicit config dir that does not exist (startup would fail)", async () => {
    const missing = path.join(os.tmpdir(), `rescue-missing-${Date.now()}`);
    const { exitCode, stdout } = await runMain(["--config-dir", missing, "rescue"]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("PROBLEM");
    expect(stdout).toContain("never falls through");
  });

  it("reports a broken config with context, exit 1, and leaves the file alone", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-int-"));
    try {
      const cfg = path.join(dir, "defaults.json");
      const broken = '{\n  // oops\n  "maxIterations": 30,\n}\n';
      await fs.writeFile(cfg, broken);

      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue"]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain("BROKEN");
      expect(stdout).toContain("line 2");
      expect(stdout).toContain("comment");
      expect(stdout).toContain("trailing comma");
      expect(stdout).toContain("FIXABLE");
      expect(await fs.readFile(cfg, "utf-8")).toBe(broken);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("fix repairs comments and trailing commas, keeps a .bak, and re-run is clean", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-fix-"));
    try {
      const cfg = path.join(dir, "defaults.json");
      const broken = '{\n  // oops\n  "maxIterations": 30,\n}\n';
      await fs.writeFile(cfg, broken);

      const { exitCode, stdout } = await runMain(
        ["--config-dir", dir, "rescue", "fix"],
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("FIXED");
      expect(JSON.parse(await fs.readFile(cfg, "utf-8"))).toEqual({ maxIterations: 30 });
      expect(await fs.readFile(cfg + ".bak", "utf-8")).toBe(broken);

      const again = await runMain(["--config-dir", dir, "rescue"]);
      expect(again.exitCode).toBe(0);
      expect(again.stdout).toContain("No problems found.");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("warns about unknown and duplicate top-level keys with a suggestion", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-keys-"));
    try {
      await fs.writeFile(
        path.join(dir, "defaults.json"),
        '{\n  "defailt_provider": "x",\n  "maxIterations": 2,\n  "maxIterations": 3\n}\n',
      );
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue"]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('UNKNOWN key: "defailt_provider"');
      expect(stdout).toContain("did you mean");
      expect(stdout).toContain("DUPLICATE key");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports schema violations", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-schema-"));
    try {
      await fs.writeFile(path.join(dir, "defaults.json"), '{ "maxIterations": "lots" }\n');
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue"]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain("SCHEMA");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("a broken config no longer crashes other subcommands -- they point to rescue", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-hint-"));
    try {
      await fs.writeFile(path.join(dir, "defaults.json"), "{ broken\n");
      const { exitCode, stdout, stderr } = await runMain(
        ["--config-dir", dir, "prompt", "hi"],
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Error loading config");
      // Guidance rides stderr: stdout stays empty for consumers of piped output.
      expect(stdout).toBe("");
      expect(stderr).toContain("hotdog rescue");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("flags a truncated file at end of input", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-trunc-"));
    try {
      await fs.writeFile(path.join(dir, "defaults.json"), '{ "model": "x"\n');
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue"]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain("NOT auto-fixable");
      expect(stdout).toContain("looks truncated");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("advertises rescue in --help", async () => {
    const { stdout } = await runMain(["--help"]);
    expect(stdout).toContain("rescue");
  });

  it("recognizes layer key names that differ from schema property names", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-layers-"));
    try {
      // chatTimeoutSecs is the config-layer key; chatTimeout is the schema key.
      // healthCheckTimeoutSecs and streamIdleTimeoutSecs are similar cases.
      await fs.writeFile(
        path.join(dir, "defaults.json"),
        '{\n  "chatTimeoutSecs": 300,\n  "healthCheckTimeoutSecs": 10,\n  "streamIdleTimeoutSecs": 300\n}\n',
      );
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("No problems found.");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── rescue --json ────────────────────────────────────────────────────────────

describe("main rescue --json", () => {
  it("valid config prints a pure JSON envelope and exits 0", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-json-ok-"));
    try {
      await fs.writeFile(path.join(dir, "defaults.json"), '{ "maxIterations": 30 }\n');
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue", "--json"]);
      expect(exitCode).toBe(0);
      const env = JSON.parse(stdout); // proves no prose leaked to stdout
      expect(env.problems).toBe(0);
      expect(env.fixed).toBe(0);
      expect(env.config_dir).toBe(path.resolve(dir));
      const chosen = env.resolution.filter((r: any) => r.chosen);
      expect(chosen.length).toBe(1);
      expect(chosen[0].path).toBe(path.resolve(dir));
      expect(env.files.find((f: any) => f.in_use).status).toBe("ok");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("broken fixable file: structured status, jsonc issues, exit 1, file untouched", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-json-broken-"));
    try {
      const cfg = path.join(dir, "defaults.json");
      const broken = '{\n  // oops\n  "maxIterations": 30,\n}\n';
      await fs.writeFile(cfg, broken);
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue", "--json"]);
      expect(exitCode).toBe(1);
      const env = JSON.parse(stdout);
      expect(env.problems).toBeGreaterThan(0);
      const file = env.files.find((f: any) => f.path === path.resolve(cfg));
      expect(file.in_use).toBe(true);
      expect(file.status).toBe("broken");
      expect(file.fixable).toBe(true);
      expect(file.fixed).toBeFalsy();
      const kinds = file.jsonc_issues.map((i: any) => `${i.kind}@${i.lines.join(",")}`).sort();
      expect(kinds).toEqual(["comment@2", "trailing-comma@3"]);
      expect(await fs.readFile(cfg, "utf-8")).toBe(broken);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("unknown and duplicate keys surface as findings with did-you-mean", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-json-keys-"));
    try {
      await fs.writeFile(
        path.join(dir, "defaults.json"),
        '{\n  "defailt_provider": "x",\n  "maxIterations": 2,\n  "maxIterations": 3\n}\n',
      );
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue", "--json"]);
      expect(exitCode).toBe(1);
      const env = JSON.parse(stdout);
      const unknown = env.findings.find((f: any) => f.type === "unknown-key" && f.key === "defailt_provider");
      expect(unknown).toBeDefined();
      expect(unknown.line).toBe(2);
      expect(unknown.did_you_mean.length).toBeGreaterThan(0);
      expect(env.findings.some((f: any) => f.type === "duplicate-key" && f.key === "maxIterations")).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("fix mode: envelope reports the repair and the backup path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-json-fix-"));
    try {
      const cfg = path.join(dir, "defaults.json");
      const broken = '{\n  // oops\n  "maxIterations": 30,\n}\n';
      await fs.writeFile(cfg, broken);
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue", "fix", "--json"]);
      expect(exitCode).toBe(0);
      const env = JSON.parse(stdout);
      expect(env.fixed).toBe(1);
      expect(env.problems).toBe(0);
      const file = env.files.find((f: any) => f.path === path.resolve(cfg));
      expect(file.fixed).toBe(true);
      expect(file.backup).toBe(cfg + ".bak");
      expect(JSON.parse(await fs.readFile(cfg, "utf-8"))).toEqual({ maxIterations: 30 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("missing explicit config dir surfaces a missing-config-dir finding", async () => {
    const missing = path.join(os.tmpdir(), `rescue-json-missing-${Date.now()}`);
    const { exitCode, stdout } = await runMain(["--config-dir", missing, "rescue", "--json"]);
    expect(exitCode).toBe(1);
    const env = JSON.parse(stdout);
    expect(env.findings.some((f: any) => f.type === "missing-config-dir")).toBe(true);
  });
});

// ── stdout discipline on fatal failures ──────────────────────────────────────

describe("fatal config failures keep stdout clean", () => {
  it("a broken config under a JSON-consuming subcommand puts guidance on stderr, not stdout", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-json-fatal-"));
    try {
      await fs.writeFile(path.join(dir, "defaults.json"), "{ broken\n");
      const { exitCode, stdout, stderr } = await runMain(
        ["--config-dir", dir, "info", "--json"],
      );
      expect(exitCode).toBe(1);
      // Guidance is diagnostics, not a result: stdout stays empty so scripts
      // never have to distinguish prose from envelopes.
      expect(stdout).toBe("");
      expect(stderr).toContain("nothing else can start");
      expect(stderr).toContain("hotdog rescue");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── Enum diagnosis and repair (out-of-set values) ────────────────────────────
// The boot keeps FAILING hard on an out-of-set enum value (owner ruling);
// rescue must name the position and make getting out easy: `fix` resets the
// value to the schema default, or removes the key when the schema declares no
// default. The stage is schema-driven: logLevel/logTarget/toolExec/execFence
// and every future (nested/extension) enum ride the same code.

const enumParams = (
  params: Array<{ key: string; schema: Record<string, unknown> }>,
): ConfigParamDef[] =>
  params.map((p) => ({ key: p.key, description: "", defaults: {}, schema: p.schema }));

describe("rescue enum stage: findEnumViolations", () => {
  it("reports an out-of-set top-level enum with the exact line/column of the value token", () => {
    const src = '{\n  "logLevel": "verbos"\n}\n';
    const v = findEnumViolations(src);
    expect(v).toHaveLength(1);
    const one = v[0]!;
    expect(one.path).toBe("logLevel");
    expect(one.line).toBe(2);
    expect(one.column).toBe(15); // the value token, not the key
    expect(one.shipped).toBe('"verbos"'); // as shipped, quotes included
    expect(one.accepted).toEqual(["debug", "info", "warn", "error"]);
    expect(one.hasDefault).toBe(true);
    expect(one.defaultValue).toBe("info");
  });

  it("keeps offsets exact through comments (masked, length-preserving scan)", () => {
    const src = '{\n  // a guide comment\n  "toolExec": "sideways" // inline\n}\n';
    const v = findEnumViolations(src);
    expect(v).toHaveLength(1);
    const one = v[0]!;
    expect(one.path).toBe("toolExec");
    expect(one.line).toBe(3);
    expect(one.column).toBe(15);
    expect(src.slice(one.start, one.end)).toBe('"sideways"');
  });

  it("walks nested schema leaves with house paths and array indices", () => {
    const src = '{\n  "compaction": {\n    "strategy": "bogus"\n  },\n  "list": ["a", "z"]\n}\n';
    const params = enumParams([
      {
        key: "compaction",
        schema: {
          type: "object",
          properties: {
            strategy: { type: "string", enum: ["summarize", "pass-the-baton"], default: "pass-the-baton" },
          },
        },
      },
      { key: "list", schema: { type: "array", items: { type: "string", enum: ["a", "b"] } } },
    ]);
    const v = findEnumViolations(src, params);
    expect(v.map((x) => x.path)).toEqual(["compaction.strategy", "list[1]"]);
    expect(v[0]!.line).toBe(3);
    expect(v[0]!.column).toBe(17);
    expect(v[1]!.shipped).toBe('"z"');
  });

  it("mirrors the validator: valid values pass, wrong types are out-of-set, the schema default itself passes", () => {
    expect(findEnumViolations('{ "logLevel": "debug" }')).toEqual([]);
    const bad = findEnumViolations('{ "logLevel": 42 }');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.shipped).toBe("42");
    // Unparsable shape: no positions are invented.
    expect(findEnumViolations('{ "logLevel": ')).toEqual([]);
  });
});

describe("rescue enum stage: applyEnumRepairs", () => {
  it("resets to the default touching nothing but the value token: comments and formatting survive byte-exact", () => {
    const src = [
      "{",
      "  // guide comment above the key",
      '  "logLevel": "verbos", /* block note beside it */',
      '  "maxIterations": 5',
      "}",
      "",
    ].join("\n");
    const v = findEnumViolations(src);
    expect(v).toHaveLength(1);
    const out = applyEnumRepairs(src, v);
    expect(out).toBe(src.replace('"verbos"', '"info"'));
  });

  it("removes a key with no schema default, keeping every comment (attached notes included)", () => {
    const src = [
      "{",
      '  "maxIterations": 4,',
      "  // note attached to the doomed key",
      '  "doomed": "nope" // trailing note',
      "}",
      "",
    ].join("\n");
    const params = enumParams([{ key: "doomed", schema: { type: "string", enum: ["yes"] } }]); // no default
    const v = findEnumViolations(src, params);
    expect(v).toHaveLength(1);
    expect(v[0]!.hasDefault).toBe(false);
    const out = applyEnumRepairs(src, v);
    // Only the key..value bytes and the separator comma after `4` are gone;
    // the indent before the doomed key survives, so the trailing note keeps
    // its (now three-space) column. Comments are never inside a cut.
    expect(out).toBe(
      [
        "{",
        '  "maxIterations": 4',
        "  // note attached to the doomed key",
        "   // trailing note",
        "}",
        "",
      ].join("\n"),
    );
  });
});

describe("rescue enum stage: fix path (runRescue)", () => {
  async function mkdir(prefix: string): Promise<string> {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  }

  it("fix resets to the schema default, keeps a .bak, and the file rescues to a clean state", async () => {
    const dir = await mkdir("rescue-enum-fix-");
    try {
      const cfg = path.join(dir, "defaults.json");
      const original = '{\n  "logLevel": "verbos"\n}\n';
      await fs.writeFile(cfg, original);
      const { result } = await captureConsole(() =>
        runRescue({ configDirArg: dir, configFileArg: cfg, fix: true }),
      );
      expect(result).toBe(0);
      expect(await fs.readFile(cfg, "utf-8")).toBe('{\n  "logLevel": "info"\n}\n');
      expect(await fs.readFile(cfg + ".bak", "utf-8")).toBe(original);
      const again = await captureConsole(() =>
        runRescue({ configDirArg: dir, configFileArg: cfg, fix: false }),
      );
      expect(again.result).toBe(0);
      expect(again.output).toContain("No problems found.");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("fix removes the key when the schema declares no default; untouched bytes elsewhere", async () => {
    const dir = await mkdir("rescue-enum-remove-");
    try {
      const cfg = path.join(dir, "defaults.json");
      const original = '{\n  "maxIterations": 4,\n  "doomed": "nope",\n  "hideTools": true\n}\n';
      await fs.writeFile(cfg, original);
      const params = enumParams([{ key: "doomed", schema: { type: "string", enum: ["yes"] } }]);
      const { result } = await captureConsole(() =>
        runRescue({ configDirArg: dir, configFileArg: cfg, fix: true, configParams: params }),
      );
      expect(result).toBe(0);
      expect(await fs.readFile(cfg, "utf-8")).toBe(
        '{\n  "maxIterations": 4,\n  "hideTools": true\n}\n',
      );
      expect(await fs.readFile(cfg + ".bak", "utf-8")).toBe(original);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("every other byte survives: formatting, spacing and ordering are preserved around the spliced value", async () => {
    const dir = await mkdir("rescue-enum-bytes-");
    try {
      const cfg = path.join(dir, "defaults.json");
      const original = '{\t"logLevel":     "verbos"  ,\n    "maxIterations" : 7\n\n}';
      await fs.writeFile(cfg, original);
      await captureConsole(() =>
        runRescue({ configDirArg: dir, configFileArg: cfg, fix: true }),
      );
      expect(await fs.readFile(cfg, "utf-8")).toBe(original.replace('"verbos"', '"info"'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("a file with two violations reports (and fixes) both, and the fix is idempotent", async () => {
    const dir = await mkdir("rescue-enum-two-");
    try {
      const cfg = path.join(dir, "defaults.json");
      await fs.writeFile(cfg, '{\n  "logLevel": "verbos",\n  "logTarget": "sideways"\n}\n');
      const first = await captureConsole(() =>
        runRescue({ configDirArg: dir, configFileArg: cfg, fix: false }),
      );
      expect(first.result).toBe(1);
      expect(first.output).toContain('ENUM: "logLevel"');
      expect(first.output).toContain('ENUM: "logTarget"');
      expect(first.output).toContain("2 problem(s) found.");
      const { result } = await captureConsole(() =>
        runRescue({ configDirArg: dir, configFileArg: cfg, fix: true }),
      );
      expect(result).toBe(0);
      expect(JSON.parse(await fs.readFile(cfg, "utf-8"))).toEqual({
        logLevel: "info",
        logTarget: "stderr",
      });
      // second run: no-op -- zero new backups, still clean.
      await captureConsole(() =>
        runRescue({ configDirArg: dir, configFileArg: cfg, fix: true }),
      );
      expect((await fs.readdir(dir)).sort()).toEqual(["defaults.json", "defaults.json.bak"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rescue enum stage: main integration", () => {
  it("rescue reports an out-of-set enum with line/column and the accepted set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-enum-cli-"));
    try {
      await fs.writeFile(path.join(dir, "defaults.json"), '{\n  "logLevel": "verbos"\n}\n');
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue"]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('ENUM: "logLevel" (line 2, column 15) = "verbos"');
      expect(stdout).toContain('accepted set ["debug", "info", "warn", "error"]');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("nested extension enums (compaction.strategy) ride the same stage via the real config params", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-enum-nested-"));
    try {
      const cfg = path.join(dir, "defaults.json");
      await fs.writeFile(cfg, '{\n  "compaction": {\n    "strategy": "bogus"\n  }\n}\n');
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue"]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('ENUM: "compaction.strategy" (line 3, column 17) = "bogus"');
      const fix = await runMain(["--config-dir", dir, "rescue", "fix"]);
      expect(fix.exitCode).toBe(0);
      expect(JSON.parse(await fs.readFile(cfg, "utf-8"))).toEqual({
        compaction: { strategy: "pass-the-baton" },
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("boot failure on an out-of-set value names the repair command, every key and its accepted set (stdout stays clean)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-enum-fatal-"));
    try {
      await fs.writeFile(
        path.join(dir, "defaults.json"),
        '{\n  "logLevel": "verbos",\n  "logTarget": "sideways"\n}\n',
      );
      const { exitCode, stdout, stderr } = await runMain(["--config-dir", dir, "-p", "hi"]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      // The hard validation failure itself survives...
      expect(stderr).toContain("Configuration validation failed");
      // ...and the guidance now names the way out for BOTH keys.
      expect(stderr).toContain("`hotdog rescue fix`");
      expect(stderr).toContain('logLevel: accepted "debug" | "info" | "warn" | "error"');
      expect(stderr).toContain('logTarget: accepted "stderr" | "stdout" | "none"');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("enumHintsFromValidationErrors", () => {
  it("extracts key + accepted set from the validator's enum grammar and ignores the rest", () => {
    const err = ConfigError.ValidationError([
      'logLevel: value "verbos" not in enum ["debug", "info", "warn", "error"]',
      "maxIterations: expected integer, got string",
    ]);
    expect(err.validationErrors).toBeDefined();
    expect(enumHintsFromValidationErrors(err.validationErrors)).toEqual([
      { key: "logLevel", accepted: ['"debug"', '"info"', '"warn"', '"error"'] },
    ]);
    expect(enumHintsFromValidationErrors(undefined)).toEqual([]);
    expect(enumHintsFromValidationErrors(["root: must be 1"])).toEqual([]);
  });
});
