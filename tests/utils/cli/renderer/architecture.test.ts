// Architecture contract for the stage-2a renderer core:
//
// 1. Inverted-dependency law, renderer side: the renderer is a leaf -- every
//    import lands inside the renderer directory or on @core/error.ts
//    (formatError, the house catch rule). No extension imports, no bare
//    runtime deps (zero-dep law, design note §13).
// 2. Wiring boundary: only the ui-interactive-cli split bridge (stage 2b) may
//    import the renderer. Any other importer -- an early or accidental one --
//    must fail this test; the renderer stays extension-agnostic.
// 3. Sole byte home: the ?2026/?2004/?25 mode bytes and setRawMode live in
//    teardown.ts (TerminalModes) and the seam/double plumbing that must
//    implement them. The commit engine and scheduler emit zero mode bytes --
//    they borrow TerminalModes so pairs cannot drift apart across files (§10).

import { describe, it, expect } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");
const RENDERER = join(ROOT, "src/utils/cli/renderer");
const SRC = join(ROOT, "src");

// Matches static imports, side-effect imports, re-exports, and dynamic imports
// (same shape as tests/core/architecture-core-no-extensions.test.ts).
const SPEC_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

function scan(dir: string): Promise<string[]> {
  return (async () => {
    const files: string[] = [];
    for await (const rel of new Glob("**/*.ts").scan(dir)) files.push(join(dir, rel));
    return files.sort();
  })();
}

/** Rough comment stripper: block comments and line comments. The renderer's string literals never contain "//". */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("architecture: renderer is a dependency leaf", () => {
  it("every renderer import lands in-directory or on @core/error.ts", async () => {
    const files = await scan(RENDERER);
    expect(files.length).toBeGreaterThanOrEqual(12); // vacuity guard

    const violations: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(SPEC_RE)) {
        const spec = match[1]!;
        if (spec.startsWith("./") || spec.startsWith("../")) {
          const target = resolve(dirname(file), spec);
          if (!target.startsWith(RENDERER + "/") && target !== RENDERER) {
            violations.push(`${file}: climbing import "${spec}"`);
          }
        } else if (spec !== "@core/error.ts") {
          violations.push(`${file}: external import "${spec}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("only the ui-interactive-cli wiring may import the renderer (stage 2b)", async () => {
    const WIRING = join(ROOT, "src", "extensions", "ui-interactive-cli");
    const files = await scan(SRC);
    const outside = files.filter(
      (f) => !f.startsWith(RENDERER + "/") && !f.startsWith(WIRING + "/"),
    );
    expect(outside.length).toBeGreaterThan(100); // vacuity guard: the whole src tree is scanned

    const wired: string[] = [];
    for (const file of outside) {
      for (const match of readFileSync(file, "utf8").matchAll(SPEC_RE)) {
        const spec = match[1]!;
        let resolved: string | null = null;
        if (spec.startsWith("./") || spec.startsWith("../")) resolved = resolve(dirname(file), spec);
        else if (spec.startsWith("@utils/")) resolved = join(SRC, "utils", spec.slice("@utils/".length));
        if (resolved && (resolved.startsWith(RENDERER + "/") || resolved === join(RENDERER, "index.ts"))) {
          wired.push(`${file}: imports "${spec}"`);
        }
      }
    }
    expect(wired).toEqual([]);
  });
});

describe("architecture: mode bytes have exactly one home (§10)", () => {
  it("?2026/?2004/?25 literals appear only in teardown.ts", async () => {
    const MODE_RE = /\?2026|\?2004|\?25[h l]/;
    const violations: string[] = [];
    for (const file of await scan(RENDERER)) {
      if (basenameIs(file, "teardown.ts")) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (MODE_RE.test(code)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it("setRawMode is touched only by the seam, its real/test impls, and TerminalModes", async () => {
    const ALLOWED = ["seams.ts", "terminal.ts", "grid.ts", "teardown.ts"];
    const violations: string[] = [];
    for (const file of await scan(RENDERER)) {
      if (ALLOWED.some((n) => basenameIs(file, n))) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (code.includes("setRawMode")) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it("the renderer tests mock no modules (AGENTS.md ban)", async () => {
    const files = await scan(import.meta.dir);
    expect(files.length).toBeGreaterThanOrEqual(5);
    // A real call site has a dot then an open paren between the words; the
    // pattern stays split here so this scanner never flags its own source.
    const MOCK_RE = /\bmock\W[a-z]*module\s*\(/;
    const offenders = files.filter((f) => MOCK_RE.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

function basenameIs(file: string, name: string): boolean {
  return file.endsWith("/" + name);
}

// Appended by the stage-3a audit: the input/editor stack (the modules 3b will
// drive) must stay pure -- no fs, no process, no global timers. Persistence,
// signals, and timing all arrive through the injected seams (Clock, save
// callback), which is what makes the whole stack testable without a TTY.

describe("architecture: the 3a input stack has no ambient runtime access", () => {
  const PURE = [
    "stdin-buffer.ts", "keyevents.ts", "clusters.ts", "line-editor.ts",
    "history.ts", "popup.ts", "editor-view.ts",
  ];

  it("no fs/process/tty imports and no bare process references", () => {
    const offenders: string[] = [];
    for (const name of PURE) {
      const code = stripComments(readFileSync(join(RENDERER, name), "utf8"));
      if (/node:(fs|process|tty|child_process|net)/.test(code)) offenders.push(`${name}: node: builtin`);
      if (/\bprocess\b/.test(code)) offenders.push(`${name}: process reference`);
    }
    expect(offenders).toEqual([]);
  });

  it("timers are reached only through the injected Clock (clock.setTimeout, never bare)", () => {
    const offenders: string[] = [];
    for (const name of PURE) {
      const code = stripComments(readFileSync(join(RENDERER, name), "utf8"));
      // Any .setTimeout( style call is a seam call; a BARE setTimeout( is the global.
      if (/(?<![.\w])(setTimeout|setInterval|clearTimeout|clearInterval|setImmediate|clearImmediate)\s*\(/.test(code)) {
        offenders.push(`${name}: global timer call`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
