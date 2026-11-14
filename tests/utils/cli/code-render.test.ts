// The terminal posture for a declared result-sourced kind "file" part with a
// guessable language: the declaration plus the shared registry's basename
// table decide (no tool names here), and every absence falls back to the
// generic plain box. Sink wiring is pinned in cli-output-sink.test.ts.

import { describe, it, expect } from "bun:test";
import { renderCliCode, resolveCliFileSyntax } from "@utils/cli/code-render.ts";
import { ColorPalette } from "@utils/cli/colors.ts";
import type { ToolDisplaySpec } from "@core/extensions/tool-registry.ts";

// read's shipped declaration, mirrored so a test reads like a real call.
const READ: ToolDisplaySpec[] = [
  { kind: "file", pathArg: "path", offsetArg: "offset", limitArg: "limit" },
];
const args = (path: unknown): string => JSON.stringify({ path });

describe("resolveCliFileSyntax: the declaration and the table decide", () => {
  it("resolves nothing without a result-sourced file part", () => {
    expect(resolveCliFileSyntax(undefined, args("a.ts"))).toBeNull();
    expect(resolveCliFileSyntax([], args("a.ts"))).toBeNull();
    expect(resolveCliFileSyntax([{ kind: "prose" }, { kind: "tomorrow" }] as ToolDisplaySpec[], args("a.ts"))).toBeNull();
    // The args-sourced file posture is a call-time body, not a result.
    expect(resolveCliFileSyntax([{ kind: "file", source: "args", arg: "content", pathArg: "path" }], args("a.ts"))).toBeNull();
    // A file part with no path key cannot name a language.
    expect(resolveCliFileSyntax([{ kind: "file" }], args("a.ts"))).toBeNull();
  });

  it("resolves nothing for a failed call or unparseable args", () => {
    expect(resolveCliFileSyntax(READ, args("a.ts"), { failed: true })).toBeNull();
    expect(resolveCliFileSyntax(READ, "not json")).toBeNull();
    expect(resolveCliFileSyntax(READ, "[1,2]")).toBeNull();
  });

  it("skips missing, non-string, and empty path values", () => {
    expect(resolveCliFileSyntax(READ, "{}")).toBeNull();
    expect(resolveCliFileSyntax(READ, JSON.stringify({ path: 7 }))).toBeNull();
    expect(resolveCliFileSyntax(READ, args(""))).toBeNull();
  });

  it("guesses through the registry table: extension, dotless basename, slash shape", () => {
    expect(resolveCliFileSyntax(READ, args("src/a.ts"))).toBe("typescript");
    expect(resolveCliFileSyntax(READ, args("win\\path\\mod.rs"))).toBe("rust");
    expect(resolveCliFileSyntax(READ, args("Dockerfile.dev"))).toBe("dockerfile");
    expect(resolveCliFileSyntax(READ, args("src"))).toBeNull(); // dotless dir name
    expect(resolveCliFileSyntax(READ, args("notes.unknownext"))).toBeNull();
  });

  it("a guess without a scanner renders plain: markdown's scanner lives outside the registry", () => {
    expect(resolveCliFileSyntax(READ, args("README.md"))).toBeNull();
  });
});

describe("renderCliCode: painting the runs", () => {
  const colors = new ColorPalette({ use_colors: true });
  const plain = new ColorPalette({ use_colors: false });

  it("colors off returns the input untouched (the legacy byte path)", () => {
    const text = "const x = 1";
    expect(renderCliCode(text, "typescript", plain)).toBe(text);
  });

  it("lights known classes and washes the rest in the tool_result color", () => {
    expect(renderCliCode("const x = 1 // hi", "typescript", colors)).toBe(
      "\x1b[35mconst\x1b[0m\x1b[32m \x1b[0m\x1b[32mx\x1b[0m\x1b[32m \x1b[0m" +
        "\x1b[32m=\x1b[0m\x1b[32m \x1b[0m\x1b[1;36m1\x1b[0m\x1b[32m \x1b[0m\x1b[90m// hi\x1b[0m",
    );
  });

  it("is lossless under ANSI stripping", () => {
    const text = 'def f(x):\n    return {"k": [1, 2]}  # add';
    const stripped = renderCliCode(text, "python", colors).replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toBe(text);
  });

  it("empty lines ride through unpainted (no bare SGR pairs, spacing is the newline buffer's)", () => {
    expect(renderCliCode("a\n\nb\n", "typescript", colors)).toBe(
      "\x1b[32ma\x1b[0m\n\n\x1b[32mb\x1b[0m\n",
    );
  });

  it("neutralizes ESC before composing ANSI: a file line cannot forge a sequence", () => {
    const painted = renderCliCode("\x1b[31mred", "typescript", colors);
    expect(painted).toContain("[U+001B]");
    // The forged sequence never survives: the only colors present are the
    // painter's own palette picks for the neutralized text.
    expect(painted).not.toContain("\x1b[31m");
  });

  it("a scannerless lang handed in directly stays plain (resolve is not assumed)", () => {
    expect(renderCliCode("hello", "markdown", colors)).toBe("hello");
    expect(renderCliCode("hello", "no-such-lang", colors)).toBe("hello");
  });
});
