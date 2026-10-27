// Shared harness for the house-rule lints (AGENTS.md rules as plain bun tests).
//
// Baseline semantics are SHRINK-ONLY, both directions are failures:
//   (a) a violation NOT in the baseline  -> "new violation, fix your code"
//   (b) a baseline entry no longer found -> "violation fixed, prune the baseline entry"
// So the baseline can only ever get smaller. Matching is file path +
// whitespace-normalized code snippet (never line numbers -- lines drift).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Violation {
  /** Repo-relative path, posix separators. */
  file: string;
  /** Whitespace-normalized offending code snippet (see normalizeSnippet). */
  snippet: string;
}

/** Collapse all runs of whitespace to a single space and trim. */
export function normalizeSnippet(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function violationKey(v: Violation): string {
  return `${v.file}\u0000${v.snippet}`;
}

function tally(violations: Violation[]): Map<string, { v: Violation; n: number }> {
  const m = new Map<string, { v: Violation; n: number }>();
  for (const v of violations) {
    const key = violationKey(v);
    const hit = m.get(key);
    if (hit) hit.n++;
    else m.set(key, { v, n: 1 });
  }
  return m;
}

/**
 * Compare a scan result against the committed baseline.
 * Returns null when they agree exactly; otherwise a failure message that
 * names both directions (new violations AND prunable baseline entries).
 */
export function compareViolations(
  actual: Violation[],
  baseline: Violation[],
  baselineRelPath: string,
): string | null {
  const a = tally(actual);
  const b = tally(baseline);
  const fresh: string[] = [];
  const stale: string[] = [];
  for (const [key, { v, n }] of a) {
    const inBase = b.get(key);
    if (!inBase) fresh.push(`  ${v.file}: ${v.snippet}`);
    else if (n > inBase.n) fresh.push(`  ${v.file}: ${v.snippet}  (x${n - inBase.n} more)`);
  }
  for (const [key, { v, n }] of b) {
    const inActual = a.get(key);
    if (!inActual) stale.push(`  ${v.file}: ${v.snippet}`);
    else if (n > inActual.n) stale.push(`  ${v.file}: ${v.snippet}  (x${n - inActual.n} fewer)`);
  }
  if (fresh.length === 0 && stale.length === 0) return null;
  const parts: string[] = [];
  if (fresh.length > 0) {
    parts.push(
      `NEW VIOLATION(S), FIX YOUR CODE (${fresh.length}) -- not in the committed baseline:\n${fresh.join("\n")}`,
    );
  }
  if (stale.length > 0) {
    parts.push(
      `BASELINE ENTRY NO LONGER FOUND (${stale.length}) -- violation fixed, prune the entry from ${baselineRelPath}:\n${stale.join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

export function loadBaseline(baselinePath: string): Violation[] {
  if (!existsSync(baselinePath)) {
    throw new Error(
      `Baseline file missing: ${baselinePath}. Generate it with \`bun tests/lints/regenerate.ts\`.`,
    );
  }
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Baseline ${baselinePath} must be a JSON array`);
  return parsed.map((e, i) => {
    const rec = e as Partial<Violation>;
    if (typeof rec.file !== "string" || typeof rec.snippet !== "string") {
      throw new Error(`Baseline ${baselinePath} entry ${i} needs string file+snippet`);
    }
    return { file: rec.file, snippet: normalizeSnippet(rec.snippet) };
  });
}

/** Write a baseline (sorted, deduped-preserving-count). Used by regenerate.ts only. */
export function saveBaseline(baselinePath: string, violations: Violation[]): void {
  const norm = violations
    .map((v) => ({ file: v.file, snippet: normalizeSnippet(v.snippet) }))
    .sort((x, y) => (x.file === y.file ? (x.snippet < y.snippet ? -1 : 1) : x.file < y.file ? -1 : 1));
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, JSON.stringify(norm, null, 2) + "\n", "utf8");
}

/** Recursively list files under root/subDir whose name ends with one of `exts`. */
export function listSourceFiles(root: string, subDir: string, exts: string[]): string[] {
  const base = join(root, subDir);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) out.push(p);
    }
  };
  walk(base);
  return out.sort();
}

/** Repo-relative posix path for display/baseline keys. */
export function relPath(root: string, absPath: string): string {
  return absPath.slice(root.length + 1).split("\\").join("/");
}

/**
 * Blank out comment and string/template *text* so scanners never match prose,
 * while preserving: length, newline positions, code inside `${...}` template
 * interpolations, and quote characters. Regex literals are skipped when a
 * `/` appears in regex position (heuristic: after `( , = : ! & | ? { } ; + - * % ~ ^ < >`).
 * Known ceiling: exotic regex/JSX-text constructs can mis-mask; the repo
 * self-tests below pin the constructs that matter here.
 */
export function maskCode(src: string): string {
  const out = src.split("");
  const blank = (i: number): void => {
    if (out[i] !== "\n") out[i] = " ";
  };
  type Frame =
    | { k: "code"; depth: number } // depth > 0: inside a template `${`
    | { k: "line" }
    | { k: "block" }
    | { k: "str"; q: string }
    | { k: "tpl" };
  const stack: Frame[] = [{ k: "code", depth: 0 }];
  let prevCode = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const top = stack[stack.length - 1]!;
    if (top.k === "line") {
      if (c === "\n") stack.pop();
      else blank(i);
      continue;
    }
    if (top.k === "block") {
      if (c === "*" && src[i + 1] === "/") {
        blank(i);
        blank(i + 1);
        i++;
        stack.pop();
      } else blank(i);
      continue;
    }
    if (top.k === "str") {
      if (c === "\\") {
        blank(i);
        blank(i + 1);
        i++;
      } else if (c === top.q) {
        stack.pop();
        prevCode = c;
      } else blank(i);
      continue;
    }
    if (top.k === "tpl") {
      if (c === "\\") {
        blank(i);
        blank(i + 1);
        i++;
      } else if (c === "`") {
        blank(i);
        stack.pop();
        prevCode = c;
      } else if (c === "$" && src[i + 1] === "{") {
        stack.push({ k: "code", depth: 1 });
        i++; // `${` stays visible as code; matching `}` pops on depth 0
        prevCode = "{";
      } else blank(i);
      continue;
    }
    // code frame
    if (c === "/" && src[i + 1] === "/") {
      blank(i);
      blank(i + 1);
      i++;
      stack.push({ k: "line" });
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      blank(i);
      blank(i + 1);
      i++;
      stack.push({ k: "block" });
      continue;
    }
    if (c === "/" && isRegexPos(prevCode)) {
      // Skip a regex literal wholesale.
      let inClass = false;
      let j = i + 1;
      blank(i);
      for (; j < src.length; j++) {
        const r = src[j]!;
        if (r === "\n") break; // bail out; treat as division-like noise
        if (r === "\\") {
          blank(j - 1);
          blank(j);
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) {
          blank(j);
          break;
        }
        blank(j);
      }
      i = j;
      prevCode = "/";
      continue;
    }
    if (c === '"' || c === "'") {
      stack.push({ k: "str", q: c });
      prevCode = c;
      continue; // quote chars stay visible; content blanked by the frame
    }
    if (c === "`") {
      stack.push({ k: "tpl" });
      blank(i);
      prevCode = "`";
      continue;
    }
    if (top.depth > 0) {
      if (c === "{") top.depth++;
      else if (c === "}") {
        top.depth--;
        if (top.depth === 0) {
          stack.pop(); // `}` stays visible: `${`...`}` brace-balanced
          prevCode = "}";
          continue;
        }
      }
    }
    if (!/\s/.test(c)) prevCode = c;
  }
  return out.join("");
}

function isRegexPos(prev: string): boolean {
  return prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev);
}

/**
 * Blank line/block comments only; strings, templates, and everything else are
 * left intact. Used where the scan target lives inside string literals
 * (import specifiers) but prose must stay invisible.
 */
export function maskCommentsOnly(src: string): string {
  const out = src.split("");
  const blank = (i: number): void => {
    if (out[i] !== "\n") out[i] = " ";
  };
  const stack: Array<{ k: "code" } | { k: "line" } | { k: "block" } | { k: "str"; q: string } | { k: "tpl" }> = [
    { k: "code" },
  ];
  let prevCode = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const top = stack[stack.length - 1]!;
    if (top.k === "line") {
      if (c === "\n") stack.pop();
      else blank(i);
      continue;
    }
    if (top.k === "block") {
      if (c === "*" && src[i + 1] === "/") {
        blank(i);
        blank(i + 1);
        i++;
        stack.pop();
      } else blank(i);
      continue;
    }
    if (top.k === "str") {
      if (c === "\\") {
        i++;
      } else if (c === top.q) stack.pop();
      continue;
    }
    if (top.k === "tpl") {
      if (c === "\\") i++;
      else if (c === "`") stack.pop();
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      blank(i);
      blank(i + 1);
      i++;
      stack.push({ k: "line" });
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      blank(i);
      blank(i + 1);
      i++;
      stack.push({ k: "block" });
      continue;
    }
    if (c === "/" && isRegexPos(prevCode)) {
      let inClass = false;
      let j = i + 1;
      for (; j < src.length; j++) {
        const r = src[j]!;
        if (r === "\n") break;
        if (r === "\\") {
          j++;
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
      }
      i = j;
      prevCode = "/";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      stack.push(c === "`" ? { k: "tpl" } : { k: "str", q: c });
    }
    if (!/\s/.test(c)) prevCode = c;
  }
  return out.join("");
}

/** Index of the bracket matching the one at openIdx (same type). -1 if unbalanced. */
export function findMatching(src: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 1-based line number of idx in src. */
export function lineOf(src: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

/** The raw source line containing idx (unmasked). */
export function lineText(src: string, idx: number): string {
  const s = src.lastIndexOf("\n", idx) + 1;
  let e = src.indexOf("\n", idx);
  if (e === -1) e = src.length;
  return src.slice(s, e);
}
