// Config snapshot for the webui settings VIEWER (C2S configSnapshot ->
// S2C configSnapshotResult). Computed LIVE per request (the config may have
// changed on disk since startup; the viewer's honest framing is
// snapshot-at-open, never a live feed).
//
// Hard rules (owner ruling):
// - READ-ONLY. Zero writes, zero new config keys.
// - Diagnostics only: FileReport.rawText and parse-error excerpts NEVER
//   serialize. File bytes are not a viewer deliverable.
// - REDACTION IS THE WHOLE BALLGAME: at this wire boundary every value whose
//   dotted key path names an API key / token / secret (isSecretConfigPath in
//   ./protocol.ts, which covers providers.*.apiKey, webui.apiKey,
//   webSearch.{brave,tavily}ApiKey and the env slots behind them) ships as
//   value null + redacted:true, and container values are walked deep so a
//   secret-shaped entry inside a map (bashTool.env.GITHUB_TOKEN,
//   mcpServers[].env.*) is nulled too. Unknown-key findings carry key + line,
//   never the key's value.
//
// Layer attestation honesty:
// - default: schema literal (getLayerDefault / the property's own `default`);
//   computed (function) defaults ride OMITTED.
// - file: the in-use file's parsed value (normalizeConfigKeys, like the load
//   pipeline; raw `$VAR` references stay un-interpolated -- it is the raw text).
// - env: process.env at request time for the sources the schema declares.
// - cli: the key's declared cliFlag (schema + configRegistry) matched against
//   the live process.argv -- the same argv the parser consumed, so a present
//   flag is honestly attestable. Absent flags ride OMITTED (the registry holds
//   flag definitions, not parsed values; an alias parsed by a custom parse fn
//   is not attestable and is never invented).
// - resolved: core.resolved for core keys (the startup resolution chain),
//   falling back to the merged core.config where extension-resolved keys live.

import path from "node:path";
import {
  diagnoseConfigFile,
  scanTopLevelKeys,
  scanKeys,
  EXTRA_KNOWN_KEYS,
  REMOVED_KEYS,
} from "@core/config/rescue.ts";
import {
  buildUnifiedSchema,
  getLayerDefault,
  extractConfigLayerKeys,
  CONFIG_SCHEMA,
  type ConfigSchema,
  type SchemaProperty,
} from "@core/config/schema-loader.ts";
import { normalizeConfigKeys } from "@core/config/index.ts";
import { resolveConfigDir, DEFAULT_CONFIG_FILENAME } from "@core/config/defaults.ts";
import { suggestCandidates } from "@utils/strings.ts";
import { getNested } from "@utils/objects.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import type { ProviderDef } from "@core/config/providers.ts";
import {
  S2C,
  errorFrame,
  isSecretConfigPath,
  MAX_CONFIG_VALUE_CHARS,
  MAX_CONFIG_ROWS,
  MAX_CONFIG_FINDINGS,
  type ConfigFileEntryWire,
  type ConfigFindingWire,
  type ConfigKeyEntryWire,
  type ConfigSectionWire,
  type ConfigSnapshotResultWire,
} from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import type { RouteContext } from "./route-types.ts";

/** rescue's checkKeys normalization (private there): keys compare
 *  case-insensitively with "-" and "_" interchangeable. */
function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, "");
}

const removedHit = (key: string) =>
  REMOVED_KEYS.find((r) => normalizeKey(r.key) === normalizeKey(key));

// ── Value wire-shaping (redaction + truncation) ─────────────────────────────

// URL userinfo never ships: an authority section carrying user[:pass]@ is
// basic-auth material in disguise (judge hardening 2026-11-09 on provider
// urls). Matches only scheme://userinfo@ -- an "@" in a path or a plain
// email-shaped config string rides untouched.
const URL_USERINFO_RE = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/i;

/**
 * Serialize one slot value for the wire: walk objects/arrays and null every
 * entry whose own key segment is secret-shaped (the same isSecretConfigPath
 * rule, applied per path segment inside container values), scrub URL
 * userinfo, truncate long strings with the "[truncated]" marker. Returns
 * [value, redactedSomething]. Never mutates the source config.
 */
function wireValue(value: unknown, depth = 0): { value: unknown; hit: boolean } {
  if (depth > 24) return { value: "[depth-limit]", hit: false };
  if (typeof value === "string") {
    const s = value.replace(URL_USERINFO_RE, "$1***@");
    // Inside a container, a long string is body text (profile prompts,
    // pasted docs): the viewer shows structure, never the prose (owner
    // 2026-11-09). Top-level slots keep the truncation marker instead.
    if (depth >= 1 && s.length > 80) return { value: `[${s.length}-char text omitted]`, hit: false };
    return {
      value: s.length > MAX_CONFIG_VALUE_CHARS ? `${s.slice(0, MAX_CONFIG_VALUE_CHARS)}...[truncated]` : s,
      hit: false,
    };
  }
  if (Array.isArray(value)) {
    let hit = false;
    const items = value.map((item) => {
      const r = wireValue(item, depth + 1);
      hit = hit || r.hit;
      return r.value;
    });
    return { value: items, hit };
  }
  if (value && typeof value === "object") {
    let hit = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretConfigPath(k)) {
        hit = true;
        out[k] = null;
        continue;
      }
      const r = wireValue(v, depth + 1);
      hit = hit || r.hit;
      out[k] = r.value;
    }
    return { value: out, hit };
  }
  return { value, hit: false };
}

// ── Schema walk ──────────────────────────────────────────────────────────────

/** The unified schema for the RUNNING server: core CONFIG_SCHEMA plus the
 *  extension schemas registered on core.configRegistry (extractSchemaDefaults
 *  keeps each configSchema entry's layers on param.schema). */
function unifiedSchemaFor(core: CoreContext): ConfigSchema {
  const params = core.configRegistry?.getConfigParams?.() ?? [];
  const configSchema: Record<string, unknown> = {};
  for (const p of params) {
    if (p.schema && typeof p.schema === "object") configSchema[p.key] = p.schema;
  }
  return buildUnifiedSchema(Object.keys(configSchema).length > 0 ? [{ configSchema }] : undefined);
}

interface LeafEntry {
  path: string;
  prop: SchemaProperty;
}

/** One row per LEAF: objects with declared properties recurse; everything
 *  else (scalars, arrays, free-form maps like bashTool.env) is its own row. */
function collectLeaves(prefix: string, prop: SchemaProperty, out: LeafEntry[]): void {
  const props = prop.properties;
  if (props && typeof props === "object" && Object.keys(props).length > 0) {
    for (const [name, child] of Object.entries(props)) {
      collectLeaves(`${prefix}.${name}`, child, out);
    }
    return;
  }
  out.push({ path: prefix, prop });
}

/** The config-file key a layer reads (its declared `key`, else the dotted path). */
function configLayerKey(prop: SchemaProperty, path: string): string {
  for (const layer of prop.layers ?? []) {
    if (layer.source === "config" && typeof layer.key === "string") return layer.key;
  }
  return path;
}

/** True when a layer value counts as SET (resolveKey semantics: "" is unset). */
const isSet = (v: unknown): boolean => v !== undefined && v !== null && v !== "";

/** Flag literal present in the live argv? The core parser (cli.ts) consumes
 *  `--flag value` / `-f value` as separate tokens and boolean flags as bare
 *  tokens -- mirrored here exactly (`--flag=value` is NOT a form the parser
 *  accepts, so it is not attested either). */
function cliFlagInArgv(argv: string[], flag: { long: string; short?: string; type?: string }): { literal: string; value?: unknown } | null {
  const hasValue = flag.type !== "boolean";
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    for (const name of [flag.long, flag.short]) {
      if (!name || tok !== name) continue;
      if (!hasValue) return { literal: name, value: true };
      const next = argv[i + 1];
      return { literal: name, ...(next !== undefined ? { value: next } : {}) };
    }
  }
  return null;
}

// ── Rows ────────────────────────────────────────────────────────────────────

interface RowCtx {
  fileConfig: Record<string, unknown> | null;
  core: CoreContext;
  argv: string[];
  registryFlags: Map<string, { long: string; short?: string; type?: string }>;
}

/**
 * Build one key row and apply the redaction boundary: when the leaf path is
 * secret-shaped, every slot value nulls (slot PRESENCE survives -- that is
 * how the UI says "set (redacted)" vs "unset") and redacted:true rides. A
 * redacted row with nothing set rides redacted absent (the honest "unset").
 */
function buildRow(entry: LeafEntry, ctx: RowCtx): ConfigKeyEntryWire {
  const { path, prop } = entry;
  const row: ConfigKeyEntryWire = { key: path };
  if (prop.description) row.description = prop.description;

  // default: schema literal only (computed defaults stay omitted).
  let def = getLayerDefault(prop);
  if (def === undefined) def = prop.default;
  const hasDefault = def !== undefined && typeof def !== "function";

  // file: the parsed in-use file (or explicit --config), camelCased like the
  // load pipeline; raw text, so "$VAR" references are NOT interpolated.
  let fileValue: unknown;
  if (ctx.fileConfig) {
    const v = getNested(ctx.fileConfig, configLayerKey(prop, path));
    if (v !== undefined) fileValue = v;
  }

  // env: only attested when the schema declares env sources for this key.
  const envSources = (prop.layers ?? [])
    .filter((l) => l.source === "env" && typeof l.key === "string")
    .map((l) => l.key as string);
  let envSet: { set: boolean; source?: string; value?: unknown } | undefined;
  if (envSources.length > 0) {
    const first = envSources.find((name) => isSet(process.env[name]));
    envSet = first !== undefined
      ? { set: true, source: first, value: process.env[first] }
      : { set: false, source: envSources[0] };
  }

  // cli: declared flag + live argv. The registry table is consulted for keys
  // whose flag came from an extension registration (same definitions table
  // cliFlagsFromSchema feeds); an unattested flag rides omitted, never invented.
  const flagDecl = prop.cliFlag ?? ctx.registryFlags.get(path);
  const cliHit = flagDecl ? cliFlagInArgv(ctx.argv, flagDecl) : null;

  // resolved: core.resolved carries the startup resolution chain for core
  // keys; extension-resolved keys live on core.config (resolveExtensionConfig
  // assigns them there).
  const fromResolved = ctx.core.resolved ? getNested(ctx.core.resolved, path) : undefined;
  const resolvedValue = fromResolved !== undefined ? fromResolved : getNested(ctx.core.config ?? {}, path);

  const secret = isSecretConfigPath(path);
  if (secret) {
    const anySet = isSet(fileValue) || envSet?.set === true || cliHit !== null || isSet(resolvedValue);
    // A secret-shaped key never ships a value, set or not (defense in depth).
    row.leafSecret = true;
    if (hasDefault) row.default = null;
    if (fileValue !== undefined) row.file = null;
    if (envSet) row.env = { set: envSet.set, ...(envSet.source ? { source: envSet.source } : {}) };
    if (cliHit) row.cli = { flag: cliHit.literal, value: null };
    if (resolvedValue !== undefined) row.resolved = null;
    if (anySet) row.redacted = true;
    return row;
  }

  let hit = false;
  if (hasDefault) {
    const r = wireValue(def);
    row.default = r.value;
    hit = hit || r.hit;
  }
  if (fileValue !== undefined) {
    const r = wireValue(fileValue);
    row.file = r.value;
    hit = hit || r.hit;
  }
  if (envSet) {
    // The env var NAME is redaction-tested too: a third-party schema that
    // names its env var like a credential behind a non-secret key path must
    // not hand its value over (the key-path rule alone would miss it).
    const nameSecret = envSet.source !== undefined && isSecretConfigPath(envSet.source.replace(/_/g, "."));
    const r =
      !nameSecret && envSet.value !== undefined ? wireValue(envSet.value) : { value: undefined, hit: false };
    row.env = {
      set: envSet.set,
      ...(envSet.source ? { source: envSet.source } : {}),
      ...(envSet.set ? (nameSecret ? { value: null } : { value: r.value }) : {}),
    };
    hit = hit || r.hit || nameSecret;
  }
  if (cliHit) {
    const r = cliHit.value !== undefined ? wireValue(cliHit.value) : { value: undefined, hit: false };
    row.cli = { flag: cliHit.literal, ...(cliHit.value !== undefined ? { value: r.value } : {}) };
    hit = hit || r.hit;
  }
  if (resolvedValue !== undefined) {
    const r = wireValue(resolvedValue);
    row.resolved = r.value;
    hit = hit || r.hit;
  }
  // A secret-shaped entry nulled inside a container value (bashTool.env,
  // mcpServers[].env) is a redaction event too -- flag it so the UI says so.
  if (hit) row.redacted = true;
  return row;
}

/** The providers passthrough block (EXTRA_KNOWN_KEYS, not a schema entry):
 *  url + model names + the redacted apiKey, one row triple per provider.
 *  Without it the viewer would hide the most-read config block; the apiKey
 *  rows are exactly the providers.*.apiKey shape the redaction rule must
 *  cover, so they ship null + redacted:true. */
function providerRows(core: CoreContext): ConfigKeyEntryWire[] {
  const providers = Array.isArray(core.config?.providers) ? (core.config.providers as ProviderDef[]) : [];
  const rows: ConfigKeyEntryWire[] = [];
  for (const p of providers) {
    if (!p || typeof p !== "object" || typeof p.name !== "string") continue;
    const base = `providers.${p.name}`;
    if (p.url !== undefined) {
      rows.push({ key: `${base}.url`, description: "Provider base URL", resolved: wireValue(p.url).value });
    }
    if (Array.isArray(p.models) && p.models.length > 0) {
      const names = p.models.map((m) => (typeof m === "string" ? m : m?.name)).filter((n): n is string => typeof n === "string");
      if (names.length > 0) {
        rows.push({ key: `${base}.models`, description: "Models served by this provider", resolved: wireValue(names).value });
      }
    }
    const apiKeySet = isSet(p.apiKey);
    rows.push({
      key: `${base}.apiKey`,
      description: "Provider API key (never leaves the server)",
      leafSecret: true,
      resolved: null,
      ...(apiKeySet ? { redacted: true } : {}),
    });
  }
  return rows;
}

// ── Findings (rescue's key stages, in-process) ──────────────────────────────

/**
 * rescue.ts checkKeys replayed on the unified schema (its own checkKeys is
 * module-private; every primitive it composes is reused here verbatim:
 * scanTopLevelKeys / scanKeys + REMOVED_KEYS tombstones + suggestCandidates
 * + EXTRA_KNOWN_KEYS). Findings carry keys and line numbers, never values.
 */
function buildFindings(usableText: string, unified: ConfigSchema, configParamKeys: string[]): { findings: ConfigFindingWire[]; truncated: boolean } {
  const allowed = [
    ...Object.keys(unified),
    ...extractConfigLayerKeys(unified),
    ...EXTRA_KNOWN_KEYS,
    ...configParamKeys,
  ];
  const findings: ConfigFindingWire[] = [];
  let truncated = false;
  const push = (f: ConfigFindingWire): void => {
    if (findings.length >= MAX_CONFIG_FINDINGS) truncated = true;
    else findings.push(f);
  };

  const seen = new Map<string, number>();
  for (const { key, line } of scanTopLevelKeys(usableText)) {
    const norm = normalizeKey(key);
    const first = seen.get(norm);
    if (first !== undefined) {
      push({ type: "duplicate-key", key, line, firstLine: first });
      continue;
    }
    seen.set(norm, line);
    if (removedHit(key)) continue;
    if (!allowed.some((a) => normalizeKey(a) === norm)) {
      const hints = suggestCandidates(norm, allowed.map(normalizeKey), { limit: 3 });
      const real = hints.map((h) => allowed.find((a) => normalizeKey(a) === h)!);
      push({ type: "unknown-key", key, line, ...(real.length > 0 ? { didYouMean: real } : {}) });
    }
  }
  for (const hit of scanKeys(usableText, Number.POSITIVE_INFINITY)) {
    const r = removedHit(hit.key);
    if (!r) continue;
    push({
      type: "removed-key",
      key: hit.key,
      line: hit.line,
      message: `"${hit.key}" is no longer read; replaced by "${r.replacement}"${r.note ? ` (${r.note})` : ""}`,
    });
  }
  return { findings, truncated };
}

// ── Files ───────────────────────────────────────────────────────────────────

/** The in-use config file: an explicit --config/-f on the live argv (the same
 *  argv loadConfig consumed) wins, else <configDir>/defaults.json. Other
 *  chain candidates stay `hotdog rescue`'s job -- the viewer reports what the
 *  running server actually reads. */
function inUseConfigPath(argv: string[], configDir: string): string {
  const hit = cliFlagInArgv(argv, { long: "--config", short: "-f", type: "string" });
  if (typeof hit?.value === "string" && hit.value) return path.resolve(hit.value);
  return path.join(configDir, DEFAULT_CONFIG_FILENAME);
}

function fileEntryWire(pathStr: string, report: Awaited<ReturnType<typeof diagnoseConfigFile>>, inUse: boolean): ConfigFileEntryWire {
  const entry: ConfigFileEntryWire = { path: pathStr, inUse, status: report.status };
  if (report.status === "broken") {
    // Parse messages quote the offending token -- and that token is FILE
    // BYTES. Scrub the quoted runs (both quote styles) so a file broken
    // after boot can never echo its content through the error text; the
    // position wording survives, and rescue owns the real diagnosis.
    entry.parseError = (report.parseErrorMessage ?? "invalid JSON")
      .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '"…"')
      .slice(0, 200);
    entry.fixable = report.fixable === true;
    if (report.jsoncIssues.length > 0) {
      const byKind = new Map<string, number[]>();
      for (const iss of report.jsoncIssues) {
        const list = byKind.get(iss.kind) ?? [];
        list.push(iss.line);
        byKind.set(iss.kind, list);
      }
      entry.jsoncIssues = Array.from(byKind.entries()).map(([kind, lines]) => ({ kind, lines }));
    }
  }
  return entry;
}

// ── Snapshot build + handler ────────────────────────────────────────────────

/** Compute the live snapshot payload (pure read: config files, process.env,
 *  process.argv, the registries and the resolved config). Exported for tests. */
export async function buildConfigSnapshot(
  core: CoreContext,
  opts: { argv?: string[] } = {},
): Promise<Omit<ConfigSnapshotResultWire, "type">> {
  const argv = opts.argv ?? process.argv;
  const configDir = (typeof core.resolved?.configDir === "string" && core.resolved.configDir) || resolveConfigDir();
  const inUsePath = inUseConfigPath(argv, configDir);

  const report = await diagnoseConfigFile(inUsePath);
  const files = [fileEntryWire(inUsePath, report, true)];

  // Key checks need text that parses (original or JSONC-repaired) -- exactly
  // runRescue's usableText gate.
  let fileConfig: Record<string, unknown> | null = null;
  let findings: ConfigFindingWire[] = [];
  let truncatedFindings = false;
  const unified = unifiedSchemaFor(core);
  const configParamKeys = (core.configRegistry?.getConfigParams?.() ?? []).map((p) => p.key);
  if (report.parsedText !== null) {
    try {
      fileConfig = normalizeConfigKeys(JSON.parse(report.parsedText)) as Record<string, unknown>;
    } catch {
      // diagnoseConfigFile already attests parseability; a racing rewrite can
      // still land unparseable bytes -- treat it as "no file layer" and keep
      // every other slot honest.
      fileConfig = null;
    }
    const r = buildFindings(report.parsedText, unified, configParamKeys);
    findings = r.findings;
    truncatedFindings = r.truncated;
  }

  // Flag table the registry holds for extension-registered flags (core schema
  // flags carry cliFlag on the property itself).
  const registryFlags = new Map<string, { long: string; short?: string; type?: string }>();
  for (const f of core.configRegistry?.getCliFlags?.() ?? []) {
    if (f.key && !registryFlags.has(f.key)) {
      registryFlags.set(f.key, { long: f.long, short: f.short, type: f.type });
    }
  }

  const ctx: RowCtx = { fileConfig, core, argv, registryFlags };
  const sections: ConfigSectionWire[] = [];
  const sectionFor = (name: string): ConfigSectionWire => {
    let s = sections.find((x) => x.name === name);
    if (!s) {
      s = { name, rows: [] };
      sections.push(s);
    }
    return s;
  };

  let rowCount = 0;
  let truncatedRows = false;
  for (const [topKey, topProp] of Object.entries(unified)) {
    const leaves: LeafEntry[] = [];
    collectLeaves(topKey, topProp, leaves);
    const coreKey = Object.hasOwn(CONFIG_SCHEMA, topKey);
    for (const leaf of leaves) {
      if (rowCount >= MAX_CONFIG_ROWS) {
        truncatedRows = true;
        break;
      }
      sectionFor(coreKey ? "core" : topKey).rows.push(buildRow(leaf, ctx));
      rowCount++;
    }
  }
  const pRows = providerRows(core);
  for (const row of pRows) {
    if (rowCount >= MAX_CONFIG_ROWS) {
      truncatedRows = true;
      break;
    }
    sectionFor("providers").rows.push(row);
    rowCount++;
  }

  return {
    ts: Date.now(),
    configDir,
    files,
    findings,
    sections,
    ...(truncatedFindings || truncatedRows ? { truncated: true } : {}),
  };
}

export async function handleConfigSnapshot(ctx: RouteContext): Promise<void> {
  const { ws, msg, core } = ctx;
  const requestId = typeof msg.requestId === "number" ? msg.requestId : undefined;
  // Awaited for the settle contract: this reads the config file off disk.
  await buildConfigSnapshot(core)
    .then((payload) => {
      // requestId rides last so an echoed non-number (undefined) simply
      // drops out of the JSON instead of shadowing the payload.
      SessionRegistry.sendSafe(ws, {
        ...payload,
        type: S2C.CONFIG_SNAPSHOT_RESULT,
        requestId,
      });
    })
    .catch((err: unknown) => {
      logger.warn(`[websocket] configSnapshot failed: ${formatError(err)}`);
      SessionRegistry.sendSafe(ws, errorFrame(err));
    });
}
