// Extension distribution: npm/git/file specifiers in extensionPaths install
// into the user-level tree (HOTDOG_EXTENSIONS_DIR in tests) and load as
// ordinary bundle dirs. Real temp dirs and real `bun add` runs (file: and
// git+file: are offline), no mocks.

import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  classifyExtensionSpec,
  ensureInstallRoot,
  extensionsInstallRoot,
  installedExtensionDir,
  installExtensionSpec,
  npmInstallPolicy,
  runExtensionInstall,
  runExtensionList,
} from "@core/extensions/install.ts";
import {
  ExtensionLoader,
  getExtensionsToLoad,
  type LoaderCore,
} from "@core/extensions/extensions.ts";
import { runExtensionValidate } from "@core/extensions/validate.ts";
import { createHooks } from "@core/hooks.ts";
import { createToolRegistry } from "@core/extensions/tool-registry.ts";
import { createServiceRegistry } from "@core/extensions/service-registry.ts";
import { ConfigRegistry } from "@core/extensions/config.ts";
import { createSubcommandRegistry } from "@core/extensions/registries.ts";
import { createCompletionService } from "@core/completion.ts";
import { tmpDir, cleanupDir } from "../mocks/io.ts";

const dirs: string[] = [];
const originalRoot = process.env.HOTDOG_EXTENSIONS_DIR;
afterEach(() => {
  while (dirs.length > 0) cleanupDir(dirs.pop()!);
  if (originalRoot === undefined) delete process.env.HOTDOG_EXTENSIONS_DIR;
  else process.env.HOTDOG_EXTENSIONS_DIR = originalRoot;
});

/** An isolated install tree for one test (unique root: the boot memo is keyed per root). */
function isolatedRoot(prefix: string): string {
  const base = tmpDir(prefix);
  dirs.push(base);
  const root = path.join(base, "ext");
  process.env.HOTDOG_EXTENSIONS_DIR = root;
  return root;
}

/** A bundle package: root-level extension importing the sdk through the anchor. */
async function makeFixturePkg(name: string): Promise<string> {
  const base = tmpDir("hotdog-dist-fx-");
  dirs.push(base);
  const pkg = path.join(base, name);
  await fs.mkdir(pkg, { recursive: true });
  await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name, version: "1.2.3" }));
  await fs.writeFile(
    path.join(pkg, "extension.json"),
    JSON.stringify({ name, sdk: ">=0.1", description: "dist fixture", provides: ["tools"] }),
  );
  // The sdk import is the point: it must resolve through the install root's
  // anchor symlink to the RUNNING checkout.
  await fs.writeFile(
    path.join(pkg, "index.ts"),
    `import { HOOKS } from "@read-receipt/hotdog/sdk";
export function create() {
  return { hooks: { [HOOKS.TOOL_METADATA]: () => "fired" } };
}\n`,
  );
  return pkg;
}

function scratchCore(): LoaderCore {
  return {
    hooks: createHooks(),
    toolRegistry: createToolRegistry(),
    services: createServiceRegistry(),
    completion: createCompletionService(),
    configRegistry: new ConfigRegistry(),
    cliSubcommandRegistry: createSubcommandRegistry(),
  };
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string[] }> {
  const orig = console.log;
  const origErr = console.error;
  const out: string[] = [];
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => out.push(a.join(" "));
  try {
    return { code: await fn(), out };
  } finally {
    console.log = orig;
    console.error = origErr;
  }
}

describe("classifyExtensionSpec: npm needs the explicit prefix", () => {
  const cases: Array<[string, "alias" | "fs" | "npm" | "git" | "file", string | null]> = [
    ["@extensions", "alias", null],
    ["@experimental", "alias", null],
    ["/abs/somewhere", "fs", null],
    ["./my-extensions", "fs", null],
    ["../side-bundle", "fs", null],
    ["my-ext", "fs", null],
    ["some/dir", "fs", null],
    ["@scope", "fs", null],
    // No implicit npm, in any package-shaped spelling:
    ["@read-receipt/example-extension", "fs", null],
    ["@read-receipt/example-extension@1.2.3", "fs", null],
    ["example-extension@1.0.0", "fs", null],
    // The explicit prefix, parsed to the package name:
    ["npm:foo", "npm", "foo"],
    ["npm:foo@1.2.3", "npm", "foo"],
    ["npm:foo@^1.0.0", "npm", "foo"],
    ["npm:@read-receipt/example-extension", "npm", "@read-receipt/example-extension"],
    ["npm:@read-receipt/example-extension@2.0.0", "npm", "@read-receipt/example-extension"],
    ["git:github.com/read-receipt/example-extension", "git", null],
    ["github:read-receipt/example-extension#v1.0.0", "git", null],
    ["git+https://github.com/read-receipt/example-extension.git", "git", null],
    ["https://github.com/read-receipt/example-extension.git", "git", null],
    ["git@github.com:read-receipt/example-extension.git", "git", null],
    ["file:./local-bundle", "file", null],
  ];
  for (const [spec, kind, name] of cases) {
    it(`${spec} -> ${kind}`, () => {
      expect(classifyExtensionSpec(spec)).toEqual({ kind, name });
    });
  }
});

describe("npm install policy: silently-moving refs get pinned", () => {
  const cases: Array<[string, boolean, boolean]> = [
    ["npm:@read-receipt/example-extension", true, true], // no version: floats, pinned with --exact
    ["npm:@read-receipt/example-extension@beta", true, true], // dist-tag: floats
    ["npm:@read-receipt/example-extension@1.2.3", false, false], // exact: rides as written
    ["npm:@read-receipt/example-extension@^1.2.0", false, false], // bounded range: the user's constraint
    ["npm:@read-receipt/example-extension@>=1 <2", false, false],
    ["npm:x@npm:other", false, false], // alias: handed to bun as written
  ];
  for (const [spec, floats, exactFlag] of cases) {
    it(`${spec} floats=${floats} exact=${exactFlag}`, () => {
      expect(npmInstallPolicy(spec)).toEqual({ floats, exactFlag });
    });
  }
});

describe("install tree: layout, anchor, offline re-resolution", () => {
  it("installs a file: bundle and the anchor lets the extension import the sdk", async () => {
    const root = isolatedRoot("hotdog-dist-");
    const pkg = await makeFixturePkg("dist-ext");

    const r = await installExtensionSpec(`file:${pkg}`, root);
    expect(r.pkgName).toBe("dist-ext");
    expect(r.version).toBe("1.2.3");
    expect(r.dir).toBe(path.join(root, "node_modules", "dist-ext"));

    // Tree shape: private bun project + anchor symlink to this checkout.
    const pkgJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf-8"));
    expect(pkgJson.private).toBe(true);
    expect(pkgJson.dependencies["dist-ext"]).toBe(`file:${pkg}`);
    const anchor = path.join(root, "node_modules", "@read-receipt", "hotdog");
    expect(await fs.realpath(anchor)).toBe(await fs.realpath(path.resolve(import.meta.dir, "../..")));

    // The extension's `@read-receipt/hotdog/sdk` import resolves through the
    // anchor: load it for real and see the hook land on the shared HOOKS table.
    const [meta] = await getExtensionsToLoad([`file:${pkg}`], true, []);
    expect(meta).toBeDefined();
    expect(meta!.name).toBe("dist-ext");
    const core = scratchCore();
    const loader = new ExtensionLoader(core);
    const instance = await loader.load(meta!.name, meta!.path!);
    expect(instance).not.toBeNull();
    expect(core.hooks.handlerCount("tool:metadata")).toBe(1);
  });

  it("a present dependency resolves without the network: deleting the source keeps it loadable", async () => {
    const root = isolatedRoot("hotdog-dist-");
    const pkg = await makeFixturePkg("offline-ext");
    await installExtensionSpec(`file:${pkg}`, root);

    // The installed copy is real bytes; with the source gone only the tree
    // remains, and the entry still resolves (boots never re-run bun add).
    await fs.rm(pkg, { recursive: true, force: true });
    const dir = await installedExtensionDir(`file:${pkg}`, root);
    expect(dir).toBe(path.join(root, "node_modules", "offline-ext"));
    const [meta] = await getExtensionsToLoad([`file:${pkg}`], true, []);
    expect(meta?.name).toBe("offline-ext");
  });

  it("installs from a local git repo at a pinned commit", async () => {
    const root = isolatedRoot("hotdog-dist-");
    const base = tmpDir("hotdog-dist-git-");
    dirs.push(base);
    const repo = path.join(base, "src");
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "git-ext", version: "0.3.0" }));
    await fs.writeFile(path.join(repo, "extension.json"), JSON.stringify({ name: "git-ext", sdk: ">=0.1" }));
    await fs.writeFile(path.join(repo, "index.ts"), "export function create() { return {}; }\n");
    const git = async (...args: string[]) => {
      const p = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
      const code = await p.exited;
      if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
      return new Response(p.stdout).text();
    };
    await git("init", "-q", "-b", "main", ".");
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await git("add", "-A");
    await git("commit", "-qm", "init");
    const commit = (await git("rev-parse", "HEAD")).trim();

    const spec = `git+file://${repo}#${commit}`;
    const r = await installExtensionSpec(spec, root);
    expect(r.pkgName).toBe("git-ext");
    const [meta] = await getExtensionsToLoad([spec], true, []);
    expect(meta?.name).toBe("git-ext");
  });

  it("a missing install degrades loudly: discovery skips the entry, nothing throws", async () => {
    isolatedRoot("hotdog-dist-");
    const metas = await getExtensionsToLoad(["file:/no/such/bundle"], true, []);
    expect(metas).toEqual([]);
  });

  it("a nested node_modules under a bundle root is never scanned", async () => {
    const base = tmpDir("hotdog-dist-nm-");
    dirs.push(base);
    const nested = path.join(base, "node_modules", "sneaky");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "extension.json"), JSON.stringify({ name: "sneaky" }));
    await fs.writeFile(path.join(nested, "index.ts"), "export function create() { return {}; }\n");
    const metas = await getExtensionsToLoad([base], true, []);
    expect(metas.map((m) => m.name)).toEqual([]);
  });

  it("ensureInstallRoot retargets a stale anchor symlink", async () => {
    const root = isolatedRoot("hotdog-dist-");
    await ensureInstallRoot(root);
    const anchor = path.join(root, "node_modules", "@read-receipt", "hotdog");
    expect(await fs.realpath(anchor)).toBe(await fs.realpath(path.resolve(import.meta.dir, "../..")));
    // A symlink left pointing at an old checkout location is moved back to
    // the running one on the next ensure.
    await fs.rm(anchor, { force: true });
    await fs.symlink("/somewhere/old/hotdog", anchor, "dir");
    await ensureInstallRoot(root);
    expect(await fs.realpath(anchor)).toBe(await fs.realpath(path.resolve(import.meta.dir, "../..")));
  });
});

describe("extension install / list runners", () => {
  it("install refuses a non-specifier with usage-grade feedback", async () => {
    isolatedRoot("hotdog-dist-");
    const { code, out } = await capture(() => runExtensionInstall({ specs: ["./some/dir"], json: false }));
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("not an installable specifier");
  });

  it("install then list: the package is recorded and cross-referenced against extensionPaths", async () => {
    const root = isolatedRoot("hotdog-dist-");
    const pkg = await makeFixturePkg("listed-ext");
    const spec = `file:${pkg}`;

    const inst = await capture(() => runExtensionInstall({ specs: [spec], json: true }));
    expect(inst.code).toBe(0);
    const env = JSON.parse(inst.out.join("\n"));
    expect(env.results[0]).toMatchObject({ spec, ok: true, package: "listed-ext", version: "1.2.3" });

    const list = await capture(() => runExtensionList({ json: true, extensionPaths: ["@extensions", spec] }));
    expect(list.code).toBe(0);
    const lenv = JSON.parse(list.out.join("\n"));
    expect(lenv.root).toBe(root);
    expect(lenv.sdk_anchor).toBe(true);
    expect(lenv.packages[0]).toMatchObject({ name: "listed-ext", installed: true, referenced: true });
    expect(lenv.uninstalled_specs).toEqual([]);
  });

  it("list names configured-but-uninstalled specs with the fix", async () => {
    isolatedRoot("hotdog-dist-");
    const { code, out } = await capture(() =>
      runExtensionList({ json: false, extensionPaths: ["@extensions", "npm:@read-receipt/example-extension@1.0.0"] }),
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("npm:@read-receipt/example-extension@1.0.0  NOT INSTALLED");
    expect(out.join("\n")).toContain("hotdog extension install npm:@read-receipt/example-extension@1.0.0");
  });

  it("validate on an uninstalled spec points at the install command (it never installs)", async () => {
    isolatedRoot("hotdog-dist-");
    const { code, out } = await capture(() =>
      runExtensionValidate({ args: ["validate", "npm:@read-receipt/example-extension@1.0.0"], json: false }),
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("[dir]");
    expect(out.join("\n")).toContain("not installed");
    expect(out.join("\n")).toContain("hotdog extension install npm:@read-receipt/example-extension@1.0.0");
    expect(existsSync(extensionsInstallRoot())).toBe(false);
  });
});
