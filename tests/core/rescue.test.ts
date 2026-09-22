// Tests for `hotdog rescue`: the pre-config diagnostic path.
// Unit tests for the JSON scanner/repair helpers and the config-dir chain,
// plus main()-level integration through a temp config dir.

import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
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
} from "@core/config/rescue.ts";
import { resolveConfigDirChain, resolveConfigDir } from "@core/config/defaults.ts";

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
  console.log = (...a: unknown[]) => process.stdout.write(a.join(" ") + "\n");

  try {
    const exitCode = await main();
    return { exitCode, stdout: out, stderr: err };
  } finally {
    process.argv = origArgv;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    console.log = origLog;
    process.env = origEnv;
    resetLoggerForTesting();
  }
}

describe("main rescue subcommand", () => {
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
      expect(stdout).toContain("hotdog rescue");
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
