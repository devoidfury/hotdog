// rescue tombstone: removed config keys get a REMOVED verdict (not UNKNOWN),
// caret-pointing at the line, naming the replacement, in prose and --json.

import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "@core/main.ts";
import { resetLoggerForTesting } from "@utils/logger.ts";

// Same capture harness as tests/core/rescue.test.ts (local on purpose: main()
// mutates argv/env/console).
async function runMain(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const origArgv = process.argv;
  const origEnv = { ...process.env };
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

async function withConfig<T>(body: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-removed-"));
  try {
    await fs.writeFile(path.join(dir, "defaults.json"), body);
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("rescue removed-key tombstone (maxToolOutputLines)", () => {
  it("flags the top-level AND nested old keys with a caret and names maxToolResultChars", async () => {
    const cfg =
      '{\n  "maxIterations": 2,\n  "maxToolOutputLines": 100,\n  "bashTool": {\n    "maxToolOutputLines": 50\n  }\n}\n';
    await withConfig(cfg, async (dir) => {
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue"]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('REMOVED key: "maxToolOutputLines" (line 3)');
      expect(stdout).toContain('REMOVED key: "maxToolOutputLines" (line 5)');
      expect(stdout).toContain('replaced by "maxToolResultChars"');
      // caret-pointing at the key (errorExcerpt's pointing style)
      const caretLines = stdout.split("\n").filter((l) => l.trim() === "^");
      expect(caretLines.length).toBeGreaterThanOrEqual(2);
      // Not ALSO an UNKNOWN verdict for the same key.
      expect(stdout).not.toContain('UNKNOWN key: "maxToolOutputLines"');
    });
  });

  it("--json carries removed-key findings naming the replacement", async () => {
    const cfg = '{\n  "coreTools": {\n    "maxToolOutputLines": 600\n  }\n}\n';
    await withConfig(cfg, async (dir) => {
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue", "--json"]);
      expect(exitCode).toBe(1);
      const envelope = JSON.parse(stdout);
      const removed = envelope.findings.filter((f: { type: string }) => f.type === "removed-key");
      expect(removed.length).toBe(1);
      expect(removed[0].key).toBe("maxToolOutputLines");
      expect(removed[0].line).toBe(3);
      expect(removed[0].message).toContain("maxToolResultChars");
      expect(envelope.problems).toBeGreaterThanOrEqual(1);
    });
  });

  it("a config without the old keys carries no removed-key verdict", async () => {
    await withConfig('{\n  "maxToolResultChars": 500000\n}\n', async (dir) => {
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue", "--json"]);
      expect(exitCode).toBe(0);
      expect(stdout).not.toContain("removed-key");
      expect(stdout).not.toContain("UNKNOWN");
    });
  });

  it("kebab and snake spellings of the old key are tombstoned too", async () => {
    await withConfig('{\n  "max_tool_output_lines": 20\n}\n', async (dir) => {
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue"]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('REMOVED key: "max_tool_output_lines"');
      expect(stdout).toContain("maxToolResultChars");
    });
  });
});

// ── B0 retirements: root `temperature` and `prompt` ──────────────────────────

describe("rescue removed-key tombstone (temperature / prompt, root-only)", () => {
  it("flags the retired root keys with carets, names their replacements, and stays off the nested survivors", async () => {
    const cfg =
      '{\n  "temperature": 0.7,\n  "prompt": "> ",\n  "providers": [\n    { "name": "p1", "temperature": 0.4, "models": [{ "name": "m1", "temperature": 0.2 }] }\n  ]\n}\n';
    await withConfig(cfg, async (dir) => {
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue"]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('REMOVED key: "temperature" (line 2)');
      expect(stdout).toContain('REMOVED key: "prompt" (line 3)');
      expect(stdout).toContain('replaced by "per-provider / per-model temperature definitions (providers[].temperature, providers[].models[].temperature)"');
      expect(stdout).toContain('replaced by "the interactive CLI\'s own prompt surface"');
      // NOT also UNKNOWN for the same keys.
      expect(stdout).not.toContain('UNKNOWN key: "temperature"');
      expect(stdout).not.toContain('UNKNOWN key: "prompt"');
      // topLevelOnly: the SAME spelling under providers / a model entry is the
      // surviving class the tombstone NAMES as the replacement -- no verdict.
      const removedLines = stdout.split("\n").filter((l) => l.includes("REMOVED key:"));
      expect(removedLines.length).toBe(2);
    });
  });

  it("--json carries both retired-key findings with their replacement text", async () => {
    const cfg = '{\n  "temperature": 0.7,\n  "prompt": "> "\n}\n';
    await withConfig(cfg, async (dir) => {
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue", "--json"]);
      expect(exitCode).toBe(1);
      const envelope = JSON.parse(stdout);
      const removed = envelope.findings.filter((f: { type: string }) => f.type === "removed-key");
      expect(removed.length).toBe(2);
      const byKey = Object.fromEntries(removed.map((f: { key: string }) => [f.key, f]));
      expect(byKey.temperature.message).toContain("providers[].temperature");
      expect(byKey.prompt.message).toContain("the interactive CLI's own prompt surface");
    });
  });

  it("a file WITHOUT the retired keys (nested temperature included) diagnoses clean", async () => {
    // The pin the task demands: absence is CLEAN -- and the nested replacement
    // spelling must not conjure a verdict either.
    await withConfig('{\n  "maxRetries": 3,\n  "providers": [{ "name": "p1", "temperature": 0.4 }]\n}\n', async (dir) => {
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue", "--json"]);
      expect(exitCode).toBe(0);
      expect(stdout).not.toContain("removed-key");
      expect(stdout).not.toContain("REMOVED");
      expect(stdout).not.toContain("UNKNOWN");
    });
  });

  it("kebab and snake spellings of the retired roots are tombstoned too", async () => {
    await withConfig('{\n  "Temperature": 0.1\n}\n', async (dir) => {
      const { exitCode, stdout } = await runMain(["--config-dir", dir, "rescue"]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('REMOVED key: "Temperature"');
    });
  });
});
