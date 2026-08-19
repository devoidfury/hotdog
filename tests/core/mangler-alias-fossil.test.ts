// Source hygiene: no Marker Mangler alias may be committed into src/.
//
// The mangler rewrites protected markers to random per-session aliases in
// everything an agent receives. If an agent writes or edits text based on
// what it saw, the alias can fossilize into the source as a literal string.
// Such a literal is dead: no session's mapping will ever contain it, so it
// can never be unescaped back to the real marker.
//
// This test scans src/ for alias literals (pattern built by the mangler
// itself, see buildAliasPattern in src/core/marker-mangler.ts) and fails
// listing every hit.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MarkerMangler, buildAliasPattern } from "../../src/core/marker-mangler.ts";

function collectFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

interface Fossil {
  file: string;
  line: number;
  match: string;
}

function findFossils(srcDir: string): Fossil[] {
  const fossils: Fossil[] = [];
  const pattern = buildAliasPattern();

  for (const file of collectFiles(srcDir)) {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0; // reset internal state
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(lines[i]!)) !== null) {
        fossils.push({ file, line: i + 1, match: m[0] });
        if (m.index === pattern.lastIndex) pattern.lastIndex++;
      }
    }
  }
  return fossils;
}

/**
 * Escape a protected marker and pull the alias out of the result.
 * The marker is built from bare words: only the tag form is mangled, so
 * the parts are safe to write literally. This keeps the test editable by
 * agents who only ever see the aliased form of the full marker.
 */
function makeRealAlias(): string {
  const escaped = new MarkerMangler().escape("<" + "tool-call" + ">");
  const m = (escaped ?? "").match(/^<(m_[^>]+)>$/);
  if (!m?.[1]) throw new Error(`unexpected escape output: ${escaped}`);
  return m[1];
}

describe("mangler alias fossil scan", () => {
  test("detector recognizes a real alias and rejects lookalikes", () => {
    const alias = makeRealAlias();
    const body = alias.slice(2);
    const pattern = buildAliasPattern();

    // Standalone alias: detected.
    pattern.lastIndex = 0;
    expect(pattern.test(`tag: ${alias}`)).toBe(true);

    // One char short: not an alias.
    pattern.lastIndex = 0;
    expect(pattern.test(`m_${body.slice(0, -1)}`)).toBe(false);

    // One char longer: a longer run, not an alias literal.
    pattern.lastIndex = 0;
    expect(pattern.test(`${alias}${body[0]}`)).toBe(false);

    // Embedded in a longer identifier: not an alias.
    pattern.lastIndex = 0;
    expect(pattern.test(`sym_${body.slice(1)}`)).toBe(false);
  });

  test("no mangler alias literals in src/", () => {
    const srcDir = join(import.meta.dir, "../../src");
    const fossils = findFossils(srcDir);

    expect(fossils, fossils.map((f) => `  ${f.file}:${f.line}  ${f.match}`).join("\n")).toEqual([]);
  });
});
