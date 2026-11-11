/**
 * `hotdog rescue` -- config diagnostics that don't depend on the config working.
 * 
 * Detects broken JSON, repairs what it can, reports the config-dir resolution chain, unknown/duplicate top-level keys, and schema violations --
 * including out-of-set ENUM values, which parse fine but fail startup validation:
 * `rescue fix` resets each to its schema default (or removes the key when the
 * schema declares none), keeping every other byte of the file.
 * main() dispatches to runRescue() before buildConfig() or extension loading.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigDirChain, DEFAULT_CONFIG_FILENAME, DEFAULT_SYSTEM_PROMPT_FILENAME } from "./defaults.ts";
import { interpolateEnvVars, normalizeConfigKeys, validateConfig } from "./index.ts";
import { CONFIG_SCHEMA, extractConfigLayerKeys } from "./schema-loader.ts";
import { camelCase, suggestCandidates } from "@utils/strings.ts";
import type { ConfigParamDef } from "@core/extensions/config.ts";

// Keys a defaults.json may carry that are not in CONFIG_SCHEMA: the providers
// block, the legacy workspace passthroughs buildAgentConfig reads directly,
// the env-scrub addition (utils/env.ts), the service-provider override map the
// extension loader reads straight off the config (getExtensionsToLoad), and
// the legacy top-level skillsPath still resolved by the skills extension's
// `skills.path` config layer. (tests/lints/doc-config-keys.test.ts guards this
// list against the docs.)
export const EXTRA_KNOWN_KEYS = [
  "providers",
  "cwdBoundary",
  "workspaceRoot",
  "services",
  "envScrub",
  "skillsPath",
];

/**
 * Config keys that once existed and were removed. They are not UNKNOWN (a
 * did-you-mean would mislead); they get a tombstone verdict that names the
 * replacement, with a caret at the offending line. Checked at every nesting
 * depth: `maxToolOutputLines` lived inside the bashTool/coreTools blocks, so
 * a top-level-only scan would miss exactly what users carry.
 */
export const REMOVED_KEYS: Array<{ key: string; replacement: string; note?: string }> = [
  {
    key: "maxToolOutputLines",
    replacement: "maxToolResultChars",
    note:
      "line-shaping knobs retired for one central char cap on every tool result " +
      "(the tools keep internal line shaping below it)",
  },
];

export interface JsoncIssue {
  kind: "comment" | "trailing-comma" | "bom";
  line: number;
}

/**
 * Replace JSONC-isms with whitespace (newlines preserved so line numbers stay
 * aligned) and report each repair. String-aware: `"http://x"` is untouched.
 */
export function stripJsonc(src: string): { text: string; issues: JsoncIssue[] } {
  const issues: JsoncIssue[] = [];
  const n = src.length;
  let out = "";
  let i = 0;
  let line = 1;

  if (src.charCodeAt(0) === 0xfeff) {
    issues.push({ kind: "bom", line: 1 });
    i = 1;
  }

  while (i < n) {
    const c = src[i]!;
    if (c === '"') {
      out += c;
      i++;
      while (i < n) {
        const s = src[i]!;
        out += s;
        i++;
        if (s === "\\" && i < n) {
          if (src[i] === "\n") line++;
          out += src[i]!;
          i++;
          continue;
        }
        if (s === "\n") line++;
        if (s === '"') break;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const at = line;
      while (i < n && src[i] !== "\n") i++;
      issues.push({ kind: "comment", line: at });
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const at = line;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") {
          line++;
          out += "\n";
        }
        i++;
      }
      i += 2;
      issues.push({ kind: "comment", line: at });
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(src[j]!)) j++;
      if (src[j] === "}" || src[j] === "]") {
        issues.push({ kind: "trailing-comma", line });
        out += " ";
        i++;
        continue;
      }
    }
    if (c === "\n") line++;
    out += c;
    i++;
  }
  return { text: out, issues };
}

/** Recursion ceiling for findJsonError; config files nest in the tens. */
const MAX_SCAN_DEPTH = 2000;

/**
 * Engine-independent syntax locator: returns the index of the first token
 * that violates JSON grammar, or null when the text parses (or nests too
 * deeply to scan). JSON.parse error messages carry no position, so rescue
 * needs its own scan to point at the offending line.
 */
export function findJsonError(text: string): number | null {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let failAt = i;
  let depth = 0;
  let gaveUp = false;

  const note = (pos: number): false => {
    if (pos >= failAt) failAt = pos;
    return false;
  };
  const isWs = (c: string | undefined): boolean =>
    c === " " || c === "\t" || c === "\n" || c === "\r";
  const ws = () => {
    while (i < n && isWs(text[i])) i++;
  };
  const eat = (word: string): boolean => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return true;
    }
    return note(i);
  };

  const parseString = (): boolean => {
    if (text[i] !== '"') return note(i);
    i++;
    while (i < n) {
      const c = text[i]!;
      if (c === '"') {
        i++;
        return true;
      }
      if (c === "\\") {
        i++;
        const e = text[i];
        if (!e || !'"\\/bfnrtu'.includes(e)) return note(i);
        if (e === "u") {
          for (let k = 1; k <= 4; k++) {
            const h = text[i + k];
            if (!h || !/[0-9a-fA-F]/.test(h)) return note(i + k);
          }
          i += 4;
        }
        i++;
        continue;
      }
      if (c.charCodeAt(0) < 0x20) return note(i);
      i++;
    }
    return note(n); // unterminated string
  };

  const parseNumber = (): boolean => {
    const start = i;
    if (text[i] === "-") i++;
    if (text[i] === "0") {
      i++;
      if (text[i] && /[0-9]/.test(text[i]!)) return note(i); // leading zero
    } else if (text[i] && /[1-9]/.test(text[i]!)) {
      while (text[i] && /[0-9]/.test(text[i]!)) i++;
    } else {
      return note(start);
    }
    if (text[i] === ".") {
      i++;
      if (!text[i] || !/[0-9]/.test(text[i]!)) return note(i);
      while (text[i] && /[0-9]/.test(text[i]!)) i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (!text[i] || !/[0-9]/.test(text[i]!)) return note(i);
      while (text[i] && /[0-9]/.test(text[i]!)) i++;
    }
    return true;
  };

  const parseValue = (): boolean => {
    // Depth guard: recursive descent blows the JS stack somewhere past 10k
    // levels, while JSON.parse handles 20k+ fine -- a broken file this deep
    // RangeError'd out of rescue instead of reporting. Treat "too deep to
    // scan" like any other unlocatable grammar: give up, verdict null.
    if (depth >= MAX_SCAN_DEPTH) {
      gaveUp = true;
      return true;
    }
    depth++;
    const ok = parseNested();
    depth--;
    return ok;
  };

  const parseNested = (): boolean => {
    ws();
    const c = text[i];
    if (c === undefined) return note(n);
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "-" || /[0-9]/.test(c)) return parseNumber();
    if (c === "t") return eat("true");
    if (c === "f") return eat("false");
    if (c === "n") return eat("null");
    return note(i);
  };

  const parseObject = (): boolean => {
    i++; // {
    ws();
    if (text[i] === "}") {
      i++;
      return true;
    }
    for (;;) {
      ws();
      if (!parseString()) return false;
      ws();
      if (text[i] !== ":") return note(i);
      i++;
      if (!parseValue()) return false;
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return true;
      }
      return note(i);
    }
  };

  const parseArray = (): boolean => {
    i++; // [
    ws();
    if (text[i] === "]") {
      i++;
      return true;
    }
    for (;;) {
      if (!parseValue()) return false;
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return true;
      }
      return note(i);
    }
  };

  const parsed = parseValue();
  if (gaveUp) return null;
  if (!parsed) return failAt;
  ws();
  if (i < n) {
    note(i); // trailing garbage
    return failAt;
  }
  return null;
}

/** Quoted keys at object depth 1 (string-aware); used for unknown/duplicate checks. */
export function scanTopLevelKeys(text: string): Array<{ key: string; line: number }> {
  return scanKeys(text, 1);
}

/**
 * Quoted keys at object depth 1..maxDepth (string-aware). maxDepth > 1 feeds
 * the REMOVED_KEYS tombstone stage: retired keys lived nested inside the
 * bashTool/coreTools blocks, so a top-level-only scan would miss them.
 */
export function scanKeys(text: string, maxDepth: number): Array<{ key: string; line: number }> {
  const keys: Array<{ key: string; line: number }> = [];
  const n = text.length;
  let i = 0;
  let depth = 0;
  let line = 1;
  while (i < n) {
    const c = text[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === '"') {
      const startLine = line;
      let j = i + 1;
      while (j < n) {
        const s = text[j]!;
        if (s === "\\") {
          if (text[j + 1] === "\n") line++;
          j += 2;
          continue;
        }
        if (s === "\n") line++;
        if (s === '"') break;
        j++;
      }
      let k = j + 1;
      while (k < n && /\s/.test(text[k]!)) k++;
      if (depth >= 1 && depth <= maxDepth && text[k] === ":") {
        keys.push({ key: text.slice(i + 1, j), line: startLine });
      }
      i = j + 1;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    if (c === "}" || c === "]") depth--;
    i++;
  }
  return keys;
}

export function lineColAt(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

/** Excerpt of the offending line with a caret under the column. */
export function errorExcerpt(text: string, index: number): string {
  const { line, column } = lineColAt(text, index);
  const lines = text.split("\n");
  const snippet = (lines[line - 1] ?? "").replace(/\t/g, " ");
  const num = String(line);
  return (
    `  line ${num}:\n` +
    `  ${snippet}\n` +
    `  ${" ".repeat(Math.max(0, column - 1))}^`
  );
}

// ── Enum stage ───────────────────────────────────────────────────────────────
// A file that PARSES can still be fatal: a schema key whose declared enum
// rejects its value fails startup validation ("value ... not in enum [...]").
// The SCHEMA stage prints that verdict without position and nothing repairs
// it. This stage walks the same schema sources the validator uses (core +
// loaded extension params -- logLevel/logTarget/toolExec/execFence and every
// future enum ride along with zero special-casing), locates each offending
// VALUE TOKEN in the shipped bytes, and hands `rescue fix` a surgical splice:
// rewrite the token to the schema default, or remove the key when the schema
// declares none. Nothing outside the value token (and, for removals, the one
// separator comma) is ever touched: comments, formatting and every other byte
// survive.

/**
 * JSONC-isms -> SAME-LENGTH whitespace: comments blanked to spaces (newlines
 * kept), trailing commas to spaces, BOM to a space. Unlike stripJsonc (which
 * normalizes and shifts every later offset), this preserves byte offsets 1:1,
 * so a range located in the masked text points at the shipped file -- and
 * JSON.parse(mask) yields exactly the value loadConfig would see after
 * stripping. Strings are walked untouched.
 */
export function maskJsonc(src: string): string {
  const n = src.length;
  let out = "";
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  out += " ".repeat(i); // BOM -> space (length preserved)
  while (i < n) {
    const c = src[i]!;
    if (c === '"') {
      const end = stringEnd(src, i);
      if (end < 0) return src.slice(0, i) + " ".repeat(n - i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(j + 2, n);
      for (let k = i; k < j; k++) out += src[k] === "\n" ? "\n" : " ";
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  // Trailing commas (outside strings): stripJsonc's rule -- a comma whose next
  // significant char is } or ] -- blanked in place.
  const chars = out.split("");
  let inStr = false;
  for (let p = 0; p < chars.length; p++) {
    const ch = chars[p]!;
    if (inStr) {
      if (ch === "\\") p++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === ",") {
      let q = p + 1;
      while (q < chars.length && /\s/.test(chars[q]!)) q++;
      if (chars[q] === "}" || chars[q] === "]") chars[p] = " ";
    }
  }
  return chars.join("");
}

/** A key path in the house addressing format: "compaction.strategy", "providers[0].url". */
export type KeySeg = string | number;
export function formatKeyPath(segs: readonly KeySeg[]): string {
  let p = "";
  for (const s of segs) p += typeof s === "number" ? `[${s}]` : p ? `.${s}` : s;
  return p;
}

export interface EnumViolation {
  /** Schema-addressable key path of the offending leaf ("logLevel", "compaction.strategy"). */
  path: string;
  /** Position of the offending VALUE TOKEN in the shipped file. */
  line: number;
  column: number;
  /** Byte range of the value token; keyStart covers the key token too (removals). */
  start: number;
  end: number;
  keyStart: number;
  /** The offending value exactly as shipped (raw token bytes). */
  shipped: string;
  /** The schema's accepted set. */
  accepted: unknown[];
  /** Schema default (own `default`, else the first literal `default` layer). */
  hasDefault: boolean;
  defaultValue?: unknown;
}

function enumSchemaSources(configParams: ConfigParamDef[]): Array<Record<string, unknown>> {
  const sources: Array<Record<string, unknown>> = [CONFIG_SCHEMA as unknown as Record<string, unknown>];
  for (const p of configParams) if (p.schema) sources.push({ [p.key]: p.schema });
  return sources;
}

/** The value's default per the schema node: own `default`, else the first layer declaring one (computed layers carry `compute`, not `default`, and are skipped -- the removal rule covers them). */
function enumDefaultOf(node: Record<string, unknown>): { has: boolean; value?: unknown } {
  if (node.default !== undefined) return { has: true, value: node.default };
  const layers = node.layers;
  if (Array.isArray(layers)) {
    for (const l of layers) {
      if (l && typeof l === "object" && "default" in l) {
        return { has: true, value: (l as Record<string, unknown>).default };
      }
    }
  }
  return { has: false };
}

/** camelCase slot lookup mirroring normalizeConfigKeys + object-literal last-wins semantics. */
function slotOf(obj: Record<string, unknown>, want: string): unknown {
  const wantC = camelCase(want);
  let hit: unknown;
  for (const k of Object.keys(obj)) if (camelCase(k) === wantC) hit = obj[k];
  return hit;
}

interface RawEnumHit {
  segs: KeySeg[];
  value: unknown;
  accepted: unknown[];
  hasDefault: boolean;
  defaultValue?: unknown;
}

function walkEnumNode(value: unknown, node: unknown, segs: KeySeg[], out: RawEnumHit[], depth: number): void {
  if (depth > MAX_SCAN_DEPTH || !node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.enum)) {
    // Mirror json-schema.ts exactly: a value equal to the node's own default
    // passes, membership is JSON.stringify equality. Non-members are
    // violations even when the type is wrong -- the default fixes both.
    const accepted = n.enum as unknown[];
    if (n.default !== undefined && JSON.stringify(value) === JSON.stringify(n.default)) return;
    if (accepted.some((e) => JSON.stringify(e) === JSON.stringify(value))) return;
    const d = enumDefaultOf(n);
    out.push({ segs, value, accepted, hasDefault: d.has, defaultValue: d.value });
    return;
  }
  if (n.properties && value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const [k, child] of Object.entries(n.properties as Record<string, unknown>)) {
      const v = slotOf(obj, k);
      if (v !== undefined && v !== null) walkEnumNode(v, child, [...segs, k], out, depth + 1);
    }
  }
  if (n.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      if (v !== undefined && v !== null) walkEnumNode(v, n.items, [...segs, i], out, depth + 1);
    }
  }
}

/**
 * Schema-driven enum diagnosis over the shipped file text: every leaf the
 * schemas declare an enum for whose value is outside the set, with exact
 * line/column of the value token, the token as shipped, and the accepted set.
 * Returns [] for files whose shape cannot be read (unparsable, or an env-ref
 * that cannot interpolate -- the syntax/env error owns those files; guessing
 * positions there would lie). Fail-closed on location too: an unlocatable
 * value is never approximated.
 */
export function findEnumViolations(text: string, configParams: ConfigParamDef[] = []): EnumViolation[] {
  const mask = maskJsonc(text);
  let raw: unknown;
  try {
    raw = JSON.parse(mask);
  } catch {
    return [];
  }
  let effective: unknown;
  try {
    effective = interpolateEnvVars(normalizeConfigKeys(raw));
  } catch {
    return []; // unset $VAR: loadConfig dies on the interpolation before validation ever sees an enum
  }
  if (!effective || typeof effective !== "object" || Array.isArray(effective)) return [];
  const hits: RawEnumHit[] = [];
  for (const source of enumSchemaSources(configParams)) {
    for (const [key, node] of Object.entries(source)) {
      const v = slotOf(effective as Record<string, unknown>, key);
      if (v !== undefined && v !== null) walkEnumNode(v, node, [key], hits, 0);
    }
  }
  const seen = new Set<string>();
  const violations: EnumViolation[] = [];
  for (const h of hits) {
    const path = formatKeyPath(h.segs);
    // Core and an extension schema can both describe a key (compaction); the
    // first source wins so one violation is reported once.
    if (seen.has(path)) continue;
    seen.add(path);
    const at = locateFrom(mask, skipWs(mask, 0), h.segs);
    if (!at) continue;
    const { line, column } = lineColAt(text, at.start);
    violations.push({
      path,
      line,
      column,
      start: at.start,
      end: at.end,
      keyStart: at.keyStart,
      shipped: text.slice(at.start, at.end),
      accepted: h.accepted,
      hasDefault: h.hasDefault,
      defaultValue: h.defaultValue,
    });
  }
  violations.sort((a, b) => a.start - b.start);
  return violations;
}

const WS_CHARS = " \t\n\r";
function skipWs(t: string, i: number): number {
  while (i < t.length && WS_CHARS.includes(t[i]!)) i++;
  return i;
}

/** t[i] must be a '"' -> index just past the closing quote, or -1 (unterminated). */
function stringEnd(t: string, i: number): number {
  if (t[i] !== '"') return -1;
  let j = i + 1;
  while (j < t.length) {
    const s = t[j]!;
    if (s === "\\") {
      j += 2;
      continue;
    }
    if (s === '"') return j + 1;
    j++;
  }
  return -1;
}

/** End of one JSON value token starting at i (masked text: no comments). */
function valueEnd(t: string, i: number, depth = 0): number {
  if (depth > MAX_SCAN_DEPTH || i >= t.length) return -1;
  const c = t[i]!;
  if (c === '"') return stringEnd(t, i);
  if (c === "{" || c === "[") {
    const close = c === "{" ? "}" : "]";
    let j = i + 1;
    let d = 1;
    while (j < t.length && d > 0) {
      const s = t[j]!;
      if (s === '"') {
        const e = stringEnd(t, j);
        if (e < 0) return -1;
        j = e;
        continue;
      }
      if (s === c) d++;
      else if (s === close) d--;
      j++;
    }
    return d === 0 ? j : -1;
  }
  if (c === "-" || (c >= "0" && c <= "9")) {
    let j = i + 1;
    while (j < t.length && "0123456789eE+-.".includes(t[j]!)) j++;
    return j;
  }
  for (const lit of ["true", "false", "null"]) if (t.startsWith(lit, i)) return i + lit.length;
  return -1;
}

interface LocateHit {
  keyStart: number;
  start: number;
  end: number;
}

/** Resolve a key path to byte ranges in (masked) text: `pos` points at the value the next segment addresses. Key match = camelCase equality (normalizeConfigKeys semantics); duplicates resolve LAST-wins (what JSON.parse/loader keep); a segment that does not resolve returns null (fail closed). */
function locateFrom(t: string, pos: number, segs: readonly KeySeg[]): LocateHit | null {
  if (segs.length === 0) return null;
  const seg = segs[0]!;
  const rest = segs.slice(1);
  if (typeof seg === "string") {
    if (t[pos] !== "{") return null;
    let i = skipWs(t, pos + 1);
    let found: LocateHit | null = null;
    while (i < t.length && t[i] !== "}") {
      if (t[i] !== '"') return found;
      const keyStart = i;
      const ke = stringEnd(t, i);
      if (ke < 0) return found;
      let key: string;
      try {
        key = JSON.parse(t.slice(keyStart, ke)) as string;
      } catch {
        return found;
      }
      let j = skipWs(t, ke);
      if (t[j] !== ":") return found;
      j = skipWs(t, j + 1);
      const ve = valueEnd(t, j);
      if (ve < 0) return found;
      if (camelCase(key) === camelCase(seg)) {
        const hit = rest.length === 0 ? { keyStart, start: j, end: ve } : locateFrom(t, j, rest);
        if (hit) found = hit;
      }
      i = skipWs(t, ve);
      if (t[i] === ",") i = skipWs(t, i + 1);
      else break;
    }
    return found;
  }
  if (t[pos] !== "[") return null;
  let i = skipWs(t, pos + 1);
  let idx = 0;
  let found: LocateHit | null = null;
  while (i < t.length && t[i] !== "]") {
    const ve = valueEnd(t, i);
    if (ve < 0) return found;
    if (idx === seg) {
      const hit = rest.length === 0 ? { keyStart: i, start: i, end: ve } : locateFrom(t, i, rest);
      if (hit) found = hit;
    }
    idx++;
    i = skipWs(t, ve);
    if (t[i] === ",") i = skipWs(t, i + 1);
    else break;
  }
  return found;
}

/** Byte cuts for removing one violation: key..value plus the separator comma (trailing, else preceding), and a whole-line collapse when only whitespace would remain. The comma search runs through the MASK so a comment sitting between members cannot hide the separator (an un-removed comma would leave a trailing comma behind); the collapse decision runs on RAW bytes, where a comment keeps its line standing (user data). */
function removalCuts(t: string, mask: string, v: EnumViolation): Array<[number, number]> {
  const extra: Array<[number, number]> = [];
  const a = v.keyStart;
  let b = v.end;
  // Forward: raw spaces/tabs and masked (comment) bytes stop at the comma or
  // at anything real (a masked newline is still \n in the mask, so the scan
  // never leaves the value's line here).
  let j = b;
  while (j < t.length && (t[j] === " " || t[j] === "\t" || (mask[j] === " " && t[j] !== "\n" && t[j] !== "\r"))) j++;
  if (mask[j] === ",") {
    b = j + 1;
    while (b < t.length && (t[b] === " " || t[b] === "\t")) b++;
  } else {
    // Last member: take the comma that separates it from the PREVIOUS member,
    // skipping whitespace AND comments (in mask coordinates) to find it.
    let p = a - 1;
    while (p >= 0 && (WS_CHARS.includes(t[p]!) || mask[p] === " ")) p--;
    if (mask[p] === ",") extra.push([p, p + 1]);
  }
  const lineStart = t.lastIndexOf("\n", a - 1) + 1;
  let lineEnd = t.indexOf("\n", b);
  if (lineEnd < 0) lineEnd = t.length;
  else lineEnd += 1;
  const rest = t.slice(lineStart, a) + t.slice(b, lineEnd);
  if (rest.trim() === "") return [...extra, [lineStart, lineEnd]];
  return [...extra, [a, b]];
}

/**
 * Splice every violation out in one right-to-left pass: resets rewrite ONLY
 * the value token; removals drop key+value, one comma, and (when only
 * whitespace would remain) the line. Every other byte of the text survives.
 */
export function applyEnumRepairs(text: string, violations: readonly EnumViolation[]): string {
  const mask = maskJsonc(text);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const v of violations) {
    if (v.hasDefault) edits.push({ start: v.start, end: v.end, text: JSON.stringify(v.defaultValue) });
    else for (const [a, b] of removalCuts(text, mask, v)) edits.push({ start: a, end: b, text: "" });
  }
  edits.sort((x, y) => y.start - x.start);
  let out = text;
  let prevStart = Infinity;
  for (const e of edits) {
    if (e.end > prevStart) continue; // overlapping (should be impossible): never double-splice
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    prevStart = e.start;
  }
  return out;
}

/**
 * Pull the out-of-set keys out of a ConfigError.ValidationError's individual
 * error strings (the json-schema.ts enum grammar:
 * `<path>: value <json> not in enum [<json, json]>`) so boot guidance can
 * name the repair command, the key and the accepted set. Parse-only over
 * messages this repo generates; anything else is ignored.
 */
export function enumHintsFromValidationErrors(
  errors: readonly string[] | undefined,
): Array<{ key: string; accepted: string[] }> {
  const out: Array<{ key: string; accepted: string[] }> = [];
  for (const err of errors ?? []) {
    const sep = err.indexOf(": value ");
    const tail = err.lastIndexOf(" not in enum [");
    if (sep < 0 || tail <= sep || !err.endsWith("]")) continue;
    const key = err.slice(0, sep);
    const inner = err.slice(tail + " not in enum [".length, err.length - 1);
    let accepted: string[];
    try {
      accepted = (JSON.parse(`[${inner}]`) as unknown[]).map((v) => JSON.stringify(v));
    } catch {
      accepted = inner.split(", ").map((s) => s.trim());
    }
    out.push({ key, accepted });
  }
  return out;
}

export interface FileReport {
  path: string;
  status: "missing" | "broken" | "ok";
  /** First grammar error offset (when broken). */
  errorIndex: number | null;
  parseErrorMessage: string | null;
  jsoncIssues: JsoncIssue[];
  /** True when stripJsonc(text) parses -- rescue fix can repair the file. */
  fixable: boolean;
  /** Config text that parses (original or repaired), for downstream checks. */
  parsedText: string | null;
  /** Raw file text, for error excerpts. */
  rawText: string;
}

export async function diagnoseConfigFile(filePath: string): Promise<FileReport> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch {
    return {
      path: filePath,
      status: "missing",
      errorIndex: null,
      parseErrorMessage: null,
      jsoncIssues: [],
      fixable: false,
      parsedText: null,
      rawText: "",
    };
  }

  try {
    JSON.parse(text);
    return {
      path: filePath,
      status: "ok",
      errorIndex: null,
      parseErrorMessage: null,
      jsoncIssues: [],
      fixable: false,
      parsedText: text,
      rawText: text,
    };
  } catch (e) {
    // Report-only: comments and trailing commas are repairable, anything else
    // the scanner can point at gets a line/column; the rest is manual.
    const { text: stripped, issues } = stripJsonc(text);
    let fixable = false;
    try {
      JSON.parse(stripped);
      fixable = issues.length > 0;
    } catch {}
    const idx = findJsonError(text);
    return {
      path: filePath,
      status: "broken",
      errorIndex: idx,
      parseErrorMessage: e instanceof Error ? e.message : String(e),
      jsoncIssues: issues,
      fixable,
      parsedText: fixable ? stripped : null,
      rawText: text,
    };
  }
}

function uniquePaths(files: string[]): string[] {
  return Array.from(new Set(files));
}

export interface RescueOptions {
  configDirArg?: string | null;
  configFileArg?: string | null;
  fix: boolean;
  configParams?: ConfigParamDef[];
  /** Machine mode: stdout carries only the JSON envelope; the prose renderer is silenced. */
  json?: boolean;
}

/** One structured problem from the key/schema stages (file-level state lives in RescueFileEntry). */
export interface RescueFinding {
  type: "missing-config-dir" | "config-file-missing" | "unknown-key" | "duplicate-key" | "removed-key" | "schema" | "enum";
  message: string;
  key?: string;
  line?: number;
  did_you_mean?: string[];
  /** enum: column of the value token; the accepted set; the reset default (null = no schema default, the key is removed); whether `fix` repaired this run. */
  column?: number;
  accepted?: unknown[];
  default?: unknown;
  fix?: "reset-default" | "remove-key";
  fixed?: boolean;
}

/** Per-config-file verdict in the --json envelope. */
export interface RescueFileEntry {
  path: string;
  in_use: boolean;
  status: "missing" | "ok" | "broken";
  parse_error?: string;
  jsonc_issues?: Array<{ kind: string; lines: number[] }>;
  fixable?: boolean;
  fixed?: boolean;
  backup?: string | null;
}

export async function runRescue(opts: RescueOptions): Promise<number> {
  // Envelope mode silences the prose renderer instead of restructuring it:
  // every diagnostic also lands in `findings`/`fileEntries`, so nothing is
  // gained by threading two formatters through one pass.
  const log = opts.json ? (_s?: string) => {} : (s = "") => console.log(s);
  const findings: RescueFinding[] = [];
  const fileEntries: RescueFileEntry[] = [];
  let problems = 0;
  let fixed = 0;

  log("hotdog rescue - config diagnostics");
  log();

  // 1. Config directory resolution chain.
  log("Config directory resolution (first match wins):");
  const chain = resolveConfigDirChain(opts.configDirArg ?? null);
  for (const c of chain) {
    const mark = c.chosen ? "USING" : c.exists ? "     " : "(absent)";
    log(`  ${mark}  ${c.source.padEnd(28)} ${c.path}`);
  }
  const configDir = chain.find((c) => c.chosen)!.path;
  // An explicit source (flag/env) must exist: buildConfig fails startup on a
  // missing one (it never falls through to defaults). Say so here too -- rescue
  // is where users come to understand why the run died.
  const chosenCandidate = chain.find((c) => c.chosen)!;
  if (
    !chosenCandidate.exists &&
    (chosenCandidate.source === "--config-dir flag" ||
      chosenCandidate.source.startsWith("HOTDOG_CONFIG_DIR"))
  ) {
    problems++;
    findings.push({
      type: "missing-config-dir",
      message:
        "the explicit config directory does not exist; startup never falls through to defaults",
    });
    log(`  PROBLEM: the explicit config directory does not exist.`);
    log("  Startup will fail here: an explicit --config-dir / HOTDOG_CONFIG_DIR never falls through to defaults.");
  }
  log();

  // 2. Which defaults.json files are in play: the explicit --config file plus
  // every candidate config file along the chain (a broken file in a dir that
  // lost the chain race is still worth reporting).
  const explicit = opts.configFileArg ?? null;
  const files = explicit
    ? [path.resolve(explicit)]
    : uniquePaths(chain.map((c) => path.join(c.path, DEFAULT_CONFIG_FILENAME)));
  const inUse = explicit ?? path.join(configDir, DEFAULT_CONFIG_FILENAME);

  let usableText: string | null = null;
  const enumParams = opts.configParams ?? [];
  for (const file of files) {
    const report = await diagnoseConfigFile(file);
    const tag = file === inUse ? " [in use]" : "";
    const entry: RescueFileEntry = {
      path: file,
      in_use: file === inUse,
      status: report.status === "missing" ? "missing" : report.status === "ok" ? "ok" : "broken",
    };
    fileEntries.push(entry);
    if (report.status === "missing") {
      if (explicit) {
        problems++;
        findings.push({ type: "config-file-missing", message: "the --config path is unreadable" });
        log(`${file}${tag}: NOT FOUND - the --config path is unreadable`);
      } else {
        log(`${file}: no file (defaults apply)`);
      }
      continue;
    }
    log(`${file}${tag}:`);
    if (report.status === "ok") {
      log("  OK (valid JSON)");
      if (file === inUse) usableText = report.parsedText;
    } else {
      entry.parse_error = report.parseErrorMessage ?? "invalid JSON";
      log(`  BROKEN: ${report.parseErrorMessage ?? "invalid JSON"}`);
      if (report.errorIndex !== null) {
        log(errorExcerpt(report.rawText, report.errorIndex));
        if (report.errorIndex >= report.rawText.trimEnd().length) {
          log("  (error sits at end of input - the file looks truncated)");
        }
      }
      if (report.jsoncIssues.length > 0) {
        const byKind = new Map<string, number[]>();
        for (const iss of report.jsoncIssues) {
          const list = byKind.get(iss.kind) ?? [];
          list.push(iss.line);
          byKind.set(iss.kind, list);
        }
        entry.jsonc_issues = Array.from(byKind.entries()).map(([kind, lines]) => ({ kind, lines }));
        for (const [kind, lines] of byKind) {
          const label =
            kind === "trailing-comma"
              ? `trailing comma${lines.length === 1 ? "" : "s"}`
              : `${kind}${lines.length === 1 ? "" : "s"}`;
          log(`  found ${lines.length} ${label} (lines ${lines.join(", ")})`);
        }
      }
      entry.fixable = report.fixable === true;
    }

    // Enum stage: schema-driven, over the SHIPPED bytes (maskJsonc keeps
    // offsets exact for JSONC files). Reported before any repair so the
    // line/column names the file the user is looking at.
    const violations = findEnumViolations(report.rawText, enumParams);
    let enumPlanned: string | null = null;
    for (const v of violations) {
      const accepted = v.accepted.map((x) => JSON.stringify(x)).join(", ");
      log(`ENUM: "${v.path}" (line ${v.line}, column ${v.column}) = ${v.shipped} not in the accepted set [${accepted}]`);
      log(errorExcerpt(report.rawText, v.start));
      log(
        v.hasDefault
          ? `  \`hotdog rescue fix\` resets it to ${JSON.stringify(v.defaultValue)} (the schema default)`
          : `  no schema default: \`hotdog rescue fix\` removes the key so the built-in default applies`,
      );
      if (!opts.fix) {
        problems++;
        findings.push({
          type: "enum",
          key: v.path,
          line: v.line,
          column: v.column,
          accepted: v.accepted,
          default: v.hasDefault ? v.defaultValue : null,
          fix: v.hasDefault ? "reset-default" : "remove-key",
          message: `"${v.path}" (line ${v.line}, column ${v.column}) = ${v.shipped} not in the accepted set [${accepted}]`,
        });
      }
    }
    // A file that cannot be repaired at all stays the syntax stage's problem;
    // enum findings there are context, not a second repair promise.
    if (opts.fix && violations.length > 0 && (report.status === "ok" || report.fixable)) {
      enumPlanned = applyEnumRepairs(report.rawText, violations);
    }

    const syntaxRepairable = report.status === "broken" && report.fixable;
    if (report.status === "broken") {
      if (report.fixable && !opts.fix) {
        problems++;
        log(`  FIXABLE - re-run with \`hotdog rescue fix\` to repair (a .bak backup is kept)`);
      } else if (!report.fixable) {
        problems++;
        log(`  NOT auto-fixable - edit the file and fix the position marked above`);
      }
    }
    // One repair per file: enum splices (on the shipped text) and the JSONC
    // strip compose into ONE atomic write with ONE .bak of the pre-fix bytes.
    if (opts.fix && (enumPlanned !== null || syntaxRepairable)) {
      const target =
        enumPlanned !== null && syntaxRepairable
          ? stripJsonc(enumPlanned).text
          : enumPlanned ?? report.parsedText!;
      const backup = await repairFile(file, target, enumParams, log);
      if (backup !== null) {
        fixed++;
        entry.fixed = true;
        entry.backup = backup;
        if (file === inUse) usableText = target;
        for (const v of violations) {
          const accepted = v.accepted.map((x) => JSON.stringify(x)).join(", ");
          log(
            v.hasDefault
              ? `  REPAIRED "${v.path}" (line ${v.line}): ${v.shipped} -> ${JSON.stringify(v.defaultValue)} (accepted: ${accepted})`
              : `  REPAIRED "${v.path}" (line ${v.line}): removed ${v.shipped}; no schema default - the built-in default now applies (accepted set was [${accepted}])`,
          );
        }
      } else {
        problems++;
      }
      for (const v of violations) {
        const accepted = v.accepted.map((x) => JSON.stringify(x)).join(", ");
        findings.push({
          type: "enum",
          key: v.path,
          line: v.line,
          column: v.column,
          accepted: v.accepted,
          default: v.hasDefault ? v.defaultValue : null,
          fix: v.hasDefault ? "reset-default" : "remove-key",
          fixed: entry.fixed === true,
          message:
            v.hasDefault
              ? `"${v.path}" was ${v.shipped} (accepted: ${accepted}), ${entry.fixed === true ? `repaired to ${JSON.stringify(v.defaultValue)}` : "repair FAILED"}`
              : `"${v.path}" was ${v.shipped} with no schema default, ${entry.fixed === true ? "key removed so the built-in default applies" : "repair FAILED"}`,
        });
      }
    }
  }
  log();

  // 3-4. Key and schema checks on the effective config (only when we have JSON
  // that parses, original or just-repaired).
  let paths: {
    system_prompt: { path: string; exists: boolean };
    profiles_dir: { path: string; exists: boolean };
  } | null = null;
  if (usableText !== null) {
    problems += await checkKeys(usableText, opts.configParams ?? [], log, findings);
    problems += checkSchema(usableText, opts.configParams ?? [], log, findings);
    log();
  }

  // 5. Sidecar paths in play.
  if (usableText !== null) {
    let profileDir = path.join(configDir, "profiles");
    try {
      const raw = JSON.parse(usableText) as Record<string, unknown>;
      if (typeof raw.profiles_path === "string" && raw.profiles_path) {
        profileDir = path.resolve(raw.profiles_path);
      } else if (typeof raw.profilesPath === "string" && raw.profilesPath) {
        profileDir = path.resolve(raw.profilesPath);
      }
    } catch {}
    const sysPrompt = path.join(configDir, DEFAULT_SYSTEM_PROMPT_FILENAME);
    const sysPromptExists = await exists(sysPrompt);
    const profileDirExists = await exists(profileDir);
    paths = {
      system_prompt: { path: sysPrompt, exists: sysPromptExists },
      profiles_dir: { path: profileDir, exists: profileDirExists },
    };
    log(`System prompt template: ${sysPrompt}${sysPromptExists ? "" : " (absent - built-in template used)"}`);
    log(`Profiles directory:     ${profileDir}${profileDirExists ? "" : " (absent)"}`);
    log();
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          config_dir: configDir,
          resolution: chain,
          files: fileEntries,
          findings,
          paths,
          problems,
          fixed,
        },
        null,
        2,
      ),
    );
    return problems === 0 ? 0 : 1;
  }

  if (fixed > 0) {
    log(`FIXED ${fixed} file(s). Originals saved alongside as *.bak - restore with e.g. \`cp file.json.bak file.json\`.`);
  }
  if (problems === 0) {
    log("No problems found.");
    return 0;
  }
  log(`${problems} problem(s) found.`);
  return 1;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ONE repair write: .bak of the exact pre-fix bytes first, then temp +
 * rename in the same directory (the editor's commitVerifiedEdit discipline),
 * then rescue-verify: the bytes on disk must match what was written, strict-
 * parse, and come back enum-clean. Any doubt restores the pre-fix bytes the
 * same atomic way -- a repair that cannot be verified did not happen.
 * Returns the backup path on success, null on failure (logged).
 */
async function repairFile(
  file: string,
  fixedText: string,
  configParams: ConfigParamDef[],
  log: (s?: string) => void,
): Promise<string | null> {
  const original = await fs.readFile(file, "utf-8");
  let backup = `${file}.bak`;
  for (let n = 1; await exists(backup); n++) backup = `${file}.bak.${n}`;
  await fs.writeFile(backup, original, "utf-8");
  const tmp = `${file}.${process.pid}.rescue-tmp`;
  try {
    await fs.writeFile(tmp, fixedText, "utf-8");
    await fs.rename(tmp, file);
  } catch (e) {
    try {
      await fs.rm(tmp, { force: true });
    } catch {}
    log(`  WRITE FAILED for ${file}: ${e instanceof Error ? e.message : String(e)} (original untouched; backup: ${backup})`);
    return null;
  }
  let doubt: string | null = null;
  try {
    const after = await fs.readFile(file, "utf-8");
    if (after !== fixedText) doubt = "re-read bytes differ from what was written";
    else JSON.parse(after);
    if (!doubt && findEnumViolations(after, configParams).length > 0) doubt = "enum violations remain after the repair";
  } catch (e) {
    doubt = e instanceof Error ? e.message : String(e);
  }
  if (doubt) {
    const tmpBack = `${file}.${process.pid}.rescue-rollback-tmp`;
    try {
      await fs.writeFile(tmpBack, original, "utf-8");
      await fs.rename(tmpBack, file);
      log(`  REPAIR REJECTED (${doubt}); ${file} restored to its pre-fix bytes (backup: ${backup})`);
    } catch (e2) {
      log(`  REPAIR REJECTED (${doubt}) AND the rollback FAILED: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
    return null;
  }
  log(`  FIXED ${file} (backup: ${backup})`);
  return backup;
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, "");
}

async function checkKeys(
  text: string,
  configParams: ConfigParamDef[],
  log: (s?: string) => void,
  findings?: RescueFinding[],
): Promise<number> {
  let problems = 0;
  const allowed = [
    ...Object.keys(CONFIG_SCHEMA),
    ...extractConfigLayerKeys(CONFIG_SCHEMA),
    ...EXTRA_KNOWN_KEYS,
    ...configParams.map((p) => p.key),
  ];
  const removedHit = (key: string) =>
    REMOVED_KEYS.find((r) => normalizeKey(r.key) === normalizeKey(key));
  const seen = new Map<string, number>();
  for (const { key, line } of scanTopLevelKeys(text)) {
    const norm = normalizeKey(key);
    const first = seen.get(norm);
    if (first !== undefined) {
      problems++;
      const message = `UNKNOWN/DUPLICATE key: "${key}" (line ${line}) duplicates line ${first} - the later value silently wins`;
      findings?.push({ type: "duplicate-key", key, line, message });
      log(message);
      continue;
    }
    seen.set(norm, line);
    // A removed key gets the tombstone verdict below, not an UNKNOWN guess.
    if (removedHit(key)) continue;
    if (!allowed.some((a) => normalizeKey(a) === norm)) {
      const hints = suggestCandidates(norm, allowed.map(normalizeKey), { limit: 3 });
      const real = hints.map((h) => allowed.find((a) => normalizeKey(a) === h)!);
      problems++;
      const message =
        `UNKNOWN key: "${key}" (line ${line}) - hotdog ignores it` +
        (real.length > 0 ? `; did you mean ${real.map((r) => `"${r}"`).join(", ")}?` : "");
      findings?.push({ type: "unknown-key", key, line, did_you_mean: real, message });
      log(message);
    }
  }
  // Tombstone stage: REMOVED_KEYS occurrences at any nesting depth, each with
  // a caret under the key (same pointing style as the JSON-error excerpt).
  for (const hit of scanKeys(text, Number.POSITIVE_INFINITY)) {
    const r = removedHit(hit.key);
    if (!r) continue;
    problems++;
    const message =
      `REMOVED key: "${hit.key}" (line ${hit.line}) - no longer read; ` +
      `replaced by "${r.replacement}". ${r.note ?? ""}` +
      caretExcerptAtKey(text, hit.key, hit.line);
    findings?.push({ type: "removed-key", key: hit.key, line: hit.line, message });
    log(message);
  }
  return problems;
}

/** The key's source line with a caret under it (errorExcerpt's pointing style). */
function caretExcerptAtKey(text: string, key: string, line: number): string {
  const lines = text.split("\n");
  const snippet = (lines[line - 1] ?? "").replace(/\t/g, " ");
  const col = snippet.indexOf(`"${key}"`);
  if (col < 0) return "";
  return `\n  ${snippet}\n  ${" ".repeat(Math.max(0, col))}^`;
}

function checkSchema(
  text: string,
  configParams: ConfigParamDef[],
  log: (s?: string) => void,
  findings?: RescueFinding[],
): number {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 0; // already reported by the syntax stage
  }
  const normalized = normalizeConfigKeys(raw) as Record<string, unknown>;
  // validateConfig only inspects keys present in the config, so the raw
  // (unmerged) file is the right input -- defaults would mask nothing but add noise.
  const result = validateConfig(normalized as never, configParams.filter((p) => p.schema).map((p) => ({ key: p.key, schema: p.schema })));
  let count = 0;
  for (const err of result.errors) {
    // The ENUM stage owns out-of-set verdicts (it adds position and the fix);
    // reporting them twice under SCHEMA would double-count the problem.
    if (/: value .* not in enum \[/.test(err)) continue;
    count++;
    findings?.push({ type: "schema", message: err });
    log(`SCHEMA: ${err}`);
  }
  return count;
}
