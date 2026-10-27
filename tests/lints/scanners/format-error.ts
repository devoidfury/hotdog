import { readFileSync } from "node:fs";
// formatError house-rule scanner. Pure function over a repo root.
//
// The rule text (quoted AGENTS.md), pattern rationale, and known ceilings
// live in ../format-error.test.ts; this module is the implementation.

import {
  findMatching,
  lineText,
  maskCode,
  listSourceFiles,
  normalizeSnippet,
  relPath,
  Violation,
} from "../harness.ts";

/** Logger/console-style call sites, matched at the opening call paren.
 * sink is restricted to `.log` (the interactive UI sink); `#sink.emit(` is the
 * event bus, not a logging call. */
const LOG_CALL_RE = /\b(?:logger|console)\.[A-Za-z0-9_.]+\s*\(|\bsink\.log\s*\(|\bprocess\.stderr\.write\s*\(/g;

/** Compliant routing present in the call arguments: message-only paths the
 * rule explicitly sanctions (expected errors) or formatError itself. */
const COMPLIANT_RE = /formatError|isExpectedError/;

interface Region {
  start: number;
  end: number;
}

function inRegions(regions: Region[], idx: number): boolean {
  return regions.some((r) => idx > r.start && idx < r.end);
}

/** Error-handler regions: catch bodies, `.catch(cb)` callbacks with a param, `.on("error", cb)` listeners. */
function errorHandlerRegions(masked: string, raw: string): Region[] {
  const regions: Region[] = [];
  // catch ( … ) { … } and catch { … }
  for (const m of masked.matchAll(/\bcatch\s*(\([^()]*\))?\s*\{/g)) {
    const open = masked.indexOf("{", m.index!);
    const end = findMatching(masked, open, "{", "}");
    if (end !== -1) regions.push({ start: open, end });
  }
  // .catch(callback) -- only when the callback declares a parameter; an empty
  // `() =>` callback cannot reference the rejection and stays out of scope.
  for (const m of masked.matchAll(/\.catch\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const end = findMatching(masked, open, "(", ")");
    if (end === -1) continue;
    const arg = masked.slice(open + 1, end).trimStart();
    const hasParam = /^\(\s*[A-Za-z_$]/.test(arg) || /^[A-Za-z_$][\w$]*\s*=>/.test(arg);
    if (hasParam) regions.push({ start: open, end });
  }
  // proc.on("error", cb) -- matched on raw (the mask blanks string contents);
  // the body is scanned on the mask.
  for (const m of raw.matchAll(/\.on\(\s*"error"\s*,/g)) {
    const cbStart = m.index + m[0].length;
    const bodyStart = masked.indexOf("{", cbStart);
    const semi = masked.indexOf(";", cbStart);
    if (bodyStart === -1) continue;
    if (semi !== -1 && semi < bodyStart) continue; // not a block callback
    const end = findMatching(masked, bodyStart, "{", "}");
    if (end !== -1) regions.push({ start: bodyStart, end });
  }
  return regions;
}

function countLines(src: string, idx: number): number {
  let line = 0;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

function handlerStart(masked: string, comma: number): number {
  let i = comma + 1;
  while (i < masked.length && /\s/.test(masked[i]!)) i++;
  return i;
}

/** Record violations from one source file into `out`. */
function scanSource(rel: string, raw: string, out: Violation[]): void {
  const masked = maskCode(raw);

  // F1 + F2: `.message` inside a logging call, when the call sits inside an
  // error-handler region (F1) or is console.error anywhere (F2).
  const regions = errorHandlerRegions(masked, raw);
  const messageRe = /\.\s*message\b/;
  const flaggedLines = new Set<number>();
  for (const m of masked.matchAll(LOG_CALL_RE)) {
    const open = m.index + m[0].length - 1;
    const end = findMatching(masked, open, "(", ")");
    if (end === -1) continue;
    const isConsoleError = /^console\.error\b/.test(m[0]);
    if (!isConsoleError && !inRegions(regions, open)) continue;
    const args = masked.slice(open + 1, end);
    if (!messageRe.test(args) || COMPLIANT_RE.test(args)) continue;
    const line = countLines(masked, m.index);
    if (!flaggedLines.has(line)) {
      flaggedLines.add(line);
      // Snippet: the raw line carrying the .message read (the audit-cited
      // line), falling back to the call's first line if it is on a
      // continuation.
      const msgIdx = raw.slice(open).search(/\.\s*message\b/);
      out.push({
        file: rel,
        snippet: normalizeSnippet(lineText(raw, msgIdx === -1 ? m.index : open + msgIdx)),
      });
    }
  }

  // F3: zero-parameter rejection handler on a two-argument .then whose block
  // body neither formats nor propagates the error.
  for (const m of masked.matchAll(/\.then\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const end = findMatching(masked, open, "(", ")");
    if (end === -1) continue;
    let depth = 0;
    let comma = -1;
    for (let i = open; i <= end; i++) {
      const c = masked[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === "," && depth === 1) {
        comma = i;
        break; // a second (rejection) argument exists
      }
    }
    if (comma === -1) continue;
    const second = masked.slice(comma + 1, end).trim();
    if (!/^\(\s*\)\s*=>\s*\{/.test(second)) continue; // zero-param BLOCK rejection handler
    const bodyStart = second.indexOf("{");
    const bodyEnd = findMatching(second, bodyStart, "{", "}");
    const body = bodyEnd === -1 ? second.slice(bodyStart) : second.slice(bodyStart, bodyEnd);
    if (/formatError|throw|return\b/.test(body)) continue; // reason formatted or propagated
    const hStart = handlerStart(masked, comma);
    const handlerText = raw.slice(hStart, hStart + second.length);
    out.push({ file: rel, snippet: normalizeSnippet(handlerText) });
  }
}

/** Pure scanner over a repo root: every formatError house-rule violation in src/. */
export function scanFormatErrors(root: string): Violation[] {
  const out: Violation[] = [];
  for (const abs of listSourceFiles(root, "src", [".ts", ".tsx"])) {
    const rel = relPath(root, abs);
    if (rel === "src/core/error.ts") continue; // formatError's own implementation
    scanSource(rel, readFileSync(abs, "utf8"), out);
  }
  return out;
}
