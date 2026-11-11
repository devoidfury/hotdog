// Config snapshot for the webui settings VIEWER (C2S configSnapshot ->
// S2C configSnapshotResult). Computed LIVE per request (the config may have
// changed on disk since startup; the viewer's honest framing is
// snapshot-at-open, never a live feed). The bottom of this file adds the
// settings EDITOR (C2S setConfigKey -> S2C setConfigKeyResult): the file's
// one write path -- ALL-FIELDS editability per the owner ruling 2026-11-09
// ("it needs to be ALL the settings"), gated by the two honest refusals +
// schema/shape revalidation + surgical JSONC edit + atomic rescue-verified
// write described there.
//
// Hard rules (owner ruling):
// - The snapshot is READ-ONLY. Zero new config keys anywhere.
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
import fs from "node:fs/promises";
import {
  diagnoseConfigFile,
  scanTopLevelKeys,
  scanKeys,
  stripJsonc,
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
  errorText,
  isSecretConfigPath,
  MAX_CONFIG_VALUE_CHARS,
  MAX_CONFIG_ROWS,
  MAX_CONFIG_FINDINGS,
  type ConfigFileEntryWire,
  type ConfigFindingWire,
  type ConfigKeyEditWire,
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
 * [value, redactedSomething, byteFaithful]. Never mutates the source config.
 *
 * `lossy` is the byte-faithfulness signal the EDITOR needs (owner ruling
 * 2026-11-09): the shipped value is not a faithful copy when a string was
 * truncated or stubbed, a container was cut at the depth limit, or URL
 * userinfo was scrubbed. Editing FROM a lossy value would overwrite real
 * bytes with the stub -- exactly the harm the secret refusal exists for --
 * so lossy values never carry an edit stamp (the children-per-row refusal,
 * and the writeOnly secret box, are the escapes that do not need the old
 * value).
 */
function wireValue(value: unknown, depth = 0): { value: unknown; hit: boolean; lossy: boolean } {
  if (depth > 24) return { value: "[depth-limit]", hit: false, lossy: true };
  if (typeof value === "string") {
    const s = value.replace(URL_USERINFO_RE, "$1***@");
    const scrubbed = s !== value;
    // Inside a container, a long string is body text (profile prompts,
    // pasted docs): the viewer shows structure, never the prose (owner
    // 2026-11-09). Top-level slots keep the truncation marker instead.
    if (depth >= 1 && s.length > 80) return { value: `[${s.length}-char text omitted]`, hit: false, lossy: true };
    if (s.length > MAX_CONFIG_VALUE_CHARS) {
      return { value: `${s.slice(0, MAX_CONFIG_VALUE_CHARS)}...[truncated]`, hit: false, lossy: true };
    }
    return { value: s, hit: false, lossy: scrubbed };
  }
  if (Array.isArray(value)) {
    let hit = false;
    let lossy = false;
    const items = value.map((item) => {
      const r = wireValue(item, depth + 1);
      hit = hit || r.hit;
      lossy = lossy || r.lossy;
      return r.value;
    });
    return { value: items, hit, lossy };
  }
  if (value && typeof value === "object") {
    let hit = false;
    let lossy = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretConfigPath(k)) {
        hit = true;
        out[k] = null;
        continue;
      }
      const r = wireValue(v, depth + 1);
      hit = hit || r.hit;
      lossy = lossy || r.lossy;
      out[k] = r.value;
    }
    return { value: out, hit, lossy };
  }
  return { value, hit: false, lossy: false };
}

/** One predicate for byte-faithfulness of a value's SHIP (no secret nulled,
 *  nothing stubbed/truncated, no URL userinfo scrubbed, no depth cut). The
 *  STAMP decision (StampRequest.faithful rides this same wireValue signal)
 *  and the WRITE GATE (applyConfigKeyEditLocked) share it: a wholesale
 *  container write the stamp was withheld for must be refused server-side
 *  too -- hiding the button is not a gate, and writing the shipped summary
 *  back would splice stubs over the user's real bytes (owner ruling: the
 *  invariant is server-side). Lossy SCALARS are the exception by doctrine:
 *  scalar writes replace the whole token, so they carry a seedless REPLACE
 *  stamp instead of a refusal (fresh value, no seed faithfulness needed). */
function shipFaithful(value: unknown): boolean {
  const r = wireValue(value);
  return !r.hit && !r.lossy;
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

// ── Editor stamps (ALL-the-settings row editability) ────────────────────────
// Owner ruling 2026-11-09: EVERY row the snapshot renders carries row.edit,
// EXCEPT the two honest refusals:
//   A) NOT BYTE-FAITHFUL SHIP -- the row's seed slot was redacted (a secret
//      inside a container), URL-scrubbed, stubbed, or truncated: editing
//      from the stub would write stubs over real bytes. Containers here get
//      their children surfaced as their own stamped rows instead; secret-
//      shaped LEAVES are unaffected (their writeOnly replace box never needs
//      the old value).
//   B) NOT ADDRESSABLE -- a duplicated key anywhere on the path (the loader
//      and this editor both refuse to guess which occurrence), a file the
//      locator cannot walk at all, or a key the path grammar cannot spell
//      (a key containing '.', '[' or ']'). The row/hint says fix it in file
//      (rescue names duplicates).

/** One key-path segment: an object key or an ARRAY INDEX ("providers[0].url"
 *  addresses the first element's url -- the locator splices at that range). */
export type KeySeg = string | number;

/** Parse the wire keyPath grammar: dotted keys, `[n]` index suffixes.
 *  Null on anything the locator could not express (empty segments, a stray
 *  bracket, an out-of-grammar character inside a bracket, a key containing
 *  '.' or '[' -- those keys stay file-only, honestly unstamped). */
export function parseKeyPath(keyPath: string): KeySeg[] | null {
  const segs: KeySeg[] = [];
  let i = 0;
  const n = keyPath.length;
  for (;;) {
    let j = i;
    while (j < n && !".[]".includes(keyPath[j]!)) j++;
    if (j === i) return null; // empty key segment (leading dot, "..", "[0].x[")
    segs.push(keyPath.slice(i, j));
    i = j;
    while (i < n && keyPath[i] === "[") {
      const close = keyPath.indexOf("]", i + 1);
      if (close < 0) return null;
      const digits = keyPath.slice(i + 1, close);
      if (!/^\d{1,6}$/.test(digits)) return null;
      segs.push(Number(digits));
      i = close + 1;
    }
    if (i === n) return segs;
    if (keyPath[i] !== ".") return null;
    i++;
  }
}

/** The canonical lookup spelling of a path: keys normalized like rescue's
 *  checkKeys, indices bracketed. "providers[0].url" and "providers[0].URL"
 *  agree; "providers[1].url" is its own address. */
const spellPath = (segs: KeySeg[]): string =>
  segs.map((s) => (typeof s === "number" ? `[${s}]` : normalizeKey(s))).join(".");

/** True when every key segment round-trips through the grammar (row keys
 *  for the client, locator targets for the write path). */
function grammarSafe(segs: KeySeg[]): boolean {
  return segs.every((s) => typeof s === "number" || (s !== "" && !".[]".includes(s[0]!) && !/[.\[\]]/.test(s)));
}

/** Secret test on a PARSED path: the last KEY segment decides (an index is
 *  not a name; isSecretConfigPath's dotted rule applies to it verbatim). */
function secretSegs(segs: KeySeg[]): boolean {
  const lastKey = [...segs].reverse().find((s) => typeof s === "string");
  return typeof lastKey === "string" ? isSecretConfigPath(lastKey) : false;
}

/** The locator member list (indexed, see locateJsonStructure) reduced to the
 *  spellings that occur MORE THAN ONCE: every path under (or equal to) one
 *  of those is ambiguous and stays un-stamped. */
function collectDuplicatePaths(members: EditMember[]): Set<string> {
  const counts = new Map<string, number>();
  for (const m of members) counts.set(spellPath(m.segs), (counts.get(spellPath(m.segs)) ?? 0) + 1);
  const dups = new Set<string>();
  for (const [sp, c] of counts) if (c > 1) dups.add(sp);
  return dups;
}

/** True when `segs` or any ANCESTOR path is duplicated in the file. */
function hasDuplicatePrefix(dups: Set<string>, segs: KeySeg[]): boolean {
  if (dups.size === 0) return false;
  for (let d = segs.length; d >= 1; d--) {
    if (dups.has(spellPath(segs.slice(0, d)))) return true;
  }
  return false;
}

/** The shape class of a parsed value, as the write path and the stamp agree
 *  on it. "null" is its own class: it attests nothing about what to write. */
const shapeClass = (v: unknown): "object" | "array" | "null" | "scalar" | undefined =>
  v === undefined
    ? undefined
    : v === null
      ? "null"
      : Array.isArray(v)
        ? "array"
        : typeof v === "object"
          ? "object"
          : "scalar";

/** Runtime scalar type for a file-only value (no schema to ask). */
const runtimeScalarType = (v: unknown): "number" | "integer" | "boolean" | "string" | null =>
  typeof v === "boolean"
    ? "boolean"
    : typeof v === "number"
      ? Number.isFinite(v)
        ? Number.isInteger(v)
          ? "integer"
          : "number"
        : null
      : typeof v === "string"
        ? "string"
        : null;

interface StampRequest {
  /** The row's parsed path (already grammar-checked by the caller). */
  segs: KeySeg[];
  /** The schema property when the path is a declared leaf (null: file-only
   *  or a child inside a free-form container). */
  prop: SchemaProperty | null;
  /** The RAW current value the editor would seed from (file ?? resolved),
   *  undefined when nothing sets the path. */
  rawSeed: unknown;
  /** False when the seed slot's SHIPPED form was redacted/stubbed/truncated
   *  (wireValue's hit/lossy). Secrets ignore it: their box starts empty. */
  faithful: boolean;
  /** False when the file (or the path) is not addressable. */
  addressable: boolean;
  /** The file's duplicated member paths (collectDuplicatePaths). */
  dups: Set<string>;
}

/** THE stamp decision, shared by every row builder (schema leaves, file-only
 *  keys, container children). null = an honest refusal (see the classes). */
function stampFor(r: StampRequest): ConfigKeyEditWire | null {  if (!r.addressable || !grammarSafe(r.segs) || hasDuplicatePrefix(r.dups, r.segs)) return null;
  if (secretSegs(r.segs)) return { type: "string", writeOnly: true };
  const schemaKind = r.prop && (!r.prop.properties || Object.keys(r.prop.properties).length === 0)
    ? r.prop.type === "number" || r.prop.type === "integer" || r.prop.type === "boolean" || r.prop.type === "string"
      ? "scalar"
      : r.prop.type === "array"
        ? "array"
        : r.prop.type === "object"
          ? "object"
          : undefined
    : r.prop
      ? "object" // declared sub-properties: collectLeaves never lands here
      : undefined;
  const fileShape = shapeClass(r.rawSeed);
  if (schemaKind === "scalar") {
    // A schema scalar the file currently holds as a container/null would
    // splice a type the loader never reads: honest refusal (class B shape).
    if (fileShape !== undefined && fileShape !== "scalar") return null;
    // A lossy SHIP (truncated string, scrubbed URL userinfo) does not refuse
    // a SCALAR: the write replaces the whole value token anyway, so it rides
    // a seedless REPLACE stamp -- the client seeds an empty input instead of
    // a summary (owner ruling 2026-11-09: ALL the settings; a third refusal
    // class for big prose was never sanctioned).
    const bounds = r.prop!;
    return {
      type: r.prop!.type as "number" | "integer" | "boolean" | "string",
      ...(typeof bounds.minimum === "number" ? { minimum: bounds.minimum } : {}),
      ...(typeof bounds.maximum === "number" ? { maximum: bounds.maximum } : {}),
      ...(!r.faithful ? { seedless: true } : {}),
    };
  }
  const containerKind: "object" | "array" | undefined =
    schemaKind === "array" || schemaKind === "object"
      ? schemaKind
      : fileShape === "object" || fileShape === "array"
        ? fileShape
        : undefined;
  if (containerKind) {
    if (fileShape !== undefined && fileShape !== "object" && fileShape !== "array") return null; // null/scalar where a container belongs
    if (!r.faithful) return null; // refusal A: the shipped payload is a summary, not the bytes
    // Schema/array vs file/object disagreements are the write path's
    // (shape-class) refusal; a stamp whose write must fail is a lying
    // stamp, so align here too.
    if (schemaKind && fileShape && schemaKind !== fileShape) return null;
    return { type: "json" };
  }
  if (fileShape === "null") return null; // no shape to hold the write to
  const t = runtimeScalarType(r.rawSeed);
  if (!t) return null; // absent file-only key: nothing validates it (fail closed)
  // Lossy ship (e.g. a >MAX long prose string): REPLACE, not a refusal --
  // same seedless doctrine as schema scalars above.
  return { type: t, ...(!r.faithful ? { seedless: true } : {}) };
}

// ── Rows ────────────────────────────────────────────────────────────────────

interface RowCtx {
  fileConfig: Record<string, unknown> | null;
  core: CoreContext;
  argv: string[];
  registryFlags: Map<string, { long: string; short?: string; type?: string }>;
  /** Duplicated member paths in the in-use file (class-B refusal). */
  dups: Set<string>;
  /** False when the file exists but the locator cannot walk it: nothing is
   *  addressable, so nothing is stamped (class-B refusal). A MISSING file is
   *  addressable (the write path creates it). */
  addressable: boolean;
}

/** Grammar rendering of a parsed path (the row key the client sees and the
 *  write path re-parses). */
function keyString(segs: KeySeg[]): string {
  let out = "";
  for (const s of segs) out += typeof s === "number" ? `[${s}]` : out === "" ? s : `.${s}`;
  return out;
}

/**
 * Build the row(s) for one schema leaf and apply the redaction boundary:
 * when the leaf path is secret-shaped, every slot value nulls (slot PRESENCE
 * survives -- that is how the UI says "set (redacted)" vs "unset") and
 * redacted:true rides. A redacted row with nothing set rides redacted absent
 * (the honest "unset"). Stamping follows the ALL-the-settings ruling: every
 * row carries row.edit except the two refusals, and a class-A container
 * refusal surfaces its children as their own rows.
 */
function buildRows(entry: LeafEntry, ctx: RowCtx): ConfigKeyEntryWire[] {
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

  const segs = parseKeyPath(path) ?? [];
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
    // The writeOnly REPLACE box: the one stamp that never needs the old
    // value, so class A cannot touch it; class B (duplicate/unaddressable)
    // still refuses it.
    if (ctx.addressable && grammarSafe(segs) && !hasDuplicatePrefix(ctx.dups, segs)) {
      row.edit = { type: "string", writeOnly: true };
    }
    return [row];
  }

  let hit = false;
  let seedFaithful = true; // file ?? resolved is the editor's seed; its ship must be byte-faithful
  if (hasDefault) {
    const r = wireValue(def);
    row.default = r.value;
    hit = hit || r.hit;
  }
  if (fileValue !== undefined) {
    const r = wireValue(fileValue);
    row.file = r.value;
    hit = hit || r.hit;
    seedFaithful = !r.hit && !r.lossy;
  }
  if (envSet) {
    // The env var NAME is redaction-tested too: a third-party schema that
    // names its env var like a credential behind a non-secret key path must
    // not hand its value over (the key-path rule alone would miss it).
    const nameSecret = envSet.source !== undefined && isSecretConfigPath(envSet.source.replace(/_/g, "."));
    const r =
      !nameSecret && envSet.value !== undefined ? wireValue(envSet.value) : { value: undefined, hit: false, lossy: false };
    row.env = {
      set: envSet.set,
      ...(envSet.source ? { source: envSet.source } : {}),
      ...(envSet.set ? (nameSecret ? { value: null } : { value: r.value }) : {}),
    };
    hit = hit || r.hit || nameSecret;
  }
  if (cliHit) {
    const r = cliHit.value !== undefined ? wireValue(cliHit.value) : { value: undefined, hit: false, lossy: false };
    row.cli = { flag: cliHit.literal, ...(cliHit.value !== undefined ? { value: r.value } : {}) };
    hit = hit || r.hit;
  }
  if (resolvedValue !== undefined) {
    const r = wireValue(resolvedValue);
    row.resolved = r.value;
    hit = hit || r.hit;
    if (fileValue === undefined) seedFaithful = !r.hit && !r.lossy; // resolved seeds when the file slot is absent
  }
  // A secret-shaped entry nulled inside a container value (bashTool.env,
  // mcpServers[].env) is a redaction event too -- flag it so the UI says so.
  if (hit) row.redacted = true;
  // Editor affordance (ALL the settings, owner ruling 2026-11-09): every
  // row the snapshot renders is stamped except the two honest refusals (see
  // the stamp section). The type/bounds ride as input hints; the write path
  // revalidates against the schema/file shape on every save.
  const rawSeed = fileValue !== undefined ? fileValue : resolvedValue;
  const stamp = stampFor({
    segs,
    prop,
    rawSeed,
    faithful: seedFaithful,
    addressable: ctx.addressable,
    dups: ctx.dups,
  });
  if (stamp) {
    row.edit = stamp;
    return [row];
  }
  // Class-A container refusal: the shipped payload redacts/stubs something
  // inside, so the whole-value editor would write the summary back. Surface
  // the immediate children per row instead (each judged on its own ship).
  // Class B (duplicated / unaddressable) stamps nothing -- children too.
  const rawSeedObj = rawSeed !== null && typeof rawSeed === "object" ? (rawSeed as Record<string, unknown> | unknown[]) : null;
  if (ctx.addressable && grammarSafe(segs) && !hasDuplicatePrefix(ctx.dups, segs) && rawSeedObj !== null) {
    return [row, ...childRows(segs, rawSeedObj, ctx, fileValue !== undefined ? "file" : "resolved", 1)];
  }
  return [row];
}

/**
 * Rows for the immediate children of a class-A refused container (env
 * entries, provider fields, array elements -- the shapes the refusal exists
 * to keep honest). Children keep the existing redaction shape (member
 * strings over 80 chars stay stubs, secret-shaped names null out); a
 * secret-shaped child gets the writeOnly REPLACE box, a faithful scalar gets
 * its runtime scalar type, a faithful container gets the JSON box, and a
 * child that is itself an unfaithful container recurses one more level
 * (depth-bounded).
 */
function childRows(
  segs: KeySeg[],
  container: Record<string, unknown> | unknown[],
  ctx: RowCtx,
  slot: "file" | "resolved",
  depth: number,
): ConfigKeyEntryWire[] {
  if (depth > 8) return [];
  const out: ConfigKeyEntryWire[] = [];
  const entries: Array<[KeySeg, unknown]> = Array.isArray(container)
    ? container.map((v, i) => [i, v] as [KeySeg, unknown])
    : Object.entries(container).map(([k, v]) => [k, v] as [KeySeg, unknown]);
  for (const [seg, v] of entries) {
    const childSegs = [...segs, seg];
    const childKey = keyString(childSegs);
    const secret = secretSegs(childSegs);
    const row: ConfigKeyEntryWire = { key: childKey };
    let faithful = false;
    if (secret) {
      row.leafSecret = true;
      row[slot] = null;
      if (isSet(v)) row.redacted = true;
    } else {
      const wv = wireValue(v, 1); // container-member shaping: prose stays stubbed
      row[slot] = wv.value;
      if (wv.hit) row.redacted = true;
      faithful = !wv.hit && !wv.lossy;
    }
    const stamp = stampFor({
      segs: childSegs,
      prop: null, // children of free-form containers are shape-validated, not schema-validated
      rawSeed: v,
      faithful,
      addressable: ctx.addressable,
      dups: ctx.dups,
    });
    if (stamp) {
      row.edit = stamp;
      out.push(row);
      continue;
    }
    out.push(row);
    const rawChild = v !== null && typeof v === "object" ? (v as Record<string, unknown> | unknown[]) : null;
    if (
      rawChild !== null &&
      !secret &&
      ctx.addressable &&
      grammarSafe(childSegs) &&
      !hasDuplicatePrefix(ctx.dups, childSegs)
    ) {
      out.push(...childRows(childSegs, rawChild, ctx, slot, depth + 1));
    }
  }
  return out;
}

/** The providers passthrough block FALLBACK (EXTRA_KNOWN_KEYS, not a schema
 *  entry): when the in-use file does NOT parse its providers array, the
 *  viewer still shows the startup-resolved block (url + model names + the
 *  redacted apiKey, one row triple per provider) -- name-keyed and honest
 *  about it. These rows are NOT editable: the file (the only write target)
 *  is unaddressable or holds no such array, so this is class B -- the hint
 *  says fix it in file. When the file DOES parse, the file walk below
 *  renders indexed (`providers[0].url`) editable rows instead. */
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

/**
 * Rows for everything the file holds that the schema walk did NOT cover --
 * unknown keys, EXTRA_KNOWN passthroughs (providers, services, cwdBoundary,
 * legacy spellings) and unknown members inside known objects. Same name-based
 * redaction rules; stamped editable (scalar / json by shape) except the two
 * refusals. Removed keys stay findings-only (a tombstone names the
 * replacement; the loader never reads them, so an editor for them would lie);
 * schema-covered LEAVES are skipped whole (their row, or the class-A child
 * rows, already own them), schema interiors are descended without a row.
 * A stamped container row owns its subtree (no per-member rows); a class-A
 * refused container surfaces child rows instead. Array elements address `[i]`.
 */
function collectFileRows(
  node: unknown,
  segs: KeySeg[],
  covered: Set<string>,
  interiors: Set<string>,
  ctx: RowCtx,
  depth: number,
  out: Array<{ segs: KeySeg[]; rows: ConfigKeyEntryWire[] }>,
): void {
  if (depth > 10) return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const childSegs = [...segs, k];
    const sp = spellPath(childSegs);
    if (covered.has(sp)) continue; // a schema row (or its class-A children) owns this path
    if (removedHit(k)) continue; // tombstone findings own removed keys; the loader ignores them
    if (interiors.has(sp)) {
      collectFileRows(v as Record<string, unknown>, childSegs, covered, interiors, ctx, depth + 1, out);
      continue; // known schema object: its own rows ride the schema walk
    }
    out.push({ segs: childSegs, rows: fileOnlyRows(childSegs, v, ctx, depth === 0 ? 0 : 1) });
  }
}

/** One file-only row (unknown / passthrough), plus class-A child rows when
 *  the container's shipped payload redacts or stubs something inside. */
function fileOnlyRows(segs: KeySeg[], v: unknown, ctx: RowCtx, wireDepth: number): ConfigKeyEntryWire[] {
  const row: ConfigKeyEntryWire = { key: keyString(segs) };
  const secret = secretSegs(segs);
  let faithful = false;
  if (secret) {
    row.leafSecret = true;
    row.file = null;
    if (isSet(v)) row.redacted = true;
  } else {
    const wv = wireValue(v, wireDepth);
    row.file = wv.value;
    if (wv.hit) row.redacted = true;
    faithful = !wv.hit && !wv.lossy;
  }
  const stamp = stampFor({
    segs,
    prop: null,
    rawSeed: v,
    faithful,
    addressable: ctx.addressable,
    dups: ctx.dups,
  });
  if (stamp) {
    row.edit = stamp;
    return [row];
  }
  const shape = shapeClass(v);
  if (
    (shape === "object" || shape === "array") &&
    !secret &&
    ctx.addressable &&
    grammarSafe(segs) &&
    !hasDuplicatePrefix(ctx.dups, segs)
  ) {
    return [row, ...childRows(segs, v as Record<string, unknown> | unknown[], ctx, "file", wireDepth)];
  }
  return [row];
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

  // Addressability (class-B refusal, shared by every row stamp): the locator
  // must be able to walk the in-use file's OWN bytes. A missing file is
  // addressable (the write path creates it); an un-walkable one stamps
  // nothing. The same member list yields the duplicated paths whose whole
  // subtree stays un-stamped.
  const located = report.status === "missing" ? null : locateJsonStructure(report.rawText);
  const dups = located ? collectDuplicatePaths(located.members) : new Set<string>();
  const addressable = report.status === "missing" || located !== null;

  const ctx: RowCtx = { fileConfig, core, argv, registryFlags, dups, addressable };

  // Schema leaves drive the row set; their paths (and interiors) also tell
  // the file walk what the schema already owns.
  const allLeaves: LeafEntry[] = [];
  for (const [topKey, topProp] of Object.entries(unified)) collectLeaves(topKey, topProp, allLeaves);
  const covered = new Set<string>();
  const interiors = new Set<string>();
  for (const leaf of allLeaves) {
    const segs = parseKeyPath(leaf.path);
    if (!segs) continue;
    covered.add(spellPath(segs));
    for (let d = 1; d < segs.length; d++) interiors.add(spellPath(segs.slice(0, d)));
  }

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
  const addRow = (sectionName: string, row: ConfigKeyEntryWire): boolean => {
    if (rowCount >= MAX_CONFIG_ROWS) {
      truncatedRows = true;
      return false;
    }
    sectionFor(sectionName).rows.push(row);
    rowCount++;
    return true;
  };
  const sectionNameOf = (topKey: string): string => (Object.hasOwn(CONFIG_SCHEMA, topKey) ? "core" : topKey);

  for (const leaf of allLeaves) {
    for (const row of buildRows(leaf, ctx)) {
      if (!addRow(sectionNameOf(leaf.path.split(".")[0]!), row)) break;
    }
  }

  // File-only rows: unknown keys, passthrough blocks (the providers array
  // edits as providers[0].url here), unknown members inside known objects.
  if (fileConfig) {
    const fileGroups: Array<{ segs: KeySeg[]; rows: ConfigKeyEntryWire[] }> = [];
    collectFileRows(fileConfig, [], covered, interiors, ctx, 0, fileGroups);
    for (const g of fileGroups) {
      const top = g.segs[0];
      const name = sectionNameOf(typeof top === "string" ? top : "");
      for (const row of g.rows) {
        if (!addRow(name, row)) break;
      }
    }
  }

  // Provider fallback: startup-resolved name-keyed rows, only when the file
  // does not itself carry the array (the file walk owns it when it does).
  // These rows are class-B (the write target has no such path): honest hint,
  // no affordance.
  if (!Array.isArray(fileConfig?.providers)) {
    for (const row of providerRows(core)) {
      if (!addRow("providers", row)) break;
    }
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

// ── Settings EDITOR (C2S setConfigKey → S2C setConfigKeyResult) ────────────
// Owner ruling (2026-11-09): ALL the settings are editable -- the whitelist
// is retired. The invariant moved from a constant list to the STAMP: every
// row the snapshot renders carries row.edit except the two honest refusals
// (class A: the shipped payload is a redacted/stubbed summary, never the
// bytes -- editing it would write stubs over real values; class B: the
// surgical locator cannot address the path -- duplicated key, un-walkable
// file, un-spellable key). Raw-JSON editing of the FILE is still REJECTED:
// the browser never sends a file, a path, or a blob -- only a config keyPath
// (dotted, with `[i]` array indices) and one value (scalar `value`, or
// `valueText` for JSON containers and writeOnly secret replaces).
//
// The write path, in order, each stage refusing before any byte moves:
// 1. PATH + CHANNEL: keyPath must parse (parseKeyPath); scalars ride
//    `value`, containers/secrets ride `valueText`. A writeOnly (secret-shaped)
//    path accepts ONLY a non-empty valueText ("no new value entered") -- and
//    its reply never carries the new or the old bytes (success echoes
//    value:null + redacted:true; the sentinel sweep covers write replies).
// 2. VALIDATION: where a schema leaf exists, the value is revalidated against
//    the RUNNING server's unified CONFIG_SCHEMA (type + declared bounds);
//    where none exists (unknown keys, providers, container children), the
//    CURRENT file value is the gate: scalars must keep their primitive kind,
//    containers must JSON.parse AND keep their shape class (object stays
//    object, array stays array). An unknown key absent from the file has
//    nothing to validate against -- refused (fail closed; the file remains
//    the interface, rescue rechecks it after every write).
// 3. SURGICAL JSONC EDIT: the single target value's byte range is located in
//    the file's ORIGINAL text and swapped; nothing else is re-emitted.
//    Comments, key order, indentation, blank lines, trailing commas are user
//    data and survive byte-identical -- for a CONTAINER splice the replaced
//    range is the whole value, so comments INSIDE that value legitimately go
//    with it (the value was replaced) while siblings' and the surrounding
//    comments survive untouched. Locating fails CLOSED on any ambiguity:
//    duplicate target, duplicate ancestor segment, a non-object ancestor
//    where the path needs one, or grammar the locator cannot follow (the
//    file must also pass rescue's usableText gate first).
// 4. ATOMIC WRITE + VERIFY: temp file in the same dir + rename (pin-store
//    idiom). After the rename the file is re-read, re-parsed, and the target
//    must resolve to exactly one occurrence carrying the value written (deep
//    JSON comparison for containers). Any post-write failure restores the
//    exact pre-write bytes (rollback) and reports ok:false -- the restore
//    itself is re-verified, so the reply never claims a restore over bytes a
//    cross-process writer moved in. The whole read->write->verify->rollback
//    chain holds a module-level in-process lock (concurrent saves compose
//    instead of interleaving, across every value kind).
// 5. HONESTY: success carries needsRestart:true -- config resolves at
//    startup, so the running server NEVER claims live effect.

const isEditScalarType = (t: unknown): t is "number" | "integer" | "boolean" | "string" =>
  t === "number" || t === "integer" || t === "boolean" || t === "string";

/** The schema property for a parsed keyPath in the unified schema. Null when
 *  the path is not a declared leaf (an array index is never one) -- the write
 *  path then falls back to the file shape as the validation gate.
 *  Keys resolve through normalizeKey, the SAME equivalence the locator
 *  (spellPath), fileRawValue and rescue use: "core-tools" === "coreTools".
 *  Byte-exact schema lookup here would let the alias spelling skip the
 *  declared type/bounds gate and write a value startup revalidation would
 *  then reject -- an ACKed save guaranteeing a dead daemon. */
function findLeafProp(unified: ConfigSchema, segs: KeySeg[]): SchemaProperty | null {
  if (segs.length === 0 || typeof segs[0] === "number") return null;
  const rootKey = Object.keys(unified).find((k) => normalizeKey(k) === normalizeKey(segs[0] as string));
  if (rootKey === undefined) return null;
  let prop: SchemaProperty | undefined = unified[rootKey];
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i]!;
    if (typeof s === "number") return null; // array element: below any schema leaf
    const hit = Object.keys(prop?.properties ?? {}).find((k) => normalizeKey(k) === normalizeKey(s));
    prop = hit !== undefined ? prop!.properties![hit] : undefined;
  }
  return prop ?? null;
}

type EditScalar = string | number | boolean;

/** Server-side validation against the schema's declared type + bounds. The
 *  error strings ride the reply and render verbatim -- they name the key and
 *  what it wanted, nothing else. */
function validateEditValue(type: string, value: unknown, prop: SchemaProperty, keyPath: string): string | null {
  switch (type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `invalid value for "${keyPath}": expected a number`;
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `invalid value for "${keyPath}": expected a whole number`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return `invalid value for "${keyPath}": expected true or false`;
      break;
    case "string":
      if (typeof value !== "string") return `invalid value for "${keyPath}": expected a string`;
      break;
    default:
      return `"${keyPath}" is not a scalar in the schema -- refusing to write`;
  }
  if (typeof value === "number") {
    if (prop.minimum !== undefined && value < prop.minimum) return `"${keyPath}" must be >= ${prop.minimum} (got ${value})`;
    if (prop.maximum !== undefined && value > prop.maximum) return `"${keyPath}" must be <= ${prop.maximum} (got ${value})`;
  }
  return null;
}

// ── The JSONC locator ───────────────────────────────────────────────────────

/**
 * Replace comments with SPACES (newlines intact) so every offset maps 1:1
 * back into the original text. stripJsonc() cannot be reused here: it
 * NORMALIZES (comment bytes vanish), which shifts every later offset.
 * Strings are walked untouched (their braces and slashes are content); a BOM
 * stays as-is, so the structure walk refuses such a file (fail closed --
 * `hotdog rescue fix` removes it).
 */
function maskComments(src: string): string {
  const n = src.length;
  const chars = src.split("");
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n) {
    const c = src[i]!;
    if (c === '"') {
      i++;
      while (i < n) {
        const s = src[i]!;
        if (s === "\\") {
          i += 2;
          continue;
        }
        i++;
        if (s === '"') break;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") {
        chars[i] = " ";
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") chars[i] = " ";
        i++;
      }
      if (i < n) {
        chars[i] = " ";
        i++;
        if (i < n) {
          chars[i] = " ";
          i++;
        }
      }
      continue;
    }
    i++;
  }
  return chars.join("");
}

interface EditObjectNode {
  open: number;
  close: number;
  /** First member's key-token start (-1 while no member parsed). */
  firstKeyStart: number;
  /** End of the last member's value token (the safe insertion point: a
   *  trailing comma, when the user wrote one, becomes the separator and
   *  stays exactly one trailing comma). */
  lastValueEnd: number;
  memberCount: number;
}

interface EditMember {
  /** The member's full path: object keys plus the `[i]` indices of every
   *  ARRAY the member sits in (providers[0].url addresses the same range
   *  the editor's rows show -- array elements are addressable, unlike the
   *  pre-all-fields days where they were detached and invisible). */
  segs: KeySeg[];
  valueStart: number;
  valueEnd: number;
  /** The value's object node when the value is an object (null otherwise). */
  object: EditObjectNode | null;
}

/**
 * Walk the (comment-masked) text and record every object member with its
 * key segments and value range, plus the geometry of every object. Grammar
 * strictness mirrors JSON with one JSONC grace (a trailing comma before a
 * closing brace), because rescue calls such files fixable and their users
 * deserve an editor that keeps their style. Anything the walk cannot follow
 * returns null -- never a partial answer.
 */
function locateJsonStructure(text: string): { members: EditMember[]; root: EditObjectNode } | null {
  const t = maskComments(text);
  const n = t.length;
  const members: EditMember[] = [];
  let i = 0;
  const ws = () => {
    while (i < n && (t[i] === " " || t[i] === "\t" || t[i] === "\n" || t[i] === "\r")) i++;
  };

  const parseString = (): { value: string; start: number; end: number } | null => {
    if (t[i] !== '"') return null;
    const start = i;
    i++;
    while (i < n) {
      const c = t[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        try {
          const value = JSON.parse(text.slice(start, i)) as unknown;
          return typeof value === "string" ? { value, start, end: i } : null;
        } catch {
          return null;
        }
      }
      i++;
    }
    return null;
  };

  const parseLiteral = (): boolean => {
    const num = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(t.slice(i));
    if (num && num[0].length > 0) {
      i += num[0].length;
      return true;
    }
    for (const lit of ["true", "false", "null"]) {
      if (t.startsWith(lit, i)) {
        i += lit.length;
        return true;
      }
    }
    return false;
  };

  function parseValue(
    segs: KeySeg[],
    depth: number,
  ): { start: number; end: number; object: EditObjectNode | null } | null {
    ws();
    if (depth > 256) return null; // config files nest in the tens; deeper is a hostile guess
    const start = i;
    const c = t[i];
    if (c === "{") return parseObject(segs, depth + 1);
    if (c === "[") return parseArray(segs, depth + 1);
    if (c === '"') {
      const s = parseString();
      return s ? { start, end: s.end, object: null } : null;
    }
    return parseLiteral() ? { start, end: i, object: null } : null;
  }

  function parseArray(segs: KeySeg[], depth: number): { start: number; end: number; object: null } | null {
    const start = i;
    i++; // [
    ws();
    if (t[i] === "]") {
      i++;
      return { start, end: i, object: null };
    }
    let index = 0;
    for (;;) {
      // Elements are ADDRESSABLE by index: an element object's members carry
      // the `[i]` segment (providers[0].url), exactly like the row keys.
      const v = parseValue([...segs, index], depth);
      if (!v) return null;
      members.push({ segs: [...segs, index], valueStart: v.start, valueEnd: v.end, object: v.object });
      index++;
      ws();
      if (t[i] === ",") {
        i++;
        ws();
        if (t[i] === "]") {
          i++; // trailing comma (JSONC grace)
          return { start, end: i, object: null };
        }
        continue;
      }
      if (t[i] === "]") {
        i++;
        return { start, end: i, object: null };
      }
      return null;
    }
  }

  function parseObject(
    segs: KeySeg[],
    depth: number,
  ): { start: number; end: number; object: EditObjectNode } | null {
    const node: EditObjectNode = { open: i, close: -1, firstKeyStart: -1, lastValueEnd: -1, memberCount: 0 };
    const start = i;
    i++; // {
    ws();
    if (t[i] === "}") {
      node.close = i;
      i++;
      return { start, end: i, object: node };
    }
    for (;;) {
      ws();
      const key = parseString();
      if (!key) return null;
      if (node.firstKeyStart < 0) node.firstKeyStart = key.start;
      ws();
      if (t[i] !== ":") return null;
      i++;
      const memberSegs: KeySeg[] = [...segs, key.value];
      const v = parseValue(memberSegs, depth + 1);
      if (!v) return null;
      node.memberCount++;
      node.lastValueEnd = v.end;
      members.push({ segs: memberSegs, valueStart: v.start, valueEnd: v.end, object: v.object });
      ws();
      if (t[i] === ",") {
        i++;
        ws();
        if (t[i] === "}") {
          node.close = i;
          i++; // trailing comma (JSONC grace)
          return { start, end: i, object: node };
        }
        continue;
      }
      if (t[i] === "}") {
        node.close = i;
        i++;
        return { start, end: i, object: node };
      }
      return null;
    }
  }

  ws();
  if (t[i] !== "{") return null; // a config file is an object
  const root = parseObject([], 0);
  if (!root) return null;
  ws();
  if (i < n) return null; // trailing garbage after the root object
  return { members, root: root.object };
}

/** `"a": { "b": { "c": V } }` at column `indent` (or the multi-line
 *  equivalent, one nesting per two spaces). An INDEX segment (creation
 *  through an absent array, "providers[0].url" with no file block) wraps the
 *  rest in `[ ... ]` inline -- synthetic shape, no user formatting to
 *  borrow; the comment-run logic below only exists for real objects. */
function buildChainText(segs: KeySeg[], valueJson: string, indent: string, multiline: boolean): string {
  const head = segs[0]!;
  if (typeof head === "number") {
    if (segs.length === 1) return `[ ${valueJson} ]`;
    return `[ ${buildChainText(segs.slice(1), valueJson, indent, multiline)} ]`;
  }
  const headText = JSON.stringify(head);
  if (segs.length === 1) return `${headText}: ${valueJson}`;
  const childIndent = multiline ? indent + "  " : indent;
  const rest = buildChainText(segs.slice(1), valueJson, childIndent, multiline);
  return multiline ? `${headText}: {\n${childIndent}${rest}\n${indent}}` : `${headText}: { ${rest} }`;
}

type ConfigTextEdit =
  | { ok: true; newText: string }
  | { ok: false; reason: "unparseable" | "duplicate" | "ancestor" | "empty"; conflict?: string };

/** Produce the full file text with ONE path's value set to `newValueText`
 *  (replace in place, or insert at the right depth with formatting borrowed
 *  from the object). `newValueText` is already-validated JSON text: the
 *  scalar JSON, the accepted container text verbatim, or the secret's JSON
 *  string. A replace swaps the WHOLE value range -- interior comments of the
 *  replaced value legitimately go with it (the value was replaced), while
 *  sibling members' and the surrounding comments stay byte-identical. */
function editConfigText(text: string, segs: KeySeg[], newValueText: string): ConfigTextEdit {
  if (text.trim() === "") return { ok: false, reason: "empty" };
  const located = locateJsonStructure(text);
  if (!located) return { ok: false, reason: "unparseable" };

  // Count members along the target's own path (prefixes only -- siblings and
  // deeper paths cannot collide with this write). spellPath normalizes keys
  // the rescue way and keeps indices exact, so providers[0] and providers[1]
  // are distinct addresses while a kebab duplicate of a key is not.
  const prefixCounts: number[] = new Array(segs.length).fill(0);
  let target: EditMember | null = null;
  for (const m of located.members) {
    if (m.segs.length > segs.length) continue;
    if (spellPath(m.segs) !== spellPath(segs.slice(0, m.segs.length))) continue;
    prefixCounts[m.segs.length - 1] = (prefixCounts[m.segs.length - 1] ?? 0) + 1;
    if (m.segs.length === segs.length) target = m;
  }
  // A duplicate ANYWHERE on the path is ambiguous: which occurrence would the
  // loader (or this edit) mean? rescue names duplicates; we refuse them.
  for (let d = segs.length; d >= 1; d--) {
    if (prefixCounts[d - 1]! > 1) {
      return { ok: false, reason: "duplicate", conflict: keyString(segs.slice(0, d)) };
    }
  }

  if (target) {
    return { ok: true, newText: text.slice(0, target.valueStart) + newValueText + text.slice(target.valueEnd) };
  }

  // Absent: find the deepest EXISTING ancestor on the path.
  let node: EditObjectNode = located.root;
  let create: KeySeg[] = segs;
  for (let d = segs.length - 1; d >= 0; d--) {
    const ancestorSpelled = spellPath(segs.slice(0, d));
    const hit = located.members.find((m) => m.segs.length === d && spellPath(m.segs) === ancestorSpelled);
    if (!hit) continue;
    if (!hit.object) return { ok: false, reason: "ancestor", conflict: keyString(segs.slice(0, d)) };
    node = hit.object;
    create = segs.slice(d);
    break;
  }

  // Formatting borrowed from the object we insert into (or the open line for
  // an empty one); an object whose members share its line stays inline.
  const indentAt = (pos: number): string => {
    const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
    return /^[ \t]*/.exec(text.slice(lineStart))![0]!;
  };
  const multiline =
    node.firstKeyStart >= 0
      ? text.slice(node.firstKeyStart, node.close).includes("\n")
      : text.slice(node.open + 1, node.close).includes("\n");
  const childIndent = node.firstKeyStart >= 0 ? indentAt(node.firstKeyStart) : indentAt(node.open) + "  ";
  const chain = buildChainText(create, newValueText, childIndent, multiline);

  if (node.memberCount === 0) {
    // No comma to hang off: place the member before the closing brace (an
    // interior comment line rides untouched, above the new key).
    return { ok: true, newText: text.slice(0, node.close) + (multiline ? childIndent + chain : chain) + text.slice(node.close) };
  }
  // A comment sitting on the last member's value line belongs to THAT member:
  // inserting at lastValueEnd would strand it behind the new key (its
  // "200 // page size" describing readToolLimit would land on grepMaxResults).
  // So advance the insertion point past a comment run contiguous with the
  // value (across whitespace and one existing comma), and hang the separator
  // comma on the value token instead. With no comment in the gap the old
  // geometry stands untouched: an existing trailing comma still becomes the
  // single trailing comma behind the new member.
  let p = node.lastValueEnd;
  let sawComma = false;
  let sawComment = false;
  run: while (p < node.close) {
    while (p < node.close && (text[p] === " " || text[p] === "\t")) p++;
    if (text[p] === "/" && (text[p + 1] === "/" || text[p + 1] === "*")) {
      sawComment = true;
      if (text[p + 1] === "/") {
        while (p < node.close && text[p] !== "\n") p++;
      } else {
        p += 2;
        while (p < node.close && !(text[p] === "*" && text[p + 1] === "/")) p++;
        p += 2;
      }
      continue run;
    }
    if (!sawComma && text[p] === ",") {
      sawComma = true;
      p++;
      continue run;
    }
    break;
  }
  if (!sawComment) {
    return { ok: true, newText: text.slice(0, node.lastValueEnd) + "," + (multiline ? "\n" + childIndent : " ") + chain + text.slice(node.lastValueEnd) };
  }
  // head: reuse the member's own trailing comma when it wrote one; else the
  // separator comma lands directly on the value token, before its comment.
  const head = sawComma ? "" : ",";
  const sep = multiline ? "\n" + childIndent : " ";
  return {
    ok: true,
    newText: text.slice(0, node.lastValueEnd) + head + text.slice(node.lastValueEnd, p) + sep + chain + text.slice(p),
  };
}

/** Post-write read-back: the file must parse (raw or JSONC-repaired), the
 *  target path must resolve to EXACTLY one occurrence, and its value must
 *  deep-equal what we wrote (canonical JSON comparison: containers match
 *  through member order and key spelling as parsed). Anything else trips
 *  the rollback. */
function verifyEdit(text: string, segs: KeySeg[], canonicalValue: unknown): boolean {
  let parses = false;
  try {
    JSON.parse(text);
    parses = true;
  } catch {
    try {
      JSON.parse(stripJsonc(text).text);
      parses = true;
    } catch {
      parses = false;
    }
  }
  if (!parses) return false;
  const located = locateJsonStructure(text);
  if (!located) return false;
  const want = spellPath(segs);
  let hit: EditMember | null = null;
  for (const m of located.members) {
    if (spellPath(m.segs) !== want) continue;
    if (hit) return false; // the write must not have created an ambiguity
    hit = m;
  }
  if (!hit) return false;
  const range = text.slice(hit.valueStart, hit.valueEnd);
  let got: unknown;
  try {
    got = JSON.parse(range);
  } catch {
    try {
      got = JSON.parse(stripJsonc(range).text); // the replaced value may carry JSONC-isms around the splice
    } catch {
      return false;
    }
  }
  try {
    return JSON.stringify(got) === JSON.stringify(canonicalValue);
  } catch {
    return false;
  }
}

/** The fs surface the write path uses, injectable for the rollback test (no
 *  mock.module in this repo). Production always gets the real promises fs. */
export interface ConfigEditDeps {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
}

const realConfigEditDeps: ConfigEditDeps = {
  readFile: (p) => fs.readFile(p, "utf-8"),
  writeFile: (p, data) => fs.writeFile(p, data, "utf-8"),
  rename: (from, to) => fs.rename(from, to),
  unlink: (p) => fs.unlink(p),
};

export type ConfigKeyEditOutcome =
  | { ok: true; needsRestart: true; value?: EditScalar | null; valueText?: string; redacted?: true }
  | { ok: false; error: string };

/** What the write path receives from the frame: scalars ride `value`;
 *  JSON containers and writeOnly secret replaces ride `valueText`. */
export interface ConfigKeyEditInput {
  value?: unknown;
  valueText?: unknown;
}

/** Unique-per-writer temp name (pin-store idiom: sibling processes never
 *  truncate each other's in-flight file; the in-process counter keeps two
 *  concurrent edits from sharing one). */
let configEditSeq = 0;

/** In-process promise mutex: the whole read->splice->verify->(rollback)
 *  chain runs ONE at a time (FIFO by arrival), so two concurrent
 *  setConfigKey calls cannot interleave -- unserialized, the loser's
 *  rollback restored its own stale pre-write bytes over the winner's ACKED
 *  value. The lock also keeps the temp-name contract honest: only one chain
 *  is ever mid-write. CROSS-PROCESS writers (a second daemon, rescue, an
 *  editor saving the same file) stay OUTSIDE any lock this module can hold;
 *  the post-write verify and the rollback re-verify below are what bound
 *  them. */
let configEditTail: Promise<unknown> = Promise.resolve();

function withConfigEditLock<T>(task: () => Promise<T>): Promise<T> {
  const run = configEditTail.then(task, task);
  // The chain survives its task failing (enqueuePrompt idiom): the NEXT edit
  // must not inherit a rejected tail -- its own errors are its own.
  configEditTail = run.catch(() => {});
  return run;
}

/** Serialized entry point: see withConfigEditLock. Exported for tests. */
export function applyConfigKeyEdit(
  core: CoreContext,
  keyPath: string,
  input: ConfigKeyEditInput,
  opts: { argv?: string[]; deps?: ConfigEditDeps } = {},
): Promise<ConfigKeyEditOutcome> {
  return withConfigEditLock(() => applyConfigKeyEditLocked(core, keyPath, input, opts));
}

/** Read the raw value the PARSED in-use file holds at segs (normalized-key
 *  walking, exactly like the load pipeline sees it). The shape gate's
 *  reference: what is there now decides what may be written. */
function fileRawValue(parsed: unknown, segs: KeySeg[]): { found: boolean; value: unknown } {
  let cur: unknown = parsed;
  for (const s of segs) {
    if (typeof s === "number") {
      if (!Array.isArray(cur) || s >= cur.length) return { found: false, value: undefined };
      cur = cur[s];
    } else {
      if (!cur || typeof cur !== "object" || Array.isArray(cur)) return { found: false, value: undefined };
      const hitKey = Object.keys(cur as object).find((k) => normalizeKey(k) === normalizeKey(s));
      if (hitKey === undefined) return { found: false, value: undefined };
      cur = (cur as Record<string, unknown>)[hitKey];
    }
  }
  return { found: true, value: cur };
}

const shapeWord = (s: "object" | "array" | "null" | "scalar"): string =>
  s === "array" ? "an array" : s === "null" ? "null" : s === "scalar" ? "a different scalar" : "an object";

/**
 * The whole edit, from keyPath to persisted byte. Only ever touches the ONE
 * resolved config file path (the snapshot's in-use path: explicit --config/-f
 * on the live argv, else <configDir>/defaults.json). Runs under the
 * module-level edit lock; never call it outside withConfigEditLock.
 */
async function applyConfigKeyEditLocked(
  core: CoreContext,
  keyPath: string,
  input: ConfigKeyEditInput,
  opts: { argv?: string[]; deps?: ConfigEditDeps } = {},
): Promise<ConfigKeyEditOutcome> {
  const deps = opts.deps ?? realConfigEditDeps;
  const argv = opts.argv ?? process.argv;
  const configDir = (typeof core.resolved?.configDir === "string" && core.resolved.configDir) || resolveConfigDir();
  const filePath = inUseConfigPath(argv, configDir);
  const refusal = `edit in file: ${filePath} (hotdog rescue validates it)`;

  // 1. Path grammar + writeOnly channel. The browser spells config paths,
  //    never filesystem paths; `providers[0].url` is as addressable as
  //    webui.port. A secret-shaped path accepts ONLY a non-empty valueText:
  //    the box REPLACES sight-unseen, and nothing may echo the bytes (the
  //    outcome below carries value:null + redacted:true, never the text).
  const segs = parseKeyPath(keyPath);
  if (!segs || segs.length === 0) {
    return { ok: false, error: `"${keyPath}" is not an addressable config path -- ${refusal}` };
  }
  const scalar = input.value;
  const text = input.valueText;
  const hasScalar = typeof scalar === "string" || typeof scalar === "number" || typeof scalar === "boolean";
  const hasText = typeof text === "string";
  if (hasScalar && hasText) {
    // The channels are exclusive: a frame carrying both has no honest
    // "the client meant X" to fall back on. Refuse it at the gate.
    return { ok: false, error: `"${keyPath}" frame carries both value and valueText -- send exactly one` };
  }
  const secret = secretSegs(segs);
  if (secret && (!hasText || (text as string) === "")) {
    return { ok: false, error: `refusing to write "${keyPath}": no new value entered` };
  }

  // 2. Read the file (the one write target) and gate on rescue's verdict.
  const report = await diagnoseConfigFile(filePath);
  const hadFile = report.status !== "missing";
  if (hadFile && report.parsedText === null) {
    return { ok: false, error: `config file does not parse -- refusing to write; run "hotdog rescue" (${refusal})` };
  }

  // 3. What the file holds there now (the shape/kind gate for file-only and
  //    schema-container paths; JSON.parse makes a duplicate's later value win,
  //    which editConfigText's duplicate refusal then refuses outright).
  let parsedFile: unknown;
  try {
    parsedFile = report.parsedText === null ? undefined : JSON.parse(report.parsedText);
  } catch {
    parsedFile = undefined;
  }
  const cur = parsedFile === undefined ? { found: false, value: undefined } : fileRawValue(parsedFile, segs);
  const fileShape = cur.found ? shapeClass(cur.value) : undefined;

  // 4. Kind resolution + validation -> newValueText + canonical + echo.
  const prop = findLeafProp(unifiedSchemaFor(core), segs);
  const schemaKind =
    prop && (!prop.properties || Object.keys(prop.properties).length === 0)
      ? prop.type === "array"
        ? "array"
        : prop.type === "object"
          ? "object"
          : isEditScalarType(prop.type)
            ? "scalar"
            : undefined
      : undefined;

  if (schemaKind !== undefined && fileShape !== undefined) {
    const shapeOk =
      (schemaKind === "scalar" && fileShape === "scalar") ||
      ((schemaKind === "object" || schemaKind === "array") && schemaKind === fileShape);
    if (!shapeOk) {
      return {
        ok: false,
        error: `"${keyPath}" holds ${shapeWord(fileShape)} in the file but the schema declares a ${schemaKind} -- refusing to re-shape it (${refusal})`,
      };
    }
  }

  // REFUSAL A ENFORCED AT THE GATE, not merely hidden in the UI: a wholesale
  // CONTAINER write whose CURRENT value ships summarized (secret entries
  // nulled, long strings stubbed, URL userinfo scrubbed inside) would splice
  // that summary over the user's real bytes. The gate is the SAME predicate
  // that withheld the stamp (shipFaithful / wireValue hit+lossy): every row
  // the snapshot stamps accepts a write; a scripted or buggy client replaying
  // the shipped stub gets an honest refusal with zero file change. The
  // secrets themselves stay editable WHERE the doctrine put them: their own
  // per-row REPLACE boxes (children of the refused container).
  const containerTarget =
    schemaKind === "object" ||
    schemaKind === "array" ||
    (cur.found && (fileShape === "object" || fileShape === "array"));
  if (!secret && cur.found && containerTarget && !shipFaithful(cur.value)) {
    return {
      ok: false,
      error: `"${keyPath}" holds values the snapshot redacts or summarizes inside -- refusing to write a summary over the real bytes; edit its fields on their own rows (${refusal})`,
    };
  }

  let newValueText: string;
  let canonical: unknown;
  let echo: { value?: EditScalar | null; valueText?: string; redacted?: true };

  if (secret) {
    // The writeOnly REPLACE: a JSON string in whatever slot the path holds.
    // An unknown secret absent from the file on a server with no schema for
    // it has nothing to validate against -- fail closed like any unknown.
    if (!prop && !cur.found) {
      return {
        ok: false,
        error: `no schema entry for "${keyPath}" on this server and no value in the file -- refusing to write (${refusal})`,
      };
    }
    const newSecret = text as string;
    newValueText = JSON.stringify(newSecret);
    canonical = newSecret;
    echo = { value: null, redacted: true }; // NEVER the bytes -- new or old
  } else if (schemaKind === "scalar") {
    if (!hasScalar) {
      return { ok: false, error: "value must be a string, number, or boolean" };
    }
    const invalid = validateEditValue(prop!.type as string, scalar, prop!, keyPath);
    if (invalid) return { ok: false, error: invalid };
    newValueText = JSON.stringify(scalar);
    canonical = scalar;
    echo = { value: scalar as EditScalar };
  } else if (schemaKind === "object" || schemaKind === "array") {
    if (!hasText) {
      return { ok: false, error: `"${keyPath}" is a ${schemaKind} -- send the new value as JSON text (valueText)` };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text as string);
    } catch (err) {
      return { ok: false, error: `"${keyPath}": invalid JSON -- ${errorText(err)}` };
    }
    if (shapeClass(parsedJson) !== schemaKind) {
      return {
        ok: false,
        error: `"${keyPath}" must stay ${shapeWord(schemaKind)} -- the new JSON is ${shapeWord(shapeClass(parsedJson) ?? "null")}`,
      };
    }
    newValueText = text as string; // user formatting survives inside the replaced range
    canonical = parsedJson;
    echo = { valueText: text as string };
  } else if (cur.found && (fileShape === "object" || fileShape === "array")) {
    // File-only container (unknown key, providers element, env map...): the
    // file shape is the gate -- parse + same shape class.
    if (!hasText) {
      return { ok: false, error: `"${keyPath}" is a ${fileShape} -- send the new value as JSON text (valueText)` };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text as string);
    } catch (err) {
      return { ok: false, error: `"${keyPath}": invalid JSON -- ${errorText(err)}` };
    }
    if (shapeClass(parsedJson) !== fileShape) {
      return {
        ok: false,
        error: `"${keyPath}" must stay ${shapeWord(fileShape)} -- the new JSON is ${shapeWord(shapeClass(parsedJson) ?? "null")}`,
      };
    }
    newValueText = text as string;
    canonical = parsedJson;
    echo = { valueText: text as string };
  } else if (cur.found && fileShape === "scalar") {
    // File-only scalar (unknown key, env entry): validate by the channel's
    // scalar-ness + primitive-kind agreement with what the file holds.
    if (!hasScalar) {
      return { ok: false, error: "value must be a string, number, or boolean" };
    }
    if (typeof scalar !== typeof cur.value) {
      return {
        ok: false,
        error: `"${keyPath}" holds a ${typeof cur.value} in the file -- the new value must be a ${typeof cur.value}`,
      };
    }
    newValueText = JSON.stringify(scalar);
    canonical = scalar;
    echo = { value: scalar as EditScalar };
  } else {
    // Nothing to validate against: no schema leaf on this server and no
    // value in the file (or a null the editor cannot take a shape from).
    // Fail closed -- the file (hotdog rescue) stays the interface.
    return {
      ok: false,
      error:
        fileShape === "null"
          ? `"${keyPath}" holds null in the file -- the editor has no shape to hold (${refusal})`
          : `no schema entry for "${keyPath}" on this server and no value in the file -- refusing to write (${refusal})`,
    };
  }

  // 5. Locate + swap (or insert) in the ORIGINAL bytes. A replace swaps the
  //    WHOLE value range: for containers that is where the value's interior
  //    comments legitimately go with it (the value was replaced) while
  //    sibling members' and the surrounding comments survive byte-identical.
  let newText: string;
  if (!hadFile) {
    newText = `{\n  ${buildChainText(segs, newValueText, "  ", true)}\n}\n`;
  } else {
    const edit = editConfigText(report.rawText, segs, newValueText);
    if (!edit.ok) {
      if (edit.reason === "duplicate") {
        return {
          ok: false,
          error: `ambiguous target: "${edit.conflict ?? keyPath}" appears more than once -- refusing to guess which one (hotdog rescue names every duplicate; ${refusal})`,
        };
      }
      if (edit.reason === "ancestor") {
        return { ok: false, error: `"${edit.conflict ?? keyPath}" is not an object in the file -- refusing to re-shape it (${refusal})` };
      }
      if (edit.reason === "empty") {
        return { ok: false, error: `config file is empty -- refusing to guess its shape (hotdog rescue validates it)` };
      }
      return { ok: false, error: `config file does not parse -- refusing to write; run "hotdog rescue" (${refusal})` };
    }
    newText = edit.newText;
  }

  // 6. Atomic write (temp + rename in the same directory).
  const tmp = `${filePath}.${process.pid}.${++configEditSeq}.cfg-edit.tmp`;
  try {
    await deps.writeFile(tmp, newText);
    await deps.rename(tmp, filePath);
  } catch (err) {
    try {
      await deps.unlink(tmp);
    } catch {}
    return { ok: false, error: `could not write ${filePath}: ${errorText(err)}` };
  }

  // 7. Post-write verification, then rollback-on-any-doubt.
  let verifyErr: string | null = null;
  try {
    const after = await deps.readFile(filePath);
    if (!verifyEdit(after, segs, canonical)) verifyErr = "post-write verification failed";
  } catch (err) {
    verifyErr = `post-write read failed: ${errorText(err)}`;
  }
  // Success echoes per kind: the scalar, the accepted JSON text, or -- for a
  // writeOnly secret -- value:null + redacted:true (never the bytes).
  if (!verifyErr) return { ok: true, needsRestart: true, ...echo };

  const tmpBack = `${filePath}.${process.pid}.${++configEditSeq}.cfg-edit.tmp`;
  try {
    if (hadFile) {
      await deps.writeFile(tmpBack, report.rawText);
      await deps.rename(tmpBack, filePath);
    } else {
      await deps.unlink(filePath); // the file did not exist before; un-create it
    }
  } catch (err) {
    try {
      await deps.unlink(tmpBack);
    } catch {}
    logger.error(`[websocket] setConfigKey ${verifyErr} AND the rollback of ${filePath} failed: ${formatError(err)}`);
    return { ok: false, error: `${verifyErr}; ROLLBACK FAILED -- restore ${filePath} by hand (hotdog rescue validates it)` };
  }
  // Re-verify the restore before claiming it. The module lock serializes
  // in-process writers, but a CROSS-PROCESS one can land its bytes after our
  // rollback rename -- and then "the previous file was restored" would be a
  // lie written over someone else's ACKED value. Report what actually holds.
  let holdsOurBytes = false;
  try {
    holdsOurBytes = hadFile ? (await deps.readFile(filePath)) === report.rawText : false;
  } catch {
    holdsOurBytes = !hadFile; // the created file is gone again: the un-create landed
  }
  if (holdsOurBytes) return { ok: false, error: `${verifyErr}; the previous file was restored (${refusal})` };
  return {
    ok: false,
    error: `${verifyErr}; a concurrent edit won -- the file no longer holds its pre-write bytes; review ${filePath} before retrying (${refusal})`,
  };
}

export async function handleConfigKeySet(ctx: RouteContext): Promise<void> {
  const { ws, msg, core } = ctx;
  const requestId = typeof msg.requestId === "number" ? msg.requestId : undefined;
  const keyPath = msg.keyPath;
  const value = msg.value;
  const valueText = msg.valueText;
  // Frame-shape gate before anything else: keyPath is a config key string and
  // the payload is ONE scalar (`value`) or ONE raw JSON/secret text
  // (`valueText`) -- never both channels' garbage, never an object. (There is
  // no path field to reject -- none exists.)
  const scalarOk = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  const textOk = typeof valueText === "string";
  if (typeof keyPath !== "string" || keyPath === "" || (!scalarOk && !textOk)) {
    SessionRegistry.sendSafe(ws, {
      type: S2C.SET_CONFIG_KEY_RESULT,
      requestId,
      ok: false,
      error: "setConfigKey needs keyPath (string) and value (string | number | boolean) or valueText (string)",
    });
    return;
  }
  // Awaited for the settle contract: this writes (and re-reads) a file.
  await applyConfigKeyEdit(core, keyPath, { value, valueText })
    .then((result) => {
      SessionRegistry.sendSafe(ws, { ...result, type: S2C.SET_CONFIG_KEY_RESULT, requestId });
    })
    .catch((err: unknown) => {
      // Stacks stay server-side (formatError for the log); the wire carries
      // the wire-safe message the client renders verbatim.
      logger.warn(`[websocket] setConfigKey failed: ${formatError(err)}`);
      SessionRegistry.sendSafe(ws, { type: S2C.SET_CONFIG_KEY_RESULT, requestId, ok: false, error: errorText(err) });
    });
}
