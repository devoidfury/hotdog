/**
 * `hotdog extension validate <dir>` -- rescue-style diagnostics for extensions.
 *
 * <dir> names ONE extension directory (holds extension.json) or a BUNDLE ROOT
 * to scan -- the same duality as an extensionPaths entry. Per extension: the
 * manifest (strict JSON with line/column findings -- the loader parses with
 * JSON.parse, so comments and trailing commas are fatal), field types against
 * the loader's own vocabulary, the `sdk` range verdict against the running
 * version, the entry point, the config-schema defaults through the real
 * extraction path, the service contracts, then a DRY LOAD through the real
 * ExtensionLoader. Import failures get named verdicts: an unanchored
 * `@read-receipt/hotdog` import is the bun-link story, not a stack dump.
 *
 * Also reports manifest-only directories: discovery requires extension.json
 * AND index.{ts,js}, so such a directory is INVISIBLE to the loader -- the
 * exact silent miss this command exists to catch.
 *
 * main() dispatches here before buildConfig(), rescue-style: validating an
 * extension must work even when the user's config is broken.
 */

import fsPromises from "node:fs/promises";
import path from "node:path";

import { createHooks } from "../hooks.ts";
import { createToolRegistry } from "./tool-registry.ts";
import { createServiceRegistry } from "./service-registry.ts";
import { createSubcommandRegistry } from "./registries.ts";
import { ConfigRegistry } from "./config.ts";
import { createCompletionService } from "../completion.ts";
import { getDefaultConfig } from "../config/index.ts";
import {
  discoverExtensionsInDir,
  ExtensionLoader,
  getExtensionConfigDefaults,
  isExtensionDirectory,
  validateServiceContracts,
  type DiscoveredExtension,
  type LoaderCore,
} from "./extensions.ts";
import { errorExcerpt, findJsonError, lineColAt } from "../config/rescue.ts";
import { parseVersionRange, rangeMatches } from "@utils/version.ts";
import { formatError } from "../error.ts";
import pkg from "@package.json" with { type: "json" };

export interface ExtensionValidateOptions {
  /** Positional args after the subcommand name: ["validate", "<dir>"]. */
  args: string[];
  json: boolean;
}

export interface ValidateFinding {
  severity: "problem" | "warning";
  stage: "dir" | "manifest" | "fields" | "sdk" | "entry" | "config" | "resolve" | "load" | "services";
  message: string;
  hint?: string;
  line?: number;
  column?: number;
}

export interface ExtensionValidateReport {
  name: string;
  dir: string;
  load: "ok" | "failed" | "skipped";
  tools: string[];
  provides: string[];
  load_order: number;
  sdk: {
    declared: string | null;
    current: string;
    verdict: "none" | "compatible" | "mismatch" | "invalid";
  };
  config_defaults: Array<{ key: string; defaults: unknown }>;
  findings: ValidateFinding[];
}

export interface ExtensionValidateEnvelope {
  dir: string;
  mode: "extension" | "bundle" | "empty";
  hotdog_version: string;
  findings: ValidateFinding[];
  extensions: ExtensionValidateReport[];
  problems: number;
  warnings: number;
}

const USAGE = [
  "usage: hotdog extension validate <dir> [--json]",
  "",
  "<dir> is one extension directory (extension.json + index.ts) or a bundle root to scan.",
  "Validates the manifest (strict JSON, field types, sdk range), the entry point, the",
  "config defaults, the service contracts, and dry-loads through the real extension loader.",
].join("\n");

async function exists(p: string): Promise<boolean> {
  try {
    await fsPromises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function hasEntry(dir: string): Promise<boolean> {
  return (await exists(path.join(dir, "index.ts"))) || (await exists(path.join(dir, "index.js")));
}

/**
 * Directories holding extension.json but no index.{ts,js}: isExtensionDirectory
 * requires both, so the loader never even reads these manifests. Recuses the
 * tree (skipping node_modules/.git and discovered extension dirs, whose
 * internals are not scanned by discovery either).
 */
async function findOrphanManifestDirs(root: string, known: Set<string>): Promise<string[]> {
  const orphans: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasManifest = entries.some((e) => e.isFile() && e.name === "extension.json");
    if (hasManifest && !known.has(dir) && !(await hasEntry(dir))) {
      orphans.push(dir);
      return; // an orphan manifest dir is not descended (discovery stops at extensions too)
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git" || known.has(path.join(dir, e.name))) continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  }
  await walk(root, 0);
  return orphans;
}

function scratchCore(): LoaderCore {
  return {
    hooks: createHooks(),
    toolRegistry: createToolRegistry(),
    services: createServiceRegistry(),
    completion: createCompletionService(),
    config: getDefaultConfig() as LoaderCore["config"],
    configRegistry: new ConfigRegistry(),
    cliSubcommandRegistry: createSubcommandRegistry(),
  };
}

/** Import-failure triage: the anchor story first, then the doors, then the raw error. */
function classifyLoadError(e: unknown): ValidateFinding {
  const msg = e instanceof Error ? e.message : String(e);
  if (/@read-receipt\/hotdog/.test(msg)) {
    const specifier = /'(@read-receipt\/hotdog[^']*)'/.exec(msg)?.[1] ?? "@read-receipt/hotdog";
    if (/Cannot find package/.test(msg)) {
      return {
        severity: "problem",
        stage: "resolve",
        message: `the import of "${specifier}" has no anchor: this directory resolves the hotdog package nowhere.`,
        hint:
          "three anchors: inside the hotdog clone it resolves by self-reference; for your own bundle run " +
          "`bun link` in the hotdog checkout then `bun link @read-receipt/hotdog` in the bundle; for a project " +
          "run `bun add @read-receipt/hotdog`.",
      };
    }
    return {
      severity: "problem",
      stage: "resolve",
      message: `the hotdog import "${specifier}" was refused -- it names no published door.`,
      hint:
        "doors are '.' (root), './sdk' (authoring contract), './testing' (the extension test kit) " +
        "and './utils/*' (utilities); everything else " +
        "under src/ is internal. (If the anchor itself is missing, see the bun link story: `bun link` " +
        "in the hotdog checkout, then `bun link @read-receipt/hotdog` here.)",
    };
  }
  if (/ENOENT|Cannot find module|Could not resolve/.test(msg)) {
    return {
      severity: "problem",
      stage: "load",
      message: `the entry point (or a module it imports) could not be resolved: ${msg}`,
    };
  }
  return {
    severity: "problem",
    stage: "load",
    message: `import/create() threw: ${formatError(e)}`,
  };
}

async function validateOne(
  meta: DiscoveredExtension,
  log: (s?: string) => void,
): Promise<ExtensionValidateReport> {
  const findings: ValidateFinding[] = [];
  const report: ExtensionValidateReport = {
    name: meta.name,
    dir: meta.dirPath,
    load: "skipped",
    tools: [],
    provides: meta.provides ?? [],
    load_order: meta.loadOrder ?? 10,
    sdk: { declared: null, current: pkg.version as string, verdict: "none" },
    config_defaults: [],
    findings,
  };

  const add = (f: ValidateFinding): void => {
    findings.push(f);
    const mark = f.severity === "problem" ? "PROBLEM" : "WARN ";
    const where = f.line !== undefined ? ` (line ${f.line}${f.column !== undefined ? `, column ${f.column}` : ""})` : "";
    log(`  ${mark} [${f.stage}]${where} ${f.message}`);
    if (f.hint) log(`         fix: ${f.hint}`);
  };

  log(`--- ${meta.name} (${meta.dirPath}) ---`);

  // 1. Manifest: strict JSON (the loader parses with JSON.parse).
  const metaFile = path.join(meta.dirPath, "extension.json");
  let manifest: Record<string, unknown> | null = null;
  let raw: string | null = null;
  try {
    raw = await fsPromises.readFile(metaFile, "utf-8");
  } catch (e) {
    add({ severity: "problem", stage: "manifest", message: `extension.json is unreadable: ${formatError(e)}` });
  }
  if (raw !== null) {
    try {
      manifest = JSON.parse(raw) as Record<string, unknown>;
      if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
        add({ severity: "problem", stage: "manifest", message: "extension.json must contain a JSON object" });
        manifest = null;
      }
    } catch (e) {
      const idx = findJsonError(raw);
      if (idx !== null) {
        const { line, column } = lineColAt(raw, idx);
        add({
          severity: "problem",
          stage: "manifest",
          message:
            "extension.json is not valid strict JSON (the loader parses with JSON.parse: no comments, no trailing commas) -- broken manifest, fatal for any run that loads it",
          line,
          column,
        });
        log(errorExcerpt(raw, idx));
      } else {
        add({
          severity: "problem",
          stage: "manifest",
          message: `extension.json failed to parse: ${(e as Error).message}`,
        });
      }
    }
  }
  // The loader's own reader can fail a manifest that PARSES (e.g. a bad `sdk`
  // range): surface its exact verdict too.
  if (manifest && meta.manifestError) {
    add({ severity: "problem", stage: "manifest", message: meta.manifestError });
  }

  // 2. sdk verdict from the RAW declaration (the loader drops a bad range
  // before it reaches metadata).
  const rawSdk = manifest?.sdk;
  if (rawSdk === undefined || rawSdk === null) {
    log(`  sdk: no declaration (loader assumes this version)`);
  } else if (typeof rawSdk !== "string" || parseVersionRange(rawSdk) === null) {
    report.sdk.declared = typeof rawSdk === "string" ? rawSdk : JSON.stringify(rawSdk);
    report.sdk.verdict = "invalid";
    // A bad range already made the manifest broken above -- one finding each.
    if (!meta.manifestError) {
      add({
        severity: "problem",
        stage: "sdk",
        message: `invalid "sdk" range ${JSON.stringify(rawSdk)} (comparators >= > <= < =, whitespace-joined; no wildcards)`,
      });
    }
  } else {
    report.sdk.declared = rawSdk;
    const ok = rangeMatches(pkg.version as string, parseVersionRange(rawSdk));
    report.sdk.verdict = ok ? "compatible" : "mismatch";
    if (ok) {
      log(`  sdk: "${rawSdk}" is compatible with hotdog ${pkg.version}`);
    } else {
      add({
        severity: "warning",
        stage: "sdk",
        message: `declares sdk "${rawSdk}" but this hotdog is ${pkg.version} -- boot would load it anyway, loudly warning`,
      });
    }
  }

  // 3. Field-type lint (the loader warns and ignores these; they are findings
  // here because the manifest SAYS something the loader will not hear).
  if (manifest) {
    const fieldProblems: Array<[string, (v: unknown) => string | null]> = [
      ["provides", (v) => (Array.isArray(v) ? null : "not an array - the loader ignores it")],
      ["dependsOn", (v) => (Array.isArray(v) ? null : "not an array - the loader ignores it")],
      ["loadOrder", (v) => (typeof v === "number" ? null : "not a number - the loader ignores it")],
      ["description", (v) => (typeof v === "string" ? null : "not a string - reported as empty")],
      ["autoload", (v) => (typeof v === "boolean" ? null : "not a boolean - treated as true")],
      ["configSchema", (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? null : "not an object - the loader ignores it")],
      ["services", (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? null : "not an object - the loader ignores it")],
      ["requires", (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? null : "not an object - the loader ignores it")],
      ["cli:flags", (v) => (Array.isArray(v) ? null : "not an array - the loader ignores it")],
      ["cli:subcommands", (v) => (Array.isArray(v) ? null : "not an array - the loader ignores it")],
    ];
    for (const [field, check] of fieldProblems) {
      const value = manifest[field];
      if (value === undefined) continue;
      const why = check(value);
      if (why) add({ severity: "warning", stage: "fields", message: `"${field}" ${why}` });
    }
    if (typeof manifest.name !== "string" || manifest.name === "") {
      add({
        severity: "warning",
        stage: "fields",
        message: `no usable "name" - the loader falls back to the directory name "${path.basename(meta.dirPath)}"`,
      });
    }
  }

  // 4. Entry point. Discovery accepts index.js, but the resolved loader entry
  // is always index.ts (discoverExtensions builds that specifier) -- a
  // js-only directory discovers, then dies at import.
  const entry = path.join(meta.dirPath, "index.ts");
  const entryExists = await exists(entry);
  if (!entryExists) {
    const js = await exists(path.join(meta.dirPath, "index.js"));
    add({
      severity: "problem",
      stage: "entry",
      message: js
        ? `no index.ts: index.js exists, and while discovery accepts the directory, the loader's resolved entry specifier is index.ts -- import would fail`
        : `no entry point: the loader imports index.ts at ${meta.dirPath} and it does not exist`,
    });
  } else {
    log(`  entry: OK (${entry})`);
  }

  // 5. Config defaults through the real extraction path.
  try {
    const defs = await getExtensionConfigDefaults([meta.dirPath]);
    report.config_defaults = defs.map((d) => ({ key: d.key, defaults: d.defaults }));
    if (defs.length > 0) {
      log(`  config defaults: ${defs.map((d) => `${d.key}=${JSON.stringify(d.defaults)}`).join(", ")}`);
    } else {
      log(`  config defaults: none declared`);
    }
  } catch (e) {
    add({ severity: "warning", stage: "config", message: `config-schema extraction failed: ${formatError(e)}` });
  }

  // 6. Dry load through the real loader -- only when the manifest is trusted
  // and the entry exists; otherwise every downstream verdict is noise.
  const trusted = manifest !== null && !meta.manifestError;
  if (trusted && entryExists) {
    try {
      const core = scratchCore();
      const loader = new ExtensionLoader(core);
      const before = new Set(core.toolRegistry.getAll().map(([n]) => n));
      const instance = await loader.load(meta.name, entry, {
        taskManager: null,
        provides: meta.provides ?? [],
        dependsOn: meta.dependsOn ?? [],
      });
      report.tools = core.toolRegistry.getAll().map(([n]) => n).filter((n) => !before.has(n)).sort();
      if (instance === null) {
        add({ severity: "warning", stage: "load", message: "create() returned null (self-disabled instance); nothing registered" });
      }
      for (const err of validateServiceContracts([meta], core.services)) {
        add({ severity: "problem", stage: "services", message: err.message });
      }
      report.load = "ok";
      log(`  dry-load: OK - tools: ${report.tools.length > 0 ? report.tools.join(", ") : "(none)"}`);
    } catch (e) {
      report.load = "failed";
      add(classifyLoadError(e));
      log(`  dry-load: FAILED`);
    }
  } else {
    const reasons: string[] = [];
    if (manifest === null || meta.manifestError) reasons.push("manifest broken");
    if (!entryExists) reasons.push("entry missing");
    log(`  dry-load: SKIPPED (${reasons.join(", ") || "prior findings"})`);
  }
  log();
  return report;
}

export async function runExtensionValidate(opts: ExtensionValidateOptions): Promise<number> {
  const [verb, dirArg] = opts.args;
  if (verb !== "validate" || !dirArg) {
    if (opts.json) console.log(JSON.stringify({ error: USAGE }, null, 2));
    else console.error(USAGE);
    return 1;
  }

  const log = opts.json ? (_s?: string) => {} : (s = "") => console.log(s);
  const topFindings: ValidateFinding[] = [];
  const addTop = (f: ValidateFinding): void => {
    topFindings.push(f);
    const mark = f.severity === "problem" ? "PROBLEM" : "WARN ";
    log(`  ${mark} [${f.stage}] ${f.message}`);
    if (f.hint) log(`         fix: ${f.hint}`);
  };

  log("hotdog extension validate - extension diagnostics");
  log();

  const dir = path.resolve(dirArg);
  let dirExists = false;
  try {
    dirExists = (await fsPromises.stat(dir)).isDirectory();
  } catch {}
  if (!dirExists) {
    log(`Target: ${dir}`);
    addTop({ severity: "problem", stage: "dir", message: "the directory does not exist (or is not a directory)" });
    const envelope: ExtensionValidateEnvelope = {
      dir, mode: "empty", hotdog_version: pkg.version as string,
      findings: topFindings, extensions: [], problems: 1, warnings: 0,
    };
    if (opts.json) console.log(JSON.stringify(envelope, null, 2));
    else log(`\n1 problem(s) found.`);
    return 1;
  }

  log(`Target: ${dir}`);
  const discovered = await discoverExtensionsInDir(dir);
  const mode = (await isExtensionDirectory(dir)) ? "extension" : discovered.length > 0 ? "bundle" : "empty";
  log(`Mode:   ${mode}${mode === "extension" ? " (single extension)" : mode === "bundle" ? ` (${discovered.length} extension(s) found scanning)` : ""}`);
  log();

  const reports: ExtensionValidateReport[] = [];

  if (mode === "empty") {
    if (await exists(path.join(dir, "extension.json"))) {
      // Manifest without entry: invisible to discovery, so judge it directly.
      const fake: DiscoveredExtension = {
        name: path.basename(dir),
        path: "",
        dirPath: dir,
        provides: [], loadOrder: 10, description: "", dependsOn: [], autoload: true,
        configSchema: null, cliSubcommands: [], cliFlags: [], services: {}, requires: {},
      };
      reports.push(await validateOne(fake, log));
    } else {
      addTop({
        severity: "problem",
        stage: "dir",
        message: "no extension found: extension.json is missing here and in every subdirectory (discovery needs extension.json + index.ts|js)",
      });
      log();
    }
  } else {
    for (const ext of discovered) {
      reports.push(await validateOne(ext, log));
    }
  }

  // Manifest-only directories the loader cannot see at all.
  const known = new Set([dir, ...discovered.map((d) => d.dirPath)]);
  for (const orphan of await findOrphanManifestDirs(dir, known)) {
    addTop({
      severity: "problem",
      stage: "dir",
      message: `${orphan} holds extension.json but no index.ts/index.js -- discovery requires both, so the loader never reads this manifest`,
    });
  }

  let problems = topFindings.filter((f) => f.severity === "problem").length;
  let warnings = topFindings.filter((f) => f.severity === "warning").length;
  for (const r of reports) {
    problems += r.findings.filter((f) => f.severity === "problem").length;
    warnings += r.findings.filter((f) => f.severity === "warning").length;
  }

  if (opts.json) {
    const envelope: ExtensionValidateEnvelope = {
      dir, mode, hotdog_version: pkg.version as string,
      findings: topFindings, extensions: reports, problems, warnings,
    };
    console.log(JSON.stringify(envelope, null, 2));
    return problems === 0 ? 0 : 1;
  }

  if (problems === 0) {
    log(warnings > 0 ? `No problems. ${warnings} warning(s).` : "No problems found.");
    return 0;
  }
  log(`${problems} problem(s)${warnings > 0 ? `, ${warnings} warning(s)` : ""} found.`);
  return 1;
}
