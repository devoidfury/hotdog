// Config snapshot for the webui settings VIEWER (C2S configSnapshot ->
// S2C configSnapshotResult). Computed LIVE per request (the config may have
// changed on disk since startup; the viewer's honest framing is a
// live-at-open read -- every open re-reads the file, but there is no push
// feed, so staleness only ends at the next open/Refresh, never mid-visit).
// The bottom of this file adds the
// settings EDITOR (C2S setConfigKey -> S2C setConfigKeyResult): the file's
// one write path -- editability for EVERY SETTING THE CONFIG FILE CAN AFFECT
// (owner ruling 2026-11-09 "it needs to be ALL the settings", scoped honestly
// 2026-11-11: a schema leaf whose declared layers never read the file -- the
// CLI-only and default-only keys -- is not a setting the panel can write, so it
// ships no row and its write is refused), gated by the two honest refusals +
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
import { normalizeConfigKeys, type CliArgv } from "@core/config/index.ts";
import { resolveConfigDir, DEFAULT_CONFIG_FILENAME } from "@core/config/defaults.ts";
import { diffChanged, type ConfigGeneration, type ConfigStore } from "@core/config/store.ts";
import { configAuditNotice } from "@core/config/audit.ts";
import { reresolveConfig } from "@core/config/reresolve.ts";
import {
  canonEqual,
  hooksForPhase,
  runConfigApplyHook,
  type ApplyHookRunReport,
  type ConfigApplyContext,
} from "@core/config/apply-hooks.ts";
import { suggestCandidates } from "@utils/strings.ts";
import { compileApprovalRules, type ResolvedUserGateConfig } from "@utils/approvals/rules.ts";
import { getNested } from "@utils/objects.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { PROVIDER_DEF_FIELDS, providerDefField, type ProviderDef } from "@core/config/providers.ts";
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
  type ConfigListOp,
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

/** Depth-aware tombstone match: a topLevelOnly entry judges its ROOT occurrence
 *  only -- temperature's replacement is providers[].temperature, so nested
 *  fields of the surviving class stay themselves. */
const removedHitAt = (key: string, depth: number) =>
  REMOVED_KEYS.find((r) => normalizeKey(r.key) === normalizeKey(key) && (!r.topLevelOnly || depth === 1));

/** The write-gate tombstone refusal, shared by both write gates (the rescue /
 *  snapshot verdict already owns the file side; the gate must not contradict it
 *  by adding dead bytes). Matches a path SEGMENT: non-topLevelOnly tombstones
 *  judge at any nesting (bashTool.maxToolOutputLines), topLevelOnly ones judge
 *  the ROOT path only (providers[0].temperature keeps writing -- it is the
 *  replacement). No restart hint: a reboot would not make these bytes mean
 *  anything. */
function removedKeyRefusal(keyPath: string, segs: KeySeg[]): string | null {
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (typeof seg !== "string") continue;
    const r = removedHitAt(seg, i + 1);
    if (r) {
      return (
        `"${keyPath}" is a removed key -- no longer read; replaced by "${r.replacement}"` +
        `${r.note ? ` (${r.note})` : ""}; refusing to write dead bytes`
      );
    }
  }
  return null;
}

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
 *  else (scalars, arrays, free-form maps like bashTool.env) is its own row.
 *  Config-file-unreachable leaves are STILL collected here (they own their
 *  path in `covered`, so a stale file byte for one stays silent instead of
 *  surfacing as a file-only row); the row-emission loop is what drops them. */
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

/** THE shared config-file-reachability predicate (owner ruling 2026-11-11).
 *  resolveKey walks ONLY the declared layers chain, so a leaf that declares
 *  layers but none of them reads the settings file can never be affected by
 *  one: a cli-only key resolves from its flag and a default-only key never
 *  moves at all -- writing either lands dead bytes. Such leaves ship no row
 *  and accept no write, in core and in every extension section, unconditionally
 *  (a flag present in argv does not resurrect the row: the cli-slot
 *  attestation retires with it). Leaves declaring NO layers stay visible --
 *  they inherit resolution from their parent section's config layer. Consulted
 *  by the row-emission loop AND both write gates. */
export function notFileResolvable(prop: SchemaProperty | null | undefined): boolean {
  const layers = prop?.layers;
  return layers !== undefined && layers.length > 0 && !layers.some((l) => l.source === "config");
}

/** Honest refusal for one of those keys, shipped by both write gates. It names
 *  the source that actually decides the value -- the declared flag for a cli
 *  layer (the property's own cliFlag, else the registry's flag table: the same
 *  table the row builder consults) -- and says plainly that the file entry
 *  would be ignored. No needsRestart, no restart hint: a reboot would not make
 *  the bytes mean anything. */
function notSettableFromFileDialog(keyPath: string, prop: SchemaProperty, core: CoreContext): string {
  if ((prop.layers ?? []).some((l) => l.source === "cli")) {
    const flag =
      prop.cliFlag?.long ??
      (core.configRegistry?.getCliFlags?.() ?? []).find((f) => normalizeKey(f.key ?? "") === normalizeKey(keyPath))?.long;
    return `"${keyPath}" is not settable from the config file -- it resolves from ${flag ?? "the command line"}; a settings.json entry would be ignored`;
  }
  return `"${keyPath}" is not resolvable from the config file; the entry would be ignored`;
}

/** The write-side form of the ship filter, shared by setConfigKey and
 *  editConfigList: walk the path's schema ancestors (trailing array indices
 *  stripped, so an ELEMENT of a hidden list inherits its key's posture) and
 *  refuse on the first config-file-unreachable LEAF the schema declares. Only
 *  leaves decide -- an interior node's own layers govern the container's value,
 *  never its children, whose layers are consulted against the config by
 *  resolveNestedProperties (the row filter drops leaves for the same reason).
 *  Null when the path is file-reachable. */
function unreachableLeaf(unified: ConfigSchema, segs: KeySeg[]): SchemaProperty | null {
  for (let d = segs.length; d >= 1; d--) {
    const prefix = segs.slice(0, d);
    while (prefix.length > 0 && typeof prefix[prefix.length - 1] === "number") prefix.pop();
    if (prefix.length === 0) continue;
    const prop = findLeafProp(unified, prefix);
    if (prop && (!prop.properties || Object.keys(prop.properties).length === 0) && notFileResolvable(prop)) return prop;
  }
  return null;
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

/** LIST-CHROME array test (owner ruling 2026-11-11, the provider-card
 *  doctrine generalized): an array whose EVERY element is a writable scalar
 *  (the same four words isEditScalarType gates on the write side -- stamp
 *  predicate and write gate share the definition). Chrome row + one stamped
 *  element row per value. Arrays with object/null members (mcpServers,
 *  profiles-style maps, mixed junk) keep their existing posture -- whole-json
 *  stamp, provider cards, or class-A child rows. */
function primitiveArrayItems(v: unknown): unknown[] | null {
  return Array.isArray(v) && v.every((el) => typeof el === "string" || typeof el === "number" || typeof el === "boolean")
    ? v
    : null;
}

/** The declared items schema of a schema array leaf when it names a
 *  primitive type (null: element stamps fall back to each element's runtime
 *  shape -- the file-only doctrine). Object-item arrays are NOT chrome. */
function arrayItemsProp(prop: SchemaProperty | null | undefined): SchemaProperty | null {
  return prop?.type === "array" && prop.items && isEditScalarType(prop.items.type) ? prop.items : null;
}

/** True when the schema declares the path a LIST-chrome array: type array
 *  with no items or primitive items (even absent from the file the chrome
 *  row owns the interface -- append creates the array element by element). */
function schemaListChrome(prop: SchemaProperty | null | undefined): boolean {
  return prop?.type === "array" && (prop.items === undefined || isEditScalarType(prop.items.type));
}

/** Parse a layer's raw token (env var value / argv literal) into the array it
 *  attests. Unparseable or non-array: null -- nothing is attested per
 *  element, so the element rows simply omit that layer slot (never a
 *  fabricated source chip). */
function parseLayerArray(value: unknown): unknown[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

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
      ...(Array.isArray(bounds.enum) && bounds.enum.length > 0 ? { enum: [...bounds.enum] } : {}),
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
 * Element rows for a LIST-chrome array (one row per element, keyed
 * `parent[i]`), SHAPED LIKE A FIELD ROW: the parent's slot rides through
 * (a class-A / provider child ships one slot; schema-leaf arrays get the
 * full layer set via schemaListElementRows). Stamps come from stampFor:
 * secret-shaped paths keep the writeOnly REPLACE box (a coherent per-element
 * posture -- the write splices one string into one slot, the reply echoes
 * value:null + redacted:true, and no element byte ever ships), everything
 * else rides the items schema when the caller has one, else the element's
 * runtime scalar type (seedless when its ship is lossy). Class-B gates
 * (duplicated/unspellable) stamp nothing, exactly like every other row.
 */
function listElementRows(
  segs: KeySeg[],
  arr: unknown[],
  ctx: RowCtx,
  slot: "file" | "resolved",
  depth: number,
  items: SchemaProperty | null,
): ConfigKeyEntryWire[] {
  const out: ConfigKeyEntryWire[] = [];
  arr.forEach((el, index) => {
    const esegs: KeySeg[] = [...segs, index];
    const row: ConfigKeyEntryWire = { key: keyString(esegs) };
    let faithful = false;
    if (secretSegs(esegs)) {
      row.leafSecret = true;
      row[slot] = null;
      if (isSet(el)) row.redacted = true; // an element slot is by definition set
    } else {
      const wv = wireValue(el, depth);
      row[slot] = wv.value;
      if (wv.hit) row.redacted = true;
      faithful = !wv.hit && !wv.lossy;
    }
    const stamp = stampFor({
      segs: esegs,
      prop: items,
      rawSeed: el,
      faithful,
      addressable: ctx.addressable,
      dups: ctx.dups,
    });
    if (stamp) row.edit = stamp;
    out.push(row);
  });
  return out;
}

/** Layer slots an array element can attest (computed by buildRows; absent
 *  layer, absent slot -- the same honesty rule as every other row). */
interface ArrayLayerSlots {
  def: unknown;
  hasDefault: boolean;
  resolved: unknown;
  envSet?: { set: boolean; source?: string; value?: unknown };
  envNameSecret: boolean;
  cliHit?: { literal: string; value?: unknown } | null;
}

/**
 * Element rows for a SCHEMA-leaf LIST-chrome array: full per-layer slots so
 * the source chips stay honest (file element, plus resolved/default/env/cli
 * elements when those layers carry an array that reaches index i; env/cli
 * hand the whole array as one token, so an unparseable token attests nothing
 * per element and the slot rides omitted). Secret arrays mirror the parent's
 * secret shape per element: null slots + the REPLACE box, never a byte.
 */
function schemaListElementRows(
  segs: KeySeg[],
  arr: unknown[],
  items: SchemaProperty | null,
  slots: ArrayLayerSlots,
  secret: boolean,
  ctx: RowCtx,
): ConfigKeyEntryWire[] {
  const resolvedArr = Array.isArray(slots.resolved) ? slots.resolved : null;
  const defArr = slots.hasDefault && Array.isArray(slots.def) ? slots.def : null;
  const envArr = slots.envSet?.set === true ? parseLayerArray(slots.envSet.value) : null;
  const cliArr = slots.cliHit ? parseLayerArray(slots.cliHit.value) : null;
  const out: ConfigKeyEntryWire[] = [];
  arr.forEach((el, index) => {
    const esegs: KeySeg[] = [...segs, index];
    const row: ConfigKeyEntryWire = { key: keyString(esegs) };
    let faithful = false;
    if (secret) {
      row.leafSecret = true;
      if (defArr !== null && index < defArr.length) row.default = null;
      row.file = null;
      if (envArr !== null && index < envArr.length && slots.envSet?.source) {
        row.env = { set: true, source: slots.envSet.source };
      }
      if (cliArr !== null && index < cliArr.length && slots.cliHit) {
        row.cli = { flag: slots.cliHit.literal, value: null };
      }
      if (resolvedArr !== null && index < resolvedArr.length) row.resolved = null;
      row.redacted = true; // the file element is set; its bytes are not shippable
    } else {
      const wf = wireValue(el, 0); // an element is its own row: scalar shaping, not container stubs
      row.file = wf.value;
      faithful = !wf.hit && !wf.lossy;
      let hit = wf.hit;
      if (defArr !== null && index < defArr.length) {
        const r = wireValue(defArr[index], 0);
        row.default = r.value;
        hit = hit || r.hit;
      }
      if (resolvedArr !== null && index < resolvedArr.length) {
        const r = wireValue(resolvedArr[index], 0);
        row.resolved = r.value;
        hit = hit || r.hit;
      }
      if (envArr !== null && index < envArr.length && slots.envSet) {
        // The env var NAME keeps its own redaction test (the parent rule).
        row.env = {
          set: true,
          ...(slots.envSet.source ? { source: slots.envSet.source } : {}),
          ...(slots.envNameSecret ? { value: null } : { value: wireValue(envArr[index], 0).value }),
        };
        hit = hit || slots.envNameSecret;
      }
      if (cliArr !== null && index < cliArr.length && slots.cliHit) {
        row.cli = { flag: slots.cliHit.literal, value: wireValue(cliArr[index], 0).value };
      }
      if (hit) row.redacted = true;
    }
    const stamp = stampFor({
      segs: esegs,
      prop: items,
      rawSeed: el,
      faithful,
      addressable: ctx.addressable,
      dups: ctx.dups,
    });
    if (stamp) row.edit = stamp;
    out.push(row);
  });
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

  // The env var NAME is redaction-tested too: a third-party schema that
  // names its env var like a credential behind a non-secret key path must
  // not hand its value over (the key-path rule alone would miss it). Shared
  // by the whole-array env slot below and the array-element env slots.
  const envNameSecret = envSet?.source !== undefined && isSecretConfigPath(envSet.source.replace(/_/g, "."));

  // resolved: core.resolved carries the startup resolution chain for core
  // keys; extension-resolved keys live on core.config (resolveExtensionConfig
  // assigns them there).
  const fromResolved = ctx.core.resolved ? getNested(ctx.core.resolved, path) : undefined;
  const resolvedValue = fromResolved !== undefined ? fromResolved : getNested(ctx.core.config ?? {}, path);

  const segs = parseKeyPath(path) ?? [];
  const secret = isSecretConfigPath(path);
  const gates = ctx.addressable && grammarSafe(segs) && !hasDuplicatePrefix(ctx.dups, segs);
  const fileArr = primitiveArrayItems(fileValue);
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
    // SECRET-SHAPED LIST chrome (owner 2026-11-11 decision): a primitive
    // array (or a schema-declared list) under a secret-shaped path gets the
    // chrome posture with the REPLACE box MOVED TO THE ELEMENTS -- per
    // element the writeOnly write is coherent (it splices one string into
    // one slot, echoes value:null + redacted:true, and no byte ever ships).
    // The chrome row itself is unstamped and its bulk write is refused, so
    // the old bulk-REPLACE-that-flattens-the-array is gone; secret SCALARS
    // keep their single writeOnly box untouched.
    if (fileArr !== null && gates) {
      row.arrayChrome = true;
      const out = [row];
      out.push(
        ...schemaListElementRows(
          segs,
          fileArr,
          arrayItemsProp(prop),
          { def, hasDefault, resolved: resolvedValue, envSet, envNameSecret, cliHit },
          true,
          ctx,
        ),
      );
      return out;
    }
    if (fileValue === undefined && schemaListChrome(prop) && gates) {
      row.arrayChrome = true; // absent schema list: chrome with zero elements (append creates)
      return [row];
    }
    // The writeOnly REPLACE box (scalars, and arrays whose elements are not
    // all scalars): the one stamp that never needs the old value, so class A
    // cannot touch it; class B (duplicate/unaddressable) still refuses it.
    if (gates) {
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
    const r =
      !envNameSecret && envSet.value !== undefined ? wireValue(envSet.value) : { value: undefined, hit: false, lossy: false };
    row.env = {
      set: envSet.set,
      ...(envSet.source ? { source: envSet.source } : {}),
      ...(envSet.set ? (envNameSecret ? { value: null } : { value: r.value }) : {}),
    };
    hit = hit || r.hit || envNameSecret;
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
  // ARRAY LIST chrome (owner ruling 2026-11-11, the provider-card doctrine
  // generalized): a primitive-valued array -- or a schema-declared list the
  // file does not carry yet -- ships as this chrome row (slots intact, NO
  // edit stamp) plus one stamped row per element carrying its own per-layer
  // slots. The wholesale array write is refused server-side to match (the
  // stamp predicate is the write gate); the element rows and the editConfigList
  // ops are the interface. EMPTY arrays ride chrome + zero element rows; an
  // absent schema list rides chrome alone (append creates it). Class B ships
  // the plain unstamped row: elements of a duplicated path address nothing.
  if (fileArr !== null && gates) {
    row.arrayChrome = true;
    return [
      row,
      ...schemaListElementRows(
        segs,
        fileArr,
        arrayItemsProp(prop),
        { def, hasDefault, resolved: resolvedValue, envSet, envNameSecret, cliHit },
        false,
        ctx,
      ),
    ];
  }
  if (fileValue === undefined && schemaListChrome(prop) && gates) {
    row.arrayChrome = true;
    return [row];
  }
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
    // LIST chrome (provider-card doctrine generalized): a primitive-valued
    // array child ships as this chrome row (NO stamp; the card-field/json
    // dump is retired the same way `providers[0].models` retired it) plus one
    // stamped row per element. Secret-shaped arrays keep every slot null and
    // hand each element the writeOnly REPLACE box. Class-B paths ship the
    // plain unstamped row (no element rows: nothing addresses them).
    const chromeArr = primitiveArrayItems(v);
    if (
      chromeArr !== null &&
      ctx.addressable &&
      grammarSafe(childSegs) &&
      !hasDuplicatePrefix(ctx.dups, childSegs)
    ) {
      row.arrayChrome = true;
      out.push(row);
      out.push(...listElementRows(childSegs, chromeArr, ctx, slot, depth, null));
      continue;
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
 * Rows for a providers array the IN-USE FILE carries, shaped for the panel's
 * provider CARDS (owner ruling 2026-11-11: one card per provider, no
 * whole-array dump, no per-element JSON container row while the leaf rows
 * render). The shipped set:
 *  - the top `providers` row as-is MINUS its edit stamp: the section heading
 *    is its chrome (the whole-array JSON editor is retired -- provider lists
 *    change through the card's add/remove ops, and the write gate refuses the
 *    wholesale container write to match the stamp);
 *  - per element: the `providers[i]` row (the card HEADER's chrome row, also
 *    unstamped -- its fields own the editing) followed by every field the
 *    element carries (existing child-row machinery: faithful scalars
 *    stamped, secrets writeOnly, lossy ships recursing), plus one stamped
 *    row per KNOWN ProviderDef child the file does not set. Those
 *    known-but-absent rows ship no value slot (nothing attests one -- the
 *    panel's value cell reads "(unset)") but carry the create-on-write
 *    stamp: the staged transaction inserts the member into the element
 *    object (providers[i].url-style), and applyConfigKeyEditLocked accepts
 *    exactly these creations (same providerDefField declaration), so every
 *    live control saves. A field the DECLARATION does not know never gets a
 *    create row (the file stays the interface there).
 * Elements that are not objects (a stray string in the array) keep the plain
 * file-only row -- a card needs an object to hang fields on.
 */
function providerArrayRows(providers: unknown[], topRow: ConfigKeyEntryWire, ctx: RowCtx): ConfigKeyEntryWire[] {
  const top = { ...topRow };
  delete top.edit; // chrome: the section heading renders this row; no array-level JSON dump
  const out: ConfigKeyEntryWire[] = [top];
  providers.forEach((el, index) => {
    const segs: KeySeg[] = ["providers", index];
    if (el === null || typeof el !== "object" || Array.isArray(el)) {
      out.push(...fileOnlyRows(segs, el, ctx, 1));
      return;
    }
    const element = el as Record<string, unknown>;
    const header: ConfigKeyEntryWire = { key: keyString(segs) };
    const wv = wireValue(element, 1); // container-member shaping, same as the child rows
    header.file = wv.value;
    if (wv.hit) header.redacted = true;
    // NO edit on the chrome row (see the doc): fields and list ops own it.
    out.push(header);
    out.push(...childRows(segs, element, ctx, "file", 1));
    // Known-but-absent children: create-on-write rows (class-B gates apply
    // to the CREATION too -- an unspellable/duplicated path ships nothing).
    const present = new Set(Object.keys(element).map((k) => normalizeKey(k)));
    for (const [field, def] of Object.entries(PROVIDER_DEF_FIELDS)) {
      if (present.has(normalizeKey(field))) continue;
      const fsegs: KeySeg[] = [...segs, field];
      if (!ctx.addressable || !grammarSafe(fsegs) || hasDuplicatePrefix(ctx.dups, fsegs)) continue;
      const row: ConfigKeyEntryWire = { key: keyString(fsegs), description: def.description };
      row.edit = secretSegs(fsegs)
        ? { type: "string", writeOnly: true }
        : def.type === "json"
          ? { type: "json" }
          : { type: def.type };
      out.push(row);
    }
  });
  return out;
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
    if (removedHitAt(k, childSegs.length)) continue; // tombstone findings own removed keys (topLevelOnly: root only); the loader ignores them
    if (interiors.has(sp)) {
      collectFileRows(v as Record<string, unknown>, childSegs, covered, interiors, ctx, depth + 1, out);
      continue; // known schema object: its own rows ride the schema walk
    }
    out.push({ segs: childSegs, rows: fileOnlyRows(childSegs, v, ctx, depth === 0 ? 0 : 1) });
  }
}

/** One file-only row (unknown / passthrough), plus class-A child rows when
 *  the container's shipped payload redacts or stubs something inside. A
 *  primitive-valued array becomes LIST chrome instead (heading row, no
 *  stamp, + one stamped row per element; the write gate refuses the bulk
 *  splice to match -- owner ruling 2026-11-11). */
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
  const chromeArr = primitiveArrayItems(v);
  if (chromeArr !== null && ctx.addressable && grammarSafe(segs) && !hasDuplicatePrefix(ctx.dups, segs)) {
    row.arrayChrome = true;
    return [row, ...listElementRows(segs, chromeArr, ctx, "file", wireDepth, null)];
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
    const r = removedHitAt(hit.key, hit.depth);
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
    // THE SHIP FILTER (owner ruling 2026-11-11): a leaf the config file cannot
    // affect ships no row, so the panel never offers a file write for it (and
    // the rail counts, the search and the every-row stamp sweep simply lose it
    // -- the client renders what arrives, zero webui changes). Still collected
    // above, so `covered` keeps the path schema-owned: a stale file byte for
    // one rides silent + unknown-key-free, never as a file-only row.
    if (notFileResolvable(leaf.prop)) continue;
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
      // The providers passthrough gets the CARD shape (chrome rows + always-
      // expanded fields + known-but-absent create rows) instead of the
      // generic dump-or-container walk. Exact-key match: a "Providers"
      // misspelling keeps the unknown-key story as before.
      const rows =
        g.rows.length > 0 && typeof top === "string" && top === "providers" && Array.isArray(fileConfig.providers)
          ? providerArrayRows(fileConfig.providers, g.rows[0]!, ctx)
          : g.rows;
      for (const row of rows) {
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
// Owner ruling (2026-11-09, scoped honestly 2026-11-11): every setting the
// CONFIG FILE CAN AFFECT is editable -- the whitelist is retired.
// Config-file-unreachable leaves (notFileResolvable: layers, none of them the
// file) never reach this path: no row, and both write gates refuse them before
// any byte moves. The invariant moved from a constant list to the STAMP: every
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

/** The schema property that governs the ITEM an indexed path addresses:
 *  walks `items` on every array hop ("ports[2]" -> ports.items,
 *  "servers[0].ports[1]" -> servers.items.properties.ports.items). Null when
 *  the path is not an array element or the schema declares no items -- the
 *  element gate then falls back to the file's shape (the file-only doctrine,
 *  same as the shape-derived element STAMP). */
function findItemProp(unified: ConfigSchema, segs: KeySeg[]): SchemaProperty | null {
  if (segs.length === 0 || typeof segs[0] === "number") return null;
  const rootKey = Object.keys(unified).find((k) => normalizeKey(k) === normalizeKey(segs[0] as string));
  if (rootKey === undefined) return null;
  let prop: SchemaProperty | undefined = unified[rootKey];
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i]!;
    if (typeof s === "number") {
      if (prop?.type !== "array" || prop.items === undefined) return null;
      prop = prop.items;
    } else {
      const hit = Object.keys(prop?.properties ?? {}).find((k) => normalizeKey(k) === normalizeKey(s));
      prop = hit !== undefined ? prop!.properties![hit] : undefined;
    }
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
  if (Array.isArray(prop.enum) && prop.enum.length > 0 && !prop.enum.includes(value as string)) {
    return `"${keyPath}" must be one of: ${prop.enum.join(", ")} (got ${JSON.stringify(value)})`;
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

/** Geometry of a walked ARRAY (recorded separately from members: an array
 *  value keeps `object: null` so the absent-key ancestor walk keeps refusing
 *  to "insert into" an array it cannot re-shape). The provider list ops are
 *  the only consumers: append inserts before the closing bracket, remove
 *  drops one element range. `firstKeyStart` / `lastValueEnd` / `memberCount`
 *  carry the same meaning as in EditObjectNode (elements, not members). */
interface EditArrayNode {
  segs: KeySeg[];
  open: number;
  close: number;
  firstKeyStart: number;
  lastValueEnd: number;
  memberCount: number;
}

/**
 * Walk the (comment-masked) text and record every object member with its
 * key segments and value range, plus the geometry of every object. Grammar
 * strictness mirrors JSON with one JSONC grace (a trailing comma before a
 * closing brace), because rescue calls such files fixable and their users
 * deserve an editor that keeps their style. Anything the walk cannot follow
 * returns null -- never a partial answer.
 */
function locateJsonStructure(text: string): { members: EditMember[]; root: EditObjectNode; arrays: Map<string, EditArrayNode> } | null {
  const t = maskComments(text);
  const n = t.length;
  const members: EditMember[] = [];
  const arrays = new Map<string, EditArrayNode>();
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
    // Geometry for the provider list ops (append/remove): the same shape the
    // object insert borrows formatting from. `memberCount` counts ELEMENTS;
    // firstKeyStart is the first element's value start; lastValueEnd the last.
    const node: EditArrayNode = { segs, open: start, close: -1, firstKeyStart: -1, lastValueEnd: -1, memberCount: 0 };
    const record = (end: number): { start: number; end: number; object: null } => {
      node.close = end - 1; // the "]" itself
      arrays.set(spellPath(segs), node);
      return { start, end, object: null };
    };
    i++; // [
    ws();
    if (t[i] === "]") {
      i++;
      return record(i);
    }
    let index = 0;
    for (;;) {
      // Elements are ADDRESSABLE by index: an element object's members carry
      // the `[i]` segment (providers[0].url), exactly like the row keys.
      const v = parseValue([...segs, index], depth);
      if (!v) return null;
      if (node.firstKeyStart < 0) node.firstKeyStart = v.start;
      node.lastValueEnd = v.end;
      node.memberCount++;
      members.push({ segs: [...segs, index], valueStart: v.start, valueEnd: v.end, object: v.object });
      index++;
      ws();
      if (t[i] === ",") {
        i++;
        ws();
        if (t[i] === "]") {
          i++; // trailing comma (JSONC grace)
          return record(i);
        }
        continue;
      }
      if (t[i] === "]") {
        i++;
        return record(i);
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
  return { members, root: root.object, arrays };
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

/** Leading whitespace of the line containing `pos`. */
function indentAtOf(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0]!;
}

/** Borrowed formatting for an insertion into `node`: an object (or array)
 *  whose members share its line stays inline; multiline inserts hang off the
 *  first member's indent. Returns the full new text with `entry` slotted in
 *  as the node's LAST member. The comment-run rule: a comment sitting on the
 *  last member's value line belongs to THAT member: inserting at lastValueEnd
 *  would strand it behind the new key (its "200 // page size" describing
 *  readToolLimit would land on grepMaxResults). So advance the insertion
 *  point past a comment run contiguous with the value (across whitespace and
 *  one existing comma), and hang the separator comma on the value token
 *  instead. With no comment in the gap the old geometry stands untouched: an
 *  existing trailing comma still becomes the single trailing comma behind the
 *  new member. Shared by the value-set insert (editConfigText) and the
 *  provider list append (same byte discipline). */
function insertEntryIntoNode(text: string, node: EditObjectNode | EditArrayNode, entry: string): string {
  const multiline =
    node.firstKeyStart >= 0
      ? text.slice(node.firstKeyStart, node.close).includes("\n")
      : text.slice(node.open + 1, node.close).includes("\n");
  const childIndent =
    node.firstKeyStart >= 0 ? indentAtOf(text, node.firstKeyStart) : indentAtOf(text, node.open) + "  ";

  if (node.memberCount === 0) {
    // No comma to hang off: place the member before the closing brace (an
    // interior comment line rides untouched, above the new key).
    return text.slice(0, node.close) + (multiline ? childIndent + entry : entry) + text.slice(node.close);
  }
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
    return text.slice(0, node.lastValueEnd) + "," + (multiline ? "\n" + childIndent : " ") + entry + text.slice(node.lastValueEnd);
  }
  // head: reuse the member's own trailing comma when it wrote one; else the
  // separator comma lands directly on the value token, before its comment.
  const head = sawComma ? "" : ",";
  const sep = multiline ? "\n" + childIndent : " ";
  return text.slice(0, node.lastValueEnd) + head + text.slice(node.lastValueEnd, p) + sep + entry + text.slice(p);
}

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
  const multiline =
    node.firstKeyStart >= 0
      ? text.slice(node.firstKeyStart, node.close).includes("\n")
      : text.slice(node.open + 1, node.close).includes("\n");
  const childIndent = node.firstKeyStart >= 0 ? indentAtOf(text, node.firstKeyStart) : indentAtOf(text, node.open) + "  ";
  const chain = buildChainText(create, newValueText, childIndent, multiline);
  return { ok: true, newText: insertEntryIntoNode(text, node, chain) };
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

/** §7.1 attestation classes (the wire type lives in ./protocol.ts; the write
 *  path produces the same union). */
type ConfigAppliedClass = "live" | "rebind" | "next-session" | "restart-required";

export type ConfigKeyEditOutcome =
  | {
      ok: true;
      /** LEGACY shim, DERIVED from `applied` at reply build, never maintained
       *  by hand: true iff applied === "restart-required" (§7.1). */
      needsRestart: boolean;
      /** What actually happened in THIS process for THIS write (§7.1). */
      applied: ConfigAppliedClass;
      /** Human one-liners rendered verbatim under the row; the §2.3 last-good
       *  error text rides here (the wire type has no liveApplyError field). */
      appliedNotices?: string[];
      /** Per-hook ledger for this batch (§3); omitted when no hook ran. */
      applyHooks?: ApplyHookRunReport[];
      value?: EditScalar | null;
      valueText?: string;
      redacted?: true;
    }
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

/** Serialized entry point: see withConfigEditLock. Exported for tests.
 *  `opts.actor`: the writing panel's session id, threaded to
 *  the audit lines of the trust-class hooks; tests/direct callers omit it. */
export function applyConfigKeyEdit(
  core: CoreContext,
  keyPath: string,
  input: ConfigKeyEditInput,
  opts: { argv?: string[]; deps?: ConfigEditDeps; actor?: string } = {},
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

/** The provider array as the PARSED file spells it (normalized-key lookup,
 *  the loader's equivalence). undefined: absent; the value otherwise (the
 *  caller decides whether it is an array). */
function parsedProviders(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const hitKey = Object.keys(parsed as object).find((k) => normalizeKey(k) === "providers");
  return hitKey === undefined ? undefined : (parsed as Record<string, unknown>)[hitKey];
}

/** True when the path addresses the providers ARRAY itself or one of its
 *  OBJECT elements -- the snapshot's card chrome (heading / card header).
 *  The snapshot never stamps these and the write gate refuses the wholesale
 *  container write; the element's FIELDS stay individually writable. */
function providerListChromePath(segs: KeySeg[], parsedFile: unknown): boolean {
  if (typeof segs[0] !== "string" || normalizeKey(segs[0]) !== "providers") return false;
  const providers = parsedProviders(parsedFile);
  if (segs.length === 1) return Array.isArray(providers);
  if (segs.length === 2 && typeof segs[1] === "number") {
    const el = Array.isArray(providers) ? providers[segs[1]] : undefined;
    return el !== null && typeof el === "object" && !Array.isArray(el);
  }
  return false;
}

/** The declared ProviderDef child this path would CREATE: set when segs is
 *  providers[<i>].<knownField>, the provider ELEMENT exists in the file as an
 *  object, and the field is not there yet (normalized comparison, loader
 *  semantics). undefined otherwise -- everything else fail-closes as before. */
function providerChildCreateTarget(segs: KeySeg[], parsedFile: unknown): { type: "string" | "boolean" | "number" | "json" } | undefined {
  if (segs.length !== 3 || typeof segs[0] !== "string" || normalizeKey(segs[0]) !== "providers" || typeof segs[1] !== "number") {
    return undefined;
  }
  const providers = parsedProviders(parsedFile);
  if (!Array.isArray(providers)) return undefined;
  const el: unknown = providers[segs[1]];
  if (el === null || typeof el !== "object" || Array.isArray(el)) return undefined;
  const field = String(segs[2]);
  for (const k of Object.keys(el as object)) {
    if (normalizeKey(k) === normalizeKey(field)) return undefined; // present: the normal write path owns it
  }
  const def = providerDefField(field);
  return def ? { type: def.type } : undefined;
}

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
  opts: { argv?: string[]; deps?: ConfigEditDeps; actor?: string } = {},
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

  // 1b. NOT REACHABLE FROM THE FILE (same predicate that retired the row). The
  //     panel cannot offer these keys any more, but the gate is the gate: a
  //     stale tab, a scripted client or an older bundle can still replay the
  //     keyPath, and writing dead bytes is exactly the lie the row filter
  //     exists to stop. Resolved off the RUNNING server's schema before the
  //     file is even opened (zero bytes touched, zero restart promised -- a
  //     restart would not make the entry mean anything).
  const unified = unifiedSchemaFor(core);
  const hidden = unreachableLeaf(unified, segs);
  if (hidden) return { ok: false, error: notSettableFromFileDialog(keyPath, hidden, core) };
  // Tombstone gate (shares rescue's table): a retired key gets the named
  // REMOVED verdict from diagnose and NO new bytes from the write path --
  // the same dead-bytes rule the row filter applies, refused before the
  // schema lookup and before the file is opened.
  const dead = removedKeyRefusal(keyPath, segs);
  if (dead) return { ok: false, error: dead };
  const prop = findLeafProp(unified, segs);

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
  //    (unified + prop came from the reachability gate in 1b.)
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

  // PROVIDER LIST chrome: the providers array itself and its element rows are
  // the snapshot's CARD chrome (section heading / card header) -- the panel
  // never ships a wholesale-write stamp for them, so the gate refuses them
  // too (stamp predicate = write gate). Provider lists change through the
  // field rows and the editConfigList add/remove ops, not a bulk container
  // splice.
  if (cur.found && containerTarget && providerListChromePath(segs, parsedFile)) {
    return {
      ok: false,
      error: `"${keyPath}" is provider-list chrome -- the panel edits provider FIELDS on their own rows and changes the list with Add provider / Remove (${refusal})`,
    };
  }

  // Known ProviderDef child ABSENT from an existing provider element: the
  // card row ships a create-on-write stamp (providers[i].url-style); the
  // staged transaction inserts the member into the element object. This is
  // the gate half of that stamp -- the declared kind validates the fresh
  // value, and nothing else creates array-element children (fail closed).
  const provCreate = cur.found ? undefined : providerChildCreateTarget(segs, parsedFile);

  // ARRAY LIST chrome (owner ruling 2026-11-11, the provider-card doctrine
  // generalized): a primitive-valued array in the file, or an ABSENT
  // schema-declared list, renders as chrome (heading row without a stamp;
  // the elements are the rows, editConfigList appends/removes). The gate
  // matches the stamp: the bulk splice is refused and the honest text names
  // the interface. It also fires for SECRET-shaped primitive arrays -- the
  // secret short-circuit below must not smuggle a bulk array replace past
  // the chrome (per-element REPLACE rows own those).
  const listChromeTarget =
    (cur.found && fileShape === "array" && primitiveArrayItems(cur.value) !== null) ||
    (!cur.found && provCreate === undefined && schemaListChrome(prop));
  if (listChromeTarget) {
    return {
      ok: false,
      error: `"${keyPath}" is an array-list chrome row -- the panel edits the ELEMENTS on their own rows (${keyPath}[0], ...) and changes the list with append/remove (${refusal})`,
    };
  }

  let newValueText: string;
  let canonical: unknown;
  let echo: { value?: EditScalar | null; valueText?: string; redacted?: true };

  if (secret) {
    // The writeOnly REPLACE: a JSON string in whatever slot the path holds.
    // An unknown secret absent from the file on a server with no schema for
    // it has nothing to validate against -- fail closed like any unknown.
    // The one exception the snapshot may stamp: a provider element's own
    // declared apiKey child (the card's REPLACE row -- provCreate below).
    if (!prop && !cur.found && !provCreate) {
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
    // scalar-ness + primitive-kind agreement with what the file holds. An
    // ARRAY ELEMENT under a schema-declared list is the exception: its items
    // schema is the gate (type, bounds, enum -- the same declaration the
    // element row's stamp rode), so an off-set or out-of-bounds element value
    // refuses exactly like the leaf write would.
    if (!hasScalar) {
      return { ok: false, error: "value must be a string, number, or boolean" };
    }
    const itemProp = findItemProp(unified, segs);
    if (itemProp !== null && isEditScalarType(itemProp.type)) {
      const invalidItem = validateEditValue(itemProp.type as string, scalar, itemProp, keyPath);
      if (invalidItem) return { ok: false, error: invalidItem };
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
  } else if (provCreate) {
    // CREATE-ON-WRITE for a known provider child (the card's "(unset)" row):
    // the declared kind is the gate; the insert lands the member inside the
    // existing element object (editConfigText's ancestor insertion).
    if (provCreate.type === "json") {
      if (!hasText) {
        return { ok: false, error: `"${keyPath}" is a list -- send the new value as JSON text (valueText)` };
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text as string);
      } catch (err) {
        return { ok: false, error: `"${keyPath}": invalid JSON -- ${errorText(err)}` };
      }
      if (shapeClass(parsedJson) !== "array") {
        return {
          ok: false,
          error: `"${keyPath}" must be an array -- the new JSON is ${shapeWord(shapeClass(parsedJson) ?? "null")}`,
        };
      }
      newValueText = text as string;
      canonical = parsedJson;
      echo = { valueText: text as string };
    } else {
      if (!hasScalar) {
        return { ok: false, error: "value must be a string, number, or boolean" };
      }
      const want = provCreate.type;
      const kindOk =
        want === "string"
          ? typeof scalar === "string"
          : want === "boolean"
            ? typeof scalar === "boolean"
            : typeof scalar === "number" && Number.isFinite(scalar);
      if (!kindOk) {
        return { ok: false, error: `invalid value for "${keyPath}": expected a ${want}` };
      }
      newValueText = JSON.stringify(scalar);
      canonical = scalar;
      echo = { value: scalar as EditScalar };
    }
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

  // 6/7. Atomic write + verify + rollback (the shared write tail; the list
  // ops run through the very same one). The chain itself is UNTOUCHED; on a
  // clean verify the §2.4 live transaction continues below -- still inside
  // the SAME withConfigEditLock span (applyConfigKeyEdit wraps this whole
  // function), so file truth, store truth, and the reply can never
  // interleave with another writer, and the reply is composed before the
  // lock releases (§7.2: the transaction completes BEFORE the reply).
  // Approvals pre-compile, BEFORE any byte is written: a userGate write that
  // would leave rules the compiler rejects is refused here, not by the boot
  // that never happens. See candidateRuleBlockRefusal.
  const gateRefusal = candidateRuleBlockRefusal(core, segs, canonical);
  if (gateRefusal) return { ok: false, error: gateRefusal };

  const fileResult = await commitVerifiedEdit({
    filePath,
    newText,
    hadFile,
    rawText: report.rawText,
    deps,
    refusal,
    logTag: "setConfigKey",
    verify: (after) => verifyEdit(after, segs, canonical),
    onOk: () => ({ ok: true, needsRestart: true }),
  });
  if (!fileResult.ok) return fileResult;

  // 8. Live transaction (B4, design §2.4): reresolve -> prepare hooks ->
  //    swap -> apply hooks (awaited, per-hook timeout) -> commit -> attestation.
  const live = await runLiveConfigApply(core, keyPath, filePath, opts.actor);
  return {
    ok: true,
    ...echo,
    applied: live.applied,
    // The legacy shim DERIVED server-side (§7.1), never hand-maintained:
    // true iff applied === "restart-required".
    needsRestart: live.applied === "restart-required",
    ...(live.appliedNotices.length > 0 ? { appliedNotices: live.appliedNotices } : {}),
    ...(live.applyHooks.length > 0 ? { applyHooks: live.applyHooks } : {}),
  };
}

/**
 * The static per-keyPath live-class table (design §7.1: the `applied` CLASS
 * comes from a table, not from a runtime "a hook ran" guess). B4's rows are
 * exactly the migrated hook-backed keys (§3.3's four); every key WITHOUT a
 * migrated live path keeps replying "restart-required" exactly as before.
 * The side-effect-class rows extend it: the webui
 * rebind/auth pair, the userGate rule fields, providers (+ the stamped
 * `providers[<i>].<field>` writable spellings, index-normalized at lookup),
 * sttUrl/sttModel, and the execFence/toolExec pair -- the latter TWO land in
 * "next-session" (the class the derivation can state truthfully: entries
 * spawned after the publish honor the new posture, running entries and
 * in-flight turns keep theirs -- the "live (new pool entries
 * only)" wording rides the hook's audit notice verbatim).
 *
 * Keys are the WRITABLE file-key spellings; values name the hook keyPath
 * (the RESOLVED-bag roots, the names the consumers read) and optionally the
 * class the reply claims. They differ where the schema resolves under an
 * alias -- the `aiUrl` file member feeds resolved `baseUrl`,
 * `chatTimeoutSecs` feeds resolved `chatTimeout` etc. -- and a write only
 * moves the resolved root when the resolution chain actually honors it -- a
 * provider/cli/env layer can shadow it, and the attestation below catches
 * exactly that: the hook never runs while other canonical values moved, so
 * the reply is restart-required with a notice naming the shadow
 * (only a TRUE no-op -- empty `changed` -- keeps a live claim without a
 * hook having run). The auth pair shares ONE hook keyPath ("webui": one
 * prepare+apply pair reads the whole candidate block); each field's row
 * points at it, so the ran-check sees the auth hook run for its field.
 */
interface LiveAppliedRow {
  /** The apply-hook keyPath whose reports attest this row (ran-check). */
  hook: string;
  /** The claimed class; default "live". "rebind" (webui.port,
   *  reply-first) and "next-session" (execFence/toolExec, new pool entries
   *  only) are the honest non-live-here-now classes the table can name. */
  class?: ConfigAppliedClass;
}

const LIVE_APPLIED_KEYS: Readonly<Record<string, LiveAppliedRow>> = {
  hookTrace: { hook: "hookTrace" },
  "websocket.sessionTimeoutMin": { hook: "websocket.sessionTimeoutMin" },
  providerHealthCheckIntervalSecs: { hook: "providerHealthCheckIntervalSecs" },
  aiUrl: { hook: "baseUrl" },
  apiKey: { hook: "apiKey" },
  chatTimeoutSecs: { hook: "chatTimeout" },
  healthCheckTimeoutSecs: { hook: "healthCheckTimeout" },
  streamIdleTimeoutSecs: { hook: "streamIdleTimeout" },
  maxRetries: { hook: "maxRetries" },
  modelWireFormat: { hook: "modelWireFormat" },
  modelRoleMapping: { hook: "modelRoleMapping" },
  // ── The side-effect class rows ────────────────────────────────────────────
  "webui.port": { hook: "webui.port", class: "rebind" },
  "webui.apiKey": { hook: "webui" },
  "webui.sessionTokenTtlMin": { hook: "webui" },
  "webui.trustedProxy": { hook: "webui" },
  "userGate.allow": { hook: "userGate" },
  "userGate.deny": { hook: "userGate" },
  "userGate.default": { hook: "userGate" },
  "userGate.tools": { hook: "userGate" },
  providers: { hook: "providers" },
  // The snapshot's create-on-write / card spellings stamp array indices;
  // the lookup normalizes them to these entries (see liveRowForWrite).
  "providers[].url": { hook: "providers" },
  "providers[].apiKey": { hook: "providers" },
  "providers[].models": { hook: "providers" },
  sttUrl: { hook: "sttUrl" },
  sttModel: { hook: "sttModel" },
  toolExec: { hook: "toolExec", class: "next-session" },
  execFence: { hook: "execFence", class: "next-session" },
};

/** Table lookup for a written keyPath: exact first, then INDEX-ONLY
 *  normalization (every `[<digits>]` collapses to `[]`) so the panel's
 *  stamped `providers[0].url` / `providers[12].apiKey` spellings land on
 *  the same honest row as the class the write belongs to -- the lookup
 *  never index-matches (`providers[0].models.extra` normalizes segment by
 *  segment and still finds nothing beyond the declared spellings). */
function liveRowForWrite(keyPath: string): LiveAppliedRow | undefined {
  const direct = LIVE_APPLIED_KEYS[keyPath];
  if (direct) return direct;
  return LIVE_APPLIED_KEYS[keyPath.replace(/\[\d+\]/g, "[]")];
}

/** Value at keyPath in a generation: config bag first, resolved bag as the
 *  fallback (the same two-bag namespace the changed-diff spans; live.ts's
 *  seam reads identically). Hook ARGUMENTS only -- the §3.1 generic pair;
 *  hooks that need the resolution chain's authoritative value read
 *  ctx.store.current().resolved themselves (post-swap truth, §1.5). */
function generationValueAt(
  bags: { config: object; resolved?: object },
  keyPath: string,
): unknown {
  const v = getNested(bags.config, keyPath);
  return v === undefined ? getNested(bags.resolved, keyPath) : v;
}

/**
 * The §2.4 transaction, run INSIDE withConfigEditLock after a verified file
 * write. Returns the §7.1 attestation for the reply. Never throws: every
 * failure mode answers with a plain, honest restart-required story.
 */
async function runLiveConfigApply(
  core: CoreContext,
  keyPath: string,
  filePath: string,
  actor?: string,
): Promise<{ applied: ConfigAppliedClass; appliedNotices: string[]; applyHooks: ApplyHookRunReport[] }> {
  const notices: string[] = [];
  const reports: ApplyHookRunReport[] = [];
  const store: ConfigStore | undefined = core.configStore;
  if (!store) {
    // No store on this host (hand-built/embedded core): the pre-C7 posture,
    // verbatim -- persisted, restart-required, nothing live happened.
    return { applied: "restart-required", appliedNotices: notices, applyHooks: reports };
  }

  // reresolve (may throw -> §2.3 last-good). The live argv: the parsed CLI
  // bag main() bound at boot (the cli layer cannot change at runtime but
  // MUST keep applying, §4.2's provenance argument), with `config` pinned to
  // the exact file the write chain just verified -- the same bytes the
  // snapshot's in-use path resolved (peekConfigFlags/resolveConfigDir are
  // boot-stable; pinning keeps the re-read pointed at what was written even
  // for an explicit --config host).
  let previous: ConfigGeneration;
  let candidate;
  try {
    previous = store.current();
    const cliArgv: CliArgv = { ...(core.cliArgv ?? {}), config: filePath };
    candidate = await reresolveConfig(cliArgv, core.configRegistry, previous);
  } catch (e) {
    // LAST-GOOD (§2.3): the file keeps the write (verified bytes; next boot's
    // truth; a broken-boot file is rescue's domain, not the runtime's). The
    // store keeps the PREVIOUS generation, untouched. Plain reply, formatError
    // text included -- liveApplyError ruling (§7.1-canonical): the wire type
    // carries no such field, the error text rides appliedNotices verbatim.
    // No retry machinery; the next successful write re-runs the whole chain.
    notices.push(
      `persisted; the running process kept its current values because re-resolution failed: ${formatError(e)} -- fix the file (or export the referenced variable) and the next write applies live, otherwise restart.`,
    );
    return { applied: "restart-required", appliedNotices: notices, applyHooks: reports };
  }

  const changed = diffChanged(previous, candidate);
  const ctx: ConfigApplyContext = {
    store,
    // The audit floor: the shared primitive (core/config/audit.ts) -- the
    // grep-able `logger.warn("[config-live] <keyPath>: <summary>")` PLUS the
    // webui surface push when a server is serving. The hooks registered
    // before this seam keep their exact bytes: the log line the primitive
    // writes IS "[config-live] " + the hook's text, as before.
    notice: (text: string) => configAuditNotice(text),
    core,
    // WHO wrote, for the trust-class audit lines; undefined when the
    // write arrived without a session context (direct/test callers).
    actor,
  };

  // PREPARE hooks (before the swap): a throw REFUSES the swap. The value
  // stays persisted in the file, the runtime untouched, applied
  // "restart-required" + the refuse reason (§2.4).
  for (const hook of hooksForPhase("prepare", changed)) {
    const report = await runConfigApplyHook(
      ctx,
      hook,
      generationValueAt(previous, hook.keyPath),
      generationValueAt(candidate, hook.keyPath),
    );
    reports.push(report);
    if (report.status !== "applied") {
      notices.push(
        `persisted; the live apply was refused before the swap at "${report.keyPath}": ${report.error ?? "prepare hook failed"}`,
      );
      return { applied: "restart-required", appliedNotices: notices, applyHooks: reports };
    }
  }

  // SWAP: reads are NEW from here on; the changed prefixes are "applying"
  // until commit (§1.5 F5 window). APPLY hooks run after the swap, awaited,
  // each under its timeoutMs -- a throw/timeout is a degraded report and the
  // store NEVER re-swaps (§3.2).
  const commit = store.swap(candidate);
  const degraded: Array<{ keyPath: string; why: string }> = [];
  try {
    for (const hook of hooksForPhase("apply", changed)) {
      const report = await runConfigApplyHook(
        ctx,
        hook,
        generationValueAt(previous, hook.keyPath),
        generationValueAt(candidate, hook.keyPath),
      );
      reports.push(report);
      if (report.status !== "applied") {
        degraded.push({ keyPath: report.keyPath, why: report.error ?? "apply hook failed" });
        notices.push(
          `"${report.keyPath}": the new value is live in the store but its apply hook reported ${report.status}${report.error ? `: ${report.error}` : ""}; the previous behavior stays in effect until a restart.`,
        );
      }
    }
  } finally {
    // ONE notify pass (batchId+1, applying clears, degraded attaches via
    // B1's commit(degraded?) channel -- clearing per the prefix rule).
    commit(degraded.length > 0 ? degraded : undefined);
  }

  // The `applied` attestation: static class, downgraded by what actually
  // happened to this key's live path (§7.1). Three demotions, then the one
  // quiet pass. (1) A degraded primary effect means the new value is NOT in
  // effect (the old side effect still runs): restart-required, with the
  // degraded notice stated above. (2) The hook ran nothing and the resolved
  // root DID move: no live holder is registered on this host, say so (this
  // is what makes "a host not serving webui" answer webui.port/rebind rows
  // honestly with restart-required -- there IS no hook, and no lie). (3) The
  // hook ran nothing, other canonical values moved, but THIS key's root did
  // not -- a higher layer (provider/cli/env) decides it and the file's new
  // value reached nobody but the store: restart-required, notice names the
  // shadow (B4 review F1). (4) Nothing at all in `changed`: a genuine no-op,
  // the running value already equals the file, so the live claim stands
  // unconfirmed and honest -- EXCEPT for "rebind", which claims an act that
  // a no-op does not perform: it is downgraded to "live" (the port is
  // already the one listening). The "rebind" claim additionally carries the
  // static notice: the reply MUST leave the socket BEFORE the rebind
  // runs, so the follow-up truth lives on the audit log (and, on failure,
  // on store.reportDegraded for the next snapshot's row) -- the reply says
  // "expect a brief drop", plainly.
  const row = liveRowForWrite(keyPath);
  // The written key's own value across this publish. Canonical comparison, so a
  // re-resolve that rebuilt the subtree with fresh identities is not a change.
  const valueAtKeyPathMoved = !canonEqual(
    generationValueAt(previous, keyPath),
    generationValueAt(candidate, keyPath),
  );
  let applied: ConfigAppliedClass = row ? row.class ?? "live" : "restart-required";
  if (row) {
    const hookKeyPath = row.hook;
    const ran = reports.filter((r) => r.phase === "apply" && r.keyPath === hookKeyPath);
    const root = hookKeyPath.split(".")[0]!;
    if (ran.some((r) => r.status !== "applied")) {
      applied = "restart-required";
    } else if (ran.length === 0 && changed.includes(root)) {
      applied = "restart-required";
      notices.push(
        `no live holder is registered for "${keyPath}" on this host: the value is live in the store but takes effect at restart.`,
      );
    } else if (ran.length === 0 && changed.length > 0 && !changed.includes(root)) {
      // The write DID move canonical values, just not this key's resolved
      // root: a higher layer (provider/cli/env) decides it, so the hook never
      // ran and nothing re-read the new value -- restart-required, named.
      applied = "restart-required";
      notices.push(
        `persisted; a higher layer decides "${keyPath}" than the config file: the file holds the new value but the running value does not -- clear the shadowing layer and the next write applies live, otherwise restart without it.`,
      );
    } else if (applied === "rebind" && !valueAtKeyPathMoved) {
      // "rebind" is the only class that claims an ACT instead of a re-read, so
      // it is the one class the table cannot grant on the hook-ran evidence
      // alone: a hook that matched this root, guarded its own keyPath, and did
      // nothing still reports "applied" (a sibling write under the same root --
      // webui.apiKey -- matches webui.port's row). The port did not move, so no
      // listener moves: the claim drops to the truth, "live".
      applied = "live";
      notices.push(`the value did not change; nothing had to be rebound and the current listener stays up.`);
    } else if (applied === "rebind") {
      // The reply is the drop notice: it leaves the socket BEFORE the move (the
      // hook defers the rebind past this turn), so the follow-up truth lives on
      // the audit log and, on a failed move, on the generation's degraded list
      // for the NEXT snapshot's row to render.
      notices.push(
        `rebinding: the reply reaches you BEFORE the listener moves, expect a brief drop; connected sockets drop and the webui reconnects. The rebind result lands on the audit log and (on failure) on the next snapshot's row.`,
      );
    }
  }
  return { applied, appliedNotices: notices, applyHooks: reports };
}

/** The ONE write tail: temp+rename in the same directory, re-read + verify,
 *  and rollback to the exact pre-write bytes (or un-create the file) on any
 *  post-write doubt, with the restore re-verified before it is claimed. The
 *  value edit and the provider list ops share it verbatim: one atomicity
 *  discipline for the config file, no second implementation to drift. */
function commitVerifiedEdit(args: {
  filePath: string;
  newText: string;
  hadFile: boolean;
  rawText: string;
  deps: ConfigEditDeps;
  refusal: string;
  logTag: string;
  verify: (after: string) => boolean;
  onOk: () => { ok: true; needsRestart: true } | { ok: false; error: string };
}): Promise<{ ok: true; needsRestart: true } | { ok: false; error: string }> {
  const { filePath, newText, hadFile, rawText, deps, refusal, logTag, verify, onOk } = args;
  return (async () => {
    // Atomic write (temp + rename in the same directory).
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

    // Post-write verification, then rollback-on-any-doubt.
    let verifyErr: string | null = null;
    try {
      const after = await deps.readFile(filePath);
      if (!verify(after)) verifyErr = "post-write verification failed";
    } catch (err) {
      verifyErr = `post-write read failed: ${errorText(err)}`;
    }
    if (!verifyErr) return onOk();

    const tmpBack = `${filePath}.${process.pid}.${++configEditSeq}.cfg-edit.tmp`;
    try {
      if (hadFile) {
        await deps.writeFile(tmpBack, rawText);
        await deps.rename(tmpBack, filePath);
      } else {
        await deps.unlink(filePath); // the file did not exist before; un-create it
      }
    } catch (err) {
      try {
        await deps.unlink(tmpBack);
      } catch {}
      logger.error(`[websocket] ${logTag} ${verifyErr} AND the rollback of ${filePath} failed: ${formatError(err)}`);
      return { ok: false, error: `${verifyErr}; ROLLBACK FAILED -- restore ${filePath} by hand (hotdog rescue validates it)` };
    }
    // Re-verify the restore before claiming it. The module lock serializes
    // in-process writers, but a CROSS-PROCESS one can land its bytes after our
    // rollback rename -- and then "the previous file was restored" would be a
    // lie written over someone else's ACKED value. Report what actually holds.
    let holdsOurBytes = false;
    try {
      holdsOurBytes = hadFile ? (await deps.readFile(filePath)) === rawText : false;
    } catch {
      holdsOurBytes = !hadFile; // the created file is gone again: the un-create landed
    }
    if (holdsOurBytes) return { ok: false, error: `${verifyErr}; the previous file was restored (${refusal})` };
    return {
      ok: false,
      error: `${verifyErr}; a concurrent edit won -- the file no longer holds its pre-write bytes; review ${filePath} before retrying (${refusal})`,
    };
  })();
}

/**
 * The panel-side pre-compile for the approvals gate (defense in depth): a write
 * under `userGate` compiles the CANDIDATE rule block -- the live block with this
 * write's value spliced in -- and refuses before a single byte is written.
 * Without it a malformed rule would persist in the file, the prepare hook would
 * refuse the live swap, and the operator would be left holding a file whose
 * next boot fails closed (every tool blocked) while the reply only said
 * "restart-required". The compile error rides the refusal verbatim, so the row
 * the user just edited names exactly what is wrong with it.
 *
 * Returns null when the write is fine OR when there is nothing to check: only
 * the `userGate` root is the gate's, and a host whose live bag carries no gate
 * block at all has no rules for the candidate to disagree with.
 */
function candidateRuleBlockRefusal(core: CoreContext, segs: KeySeg[], proposed: unknown): string | null {
  if (segs[0] !== "userGate") return null;
  const live = (core.config as Record<string, unknown> | undefined)?.userGate;
  if (live === undefined || live === null) return null;
  let candidate: unknown;
  try {
    candidate = spliceAtSegs(structuredClone(live), segs.slice(1), proposed);
  } catch {
    return null; // a shape this splice cannot model is the prepare hook's problem, not a reason to refuse
  }
  try {
    compileApprovalRules(candidate as ResolvedUserGateConfig);
  } catch (e: unknown) {
    return `"${spellPath(segs)}" would leave approval rules that do not compile: ${errorText(e)} -- nothing was written`;
  }
  return null;
}

/** Set `value` at `path` inside `root` (object keys and array indices), over a
 *  structure the caller already cloned. A path that walks out of a scalar or
 *  off the end of an array throws -- the caller reads that as "cannot check",
 *  never as a refusal. */
function spliceAtSegs(root: unknown, path: KeySeg[], value: unknown): unknown {
  if (path.length === 0) return value;
  const head = path[0];
  const rest = path.slice(1);
  if (head === undefined) throw new Error("empty path segment");
  if (typeof head === "number") {
    if (!Array.isArray(root)) throw new Error("path walks out of an array");
    const next = [...root];
    next[head] = spliceAtSegs(next[head], rest, value);
    return next;
  }
  if (root !== null && typeof root !== "object") throw new Error("path walks out of a scalar");
  const obj = { ...(root as Record<string, unknown>) };
  obj[head] = spliceAtSegs(obj[head], rest, value);
  return obj;
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
  // `actor` is the writing session: the trust-class audit lines name who asked
  // for the change (an attached socket's active session; a socket that never
  // attached an agent has none, and the line says nothing it cannot support).
  await applyConfigKeyEdit(core, keyPath, { value, valueText }, { actor: ws.activeSessionId })
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

// ── LIST edit (C2S editConfigList → S2C editConfigListResult) ────────────────
// Add / remove ONE ELEMENT of any array (the providers cards and every
// primitive LIST-chrome row) through the SAME verified transaction the value
// editor uses: read the in-use file, splice surgically, atomic temp+rename,
// rescue-verify, rollback-on-doubt (commitVerifiedEdit). What is not the
// targeted element survives byte-identically -- append borrows the array's own
// formatting through insertEntryIntoNode, remove cuts exactly one element
// under the comment-preserving doctrine of providerRemoveCuts (INDEX-
// addressed, so duplicate values are removable one at a time). The whole
// chain runs under the module edit lock (withConfigEditLock) so it can never
// interleave with a setConfigKey.

export type ConfigListEditOutcome = { ok: true; needsRestart: true } | { ok: false; error: string };

/** Any provider-name reference the PARSED file holds, EXCLUDING the element at
 *  skipPath (the one being removed never "references itself" through its own
 *  name field or its own "name/..." model keys). A reference is any object key
 *  or string value equal to `name`, or starting "name/" -- the loader matches
 *  provider ids exactly (config/index.ts: providers.find(p => p.name === name))
 *  and model registry keys are "name/…" (findModelKey suffix). The FIRST
 *  referencing keyPath is returned so the refusal names it; null when clean. */
function providerRemoveReferences(name: string, parsedFile: unknown, skipPath: string): string | null {
  if (name === "") return null;
  const walk = (node: unknown, path: string): string | null => {
    if (path === skipPath) return null; // the element being removed
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const r = walk(node[i], `${path}[${i}]`);
        if (r) return r;
      }
      return null;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const child = path === "" ? k : `${path}.${k}`;
        if (k === name || k.startsWith(`${name}/`)) return child;
        if (typeof v === "string" && (v === name || v.startsWith(`${name}/`))) return child;
        const r = walk(v, child);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(parsedFile, "");
}

/** Post-write read-back for a list op: the file parses (raw or JSONC) and the
 *  ARRAY at `pathSegs` equals `expected` exactly (order and members) -- append
 *  landed its one element, remove spliced exactly one out. Normalized-key
 *  walking, the loader's equivalence (same rules as verifyEdit's path walk). */
function verifyListValue(after: string, pathSegs: KeySeg[], expected: unknown[]): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(after);
  } catch {
    try {
      parsed = JSON.parse(stripJsonc(after).text);
    } catch {
      return false;
    }
  }
  const hit = fileRawValue(parsed, pathSegs);
  if (!hit.found || !Array.isArray(hit.value)) return false;
  try {
    return JSON.stringify(hit.value) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

type ListByteEdit = { ok: true; newText: string } | { ok: false; reason: "no-array" | "out-of-range" };

/** Mask-aware scan: position + char of the first structural character at or
 *  after `from` (whitespace and JSONC comments are transparent). Only ever run
 *  on the GAPS between array elements, which hold nothing but whitespace and
 *  comments -- no string there for a stray "/" to impersonate. */
function firstStructuralChar(text: string, from: number): { at: number; ch: string } {
  let i = from;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    return { at: i, ch: c };
  }
  return { at: text.length, ch: "" };
}

/** Does a JSONC comment START within [from, to)? (same gap-only guarantee as
 *  firstStructuralChar: the scanned range never contains a string value.) */
function commentInside(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const c = text[i] as string;
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) return true;
  }
  return false;
}

/** End of the comment starting at `at` ("//" or "/*"): line comments end AT
 *  their newline (the newline itself is not part of them); block comments
 *  end just past their two-char terminator. */
function commentEndAt(text: string, at: number): number {
  if (text[at + 1] === "/") {
    const nl = text.indexOf("\n", at);
    return nl < 0 ? text.length : nl;
  }
  const end = text.indexOf("*/", at + 2);
  return end < 0 ? text.length : end + 2;
}

/** The byte ranges a remove of elems[pos] deletes (application order: last
 *  start first). THE CUT DOCTRINE (owner ruling 2026-11-11, audit finding 2):
 * a cut swallows ONLY whitespace, at most one separator comma (plus a JSONC
 * trailing comma riding on the cut), and -- the one deliberately pinned
 * exception -- a comment that STARTS on the removed element's closing line
 * (spaces/tabs and at most its own comma in between); that comment describes
 * the line vanishing. Every other comment is user data and survives
 * byte-identical: a comment run between the element and its SUCCESSOR belongs
 * to the successor, and a comment run between the PREDECESSOR and the element
 * belongs to the predecessor. Cut shapes:
 *  - glued same-line comment: erase the element's whole LINE (leading
 *    newline+indent only when that run is comment-free). If the line swallowed
 *    no comma, or the element is last, the preceding separator comma dies too
 *    -- never may a dangling comma sit before the successor or before "]".
 *  - comment-free interior: non-last cuts [preceding separator comma, element
 *    end] (the element's own comma rises to separate the survivors, and its
 *    trailing comment run stays untouched after the cut); last cuts
 *    [preceding comma, element end + trailing comma if one sits bare there];
 *    first cuts [just past "[", own comma] so the successor's line keeps its
 *    own newline+indent.
 *  - an interior comment PINS the cut to the element: delete the element (+
 *    its own comma only when nothing comments between them) and the whitespace
 *    immediately after -- never a following comment run.
 * null = the grammar the locator accepted but this doctrine cannot cut
 * safely; the caller refuses the write. */
function providerRemoveCuts(
  text: string,
  arrNode: { open: number; close: number },
  elems: Array<{ valueStart: number; valueEnd: number }>,
  pos: number,
): Array<[number, number]> | null {
  const n = elems.length;
  const e = elems[pos]!;
  const prev = pos > 0 ? elems[pos - 1]! : null;
  const isLast = pos === n - 1;
  const killPrevComma = (cuts: Array<[number, number]>): Array<[number, number]> | null => {
    if (!prev) return null;
    const pc = firstStructuralChar(text, prev.valueEnd);
    if (pc.ch !== ",") return null;
    cuts.push([pc.at, pc.at + 1]);
    return cuts;
  };
  const cuts: Array<[number, number]> = [];

  // The same-line glued comment (the pinned exception) -- found through only
  // spaces/tabs and at most the element's own comma, never across a newline.
  let gp = e.valueEnd;
  while (" \t".includes(text[gp] as string)) gp++;
  let commaEaten = false;
  if (text[gp] === ",") {
    commaEaten = true;
    gp++;
    while (" \t".includes(text[gp] as string)) gp++;
  }
  if (text[gp] === "/" && (text[gp + 1] === "/" || text[gp + 1] === "*")) {
    let start = e.valueStart;
    while (start > arrNode.open + 1 && " \t".includes(text[start - 1] as string)) start--;
    if (text[start - 1] === "\n" && !commentInside(text, prev ? prev.valueEnd : arrNode.open + 1, e.valueStart)) start--;
    let end = commentEndAt(text, gp);
    for (;;) {
      let p = end;
      while (" \t\r".includes(text[p] as string)) p++;
      if (text[p] === ",") {
        if (commaEaten) break; // a second separator is the file's problem, not this cut's
        commaEaten = true;
        end = p + 1;
        continue;
      }
      if (text[p] === "\n") {
        let q = p + 1;
        while (" \t\r".includes(text[q] as string)) q++;
        if (text[q] === "," && !commaEaten) {
          commaEaten = true; // the comma sits on the line BELOW the comment: still this element's separator
          end = q + 1;
          continue;
        }
        break; // the line simply ends here -- a successor's newline belongs to the successor
      }
      break; // real content follows on this line: stop right after the comment
    }
    cuts.push([start, end]);
    if (isLast && n > 1) return killPrevComma(cuts); // no orphan trailing comma before "]"
    if (!commaEaten) {
      const nx = firstStructuralChar(text, end);
      if (nx.ch === ",") {
        cuts.push([nx.at, nx.at + 1]);
        return cuts;
      }
      return killPrevComma(cuts); // the element's comma eluded the line -- the preceding one dies instead
    }
    return cuts;
  }

  if (n === 1) {
    // Sole element: brackets AND everything commented between them survive;
    // only the element's bytes die (whitespace residue stays, still valid).
    return [[e.valueStart, e.valueEnd]];
  }

  if (pos === 0) {
    const oc = firstStructuralChar(text, e.valueEnd);
    if (oc.ch !== ",") return null;
    if (!commentInside(text, arrNode.open + 1, e.valueStart)) {
      cuts.push([arrNode.open + 1, oc.at + 1]); // the element's own line vanishes into "["
      return cuts;
    }
    let end = oc.at + 1; // interior comment pins the start; the element + its comma go
    while (" \t\r\n".includes(text[end] as string)) end++;
    cuts.push([e.valueStart, end]);
    return cuts;
  }

  const pc = firstStructuralChar(text, prev!.valueEnd);
  if (pc.ch !== ",") return null;
  const interiorClean = !commentInside(text, pc.at + 1, e.valueStart);
  if (!isLast) {
    if (interiorClean) {
      cuts.push([pc.at, e.valueEnd]); // the audit fixture: successor's comment run survives whole
      return cuts;
    }
    const oc = firstStructuralChar(text, e.valueEnd);
    if (oc.ch !== ",") return null;
    if (commentInside(text, e.valueEnd, oc.at)) {
      cuts.push([e.valueStart, e.valueEnd]); // even the element's own comma is comment-shielded
      let end = oc.at + 1;
      while (" \t\r\n".includes(text[end] as string)) end++;
      cuts.push([oc.at, end]);
      return cuts;
    }
    let end = oc.at + 1;
    while (" \t\r\n".includes(text[end] as string)) end++;
    cuts.push([e.valueStart, end]);
    return cuts;
  }

  if (interiorClean) {
    let end = e.valueEnd;
    let q = end;
    while (q < arrNode.close && " \t\n\r".includes(text[q] as string)) q++;
    if (text[q] === ",") end = q + 1; // a bare JSONC trailing comma dies with the last element
    cuts.push([pc.at, end]);
    return cuts;
  }
  cuts.push([e.valueStart, e.valueEnd]);
  const tc = firstStructuralChar(text, e.valueEnd);
  if (tc.ch === "," && tc.at < arrNode.close) cuts.push([tc.at, tc.at + 1]);
  return killPrevComma(cuts); // kills the separator so no dangling comma precedes the surviving comment run
}

/** Splice an ARRAY in `text` (generalized from the providers-only helper --
 *  the provider cards and every primitive list share one byte discipline).
 *  op append: insert `args.entry` (already-built JSON text: `{"name": ...}`
 *  for the providers list, JSON.stringify(value) for primitive arrays) as
 *  the last element, formatting borrowed from the array. op remove: delete
 *  element `args.index` per the CUT DOCTRINE in providerRemoveCuts --
 *  comments are user data and survive. Elements address by INDEX, so two
 *  equal values are two distinct addresses and the right one dies.
 *  `located` is locateJsonStructure(text), which already parsed
 *  (comment-masked) the file. */
function editArrayText(
  text: string,
  located: NonNullable<ReturnType<typeof locateJsonStructure>>,
  op: ConfigListOp,
  path: KeySeg[],
  args: { entry?: string; index?: number },
): ListByteEdit {
  const arrNode = located.arrays.get(spellPath(path));
  if (!arrNode) return { ok: false, reason: "no-array" };
  if (op === "append") {
    return { ok: true, newText: insertEntryIntoNode(text, arrNode, args.entry as string) };
  }
  const idx = args.index as number;
  const elems = located.members
    .filter(
      (m) =>
        m.segs.length === path.length + 1 &&
        typeof m.segs[path.length] === "number" &&
        spellPath(m.segs.slice(0, path.length)) === spellPath(path),
    )
    .sort((a, b) => a.valueStart - b.valueStart);
  const pos = elems.findIndex((m) => m.segs[path.length] === idx);
  if (pos < 0) return { ok: false, reason: "out-of-range" };
  const cuts = providerRemoveCuts(text, arrNode, elems, pos);
  if (!cuts) return { ok: false, reason: "no-array" }; // the locator parsed it; the doctrine still refuses to cut it blind
  let out = text;
  for (const [s, end] of [...cuts].sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + out.slice(end);
  return { ok: true, newText: out };
}

async function applyConfigListEditLocked(
  core: CoreContext,
  keyPath: string,
  op: ConfigListOp,
  input: { name?: unknown; index?: unknown; value?: unknown },
  opts: { argv?: string[]; deps?: ConfigEditDeps } = {},
): Promise<ConfigListEditOutcome> {
  const deps = opts.deps ?? realConfigEditDeps;
  const argv = opts.argv ?? process.argv;
  const configDir = (typeof core.resolved?.configDir === "string" && core.resolved.configDir) || resolveConfigDir();
  const filePath = inUseConfigPath(argv, configDir);
  const refusal = `edit in file: ${filePath} (hotdog rescue validates it)`;
  const unparseable = `config file does not parse -- refusing to write; run "hotdog rescue" (${refusal})`;

  const segs = parseKeyPath(keyPath);
  if (!segs || segs.length === 0) return { ok: false, error: `"${keyPath}" is not an addressable config path -- ${refusal}` };

  // Same predicate as the snapshot filter and the key-write gate (defense in
  // depth -- a hidden chrome row means no append/remove button exists, yet a
  // hand-built frame must not land dead bytes either). Refuses before the file
  // is opened: the array path and its element paths inherit the leaf's posture.
  const hiddenList = unreachableLeaf(unifiedSchemaFor(core), segs);
  if (hiddenList) return { ok: false, error: notSettableFromFileDialog(keyPath, hiddenList, core) };
  // Tombstone gate, same table and same refusal as the scalar write gate:
  // list ops must not land bytes under a retired key either.
  const deadList = removedKeyRefusal(keyPath, segs);
  if (deadList) return { ok: false, error: deadList };

  // Frame shape. The providers list keeps its historic shape verbatim (the
  // client's add/remove rides `name` because its elements are OBJECTS):
  // append targets the "providers" root, remove targets providers[<index>].
  // Every other array rides the GENERIC shape: append targets the array
  // itself and carries a typed `value`, remove targets <array>[<index>] (an
  // index field, when present, must agree with the keyPath -- both shapes).
  const headIsProviders = typeof segs[0] === "string" && normalizeKey(segs[0]) === "providers";
  const isProvidersAppend = op === "append" && headIsProviders && segs.length === 1;
  const isProvidersRemove = op === "remove" && headIsProviders && segs.length === 2 && typeof segs[1] === "number";
  let removeIndex = -1;
  if (op === "append") {
    if (isProvidersAppend) {
      if (input.value !== undefined) {
        return { ok: false, error: `appending to "providers" takes a name, not a value (its elements are objects)` };
      }
    } else {
      if (input.name !== undefined) {
        return { ok: false, error: `appending to "${keyPath}" takes a value, not a name (only "providers" names its elements)` };
      }
      if (typeof segs[segs.length - 1] === "number") {
        return { ok: false, error: `append must target the array itself (got "${keyPath}")` };
      }
    }
  } else if (isProvidersRemove) {
    removeIndex = segs[1] as number;
    if (input.index !== undefined && input.index !== removeIndex) {
      return { ok: false, error: `frame index ${JSON.stringify(input.index)} disagrees with keyPath "${keyPath}"` };
    }
  } else if (typeof segs[segs.length - 1] === "number") {
    removeIndex = segs[segs.length - 1] as number;
    if (input.index !== undefined && input.index !== removeIndex) {
      return { ok: false, error: `frame index ${JSON.stringify(input.index)} disagrees with keyPath "${keyPath}"` };
    }
  } else {
    return { ok: false, error: `remove must target "<array>[<index>]" (got "${keyPath}")` };
  }

  const report = await diagnoseConfigFile(filePath);
  const hadFile = report.status !== "missing";
  if (hadFile && report.parsedText === null) return { ok: false, error: unparseable };
  let parsedFile: unknown;
  try {
    parsedFile = report.parsedText === null ? undefined : JSON.parse(report.parsedText);
  } catch {
    parsedFile = undefined;
  }
  let newText: string;
  let expected: unknown[];
  let verifyPath: KeySeg[]; // the ARRAY the post-write read-back compares

  if (isProvidersAppend) {
    const providers = parsedProviders(parsedFile);
    const providersIsArray = Array.isArray(providers);
    const before: unknown[] = providersIsArray ? (providers as unknown[]) : [];
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name === "") return { ok: false, error: "refusing to add a provider: the name is empty" };
    for (const el of before) {
      if (el && typeof el === "object" && !Array.isArray(el) && (el as Record<string, unknown>).name === name) {
        return { ok: false, error: `a provider named "${name}" already exists -- refusing to add a duplicate` };
      }
    }
    expected = [...before, { name }];
    const entry = `{ "name": ${JSON.stringify(name)} }`;
    if (hadFile && providersIsArray) {
      const located = locateJsonStructure(report.rawText);
      if (!located) return { ok: false, error: unparseable };
      const edit = editArrayText(report.rawText, located, "append", ["providers"], { entry });
      if (!edit.ok) return { ok: false, error: unparseable };
      newText = edit.newText;
    } else if (hadFile) {
      // The value is absent OR broken -- and broken means BYTE-PRESERVING
      // refusal (owner 2026-11-11, audit finding 5): replacing a present-but-
      // unparseable value (a typo string, a dotted fallback map) would
      // silently discard what the user wrote, even if the loader cannot use
      // it. The file stays the interface until the block itself is fixed.
      if (parsedProviders(parsedFile) !== undefined) {
        return { ok: false, error: `"providers" is present but is not an array in the file -- refusing to append; fix the providers block first (${refusal})` };
      }
      // Providers key absent: create it (top-level insert, root formatting).
      const edit = editConfigText(report.rawText, ["providers"], `[ ${entry} ]`);
      if (!edit.ok) return { ok: false, error: unparseable };
      newText = edit.newText;
    } else {
      newText = `{\n  "providers": [\n    ${entry}\n  ]\n}\n`;
    }
    verifyPath = ["providers"];
  } else if (isProvidersRemove) {
    const providers = parsedProviders(parsedFile);
    if (!Array.isArray(providers)) return { ok: false, error: `"providers" is not an array in the file -- refusing to remove (${refusal})` };
    const before: unknown[] = providers;
    if (removeIndex < 0 || removeIndex >= before.length) {
      return { ok: false, error: `no provider at index ${removeIndex} -- the file holds ${before.length} (${refusal})` };
    }
    const target = before[removeIndex];
    const targetName =
      target && typeof target === "object" && !Array.isArray(target) ? (target as Record<string, unknown>).name : undefined;
    if (typeof targetName === "string") {
      const referrer = providerRemoveReferences(targetName, parsedFile, `providers[${removeIndex}]`);
      if (referrer) {
        return { ok: false, error: `"${targetName}" is still referenced by "${referrer}" -- remove that reference first (${refusal})` };
      }
    }
    expected = before.filter((_, j) => j !== removeIndex);
    const located = hadFile ? locateJsonStructure(report.rawText) : null;
    if (!located) return { ok: false, error: unparseable };
    const edit = editArrayText(report.rawText, located, "remove", ["providers"], { index: removeIndex });
    if (!edit.ok) return { ok: false, error: edit.reason === "out-of-range" ? `no provider at index ${removeIndex} (${refusal})` : unparseable };
    newText = edit.newText;
    verifyPath = ["providers"];
  } else if (op === "append") {
    // ── GENERIC append: one typed element onto a primitive array ──────────
    const value = input.value;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return { ok: false, error: `append needs a value (string, number, or boolean) for "${keyPath}"` };
    }
    const entry = JSON.stringify(value);
    const cur = parsedFile === undefined ? { found: false, value: undefined } : fileRawValue(parsedFile, segs);
    if (cur.found) {
      const items = primitiveArrayItems(cur.value);
      if (!Array.isArray(cur.value)) {
        // Present-but-not-an-array is the audit-finding-5 doctrine extended
        // to every list: those are USER BYTES; replacing them to "help" the
        // user would silently discard what they wrote.
        return { ok: false, error: `"${keyPath}" is present but is not an array in the file -- refusing to append; fix the block first (${refusal})` };
      }
      if (items === null) {
        return {
          ok: false,
          error: `"${keyPath}" holds objects or nulls -- append supports primitive lists (and "providers"); refusing to guess the element shape (${refusal})`,
        };
      }
      // Validation: the schema's items declaration when it exists (type,
      // bounds, enum -- the exact gate the element rows ride), else the
      // array's own element kind (an EMPTY array accepts any primitive:
      // the file offers no shape to disagree with).
      const itemsProp = arrayItemsProp(findLeafProp(unifiedSchemaFor(core), segs));
      if (itemsProp !== null) {
        const invalid = validateEditValue(itemsProp.type as string, value, itemsProp, keyPath);
        if (invalid) return { ok: false, error: invalid };
      } else if (items.length > 0 && typeof value !== typeof items[0]) {
        return {
          ok: false,
          error: `"${keyPath}" holds ${typeof items[0]} elements -- appending a ${typeof value} would mix types (${refusal})`,
        };
      }
      expected = [...items, value];
      const located = locateJsonStructure(report.rawText);
      if (!located) return { ok: false, error: unparseable };
      const edit = editArrayText(report.rawText, located, "append", segs, { entry });
      if (!edit.ok) return { ok: false, error: unparseable };
      newText = edit.newText;
    } else {
      // Absent: an array is created element by element ONLY where the schema
      // declares a list (or a known provider child whose declaration says
      // json) -- an unknown key has nothing to validate against (fail closed;
      // the file stays the interface).
      const provJson = providerChildCreateTarget(segs, parsedFile)?.type === "json";
      if (!schemaListChrome(findLeafProp(unifiedSchemaFor(core), segs)) && !provJson) {
        return {
          ok: false,
          error: `no schema entry declares "${keyPath}" an array on this server and no value is in the file -- refusing to invent it (${refusal})`,
        };
      }
      expected = [value];
      // Even when the array is created, the declared items schema gates the
      // value (an absent array with items {type:"string", enum:[...]} must
      // not accept an off-set first element).
      const itemsProp = arrayItemsProp(findLeafProp(unifiedSchemaFor(core), segs));
      if (itemsProp !== null) {
        const invalid = validateEditValue(itemsProp.type as string, value, itemsProp, keyPath);
        if (invalid) return { ok: false, error: invalid };
      }
      if (hadFile) {
        const edit = editConfigText(report.rawText, segs, `[ ${entry} ]`);
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
          return { ok: false, error: unparseable };
        }
        newText = edit.newText;
      } else {
        newText = `{\n  ${buildChainText(segs, `[ ${entry} ]`, "  ", true)}\n}\n`;
      }
    }
    verifyPath = segs;
  } else {
    // ── GENERIC remove: one element of ANY array, same cut doctrine ───────
    // Elements address by INDEX, so a file holding the same value twice is
    // removable one occurrence at a time: the cut splices BYTE RANGES the
    // locator assigned to that index, and which occurrence survives is
    // decided by address, never by value equality.
    const parent = segs.slice(0, -1);
    const cur = parsedFile === undefined || parent.length === 0
      ? { found: false, value: undefined }
      : fileRawValue(parsedFile, parent);
    if (!cur.found || !Array.isArray(cur.value)) {
      return { ok: false, error: `"${keyString(parent)}" is not an array in the file -- refusing to remove (${refusal})` };
    }
    const before = cur.value as unknown[];
    if (removeIndex >= before.length) {
      return {
        ok: false,
        error: `no element at index ${removeIndex} in "${keyString(parent)}" -- the array holds ${before.length} (${refusal})`,
      };
    }
    expected = before.filter((_, j) => j !== removeIndex);
    const located = hadFile ? locateJsonStructure(report.rawText) : null;
    if (!located) return { ok: false, error: unparseable };
    const edit = editArrayText(report.rawText, located, "remove", parent, { index: removeIndex });
    if (!edit.ok) {
      return {
        ok: false,
        error:
          edit.reason === "out-of-range"
            ? `no element at index ${removeIndex} in "${keyString(parent)}" (${refusal})`
            : `"${keyString(parent)}" holds a shape the surgical cut cannot make safely -- refusing to write (${refusal})`,
      };
    }
    newText = edit.newText;
    verifyPath = parent;
  }

  // The same approvals pre-compile as the value editor: an appended or removed
  // element must leave a rule block that still compiles, or the file stays as it
  // was. `expected` is the whole array this op produces, spliced at the array's
  // own path -- which is exactly what a list op edits.
  const gateRefusal = candidateRuleBlockRefusal(core, verifyPath, expected);
  if (gateRefusal) return { ok: false, error: gateRefusal };

  return commitVerifiedEdit({
    filePath,
    newText,
    hadFile,
    rawText: report.rawText,
    deps,
    refusal,
    logTag: "editConfigList",
    verify: (after) => verifyListValue(after, verifyPath, expected),
    onOk: () => ({ ok: true, needsRestart: true }),
  });
}

/** Serialized entry point for the LIST ops (see withConfigEditLock). */
export function applyConfigListEdit(
  core: CoreContext,
  keyPath: string,
  op: ConfigListOp,
  input: { name?: unknown; index?: unknown; value?: unknown },
  opts: { argv?: string[]; deps?: ConfigEditDeps } = {},
): Promise<ConfigListEditOutcome> {
  return withConfigEditLock(() => applyConfigListEditLocked(core, keyPath, op, input, opts));
}

export async function handleConfigListEdit(ctx: RouteContext): Promise<void> {
  const { ws, msg, core } = ctx;
  const requestId = typeof msg.requestId === "number" ? msg.requestId : undefined;
  const keyPath = msg.keyPath;
  const op = msg.op;
  // Frame-shape gate: keyPath is a config key string and op is exactly one of
  // the two list ops. name (append) / index (remove) are validated deeper, in
  // the handler, where the file is in hand.
  if (typeof keyPath !== "string" || keyPath === "" || (op !== "append" && op !== "remove")) {
    SessionRegistry.sendSafe(ws, {
      type: S2C.EDIT_CONFIG_LIST_RESULT,
      requestId,
      ok: false,
      error: 'editConfigList needs keyPath (string) and op ("append" | "remove")',
    });
    return;
  }
  await applyConfigListEdit(core, keyPath, op as ConfigListOp, { name: msg.name, index: msg.index, value: msg.value })
    .then((result) => {
      SessionRegistry.sendSafe(ws, { ...result, type: S2C.EDIT_CONFIG_LIST_RESULT, requestId });
    })
    .catch((err: unknown) => {
      logger.warn(`[websocket] editConfigList failed: ${formatError(err)}`);
      SessionRegistry.sendSafe(ws, { type: S2C.EDIT_CONFIG_LIST_RESULT, requestId, ok: false, error: errorText(err) });
    });
}
