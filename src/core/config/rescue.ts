/**
 * `hotdog rescue` -- config diagnostics that must never depend on the config
 * working: main() dispatches to runRescue() before buildConfig() or extension
 * loading. Detects broken JSON (with line/column context), repairs what it can
 * (BOM, line and block comments, trailing commas), reports the config-dir
 * resolution chain, unknown/duplicate top-level keys, and schema violations.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigDirChain, DEFAULT_CONFIG_FILENAME, DEFAULT_SYSTEM_PROMPT_FILENAME } from "./defaults.ts";
import { normalizeConfigKeys, validateConfig } from "./index.ts";
import { CONFIG_SCHEMA, extractConfigLayerKeys } from "./schema-loader.ts";
import { suggestCandidates } from "@utils/strings.ts";
import type { ConfigParamDef } from "@core/extensions/config.ts";

// Keys a defaults.json may carry that are not in CONFIG_SCHEMA: the providers
// block and the legacy workspace passthroughs buildAgentConfig reads directly.
const EXTRA_KNOWN_KEYS = ["providers", "cwdBoundary", "workspaceRoot"];

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

/**
 * Engine-independent syntax locator: returns the index of the first token
 * that violates JSON grammar, or null when the text parses. JSON.parse error
 * messages carry no position, so rescue needs its own scan to point at the
 * offending line.
 */
export function findJsonError(text: string): number | null {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let failAt = i;

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

  if (!parseValue()) return failAt;
  ws();
  if (i < n) {
    note(i); // trailing garbage
    return failAt;
  }
  return null;
}

/** Quoted keys at object depth 1 (string-aware); used for unknown/duplicate checks. */
export function scanTopLevelKeys(text: string): Array<{ key: string; line: number }> {
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
      if (depth === 1 && text[k] === ":") {
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
}

export async function runRescue(opts: RescueOptions): Promise<number> {
  const log = (s = "") => console.log(s);
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
  for (const file of files) {
    const report = await diagnoseConfigFile(file);
    const tag = file === inUse ? " [in use]" : "";
    if (report.status === "missing") {
      if (explicit) {
        problems++;
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
      continue;
    }

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
      for (const [kind, lines] of byKind) {
        const label =
          kind === "trailing-comma"
            ? `trailing comma${lines.length === 1 ? "" : "s"}`
            : `${kind}${lines.length === 1 ? "" : "s"}`;
        log(`  found ${lines.length} ${label} (lines ${lines.join(", ")})`);
      }
    }
    if (report.fixable) {
      if (opts.fix) {
        const ok = await repairFile(file, report.parsedText!, log);
        if (ok) {
          fixed++;
          if (file === inUse) usableText = report.parsedText;
        } else {
          problems++;
        }
      } else {
        problems++;
        log(`  FIXABLE - re-run with \`hotdog rescue fix\` to repair (a .bak backup is kept)`);
      }
    } else {
      problems++;
      log(`  NOT auto-fixable - edit the file and fix the position marked above`);
    }
  }
  log();

  // 3-4. Key and schema checks on the effective config (only when we have JSON
  // that parses, original or just-repaired).
  if (usableText !== null) {
    problems += await checkKeys(usableText, opts.configParams ?? [], log);
    problems += checkSchema(usableText, opts.configParams ?? [], log);
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
    log(`System prompt template: ${sysPrompt}${(await exists(sysPrompt)) ? "" : " (absent - built-in template used)"}`);
    log(`Profiles directory:     ${profileDir}${(await exists(profileDir)) ? "" : " (absent)"}`);
    log();
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

async function repairFile(
  file: string,
  fixedText: string,
  log: (s?: string) => void,
): Promise<boolean> {
  const original = await fs.readFile(file, "utf-8");
  let backup = `${file}.bak`;
  for (let n = 1; await exists(backup); n++) backup = `${file}.bak.${n}`;
  await fs.writeFile(backup, original, "utf-8");
  await fs.writeFile(file, fixedText, "utf-8");
  log(`  FIXED ${file} (backup: ${backup})`);
  return true;
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, "");
}

async function checkKeys(
  text: string,
  configParams: ConfigParamDef[],
  log: (s?: string) => void,
): Promise<number> {
  let problems = 0;
  const allowed = [
    ...Object.keys(CONFIG_SCHEMA),
    ...extractConfigLayerKeys(CONFIG_SCHEMA),
    ...EXTRA_KNOWN_KEYS,
    ...configParams.map((p) => p.key),
  ];
  const seen = new Map<string, number>();
  for (const { key, line } of scanTopLevelKeys(text)) {
    const norm = normalizeKey(key);
    const first = seen.get(norm);
    if (first !== undefined) {
      problems++;
      log(`UNKNOWN/DUPLICATE key: "${key}" (line ${line}) duplicates line ${first} - the later value silently wins`);
      continue;
    }
    seen.set(norm, line);
    if (!allowed.some((a) => normalizeKey(a) === norm)) {
      const hints = suggestCandidates(norm, allowed.map(normalizeKey), { limit: 3 });
      const real = hints.map((h) => allowed.find((a) => normalizeKey(a) === h)!);
      problems++;
      log(
        `UNKNOWN key: "${key}" (line ${line}) - hotdog ignores it` +
          (real.length > 0 ? `; did you mean ${real.map((r) => `"${r}"`).join(", ")}?` : ""),
      );
    }
  }
  return problems;
}

function checkSchema(
  text: string,
  configParams: ConfigParamDef[],
  log: (s?: string) => void,
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
  for (const err of result.errors) {
    log(`SCHEMA: ${err}`);
  }
  return result.errors.length;
}
