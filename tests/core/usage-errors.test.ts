// Usage-error contract for the CLI parse phase:
//  - exit code 2 (getopt convention) distinguishes "you invoked it wrong"
//    from runtime failures (1);
//  - the rejected argv token is echoed spoof-safe: terminal escapes and bidi
//    marks come back as [U+XXXX] tokens, raw bytes never reach the terminal.

import { describe, it, expect } from "bun:test";
import { main } from "@core/main.ts";
import { resetLoggerForTesting } from "@utils/logger.ts";

async function runMain(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const origArgv = process.argv;
  const origEnv = { ...process.env };
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

const MINIMAL = ["--config-dir", "examples/minimal-config/config"];

describe("usage-error exit codes", () => {
  it("unknown subcommand exits 2 and echoes the token spoof-safe", async () => {
    const { exitCode, stderr } = await runMain([...MINIMAL, "fo\u001B[5moobar"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Unknown subcommand");
    expect(stderr).toContain("[U+001B]");
    expect(stderr).not.toContain("\u001B[5m");
  });

  it("unknown flag exits 2 with the unknown-flag message", async () => {
    const { exitCode, stderr } = await runMain([...MINIMAL, "--bogus-flag-xyz"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Unknown flag: --bogus-flag-xyz");
  });

  it("flag missing its value exits 2", async () => {
    const { exitCode, stderr } = await runMain([...MINIMAL, "--model"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--model requires a value");
  });

  it("a clean parse still exits 0", async () => {
    const { exitCode } = await runMain([...MINIMAL, "info"]);
    expect(exitCode).toBe(0);
  });
});
