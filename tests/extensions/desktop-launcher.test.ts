// Tests for @experimental/desktop — launcher resolution (pure), single-
// instance lock, remote URL admission, the config/key posture, the UI hash
// handoff, and the local handler's full boot→window→drain lifecycle against
// the real createWebuiServer with a fake window (no mock.module anywhere;
// the launcher is a constructor seam).

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BROWSER_CANDIDATES_MACOS,
  browserLaunchArgs,
  compileShimArgs,
  launcherOrder,
  MACOS_ATS_PLIST,
  MACOS_SHIM_FLAGS,
  macosSectcreateFlag,
  planLauncher,
  planMacosShim,
  shimCacheKey,
  splitPkgConfigFlags,
  type LauncherProbe,
} from "@experimental/desktop/launcher.ts";
import {
  acquireInstanceLock,
  lockFilePath,
  releaseInstanceLock,
  updateInstanceLockPort,
} from "@experimental/desktop/lock.ts";
import {
  create,
  desktopServerConfig,
  handleDesktopSubcommand,
  hydrateModelRegistry,
  localAppUrl,
  validateRemoteUrl,
} from "@experimental/desktop/index.ts";
import { parseHandoffHash, consumeHandoffToken } from "@extensions/webui/ui/login.tsx";
import { HOOKS } from "@core/hooks.ts";
import { ServiceRegistry } from "@core/extensions/service-registry.ts";
import { createMockRegistry } from "../test-helpers.ts";

// ── launcher planning ───────────────────────────────────────────────────────

const OK_PKG = { code: 0, stdout: "-lgtk-4 -lgobject-2.0 -lwebkit-2 -I/inc", stderr: "" };

function fakeProbe(over: Partial<LauncherProbe> = {}): LauncherProbe {
  return {
    platform: "linux",
    arch: "x64",
    which: () => null,
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    exists: async () => false,
    readFile: async () => new TextEncoder().encode("SHIM-SOURCE"),
    ...over,
  };
}

describe("launcher planning", () => {
  it("shimCacheKey: stable per (source, flags, arch), distinct per input", () => {
    const src = new TextEncoder().encode("A");
    const base = shimCacheKey(src, "-lgtk", "x64");
    expect(base).toBe(shimCacheKey(new TextEncoder().encode("A"), "-lgtk", "x64"));
    expect(shimCacheKey(new TextEncoder().encode("B"), "-lgtk", "x64")).not.toBe(base);
    expect(shimCacheKey(src, "-lgtk4", "x64")).not.toBe(base);
    expect(shimCacheKey(src, "-lgtk", "arm64")).not.toBe(base);
  });

  it("compileShimArgs / browserLaunchArgs / splitPkgConfigFlags shapes", () => {
    expect(compileShimArgs("cc", "/s.c", "/out", ["-lgtk"])).toEqual([
      "cc",
      "-O2",
      "-o",
      "/out",
      "/s.c",
      "-lgtk",
    ]);
    const args = browserLaunchArgs("http://127.0.0.1:9/#tok=x", "/prof");
    expect(args).toContain("--app=http://127.0.0.1:9/#tok=x");
    expect(args).toContain("--user-data-dir=/prof");
    expect(args).toContain("--no-first-run");
    expect(splitPkgConfigFlags("  -la  -lb \n -lc ")).toEqual(["-la", "-lb", "-lc"]);
    // The darwin compile invocation, assembled: one argv token for the
    // sectcreate triplet (comma-joined), the plist path verbatim.
    expect(
      compileShimArgs("clang", "/s.macos.m", "/out", [
        ...MACOS_SHIM_FLAGS,
        macosSectcreateFlag("/tmp/build.info.plist"),
      ]),
    ).toEqual([
      "clang",
      "-O2",
      "-o",
      "/out",
      "/s.macos.m",
      ...MACOS_SHIM_FLAGS,
      "-Wl,-sectcreate,__TEXT,__info_plist,/tmp/build.info.plist",
    ]);
    expect(splitPkgConfigFlags("  -la  -lb \n -lc ")).toEqual(["-la", "-lb", "-lc"]);
  });

  it("linux + cc + frameworks -> shim plan, cached flag from exists()", async () => {
    const plan = await planLauncher(
      fakeProbe({ which: (n) => (n === "cc" ? "/usr/bin/cc" : null), exec: async () => OK_PKG }),
      "/src/linux.c",
    );
    expect(plan.shim).not.toBeNull();
    expect(plan.shim!.cached).toBe(false);
    expect(plan.shim!.cc).toBe("cc");
    expect(plan.shim!.flags).toEqual(["-lgtk-4", "-lgobject-2.0", "-lwebkit-2", "-I/inc"]);
    expect(plan.shim!.outPath).toContain("shim-");

    const cachedPlan = await planLauncher(
      fakeProbe({
        which: () => "/usr/bin/cc",
        exec: async () => OK_PKG,
        exists: async () => true,
      }),
      "/src/linux.c",
    );
    expect(cachedPlan.shim!.cached).toBe(true);
  });

  it("probes GTK4/6.0 first and adopts GTK3/4.1 when only it exists", async () => {
    // The user-machine shape: webkit2gtk-4.1 installed, no webkitgtk-6.0.
    // The old combined `gtk4 webkit2gtk-4.1` probe "succeeded" on mixed
    // systems and poisoned the compile; each series must be asked alone,
    // 6.0 first, and the answer's flags decide the shim's GTK branch.
    const probed: string[][] = [];
    const plan = await planLauncher(
      fakeProbe({
        which: (n) => (n === "cc" ? "/usr/bin/cc" : null),
        exec: async (cmd) => {
          probed.push(cmd);
          return cmd.includes("webkit2gtk-4.1")
            ? { code: 0, stdout: "-I/usr/include/webkitgtk-4.1 -I/usr/include/gtk-3.0 -lwebkit2gtk-4.1", stderr: "" }
            : { code: 1, stdout: "", stderr: "" };
        },
      }),
      "/src/linux.c",
    );
    expect(probed.map((c) => c.at(-1))).toEqual(["webkitgtk-6.0", "webkit2gtk-4.1"]);
    expect(plan.shim).not.toBeNull();
    expect(plan.shim!.flags).toContain("-I/usr/include/webkitgtk-4.1");
  });

  it("shim refused when cc is absent, pkg-config fails, source is unreadable, or not linux", async () => {
    const withCcOkPkg = { which: (n: string) => (n === "cc" ? "/cc" : null), exec: async () => OK_PKG };
    expect((await planLauncher(fakeProbe({ ...withCcOkPkg, which: () => null }), "/s.c")).shim).toBeNull();
    expect((await planLauncher(fakeProbe({ ...withCcOkPkg, exec: async () => ({ code: 1, stdout: "", stderr: "" }) }), "/s.c")).shim).toBeNull();
    expect((await planLauncher(fakeProbe({ ...withCcOkPkg, readFile: async () => { throw new Error("no file"); } }), "/s.c")).shim).toBeNull();
    expect((await planLauncher(fakeProbe({ ...withCcOkPkg, platform: "darwin" }), "/s.c")).shim).toBeNull();
  });

  it("browser picks the first candidate on PATH; order ends with print always", async () => {
    const plan = await planLauncher(
      fakeProbe({ which: (n) => (n === "chromium-browser" ? "/usr/bin/chromium-browser" : null) }),
      "/s.c",
    );
    expect(plan.browser).toBe("chromium-browser");
    expect(launcherOrder(plan)).toEqual(["browser", "print"]);

    const full = await planLauncher(
      fakeProbe({ which: (n) => (n === "cc" || n === "google-chrome" ? "/x" : null), exec: async () => OK_PKG }),
      "/s.c",
    );
    expect(launcherOrder(full)).toEqual(["shim", "browser", "print"]);
    expect(launcherOrder(await planLauncher(fakeProbe(), "/s.c"))).toEqual(["print"]);
  });

  // ── darwin shim planning (pure; the real compile is the gated smoke file) ──

  it("darwin + clang -> macos shim plan: fixed flags, ATS plist, cache name", async () => {
    const plan = await planLauncher(
      fakeProbe({
        platform: "darwin",
        arch: "arm64",
        which: (n) => (n === "clang" || n === "codesign" ? "/usr/bin/" + n : null),
      }),
      "/src/linux.c", // the chain's single arg: macos.m is derived next to it
    );
    expect(plan.shim).not.toBeNull();
    expect(plan.shim!.sourcePath).toBe("/src/macos.m");
    expect(plan.shim!.cc).toBe("clang");
    expect(plan.shim!.flags).toEqual(MACOS_SHIM_FLAGS);
    expect(MACOS_SHIM_FLAGS).toContain("-fobjc-arc"); // ARC is not optional under a memory-owning shim
    // 11.3, not 11.0: the whole WKDownload class is macos(11.3) (verified
    // against WKDownload.h's WK_CLASS_AVAILABLE), so a lower floor makes
    // the download delegates availability errors at compile.
    expect(MACOS_SHIM_FLAGS).toContain("-mmacosx-version-min=11.3");
    expect(MACOS_SHIM_FLAGS).toContain("Security"); // SecTrust symbols: ld64 needs it spelled out
    expect(plan.shim!.outPath).toContain("shim-macos-"); // distinct from the linux cache namespace
    expect(plan.shim!.atsPlist).toBe(MACOS_ATS_PLIST);
    expect(plan.shim!.codesign).toBe(true); // arm64: unsigned main binary => no WKWebProcess
  });

  it("darwin ATS plist: local networking only, never arbitrary loads", () => {
    expect(MACOS_ATS_PLIST).toContain("NSAppTransportSecurity");
    expect(MACOS_ATS_PLIST).toContain("NSAllowsLocalNetworking");
    expect(MACOS_ATS_PLIST).not.toContain("NSAllowsArbitraryLoads"); // https posture stays whole
  });

  it("darwin: no clang / unreadable source -> no shim; codesign absence is NOT a planning refusal", async () => {
    const clang = { platform: "darwin", which: (n: string) => (n === "clang" ? "/usr/bin/clang" : null) };
    const ok = await planMacosShim(fakeProbe(clang), "/s/macos.m");
    expect(ok).not.toBeNull();
    expect(ok!.codesign).toBe(false); // absence lands as a warning at build time, not a plan veto
    expect((await planMacosShim(fakeProbe({ platform: "darwin" }), "/s/macos.m"))).toBeNull();
    expect(
      (await planMacosShim(fakeProbe({ ...clang, readFile: async () => { throw new Error("gone"); } }), "/s/macos.m")),
    ).toBeNull();
  });

  it("darwin cache key: source/flags/arch changes rebuild, repeats hit (stable path, cached flag)", async () => {
    const read = (s: string) => async () => new TextEncoder().encode(s);
    const a = await planMacosShim(fakeProbe({ platform: "darwin", which: (n) => (n === "clang" ? "/c" : null), readFile: read("SRC-A") }), "/s.m");
    const b = await planMacosShim(fakeProbe({ platform: "darwin", which: (n) => (n === "clang" ? "/c" : null), readFile: read("SRC-A") }), "/s.m");
    const c = await planMacosShim(fakeProbe({ platform: "darwin", which: (n) => (n === "clang" ? "/c" : null), readFile: read("SRC-B") }), "/s.m");
    const arm = await planMacosShim(
      fakeProbe({ platform: "darwin", arch: "arm64", which: (n) => (n === "clang" ? "/c" : null), readFile: read("SRC-A") }),
      "/s.m",
    );
    expect(a!.outPath).toBe(b!.outPath);
    expect(c!.outPath).not.toBe(a!.outPath);
    expect(arm!.outPath).not.toBe(a!.outPath);
    const cached = await planMacosShim(
      fakeProbe({ platform: "darwin", which: (n) => (n === "clang" ? "/c" : null), readFile: read("SRC-A"), exists: async () => true }),
      "/s.m",
    );
    expect(cached!.cached).toBe(true);
  });

  it("darwin browser: absolute .app candidates probed via exists(), first hit wins; Safari is not a candidate", async () => {
    const plan = await planLauncher(
      fakeProbe({
        platform: "darwin",
        which: () => null, // PATH names mean nothing for app bundles
        exists: async (p) => p.includes("Brave") || p.includes("Chrome"),
      }),
      "/s.c",
    );
    expect(plan.browser).toBe(BROWSER_CANDIDATES_MACOS[0]!); // Chrome beats Brave by order
    expect(BROWSER_CANDIDATES_MACOS.some((c) => c.includes("Safari"))).toBe(false); // no app mode

    const none = await planLauncher(fakeProbe({ platform: "darwin", exists: async () => false }), "/s.c");
    expect(none.browser).toBeNull();
    expect(launcherOrder(none)).toEqual(["print"]);
  });
});

// ── single-instance lock ────────────────────────────────────────────────────

describe("desktop instance lock", () => {
  let dataDir: string;
  const savedEnv = process.env.HOTDOG_DATA_DIR;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hotdog-desktop-test-"));
    process.env.HOTDOG_DATA_DIR = dataDir;
  });
  afterAll(() => {
    if (savedEnv === undefined) delete process.env.HOTDOG_DATA_DIR;
    else process.env.HOTDOG_DATA_DIR = savedEnv;
  });

  it("acquires, refuses a live holder, steals a stale one, steals garbage", async () => {
    expect((await acquireInstanceLock()).ok).toBe(true);
    const mine = JSON.parse(await readFile(lockFilePath(), "utf8"));
    expect(mine.pid).toBe(process.pid);

    // Our own pid is alive: a second claim must refuse, not overwrite.
    const second = await acquireInstanceLock();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.running.pid).toBe(process.pid);

    await releaseInstanceLock();

    await writeFile(lockFilePath(), JSON.stringify({ pid: 2_000_000_000, port: 1 }));
    expect((await acquireInstanceLock()).ok).toBe(true); // stale pid -> steal
    await releaseInstanceLock();

    await writeFile(lockFilePath(), "not json {{{");
    expect((await acquireInstanceLock()).ok).toBe(true); // garbage -> steal
    await releaseInstanceLock();
  });

  it("updateInstanceLockPort refreshes ours only; release never deletes a raced-over lock", async () => {
    await acquireInstanceLock();
    await updateInstanceLockPort(4321);
    expect(JSON.parse(await readFile(lockFilePath(), "utf8")).port).toBe(4321);

    // Another process claimed the file between our write and release.
    await writeFile(lockFilePath(), JSON.stringify({ pid: 2_000_000_000, port: 9 }));
    await releaseInstanceLock();
    expect(await readFile(lockFilePath(), "utf8")).toContain("2000000000");
  });
});

// ── remote URL admission ────────────────────────────────────────────────────

describe("validateRemoteUrl", () => {
  it("admits https anywhere and http on loopback names", () => {
    expect(validateRemoteUrl("https://example.com")).toBe("https://example.com/");
    expect(validateRemoteUrl("https://hotdog.example.com:8443/some/path")).toBe(
      "https://hotdog.example.com:8443/some/path",
    );
    expect(validateRemoteUrl("http://127.0.0.1:8420")).toBe("http://127.0.0.1:8420/");
    expect(validateRemoteUrl("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(validateRemoteUrl("http://[::1]:3000")).toBe("http://[::1]:3000/");
    expect(validateRemoteUrl("http://hotdog.localhost")).toBe("http://hotdog.localhost/");
  });

  it("refuses cleartext beyond loopback, foreign schemes, credentials, fragments, garbage", () => {
    let msg = "";
    try { validateRemoteUrl("http://192.168.1.10:3000"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("Plaintext http refused");
    expect(msg).toContain("ssh -L");
    try { validateRemoteUrl("http://example.com"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("Plaintext http refused");
    try { validateRemoteUrl("ftp://example.com"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("Unsupported scheme");
    try { validateRemoteUrl("javascript:alert(1)"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("Unsupported scheme");
    try { validateRemoteUrl("https://user:pw@example.com"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("URL credentials");
    try { validateRemoteUrl("https://example.com/#tok=abc"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("fragment");
    try { validateRemoteUrl("not a url"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("Invalid server URL");
  });
});

// ── local posture + handoff URL ─────────────────────────────────────────────

describe("desktopServerConfig / localAppUrl", () => {
  it("forces loopback, ephemeral port, random one-boot key, no proxy trust; keeps ttl", () => {
    const base = { host: "0.0.0.0", port: 3000, apiKey: "real-configured-key", trustedProxy: "10.0.0.0/8", sessionTokenTtlMin: 120 };
    const a = desktopServerConfig(base);
    const b = desktopServerConfig(base);
    expect(a.host).toBe("127.0.0.1");
    expect(a.port).toBe(0);
    expect(a.trustedProxy).toBe("");
    expect(a.sessionTokenTtlMin).toBe(120);
    expect(a.apiKey).not.toBe("real-configured-key");
    expect(String(a.apiKey)).toMatch(/^[0-9a-f]{64}$/);
    expect(a.apiKey).not.toBe(b.apiKey);
  });

  it("handoff URL carries the token in the fragment, percent-encoded", () => {
    const url = localAppUrl(4321, "abc/def+ ");
    expect(url).toBe("http://127.0.0.1:4321/#tok=abc%2Fdef%2B%20");
  });
});

describe("hydrateModelRegistry", () => {
  it("publishes the provider catalog onto core.resolved.modelRegistry", async () => {
    const core = makeCore({}, [{ name: "fixtureprov", models: [{ name: "m1" }] }]) as {
      resolved: { modelRegistry?: Record<string, unknown> };
    };
    await hydrateModelRegistry(core as never);
    expect(Object.keys(core.resolved.modelRegistry ?? {})).toContain("fixtureprov/m1");
  });

  it("is a safe no-op without a resolved bag (never throws)", async () => {
    await hydrateModelRegistry({ config: {} } as never);
  });
});

describe("parseHandoffHash / consumeHandoffToken", () => {
  it("parses tok=, rejects the rest", () => {
    expect(parseHandoffHash("#tok=abc")).toBe("abc");
    expect(parseHandoffHash("#tok=a%2Fb")).toBe("a/b");
    expect(parseHandoffHash("#tok=")).toBeNull();
    expect(parseHandoffHash("#other=1")).toBeNull();
    expect(parseHandoffHash("")).toBeNull();
    expect(parseHandoffHash(undefined as unknown as string)).toBeNull();
  });

  it("consume scrubs history, persists, returns; non-handoff returns null", () => {
    const g = globalThis as Record<string, unknown>;
    let scrubbed = 0;
    const saved = { location: g.location, history: g.history, localStorage: g.localStorage };
    const store = new Map<string, string>();
    g.location = { hash: "#tok=tok123", pathname: "/", search: "" };
    g.history = { replaceState: () => scrubbed++ };
    g.localStorage = {
      setItem: (k: string, v: string) => store.set(k, v),
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => { store.delete(k); },
    };
    // The module reads the globals at CALL time, so the ones installed above
    // are what consumeHandoffToken sees; the import can stay top-level.
    expect(consumeHandoffToken()).toBe("tok123");
    expect(scrubbed).toBe(1);
    expect(store.get("hotdog-webui-token")).toBe("tok123");

    g.location = { hash: "", pathname: "/", search: "" };
    expect(consumeHandoffToken()).toBeNull();
    expect(scrubbed).toBe(1);

    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  });
});

// ── handler lifecycle (real server, fake window) ────────────────────────────

function makeCore(webui: Record<string, unknown>, providers: unknown[] = []) {
  return {
    hooks: { notifyHooks: () => {}, notifyHooksAsync: async () => {} },
    config: { webui, providers },
    resolved: {
      profileManager: { getProfilesForSwitch: () => ({}) },
      uploadLimits: { maxFileSize: 102400, maxImageSize: 10485760, maxFiles: 10 },
      contextLimit: 4096,
    },
    toolRegistry: { getAll: () => [], get: () => null, register: () => {} },
    extensions: { cleanup: async () => {} },
    services: new ServiceRegistry(),
    createLlmClient: () => ({}),
  } as never;
}

function fakeWindow(autoCloseMs?: number, exitCode = 0) {
  const urls: string[] = [];
  let release: () => void = () => {};
  const exited = new Promise<number>((resolve) => {
    release = () => resolve(exitCode);
  });
  let closedBySignal = false;
  const launcher = {
    open: async (url: string) => {
      urls.push(url);
      if (autoCloseMs !== undefined) setTimeout(release, autoCloseMs);
      return {
        kind: "shim" as const,
        exited,
        close: () => {
          closedBySignal = true;
          release();
        },
      };
    },
  };
  return { urls, launcher, closeWindow: release, wasClosed: () => closedBySignal };
}

async function waitForPortClosed(port: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/verify`);
    } catch {
      return; // refused: down
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`desktop server still listening on ${port}`);
}

describe("desktop handler lifecycle", () => {
  let dataDir: string;
  const savedEnv = process.env.HOTDOG_DATA_DIR;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hotdog-desktop-e2e-"));
    process.env.HOTDOG_DATA_DIR = dataDir;
  });
  afterAll(() => {
    if (savedEnv === undefined) delete process.env.HOTDOG_DATA_DIR;
    else process.env.HOTDOG_DATA_DIR = savedEnv;
  });

  it("registers the desktop subcommand", async () => {
    const ext = create({} as never);
    const registry = createMockRegistry() as never as {
      registeredName: string;
      registeredOpts: { description: string; handler: unknown };
    };
    await (ext.hooks as Record<string, (r: unknown) => Promise<void>>)[
      HOOKS.CLI_SUBCOMMANDS_REGISTER
    ]!(registry);
    expect(registry.registeredName).toBe("desktop");
    expect(registry.registeredOpts.description).toContain("desktop window");
  });

  it("local mode: serves, hands the token fragment to the window, drains on close", async () => {
    // no apiKey/host in config: desktop synthesizes them; the static fixture
    // provider (no fetchModels) pins that local mode hydrates the catalog
    // the boot skipped -- without touching the network in the test.
    const core = makeCore({}, [{ name: "fixtureprov", models: [{ name: "m1" }] }]);
    const win = fakeWindow();

    const done = handleDesktopSubcommand({ args: [] }, core, win.launcher);
    // Give the server a beat to bind + self-login, then close the window.
    const deadline = Date.now() + 5000;
    while (win.urls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(win.urls.length).toBe(1);
    const url = new URL(win.urls[0]!);
    expect(url.hostname).toBe("127.0.0.1");
    const token = url.hash.slice("#tok=".length);
    expect(token.length).toBeGreaterThan(0);

    const port = Number(url.port);
    // The handoff token really authenticates the listener; no token is 401.
    const ok = await fetch(`http://127.0.0.1:${port}/verify`, {
      headers: { "x-hotdog-token": decodeURIComponent(token) },
    });
    expect(ok.status).toBe(200);
    const no = await fetch(`http://127.0.0.1:${port}/verify`);
    expect(no.status).toBe(401);

    win.closeWindow();
    expect(await done).toBe(0);
    await waitForPortClosed(port);
    // Lock released on the clean path.
    expect(await readFile(lockFilePath(), "utf8").catch(() => "")).toBe("");
    // The catalog the boot skipped was hydrated before the server captured
    // core.resolved.modelRegistry (static fixture provider, zero network).
    expect(Object.keys(((core as never as { resolved: { modelRegistry?: unknown } }).resolved
      .modelRegistry ?? {}) as Record<string, unknown>)).toContain("fixtureprov/m1");
  });

  it("local mode refuses to double-stack while another instance holds the lock", async () => {
    // Real shape: a live holder claimed the lock (our pid keeps it "alive").
    expect((await acquireInstanceLock()).ok).toBe(true);
    await updateInstanceLockPort(4321);
    const core = makeCore({});
    const win = fakeWindow();
    expect(await handleDesktopSubcommand({ args: [] }, core, win.launcher)).toBe(1);
    expect(win.urls.length).toBe(0); // never opened a window
    // The live holder's file stands untouched (not ours to delete).
    expect(await readFile(lockFilePath(), "utf8")).toContain("4321");
    await releaseInstanceLock();
  });

  it("remote mode: no local server, admits the URL as-is, bad URL exits 1 without a window", async () => {
    const win = fakeWindow(0);
    const core = makeCore({}, [{ name: "fixtureprov", models: [{ name: "m1" }] }]) as {
      resolved: { modelRegistry?: unknown };
    };
    const code = await handleDesktopSubcommand(
      { args: ["https://hotdog.example.com:8443/app"] },
      core as never,
      win.launcher,
    );
    expect(code).toBe(0);
    expect(win.urls).toEqual(["https://hotdog.example.com:8443/app"]);
    // No local listener was ever bound: the data dir holds no lock, the
    // server's routes were never consulted -- and the skipped model catalog
    // stays skipped (window mode hydrates nothing).
    expect(await readFile(lockFilePath(), "utf8").catch(() => "")).toBe("");
    expect(core.resolved.modelRegistry).toBeUndefined();

    const bad = fakeWindow(0);
    expect(await handleDesktopSubcommand({ args: ["http://10.1.2.3:3000"] }, makeCore({}), bad.launcher)).toBe(1);
    expect(bad.urls.length).toBe(0);

    const tooMany = fakeWindow(0);
    expect(
      await handleDesktopSubcommand({ args: ["https://a.example", "https://b.example"] }, makeCore({}), tooMany.launcher),
    ).toBe(1);
    expect(tooMany.urls.length).toBe(0);
  });

  it("a crashed window (nonzero exit without a signal) reports failure", async () => {
    // The glibc-abort shape: shim dies with 134 (SIGABRT) mid-session.
    // Before reportWindowExit this looked exactly like a clean close.
    const win = fakeWindow(0, 134);
    const code = await handleDesktopSubcommand(
      { args: ["https://hotdog.example.com"] },
      makeCore({}),
      win.launcher,
    );
    expect(code).toBe(1);
  });

  it("print-fallback shape: a never-settling window stays up until SIGTERM", async () => {
    // The event-loop liveness bug this pins: with no server bound (remote
    // mode) and an exited promise that never settles (print rung), unref'd
    // signal listeners alone let bun idle out with code 0 right after
    // printing the URL. The handler must stay pending, then close cleanly.
    const win = fakeWindow(); // no auto-close: exited never resolves on its own
    const done = handleDesktopSubcommand(
      { args: ["https://hotdog.example.com"] },
      makeCore({}),
      win.launcher,
    );
    const outcome = await Promise.race([
      done.then(() => "settled").catch(() => "rejected"),
      new Promise((r) => setTimeout(() => r("pending"), 150)),
    ]);
    expect(outcome).toBe("pending");
    process.emit("SIGTERM");
    expect(await done).toBe(0);
    expect(win.wasClosed()).toBe(true); // the window was told to go, not just abandoned
  });
});
