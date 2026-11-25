/**
 * Extension distribution: extensionPaths entries that name an npm specifier,
 * a git URL, or a file: source are installed with bun into a user-level
 * opt-in tree, then handed to the existing loader as another bundle directory.
 * No new loader semantics: specifier detection + install + hand-off.
 *
 * The tree is a minimal bun project (package.json + node_modules) at
 * ~/.hotdog/extensions (HOTDOG_EXTENSIONS_DIR overrides; env-only like
 * HOTDOG_DATA_DIR -- extensionPaths resolution happens DURING config loading,
 * so the root cannot come from config). The core package.json stays empty of
 * dependencies; everything lands here, in the tree the user opted into.
 *
 * Supply-chain posture (docs/supply-chain.md):
 * - `bun add --ignore-scripts`: lifecycle scripts -- the ChainDrop/TanStack
 *   detonation seat -- never fire. The extension's index.ts is the declared
 *   trust boundary, not its postinstall.
 * - pin what gets installed: a spec naming no version floats silently, so it
 *   is pinned to the resolved version (--exact) and the pin is named loudly.
 * - offline once installed: a present dependency is never re-resolved. Boots
 *   touch the network only when something named in extensionPaths is missing.
 * - the SDK anchor: node_modules/@read-receipt/hotdog is a symlink to the
 *   running checkout, so installed extensions import the SAME module graph
 *   the harness runs (one sdk, no duplicated singletons or error classes) --
 *   the bun link story, done once for the tree.
 * - no implicit registry access: an entry installs from npm only behind the
 *   explicit `npm:` prefix. Everything else that is not a git prefix or a
 *   `file:` source is a filesystem path -- even a token that looks exactly
 *   like a package name. The registry is never consulted by guessing, which
 *   closes the dependency-confusion direction entirely.
 */

import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, formatError } from "../error.ts";
import { logger } from "@utils/logger.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The package root (holds package.json + the exports map), not src/: the
// anchor symlink must point at what `bun add @read-receipt/hotdog` would place.
const PKG_ROOT = path.resolve(__dirname, "../../../");

export const EXTENSIONS_ROOT_ENV = "HOTDOG_EXTENSIONS_DIR";

/** The install root; env-only (see the module comment for why). */
export function extensionsInstallRoot(): string {
  const override = process.env[EXTENSIONS_ROOT_ENV];
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".hotdog", "extensions");
}

export type ExtensionSpecKind = "alias" | "fs" | "npm" | "git" | "file";

export interface ClassifiedSpec {
  kind: ExtensionSpecKind;
  /** Package name for npm specifiers (null for every other kind). */
  name: string | null;
}

const GIT_PREFIX_RE = /^(git|git\+ssh|git\+https|git\+http|git\+git|github|gitlab|bitbucket):/i;
// Name parsing for the part after `npm:`: scoped "@scope/name[@version]"
// (exactly one slash) or bare "name[@version-or-tag]".
const NPM_SCOPED_RE = /^(@[^/@]+)\/([^/@]+)(@[^/]+)?$/;
const NPM_BARE_RE = /^([~a-zA-Z0-9][-~a-zA-Z0-9._]*)@([^/]+)$/;
const SIMPLE_NAME_RE = /^[~a-zA-Z0-9][-~a-zA-Z0-9._]*$/;
const EXACT_VERSION_RE = /^v?\d+\.\d+\.\d+([-+].*)?$/;

/**
 * classify what an extensionPaths entry names. The registry is reachable
 * only behind the explicit `npm:` prefix; git prefixes and `file:` are
 * unmistakable by shape; everything else is a filesystem path.
 */
export function classifyExtensionSpec(spec: string): ClassifiedSpec {
  if (spec === "@extensions" || spec === "@experimental") return { kind: "alias", name: null };
  if (spec.startsWith("file:")) return { kind: "file", name: null };
  if (spec.startsWith("npm:")) {
    const bare = spec.slice(4);
    const scoped = NPM_SCOPED_RE.exec(bare);
    if (scoped && scoped[1] && scoped[2]) return { kind: "npm", name: `${scoped[1]}/${scoped[2]}` };
    const m = NPM_BARE_RE.exec(bare);
    if (m && m[1] && !m[1].startsWith("@")) return { kind: "npm", name: m[1] };
    if (SIMPLE_NAME_RE.test(bare)) return { kind: "npm", name: bare };
    // "npm:" with something unparseable behind it: still an npm request
    // (bun judges it at install); there is just no name to match on, so
    // installed-lookup falls back to the recorded value.
    return { kind: "npm", name: null };
  }
  if (GIT_PREFIX_RE.test(spec) || spec.includes("://") || spec.endsWith(".git")) {
    return { kind: "git", name: null };
  }
  return { kind: "fs", name: null };
}

/**
 * Install-time policy for an `npm:` spec: an exact version or a bounded
 * range rides as written; a floating request (no version, or a dist-tag) is
 * pinned with --exact so the tree records what actually landed. npm: aliases
 * (`npm:alias@npm:real`) are handed to bun as written.
 */
export function npmInstallPolicy(spec: string): { floats: boolean; exactFlag: boolean } {
  const bare = spec.startsWith("npm:") ? spec.slice(4) : spec;
  const at = bare.lastIndexOf("@");
  // at > 0: a version/tag part exists (at 0 is a scoped name's own @).
  const version = at > 0 ? bare.slice(at + 1) : "";
  if (version.startsWith("npm:")) return { floats: false, exactFlag: false };
  if (!version) return { floats: true, exactFlag: true };
  if (EXACT_VERSION_RE.test(version)) return { floats: false, exactFlag: false };
  // A range starts with a comparator or a digit; anything else is a dist-tag
  // (latest, next, beta) -- silently moving, so pin it.
  if (/^[~><=^v\d]/.test(version)) return { floats: false, exactFlag: false };
  return { floats: true, exactFlag: true };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsPromises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readDependencies(root: string): Promise<Record<string, string>> {
  try {
    const raw = await fsPromises.readFile(path.join(root, "package.json"), "utf-8");
    const deps = (JSON.parse(raw) as { dependencies?: unknown }).dependencies;
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function installedVersion(dir: string): Promise<string | null> {
  try {
    const raw = await fsPromises.readFile(path.join(dir, "package.json"), "utf-8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Create the install tree if needed: a private bun project plus the SDK
 * anchor symlink. An anchor that exists as a real directory belongs to the
 * user (they bun added the published sdk themselves) and is left alone; a
 * symlink is retargeted so it always names the RUNNING checkout.
 */
export async function ensureInstallRoot(root = extensionsInstallRoot()): Promise<void> {
  await fsPromises.mkdir(root, { recursive: true });
  const pkgPath = path.join(root, "package.json");
  if (!(await exists(pkgPath))) {
    await fsPromises.writeFile(
      pkgPath,
      JSON.stringify({ name: "hotdog-extension-host", private: true, dependencies: {} }, null, 2) + "\n",
    );
  }
  const anchor = path.join(root, "node_modules", "@read-receipt", "hotdog");
  try {
    const link = await fsPromises.readlink(anchor);
    if (path.resolve(path.dirname(anchor), link) === PKG_ROOT) return;
    await fsPromises.rm(anchor, { force: true });
  } catch {
    if (await exists(anchor)) return; // a real directory: the user's own install
  }
  await fsPromises.mkdir(path.dirname(anchor), { recursive: true });
  try {
    await fsPromises.symlink(PKG_ROOT, anchor, "dir");
  } catch (e) {
    logger.warn(
      `[extensions] could not anchor @read-receipt/hotdog to ${PKG_ROOT}: ${formatError(e)} -- ` +
        `installed extensions may not resolve the sdk`,
    );
  }
}

/** Which installed package (if any) satisfies this spec, by directory. */
export async function installedExtensionDir(spec: string, root = extensionsInstallRoot()): Promise<string | null> {
  const cls = classifyExtensionSpec(spec);
  if (cls.kind !== "npm" && cls.kind !== "git" && cls.kind !== "file") return null;
  const deps = await readDependencies(root);
  let pkgName: string | null = null;
  if (cls.kind === "npm" && cls.name) {
    // npm identity is the name; the recorded range stays whatever was pinned.
    if (deps[cls.name] !== undefined) pkgName = cls.name;
  } else {
    // git/file record the requested spec verbatim as the dependency value.
    pkgName = Object.keys(deps).find((k) => deps[k] === spec) ?? null;
  }
  if (!pkgName) return null;
  const dir = path.join(root, "node_modules", pkgName);
  return (await exists(dir)) ? dir : null;
}

export interface ExtensionInstallResult {
  pkgName: string;
  dir: string;
  version: string | null;
  /** True when the request floated and this install pinned it. */
  floats: boolean;
}

async function runBun(root: string, argv: string[]): Promise<{ code: number; output: string }> {
  // process.execPath is the running bun -- the same runtime, so installs and
  // the harness never disagree about which bun resolved the tree.
  const proc = Bun.spawn([process.execPath, ...argv], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, output: (stdout + stderr).trim() };
}

function tail(s: string, max = 600): string {
  return s.length > max ? `...${s.slice(-max)}` : s;
}

/**
 * Install one specifier into the tree. Throws ConfigError on any failure;
 * boot resolution catches it and degrades (see ensureExtensionSourceDir).
 */
export async function installExtensionSpec(
  spec: string,
  root = extensionsInstallRoot(),
): Promise<ExtensionInstallResult> {
  const cls = classifyExtensionSpec(spec);
  if (cls.kind !== "npm" && cls.kind !== "git" && cls.kind !== "file") {
    throw new ConfigError(
      `"${spec}" is not an installable specifier (npm:<name>[@version], a git URL, or file:<path>)`,
    );
  }
  await ensureInstallRoot(root);
  const before = await readDependencies(root);

  const policy = cls.kind === "npm" ? npmInstallPolicy(spec) : { floats: false, exactFlag: false };
  const argv = ["add", "--ignore-scripts"];
  if (policy.exactFlag) argv.push("--exact");
  argv.push(spec);

  const run = await runBun(root, argv);
  // bun prunes what it does not track; re-ensure the anchor so a run that
  // dropped it leaves the tree working again.
  await ensureInstallRoot(root);
  if (run.code !== 0) {
    throw new ConfigError(`bun add ${spec} failed (exit ${run.code}):\n${tail(run.output)}`);
  }

  const after = await readDependencies(root);
  let pkgName: string | null = null;
  if (cls.kind === "npm" && cls.name && after[cls.name] !== undefined) pkgName = cls.name;
  if (!pkgName) {
    // The new key, or the key whose value moved -- what `bun add` just wrote.
    for (const [k, v] of Object.entries(after)) {
      if (before[k] !== v) {
        pkgName = k;
        break;
      }
    }
  }
  if (!pkgName) pkgName = Object.keys(after).find((k) => after[k] === spec) ?? null;

  const dir = pkgName ? path.join(root, "node_modules", pkgName) : "";
  if (!pkgName || !(await exists(dir))) {
    throw new ConfigError(
      `bun add ${spec} finished but no package directory was found -- inspect ${path.join(root, "package.json")}`,
    );
  }
  return { pkgName, dir, version: await installedVersion(dir), floats: policy.floats };
}

/**
 * The boot seam: the bundle directory an installed-spec lives in, installing
 * on miss. Null means unavailable (install failed, e.g. offline): the caller
 * skips the entry loudly rather than killing the boot -- the same
 * probe-and-degrade the sdk-range check uses. An already-installed package
 * never touches the network, so boots stay offline.
 */
const ensureCache = new Map<string, Promise<string | null>>();

export function ensureExtensionSourceDir(spec: string): Promise<string | null> {
  const key = `${extensionsInstallRoot()} ${spec}`;
  let pending = ensureCache.get(key);
  if (!pending) {
    pending = ensureSource(spec);
    ensureCache.set(key, pending);
  }
  return pending;
}

async function ensureSource(spec: string): Promise<string | null> {
  const hit = await installedExtensionDir(spec);
  if (hit) return hit;
  logger.warn(
    `[extensions] installing "${spec}" into ${extensionsInstallRoot()} (one-time; ` +
      `boots afterward use the installed copy, offline)`,
  );
  try {
    const r = await installExtensionSpec(spec);
    logger.info(`[extensions] installed ${r.pkgName}${r.version ? `@${r.version}` : ""} -> ${r.dir}`);
    if (r.floats) {
      logger.warn(
        `[extensions] "${spec}" names no version; pinned ${r.pkgName}@${r.version} in the install tree. ` +
          `Move it deliberately with \`hotdog extension install npm:${r.pkgName}@<version>\`.`,
      );
    }
    return r.dir;
  } catch (e) {
    logger.error(`[extensions] could not install "${spec}": ${formatError(e)}`);
    logger.error(
      `[extensions] skipping this entry. Retry with \`hotdog extension install ${spec}\`, ` +
        `or remove it from extensionPaths. Extensions that are already installed load normally.`,
    );
    return null;
  }
}

// ── CLI runners (`hotdog extension install|update|list`) ───────────────────

export interface ExtensionInstallOptions {
  /** Positional args after the verb. */
  specs: string[];
  json: boolean;
}

export async function runExtensionInstall(opts: ExtensionInstallOptions): Promise<number> {
  const root = extensionsInstallRoot();
  if (opts.specs.length === 0) {
    const usage = "usage: hotdog extension install <spec>... (npm:<name>[@version], a git URL, or file:<path>)";
    if (opts.json) console.log(JSON.stringify({ error: usage }, null, 2));
    else console.error(usage);
    return 1;
  }
  const results: Array<Record<string, unknown>> = [];
  let failed = 0;
  for (const spec of opts.specs) {
    try {
      const r = await installExtensionSpec(spec, root);
      results.push({ spec, ok: true, package: r.pkgName, version: r.version, dir: r.dir, pinned_floating: r.floats });
      if (opts.json) continue;
      console.log(`installed ${r.pkgName}${r.version ? `@${r.version}` : ""} -> ${r.dir}`);
      if (r.floats) {
        console.log(
          `  the request named no version, so the resolved version was pinned. ` +
            `Move it deliberately: hotdog extension install npm:${r.pkgName}@<version>`,
        );
      }
      console.log(`  to load it, add "${spec}" to extensionPaths in your config (the value REPLACES the default).`);
    } catch (e) {
      failed++;
      results.push({ spec, ok: false, error: formatError(e) });
      if (!opts.json) console.error(`${spec}: ${formatError(e)}`);
    }
  }
  if (opts.json) console.log(JSON.stringify({ root, results }, null, 2));
  return failed > 0 ? 1 : 0;
}

export interface ExtensionUpdateOptions {
  /** Package names to update; empty updates everything in the tree. */
  names: string[];
  json: boolean;
}

export async function runExtensionUpdate(opts: ExtensionUpdateOptions): Promise<number> {
  const root = extensionsInstallRoot();
  if (!(await exists(path.join(root, "package.json")))) {
    const msg = `nothing installed: ${root} holds no extension tree yet`;
    if (opts.json) console.log(JSON.stringify({ root, error: msg }, null, 2));
    else console.log(msg);
    return 0;
  }
  const before = await readDependencies(root);
  // bun update names packages, not install specs: accept the npm: spelling
  // (and a stray @version tail) and resolve both to the package name.
  const names = opts.names.map((n) => {
    const bare = n.startsWith("npm:") ? n.slice(4) : n;
    const at = bare.lastIndexOf("@");
    return at > 0 ? bare.slice(0, at) : bare;
  });
  const run = await runBun(root, ["update", "--ignore-scripts", ...names]);
  await ensureInstallRoot(root);
  if (run.code !== 0) {
    const msg = `bun update failed (exit ${run.code}):\n${tail(run.output)}`;
    if (opts.json) console.log(JSON.stringify({ root, error: msg }, null, 2));
    else console.error(msg);
    return 1;
  }
  const after = await readDependencies(root);
  const changes = Object.entries(after)
    .filter(([k, v]) => before[k] !== v)
    .map(([k, v]) => ({ name: k, from: before[k] ?? null, to: v }));
  if (opts.json) {
    console.log(JSON.stringify({ root, output: run.output, changes }, null, 2));
  } else {
    if (run.output) console.log(run.output);
    console.log(
      changes.length > 0
        ? changes.map((c) => `${c.name}: ${c.from} -> ${c.to}`).join("\n")
        : "up to date (recorded pins never move silently; install npm:<name>@<version> to move one)",
    );
  }
  return 0;
}

export interface ExtensionListOptions {
  json: boolean;
  /** Configured extensionPaths, when the config loaded (for cross-reference). */
  extensionPaths?: string[];
}

interface ListedPackage {
  name: string;
  requested: string;
  version: string | null;
  installed: boolean;
  referenced: boolean;
}

export async function runExtensionList(opts: ExtensionListOptions): Promise<number> {
  const root = extensionsInstallRoot();
  const deps = await readDependencies(root);
  const anchor = path.join(root, "node_modules", "@read-receipt", "hotdog");
  const packages: ListedPackage[] = [];
  for (const [name, requested] of Object.entries(deps)) {
    const dir = path.join(root, "node_modules", name);
    const present = await exists(dir);
    packages.push({
      name,
      requested,
      version: present ? await installedVersion(dir) : null,
      installed: present,
      referenced: opts.extensionPaths?.some(
        (p) => p === requested || classifyExtensionSpec(p).name === name,
      ) ?? false,
    });
  }
  const unresolved = (opts.extensionPaths ?? [])
    .filter((p) => ["npm", "git", "file"].includes(classifyExtensionSpec(p).kind))
    .filter((p) => packages.every((pkg) => pkg.requested !== p && classifyExtensionSpec(p).name !== pkg.name))
    .map((spec) => ({ spec, installed: false }));

  if (opts.json) {
    console.log(
      JSON.stringify(
        { root, sdk_anchor: await exists(anchor), packages, uninstalled_specs: unresolved },
        null,
        2,
      ),
    );
    return 0;
  }
  console.log(`extension root: ${root}`);
  console.log(`sdk anchor:   ${(await exists(anchor)) ? "ok (@read-receipt/hotdog -> running checkout)" : "MISSING (repaired on next install/update)"}`);
  if (packages.length === 0) {
    console.log("packages:     (none)");
  } else {
    console.log("packages:");
    for (const p of packages) {
      const state = p.installed ? `${p.version ?? "version unknown"}` : "NOT INSTALLED";
      console.log(`  ${p.name}  ${state}  <- ${p.requested}${p.referenced ? "  [in extensionPaths]" : ""}`);
    }
  }
  for (const u of unresolved) {
    console.log(`  ${u.spec}  NOT INSTALLED  hotdog extension install ${u.spec}`);
  }
  return 0;
}
