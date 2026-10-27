// centralized-defaults house-rule scanner. Pure function over a repo root.
//
// The rule text (quoted AGENTS.md), sub-pattern rationale, and ceilings live
// in ../centralized-defaults.test.ts; this module is the implementation.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  listSourceFiles,
  lineText,
  maskCode,
  normalizeSnippet,
  relPath,
  Violation,
} from "../harness.ts";

const EXEMPT_NAMES = new Set([
  "DEFAULT_PROFILES_SUBPATH",
  "DEFAULT_CONFIG_FILENAME",
  "DEFAULT_SYSTEM_PROMPT_FILENAME",
  "DEFAULT_SYSTEM_PROMPT_TEMPLATE",
]);

/** Union of core.config.json keys and every extension/experimental configSchema key. */
export function collectSchemaKeys(root: string): Set<string> {
  const keys = new Set<string>();
  const corePath = join(root, "src/core/core.config.json");
  if (existsSync(corePath)) {
    for (const k of Object.keys(JSON.parse(readFileSync(corePath, "utf8")))) keys.add(k);
  }
  for (const dir of ["src/extensions", "src/experimental"]) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const manifest = join(base, entry.name, "extension.json");
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const schema = (JSON.parse(readFileSync(manifest, "utf8")) as {
        configSchema?: Record<string, { properties?: Record<string, unknown> }>;
      }).configSchema;
      if (!schema) continue;
      for (const [group, def] of Object.entries(schema)) {
        keys.add(group);
        for (const k of Object.keys(def.properties ?? {})) keys.add(k);
      }
    }
  }
  return keys;
}

const IMPORT_RE = /\bimport\b[\s\S]{0,2000}?\bfrom\b/g;
const DEFAULT_NAME_RE = /\bDEFAULT_[A-Z0-9_]+\b/g;
// D2a: configLike.key ?? <literal | DEFAULT_*>  (receiver must contain config/cfg/resolved)
const NULLISH_RE =
  /[A-Za-z0-9_.$#]*(?:config|cfg|resolved)[A-Za-z0-9_.$#]*(?:\?\.|\.)\s*([A-Za-z0-9_]+)\s*\?\?\s*(?:DEFAULT_[A-Z0-9_]+|-?[\d][\d_]*(?:\.[\d_]+)?|"[^"\n]*"|'[^'\n]*')/g;
// D2b: configLike.key ... ? ... : <literal | DEFAULT_*>  (same-line ternary fallback)
const TERNARY_RE =
  /[A-Za-z0-9_.$#]*(?:config|cfg)[A-Za-z0-9_.$#]*\.\s*([A-Za-z0-9_]+)[^?;\n]{0,80}\?\s[^:;\n]{0,120}:\s*(?:DEFAULT_[A-Z0-9_]+|-?[\d][\d_]*(?![\w.]))/g;
// D3: numeric backup-default constant definition.
const LOCAL_DEFAULT_RE = /^\s*(?:export\s+)?const\s+(DEFAULT_[A-Z0-9_]+)\s*=\s*-?[\d][\d_]*(?:\.[\d_]+)?\s*;/gm;

/** Pure scanner over a repo root: centralized-defaults house-rule violations in src/. */
export function scanCentralizedDefaults(root: string): Violation[] {
  const schemaKeys = collectSchemaKeys(root);
  const out: Violation[] = [];
  for (const abs of listSourceFiles(root, "src", [".ts", ".tsx"])) {
    const rel = relPath(root, abs);
    if (rel.startsWith("src/core/config/")) continue; // the resolution layer itself
    const raw = readFileSync(abs, "utf8");
    const masked = maskCode(raw);

    // D1: DEFAULT_* imported into a component.
    for (const m of masked.matchAll(IMPORT_RE)) {
      const stmt = masked.slice(m.index, m.index + m[0].length);
      const names = stmt.match(DEFAULT_NAME_RE);
      if (names && names.some((n) => !EXEMPT_NAMES.has(n))) {
        out.push({ file: rel, snippet: normalizeSnippet(lineText(raw, m.index)) });
      }
    }

    // D2: literal/DEFAULT_ fallback for a schema-owned key on a config-ish receiver.
    for (const re of [NULLISH_RE, TERNARY_RE]) {
      for (const m of masked.matchAll(re)) {
        const key = m[1];
        if (!key || !schemaKeys.has(key)) continue;
        out.push({ file: rel, snippet: normalizeSnippet(lineText(raw, m.index)) });
      }
    }

    // D3: file consumes resolved extension config yet defines a numeric DEFAULT_ const.
    if (/\bgetExtensionConfig\b/.test(masked)) {
      for (const m of masked.matchAll(LOCAL_DEFAULT_RE)) {
        const name = m[1]!;
        if (EXEMPT_NAMES.has(name)) continue;
        const tok = m[0].indexOf("const"); // anchor: leading ^\s* may span masked blank lines
        out.push({ file: rel, snippet: normalizeSnippet(lineText(raw, m.index + tok)) });
      }
    }
  }
  return out;
}
