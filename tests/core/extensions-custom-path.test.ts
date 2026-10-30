// H6 integration: an extension under a documented custom `extensionPaths`
// directory must actually load through ExtensionLoader.load(). Discovery
// emits ROOT_DIR-relative ("./..." / "../...") specifiers for non-alias
// dirs; a bare relative specifier handed to import() resolves against the
// importing module (src/core/extensions/), not src/, so load() must
// resolve-and-URL-ize them. Real temp dirs only, no mocks.

import { describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import {
  ExtensionLoader,
  getExtensionsToLoad,
  type LoaderCore,
} from "@core/extensions/extensions.ts";
import { createHooks } from "@core/hooks.ts";
import { createToolRegistry } from "@core/extensions/tool-registry.ts";
import { createServiceRegistry } from "@core/extensions/service-registry.ts";
import { ConfigRegistry } from "@core/extensions/config.ts";
import { createSubcommandRegistry } from "@core/extensions/registries.ts";
import { createCompletionService } from "@core/completion.ts";

// Standard extension shape (see src/extensions/*/index.ts): a `create`
// export the loader invokes with the core, returning the instance.
const INDEX_TS = `
export function create() {
  return {
    name: "probe-ext",
    hooks: { "probe:ping": () => "pong" },
  };
}
`;

async function makeProbeExtRoot(prefix: string): Promise<string> {
  const tmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
  const extDir = nodePath.join(tmp, "probe-ext");
  await fs.mkdir(extDir);
  await fs.writeFile(
    nodePath.join(extDir, "extension.json"),
    JSON.stringify({ name: "probe-ext", description: "H6 probe", provides: [] }),
  );
  await fs.writeFile(nodePath.join(extDir, "index.ts"), INDEX_TS);
  return tmp;
}

describe("custom extensionPaths end-to-end load (H6)", () => {
  let core: LoaderCore;

  beforeEach(() => {
    core = {
      hooks: createHooks(),
      toolRegistry: createToolRegistry(),
      services: createServiceRegistry(),
      configRegistry: new ConfigRegistry(),
      cliSubcommandRegistry: createSubcommandRegistry(),
      completion: createCompletionService(),
    };
  });

  // Exercises the documented chain: config spec -> resolveExtensionPath ->
  // discoverExtensions descriptor -> ExtensionLoader.load().
  async function loadViaSpec(spec: string): Promise<void> {
    const [meta] = await getExtensionsToLoad([spec], true, []);
    expect(meta).toBeDefined();
    expect(meta!.name).toBe("probe-ext");

    const loader = new ExtensionLoader(core);
    const instance = await loader.load(meta!.name, meta!.path!);
    expect(instance).not.toBeNull();
    expect((instance as { name?: string }).name).toBe("probe-ext");
    expect(loader.has("probe-ext")).toBe(true);
    // Hook from the temp module is registered off the real file URL.
    expect(core.hooks.handlerCount("probe:ping")).toBe(1);
  }

  it("loads from an ABSOLUTE extensionPaths spec", async () => {
    const tmp = await makeProbeExtRoot("hotdog-ext-h6-abs-");
    try {
      await loadViaSpec(tmp);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // resolveExtensionPath resolves relative specs against process.cwd()
  // (src/core/extensions/extensions.ts:19-33), so a cwd-relative spec is the
  // documented "./my-extensions" form.
  it("loads from a RELATIVE (cwd-based) extensionPaths spec", async () => {
    const tmp = await makeProbeExtRoot("hotdog-ext-h6-rel-");
    try {
      const relSpec = nodePath.relative(process.cwd(), tmp);
      expect(nodePath.isAbsolute(relSpec)).toBe(false);
      await loadViaSpec(relSpec);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
