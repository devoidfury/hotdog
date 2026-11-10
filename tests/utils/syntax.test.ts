// Unit tests for the shared syntax tokenizer (src/utils/syntax/): typed
// runs over a shell corpus, the lang registry lookup, and the byte-identity
// of the terminal renderer (applyShellHighlight) against a golden ANSI
// corpus -- the same goldens the unchanged colors.test.ts pins extend.

import { describe, it, expect } from "bun:test";
import { getTokenizer, registerTokenizer, type SyntaxRun } from "@utils/syntax/index.ts";
import { tokenizeShell } from "@utils/syntax/shell.ts";
import { ColorPalette, applyShellHighlight } from "@utils/cli/colors.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

describe("tokenizeShell runs", () => {
  it("marks the command word and rides the rest default", () => {
    expect(tokenizeShell("ls -la")).toEqual([
      run("command", "ls"),
      run("default", " "),
      run("default", "-la"),
    ]);
  });

  it("arms the command position after every operator, splitting glued ones", () => {
    expect(tokenizeShell("a&&b;c")).toEqual([
      run("command", "a"),
      run("operator", "&&"),
      run("command", "b"),
      run("operator", ";"),
      run("command", "c"),
    ]);
    expect(tokenizeShell("a | b ;c||d").filter((r) => r.type === "operator").map((r) => r.text)).toEqual(
      ["|", ";", "||"],
    );
  });

  it("quotes are single runs and never split on glued operators", () => {
    expect(tokenizeShell("grep 'a;b' f")).toEqual([
      run("command", "grep"),
      run("default", " "),
      run("default", "'a;b'"),
      run("default", " "),
      run("default", "f"),
    ]);
    // Double quotes keep their escapes; the shell words inside stay inert.
    expect(tokenizeShell('grep "a && b" src')).toEqual([
      run("command", "grep"),
      run("default", " "),
      run("default", '"a && b"'),
      run("default", " "),
      run("default", "src"),
    ]);
    expect(tokenizeShell('echo "say \\"hi\\""').map((r) => r.text).join("")).toBe(
      'echo "say \\"hi\\""',
    );
    expect(tokenizeShell('echo "say \\"hi\\""')[2]!.type).toBe("default");
    // A quoted first word reads as itself and spends the command position.
    expect(tokenizeShell("'sh' -c x")[0]).toEqual(run("default", "'sh'"));
  });

  it("keeps env-assignment prefixes default but the command position armed", () => {
    expect(tokenizeShell("FOO=1 cmd arg")).toEqual([
      run("default", "FOO=1"),
      run("default", " "),
      run("command", "cmd"),
      run("default", " "),
      run("default", "arg"),
    ]);
  });

  it("carries a stray quote verbatim as its own run", () => {
    const runs = tokenizeShell("echo don't");
    expect(runs.map((r) => r.text).join("")).toBe("echo don't");
    expect(runs[0]).toEqual(run("command", "echo"));
    expect(runs.some((r) => r.text === "'")).toBe(true);
    // The stray quote and everything after it stay default.
    expect(runs.slice(1).every((r) => r.type === "default")).toBe(true);
  });

  it("treats a lone & (background, 2>&1) as default, not an operator", () => {
    for (const cmd of ["make -j 2>&1 & wait", "sleep 5 &"]) {
      expect(tokenizeShell(cmd).some((r) => r.type === "operator" && r.text === "&")).toBe(false);
      expect(tokenizeShell(cmd).map((r) => r.text).join("")).toBe(cmd);
    }
    // The lone & does not arm a command position either.
    expect(tokenizeShell("sleep 5 & echo hi")[6]).toEqual(run("default", "echo"));
  });

  it("whitespace runs are default and lossless", () => {
    const text = "  git   commit  -m  'msg'  ";
    const runs = tokenizeShell(text);
    expect(runs.map((r) => r.text).join("")).toBe(text);
    expect(runs.filter((r) => /^\s+$/.test(r.text)).every((r) => r.type === "default")).toBe(true);
  });

  it("empty input yields no runs", () => {
    expect(tokenizeShell("")).toEqual([]);
  });
});

describe("tokenizer registry", () => {
  it("resolves shell and misses unknown langs (plain-text fallback signal)", () => {
    expect(getTokenizer("shell")).toBe(tokenizeShell);
    expect(getTokenizer("json")).toBeUndefined();
    expect(getTokenizer("")).toBeUndefined();
    // A lang name shadowing Object.prototype must miss, not resolve.
    expect(getTokenizer("constructor")).toBeUndefined();
    expect(getTokenizer("toString")).toBeUndefined();
  });

  it("registerTokenizer adds a lang as a drop-in", () => {
    const upper = (text: string): SyntaxRun[] => [{ type: "default", text }];
    registerTokenizer("unit-test-lang", upper);
    expect(getTokenizer("unit-test-lang")).toBe(upper);
    expect(getTokenizer("unit-test-lang")!("abc")).toEqual([run("default", "abc")]);
  });
});

describe("terminal byte-identity (applyShellHighlight over token runs)", () => {
  // The default palette lights commands cyan (36) and operators
  // bright-black (90). These goldens pin what the extracted tokenizer +
  // thin renderer must emit, byte for byte, matching the unchanged
  // colors.test.ts expectations.
  const GOLDEN: Array<[string, string]> = [
    ["cd /tmp && ls", "\x1b[36mcd\x1b[0m /tmp \x1b[90m&&\x1b[0m \x1b[36mls\x1b[0m"],
    ["echo hi; ls -la", "\x1b[36mecho\x1b[0m hi\x1b[90m;\x1b[0m \x1b[36mls\x1b[0m -la"],
    ["a&&b||c|d;e", "\x1b[36ma\x1b[0m\x1b[90m&&\x1b[0m\x1b[36mb\x1b[0m\x1b[90m||\x1b[0m\x1b[36mc\x1b[0m\x1b[90m|\x1b[0m\x1b[36md\x1b[0m\x1b[90m;\x1b[0m\x1b[36me\x1b[0m"],
    ["make -j 2>&1 & wait", "\x1b[36mmake\x1b[0m -j 2>&1 & wait"],
    ["grep 'a;b' f;wc -l f", "\x1b[36mgrep\x1b[0m 'a;b' f\x1b[90m;\x1b[0m\x1b[36mwc\x1b[0m -l f"],
    ["grep \"a && b\" src", "\x1b[36mgrep\x1b[0m \"a && b\" src"],
    ["echo don't", "\x1b[36mecho\x1b[0m don't"],
    ["FOO=1 cmd arg", "FOO=1 \x1b[36mcmd\x1b[0m arg"],
    ["git log --oneline | head -5", "\x1b[36mgit\x1b[0m log --oneline \x1b[90m|\x1b[0m \x1b[36mhead\x1b[0m -5"],
  ];

  // An independent mini-renderer (no colors.ts): proves the golden comes
  // from the token runs, and that applyShellHighlight agrees with it.
  const renderFromRuns = (runs: SyntaxRun[]): string =>
    runs
      .map((r) =>
        r.type === "command" ? `\x1b[36m${r.text}\x1b[0m` : r.type === "operator" ? `\x1b[90m${r.text}\x1b[0m` : r.text,
      )
      .join("");

  for (const [text, golden] of GOLDEN) {
    it(`renders ${JSON.stringify(text)} byte-identically`, () => {
      expect(applyShellHighlight(text, ColorPalette.default())).toBe(golden);
      expect(renderFromRuns(getTokenizer("shell")!(text))).toBe(golden);
    });
  }
});
