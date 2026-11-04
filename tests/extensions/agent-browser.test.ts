// agent-browser (experimental): unit tests over the fake view seam.
// No mock.module: the view is injected through ViewFactory at its natural
// boundary. Pinned here: action routing, the session cap, the navigation
// admission matrix (public/private/loopback + redirect egress), snapshot caps
// via truncateOutput, the screenshot byte-budget ladder, the evaluate refusal
// when no user-gate exists, and the SESSION_END leak reclaim.
// All writes go under a tmp dir via HOTDOG_SESSIONS_DIR.

import { afterAll, describe, expect, it } from "bun:test";
import { deflateSync } from "node:zlib";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HookSystem, HOOKS } from "@core/hooks.ts";
import type { CoreContext } from "@core/extensions/types.ts";

import {
  AgentBrowserTool,
  MAX_VIEWS_PER_SESSION,
  bunWebViewOptions,
  checkNavigationAllowed,
  create,
  isLoopbackHost,
  type BrowserView,
} from "@experimental/agent-browser/index.ts";

// Screenshot saves must never touch the real sessions dir.
const SESSIONS_TMP = mkdtempSync(join(tmpdir(), "agent-browser-test-sessions-"));
process.env.HOTDOG_SESSIONS_DIR = SESSIONS_TMP;

afterAll(() => {
  rmSync(SESSIONS_TMP, { recursive: true, force: true });
});

// ── Image fixtures ──────────────────────────────────────────────────────────

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.byteLength);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])));
  return Buffer.concat([len, Buffer.from(type, "ascii"), data, crc]);
}

/** A genuinely valid PNG (deterministic noise, so Bun.Image decodes/re-encodes it). */
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  let seed = 0x2f6e2b1;
  const rowLen = 1 + width * 3;
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0; // scanline filter type: none
    for (let x = 0; x < width * 3; x++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      raw[y * rowLen + 1 + x] = (seed >>> 16) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const TINY_PNG_B64 = makePng(2, 2).toString("base64");
const HUGE_PNG_B64 = makePng(900, 900).toString("base64"); // noise: deflate keeps the PNG over the 1.5MB budget

// ── Fake view ───────────────────────────────────────────────────────────────

class FakeView implements BrowserView {
  url = "about:blank";
  title = "";
  onNavigated: ((url: string, title: string) => void) | null = null;
  closed = false;
  navigations: string[] = [];
  clicks: Array<string | { x: number; y: number }> = [];
  typed: string[] = [];
  pressed: string[] = [];
  evaluates: string[] = [];
  screenshotCalls: Array<{ format?: string; quality?: number }> = [];
  /** Scripted screenshot payloads (base64) consumed per call. */
  screenshots: string[] = [];
  /** evaluate() responses keyed by script substring; default: empty snapshot. */
  evaluateResponses = new Map<string, unknown>();
  /** onNavigated fires with this URL instead of the target (redirect sim). */
  redirectsTo: string | null = null;
  /** Watchdog tests: a navigate to one of these URLs never settles (stalled page). */
  stallNavigateUrls = new Set<string>();
  #inFlightEvals = 0;

  async navigate(url: string): Promise<void> {
    this.navigations.push(url);
    if (this.stallNavigateUrls.has(url)) return new Promise<void>(() => {});
    const landed = this.redirectsTo ?? url;
    this.redirectsTo = null;
    this.url = landed;
    this.title = `page at ${landed}`;
    this.onNavigated?.(landed, this.title);
  }

  async evaluate<T>(script: string): Promise<T> {
    if (this.#inFlightEvals > 0) throw new Error("ERR_INVALID_STATE: evaluate overlap");
    this.#inFlightEvals++;
    this.evaluates.push(script);
    try {
      for (const [needle, value] of this.evaluateResponses) {
        if (script.includes(needle)) return value as T;
      }
      return { url: this.url, title: this.title, elements: [] } as unknown as T;
    } finally {
      this.#inFlightEvals--;
    }
  }

  async screenshot(options: { encoding: "base64"; format: "png" | "jpeg"; quality?: number }): Promise<string> {
    this.screenshotCalls.push({ format: options.format, quality: options.quality });
    const next = this.screenshots.shift();
    if (next === undefined) throw new Error("FakeView: no scripted screenshot left");
    return next;
  }

  async click(selector: string, options?: { timeout?: number }): Promise<void>;
  async click(x: number, y: number): Promise<void>;
  async click(selectorOrX: string | number, second?: number | { timeout?: number }): Promise<void> {
    if (typeof selectorOrX === "string") this.clicks.push(selectorOrX);
    else this.clicks.push({ x: selectorOrX, y: second as number });
  }

  async type(text: string): Promise<void> {
    this.typed.push(text);
  }

  async press(key: string): Promise<void> {
    this.pressed.push(key);
  }

  close(): void {
    this.closed = true;
  }
}

function makeTool(over: Partial<{ allowLoopback: boolean; userGateEnabled: boolean }> = {}) {
  const made: FakeView[] = [];
  const tool = new AgentBrowserTool({
    allowLoopback: over.allowLoopback ?? false,
    userGateEnabled: over.userGateEnabled ?? false,
    createView: () => {
      const view = new FakeView();
      made.push(view);
      return view;
    },
  });
  return { tool, made };
}

function toolWithFake(make: () => FakeView) {
  const made: FakeView[] = [];
  const tool = new AgentBrowserTool({
    allowLoopback: false,
    userGateEnabled: false,
    createView: () => {
      const view = make();
      made.push(view);
      return view;
    },
  });
  return { tool, made };
}

const PUBLIC_URL = "https://93.184.216.34/"; // public IP literal: admission needs no DNS

function ctxFor(sessionId = "sess-1", modelRegistry?: Record<string, unknown>, abortSignal?: AbortSignal) {
  const agent = { sessionId, model: "test/model", modelRegistry };
  return {
    get: (key: string) =>
      key === "agent" ? agent : key === "abortSignal" ? abortSignal : undefined,
  } as never;
}

const VISION_REGISTRY = { "test/model": { name: "test/model", inputModalities: ["text", "image"] } };
const TEXT_ONLY_REGISTRY = { "test/model": { name: "test/model", inputModalities: ["text"] } };

// ── Extension wiring ────────────────────────────────────────────────────────

describe("extension wiring", () => {
  it("registers the tool and a SESSION_END reclaim handler", async () => {
    const hooks = new HookSystem();
    const core = { hooks, config: { agentBrowser: { allowLoopback: false } } } as unknown as CoreContext;
    const instance = create(core);
    const registered: string[] = [];
    const toolsHandler = instance.hooks?.[HOOKS.TOOLS_REGISTER] as (r: {
      register: (name: string, tool: unknown) => void;
    }) => Promise<void>;
    await toolsHandler({
      register: (name: string) => {
        registered.push(name);
      },
    });
    expect(registered).toEqual(["agent_browser"]);
    expect(typeof instance.hooks?.[HOOKS.SESSION_END]).toBe("function");
  });

  it("bunWebViewOptions: forced-spawn chrome, ephemeral storage (never auto-connect)", () => {
    expect(bunWebViewOptions({ width: 1280, height: 900 })).toEqual({
      width: 1280,
      height: 900,
      backend: { type: "chrome", url: false },
      dataStore: "ephemeral",
    });
  });
});

// ── Session lifecycle (the leak pin) ────────────────────────────────────────

describe("session lifecycle", () => {
  it("create() wires SESSION_END to closeSession for the ending session", async () => {
    const hooks = new HookSystem();
    const core = { hooks, config: { agentBrowser: {} } } as unknown as CoreContext;
    const instance = create(core);
    const ended: string[] = [];
    const original = AgentBrowserTool.prototype.closeSession;
    AgentBrowserTool.prototype.closeSession = function (this: AgentBrowserTool, sessionId: string) {
      ended.push(sessionId);
      original.call(this, sessionId);
    };
    try {
      const sessionEnd = instance.hooks?.[HOOKS.SESSION_END] as (p: { sessionId: string }) => unknown;
      await sessionEnd({ sessionId: "s1" });
    } finally {
      AgentBrowserTool.prototype.closeSession = original;
    }
    expect(ended).toEqual(["s1"]);
  });

  it("closeSession closes the session's views and leaves other sessions alone (leak pin)", async () => {
    const { tool, made } = makeTool();
    await tool.execute({ action: "open", url: PUBLIC_URL, view: "a" }, ctxFor("s1"));
    await tool.execute({ action: "open", url: PUBLIC_URL, view: "b" }, ctxFor("s2"));
    expect(tool.viewCount("s1")).toBe(1);

    tool.closeSession("s1");
    expect(tool.viewCount("s1")).toBe(0);
    expect(made[0]!.closed).toBe(true); // the Chromium view was actually closed
    expect(made[1]!.closed).toBe(false);
    expect(tool.viewCount("s2")).toBe(1);
  });

  it("views survive across tool calls within a session", async () => {
    const { tool, made } = makeTool();
    const first = await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    expect(first.output).toContain('view "main"');
    const nav = await tool.execute({ action: "navigate", url: "https://8.8.8.8/" }, ctxFor());
    expect(nav.output).toContain("8.8.8.8");
    expect(made).toHaveLength(1); // navigate reused the standing view
    const list = await tool.execute({ action: "list" }, ctxFor());
    expect(list.output).toContain('"main"');
    expect(list.output).toContain("(1/3 views)");
  });

  it("close takes a named view or all of them", async () => {
    const { tool, made } = makeTool();
    await tool.execute({ action: "open", url: PUBLIC_URL, view: "a" }, ctxFor());
    await tool.execute({ action: "open", url: "https://8.8.8.8/", view: "b" }, ctxFor());
    const one = await tool.execute({ action: "close", view: "a" }, ctxFor());
    expect(one.output).toContain('Closed view "a"');
    expect(made[0]!.closed).toBe(true);
    expect(made[1]!.closed).toBe(false);
    const all = await tool.execute({ action: "close" }, ctxFor());
    expect(all.output).toContain("Closed 1 view(s)");
    expect(made[1]!.closed).toBe(true);
  });

  it("operating on a missing view points at open", async () => {
    const { tool } = makeTool();
    const r = await tool.execute({ action: "snapshot", view: "ghost" }, ctxFor());
    expect(r.error).toContain('no view "ghost"');
    expect(r.hint).toContain("action=open");
  });
});

// ── Cap ─────────────────────────────────────────────────────────────────────

describe("view cap", () => {
  it("refuses beyond MAX_VIEWS_PER_SESSION and open replaces same-name views", async () => {
    const { tool, made } = makeTool();
    for (const name of ["v1", "v2", "v3"]) {
      const r = await tool.execute({ action: "open", url: PUBLIC_URL, view: name }, ctxFor());
      expect(r.error).toBeNull();
    }
    expect(tool.viewCount("sess-1")).toBe(MAX_VIEWS_PER_SESSION);
    const fourth = await tool.execute({ action: "open", url: "https://8.8.8.8/", view: "v4" }, ctxFor());
    expect(fourth.error).toContain("3 views");
    expect(fourth.hint).toContain("action=close");
    expect(made).toHaveLength(3); // no view created for a refused open

    await tool.execute({ action: "open", url: "https://8.8.8.8/", view: "v1" }, ctxFor());
    expect(tool.viewCount("sess-1")).toBe(MAX_VIEWS_PER_SESSION);
    expect(made[0]!.closed).toBe(true); // the replaced view was closed, not leaked
  });

  it("a refused admission on open burns no cap slot", async () => {
    const { tool, made } = makeTool();
    const r = await tool.execute({ action: "open", url: "http://127.0.0.1/admin" }, ctxFor());
    expect(r.error).toContain("navigation refused");
    expect(made).toHaveLength(0);
    expect(tool.viewCount("sess-1")).toBe(0);
  });
});

// ── Navigation admission ────────────────────────────────────────────────────

describe("navigation admission", () => {
  it("classifies loopback hosts by literal", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.5.5.5")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("8.8.8.8")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });

  it("https-or-http only; file/data/ftp/garbage are refused, about:blank passes", async () => {
    for (const url of ["file:///etc/passwd", "data:text/html,<script>1</script>", "ftp://x.test/", "not a url"]) {
      expect(await checkNavigationAllowed(url, true), url).not.toBeNull();
    }
    expect(await checkNavigationAllowed("about:blank", false)).toBeNull();
    expect(await checkNavigationAllowed("about:config", false)).not.toBeNull();
  });

  it("blocks private/reserved hosts by default, loopback included", async () => {
    expect(await checkNavigationAllowed("https://this-host-cannot-resolve.invalid/", false)).toContain(
      "Could not resolve",
    );
    expect(await checkNavigationAllowed("http://10.0.0.5/", false)).toContain("private or reserved");
    expect(await checkNavigationAllowed("http://127.0.0.1/", false)).toContain("private or reserved");
    expect(await checkNavigationAllowed("http://localhost:3000/", false)).toContain("private or reserved");
    expect(await checkNavigationAllowed("http://[::1]/", false)).toContain("private or reserved");
    expect(await checkNavigationAllowed("http://169.254.169.254/latest/meta-data/", false)).toContain(
      "private or reserved",
    );
  });

  it("allowLoopback opens loopback ONLY -- RFC1918 and link-local stay blocked", async () => {
    expect(await checkNavigationAllowed("http://127.0.0.1:8080/", true)).toBeNull();
    expect(await checkNavigationAllowed("http://localhost:8080/", true)).toBeNull();
    expect(await checkNavigationAllowed("http://[::1]:8080/", true)).toBeNull();
    expect(await checkNavigationAllowed("http://10.0.0.5/", true)).toContain("private or reserved");
    expect(await checkNavigationAllowed("http://192.168.1.1/", true)).toContain("private or reserved");
    expect(await checkNavigationAllowed("http://169.254.169.254/", true)).toContain("private or reserved");
  });

  it("public literals pass with no DNS needed", async () => {
    expect(await checkNavigationAllowed("https://8.8.8.8/", false)).toBeNull();
    expect(await checkNavigationAllowed("https://93.184.216.34/", false)).toBeNull();
  });

  it("a page-initiated jump to a private host egresses to about:blank and warns on the next action", async () => {
    const { tool, made } = makeTool();
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    const view = made[0]!;
    view.onNavigated?.("http://127.0.0.1:9222/json", "devtools");
    await new Promise((r) => setTimeout(r, 10));
    expect(view.navigations).toContain("about:blank"); // egress happened

    const snap = await tool.execute({ action: "snapshot" }, ctxFor());
    expect(snap.output).toContain("WARNING: navigation guard");
    expect(snap.output).toContain("about:blank");
    // Report-and-clear: the warning rides out once, not forever.
    const snap2 = await tool.execute({ action: "snapshot" }, ctxFor());
    expect(snap2.output).not.toContain("navigation guard");
  });

  it("an open that redirects into private space fails with the guard error", async () => {
    const { tool } = toolWithFake(() => {
      const view = new FakeView();
      view.redirectsTo = "http://10.1.2.3/evil";
      return view;
    });
    const r = await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    expect(r.error).toContain("blocked by navigation guard");
    expect(r.error).toContain("10.1.2.3");
  });
});

// ── Routing ─────────────────────────────────────────────────────────────────

describe("action routing", () => {
  it("click routes selector vs coordinates; bad input hints", async () => {
    const { tool, made } = makeTool();
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    await tool.execute({ action: "click", selector: "#submit" }, ctxFor());
    await tool.execute({ action: "click", x: 10, y: 20 }, ctxFor());
    expect(made[0]!.clicks).toEqual(["#submit", { x: 10, y: 20 }]);
    const bad = await tool.execute({ action: "click" }, ctxFor());
    expect(bad.error).toContain("selector or numeric x and y");
  });

  it("type and press route to the view; missing args error", async () => {
    const { tool, made } = makeTool();
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    await tool.execute({ action: "type", text: "hello@example.com" }, ctxFor());
    await tool.execute({ action: "press", key: "Enter" }, ctxFor());
    expect(made[0]!.typed).toEqual(["hello@example.com"]);
    expect(made[0]!.pressed).toEqual(["Enter"]);
    expect((await tool.execute({ action: "type" }, ctxFor())).error).toContain("text");
    expect((await tool.execute({ action: "press" }, ctxFor())).error).toContain("key");
  });

  it("unknown actions list the valid enum", async () => {
    const { tool } = makeTool();
    const r = await tool.execute({ action: "teleport" }, ctxFor());
    expect(r.error).toContain("open, navigate, snapshot, click, type, press, screenshot, evaluate, close, list");
  });

  it("serializes operations on one view (no evaluate overlap)", async () => {
    const { tool } = makeTool({ userGateEnabled: true });
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    // The fake throws on overlapping evaluate(); concurrency must queue, not race.
    const [ra, rb] = await Promise.all([
      tool.execute({ action: "evaluate", script: "1+1" }, ctxFor()),
      tool.execute({ action: "evaluate", script: "2+2" }, ctxFor()),
    ]);
    expect(ra.error).toBeNull();
    expect(rb.error).toBeNull();
  });
});

// ── Snapshot ────────────────────────────────────────────────────────────────

describe("snapshot", () => {
  const element = (i: number) => ({
    tag: "button", id: `b${i}`, cls: "primary big", name: "", role: "", type: "submit",
    label: "", text: `press ${i}`, x: 10 * i, y: 20 * i,
  });

  it("renders id/class/name/role/text and the bounding-box center, then truncates at the house line cap", async () => {
    const { tool, made } = toolWithFake(() => {
      const view = new FakeView();
      // 200 elements: header line + 200 lines blow the 150-line truncateOutput cap.
      view.evaluateResponses.set("querySelectorAll", {
        url: PUBLIC_URL,
        title: "t",
        elements: Array.from({ length: 200 }, (_, i) => element(i)),
      });
      return view;
    });
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    const r = await tool.execute({ action: "snapshot" }, ctxFor());
    expect(r.output).toContain('1. button #b0 .primary.big type=submit "press 0" (0,0)');
    expect(r.output).toContain("[truncated,");
    expect(r.output).toContain("more lines] ---");
    expect(made[0]!.evaluates).toHaveLength(1);
  });

  it("snapshot is extension-internal: fixed extraction script, works with the user-gate OFF", async () => {
    const { tool, made } = makeTool({ userGateEnabled: false });
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    const r = await tool.execute({ action: "snapshot" }, ctxFor());
    expect(r.output).toContain("(no visible interactive elements)");
    expect(made[0]!.evaluates).toHaveLength(1);
    expect(made[0]!.evaluates[0]).toContain("querySelectorAll"); // the shipped extraction script
  });
});

// ── evaluate gating (tool side; approvals side lives in tests/utils/approvals) ─

describe("evaluate gating", () => {
  it("REFUSES without an enabled user-gate and never touches the page", async () => {
    const { tool, made } = makeTool({ userGateEnabled: false });
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    const r = await tool.execute({ action: "evaluate", script: "fetch('http://10.0.0.1')" }, ctxFor());
    expect(r.error).toContain("no approval prompt surface");
    expect(r.error).toContain("user-gate");
    expect(made[0]!.evaluates).toEqual([]); // not one model script ran
  });

  it("runs with the gate on and caps the result", async () => {
    const { tool, made } = makeTool({ userGateEnabled: true });
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    made[0]!.evaluateResponses.set("big", "x".repeat(20_000));
    const okResult = await tool.execute({ action: "evaluate", script: "small" }, ctxFor());
    expect(okResult.output).toContain("93.184.216.34"); // the fake page JSON came back
    const big = await tool.execute({ action: "evaluate", script: "big" }, ctxFor());
    expect(big.output).toContain("[truncated at 8000 chars]");
    expect(made[0]!.evaluates).toEqual([expect.stringContaining("small"), expect.stringContaining("big")]);
  });
});

// ── Screenshot budget ───────────────────────────────────────────────────────

describe("screenshot", () => {
  function toolWithShots(payloads: string[]) {
    return toolWithFake(() => {
      const view = new FakeView();
      view.screenshots.push(...payloads);
      return view;
    });
  }

  it("small PNG attaches an image part for a vision model and saves under the session dir", async () => {
    const { tool } = toolWithShots([TINY_PNG_B64]);
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    const r = await tool.execute({ action: "screenshot" }, ctxFor("sess-1", VISION_REGISTRY));
    expect(r.images).toHaveLength(1);
    expect(r.images![0]).toMatchObject({ type: "image_url", mimeType: "image/png", data: TINY_PNG_B64 });
    const saved = readdirSync(SESSIONS_TMP).filter((f) => f.startsWith("agent-browser-sess-1-") && f.endsWith(".png"));
    expect(saved).toHaveLength(1);
    expect(String(r.output)).toContain(join(SESSIONS_TMP, saved[0]!));
  });

  it("non-vision model gets the path + text stub, no image", async () => {
    const { tool } = toolWithShots([TINY_PNG_B64]);
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    const r = await tool.execute({ action: "screenshot" }, ctxFor("sess-1", TEXT_ONLY_REGISTRY));
    expect(r.images ?? []).toHaveLength(0);
    expect(String(r.output)).toContain("not vision-capable");
    expect(String(r.output)).toContain("agent-browser-sess-1-");
  });

  it("oversized PNG re-encodes to jpeg via Bun.Image and stays under the budget", async () => {
    expect(Buffer.from(HUGE_PNG_B64, "base64").byteLength).toBeGreaterThan(1_500_000);
    const { tool, made } = toolWithShots([HUGE_PNG_B64]);
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    const r = await tool.execute({ action: "screenshot" }, ctxFor("sess-1", VISION_REGISTRY));
    // Exactly one capture: the re-encode happens on the captured bytes, not via fresh shots.
    expect(made[0]!.screenshotCalls).toEqual([{ format: "png", quality: undefined }]);
    expect(r.images).toHaveLength(1);
    const part = r.images![0] as { mimeType: string; data: string };
    expect(part.mimeType).toBe("image/jpeg");
    const bytes = Buffer.from(part.data, "base64");
    expect(bytes[0]).toBe(0xff); // JPEG magic
    expect(bytes.byteLength).toBeLessThanOrEqual(1_500_000);
    const saved = readdirSync(SESSIONS_TMP).filter((f) => f.endsWith(".jpg"));
    expect(saved.length).toBeGreaterThan(0);
  });

  it("an image that cannot be re-encoded below budget is saved, never attached", async () => {
    // Not a decodable image at all: every ladder step fails, and the posture
    // is the same as over-budget -- save to disk, attach nothing (frame-cap H-1).
    const junk = Buffer.alloc(1_600_000, 7).toString("base64");
    const { tool } = toolWithShots([junk]);
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    const r = await tool.execute({ action: "screenshot" }, ctxFor("sess-1", VISION_REGISTRY));
    expect(r.images ?? []).toHaveLength(0);
    expect(String(r.output)).toContain("over the 1.5MB inline budget");
  });

  it("missing/unsafe session id saves under a tmp dir, never into the sessions dir", async () => {
    const { tool } = toolWithShots([TINY_PNG_B64]);
    const sneaky = "../escape";
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor(sneaky));
    const r = await tool.execute({ action: "screenshot" }, ctxFor(sneaky, VISION_REGISTRY));
    expect(r.images).toHaveLength(1);
    expect(String(r.output)).toContain(join(tmpdir(), "hotdog-agent-browser-"));
    expect(readdirSync(SESSIONS_TMP).filter((f) => f.includes("escape"))).toEqual([]);
  });
});

// ── Session isolation ───────────────────────────────────────────────────────

describe("session isolation", () => {
  it("one session cannot drive another session's view", async () => {
    const { tool } = makeTool();
    await tool.execute({ action: "open", url: PUBLIC_URL, view: "mine" }, ctxFor("s1"));
    const intruder = await tool.execute(
      { action: "navigate", view: "mine", url: "https://8.8.8.8/" },
      ctxFor("s2"),
    );
    expect(intruder.error).toContain('no view "mine"');
    const list = await tool.execute({ action: "list" }, ctxFor("s2"));
    expect(list.output).toContain("No views open");
  });
});

// ── Watchdog: per-op ceiling, poisoning, cancellation (audit finding 1) ────

describe("view watchdog (ceiling, poison, abort)", () => {
  const CEILING_MS = 250; // "hundreds of ms" override via the constructor seam

  /** Tool whose views are built per creation index, with a short ceiling. */
  function watchdogTool(makeView: (index: number) => FakeView, opTimeoutMs = CEILING_MS) {
    const made: FakeView[] = [];
    let n = 0;
    const tool = new AgentBrowserTool({
      allowLoopback: false,
      userGateEnabled: false,
      opTimeoutMs,
      createView: () => {
        const view = makeView(n++);
        made.push(view);
        return view;
      },
    });
    return { tool, made };
  }
  const stalling = () => {
    const view = new FakeView();
    view.stallNavigateUrls.add(PUBLIC_URL);
    return view;
  };

  it("a never-settling page load rejects at the ceiling with a close instruction", async () => {
    const { tool } = watchdogTool(() => stalling());
    const t0 = Date.now();
    const open = await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    expect(open.error).toContain(`did not finish within ${CEILING_MS} ms`);
    expect(open.error).toContain('action=close, view="main"');
    expect(Date.now() - t0).toBeLessThan(4_000); // released, not left hanging
  });

  it("a wedged view fails the next queue-bound call immediately; list still works", async () => {
    const { tool } = watchdogTool(() => stalling());
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    const t0 = Date.now();
    const snap = await tool.execute({ action: "snapshot" }, ctxFor());
    expect(snap.error).toContain("wedged");
    expect(snap.hint).toContain('action=close, view="main"');
    expect(Date.now() - t0).toBeLessThan(CEILING_MS); // fast-fail: no queue wait at all
    const list = await tool.execute({ action: "list" }, ctxFor());
    expect(list.output).toContain('"main"'); // list is queue-free
  });

  it("close works on a wedged view and a same-name reopen recovers it", async () => {
    const { tool, made } = watchdogTool((i) => (i === 0 ? stalling() : new FakeView()));
    await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    const closed = await tool.execute({ action: "close", view: "main" }, ctxFor());
    expect(closed.output).toContain('Closed view "main"');
    expect(made[0]!.closed).toBe(true);
    const reopened = await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    expect(reopened.error).toBeNull();
    expect(reopened.output).toContain('Opened view "main"');
  });

  it("a stalled guard egress releases the queue instead of poisoning it forever", async () => {
    // Redirect into private space whose about:blank egress never settles:
    // the guard runs under the same ceiling, so the triggering call returns
    // (guard error) and the view poisons -- nothing hangs, follow-ups fail fast.
    const { tool, made } = watchdogTool(() => {
      const view = new FakeView();
      view.redirectsTo = "http://10.1.2.3/evil";
      view.stallNavigateUrls.add("about:blank");
      return view;
    });
    const t0 = Date.now();
    const open = await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    expect(Date.now() - t0).toBeLessThan(4_000); // settle was NOT wedged by the stalled egress
    // Either the guard reports its landing or the drain watchdog reports the
    // pending guard work -- both name the guard and carry the close route.
    expect(open.error).toMatch(/navigation guard/i);
    expect(open.error).toContain('action=close, view="main"');
    const snap = await tool.execute({ action: "snapshot" }, ctxFor());
    expect(snap.error).toContain("wedged");
    expect(made[0]!.navigations).toContain("about:blank"); // the guard did try to egress
  });

  it("an aborted run releases a pending page call promptly, far below the ceiling", async () => {
    const ac = new AbortController();
    const { tool } = watchdogTool(() => stalling(), 60_000); // only the abort can release this
    const pending = tool.execute(
      { action: "open", url: PUBLIC_URL },
      ctxFor("sess-1", undefined, ac.signal),
    );
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    const t0 = Date.now();
    const open = await pending;
    expect(String(open.error).toLowerCase()).toContain("cancel");
    expect(Date.now() - t0).toBeLessThan(2_000); // released by the signal, not the ceiling
  }, 10_000);

  it("positive control: fast operations under a small ceiling neither time out nor poison", async () => {
    const { tool } = watchdogTool(() => new FakeView(), 2_000);
    const open = await tool.execute({ action: "open", url: PUBLIC_URL }, ctxFor());
    expect(open.error).toBeNull();
    const snap = await tool.execute({ action: "snapshot" }, ctxFor());
    expect(snap.error).toBeNull();
    const nav = await tool.execute({ action: "navigate", url: "https://8.8.8.8/" }, ctxFor());
    expect(nav.error).toBeNull();
    expect(nav.output).toContain("8.8.8.8");
    const click = await tool.execute({ action: "click", selector: "#go" }, ctxFor());
    expect(click.error).toBeNull();
  });
});

// ── Sessionless callers (audit finding 3) ─────────────────────────────────

describe("sessionless callers", () => {
  const NO_SESSION = { get: () => undefined } as never; // no agent, no sessionId anywhere

  it("refuses stateful actions when no sessionId is resolvable", async () => {
    const { tool, made } = makeTool();
    for (const action of [
      "open",
      "navigate",
      "snapshot",
      "click",
      "type",
      "press",
      "screenshot",
      "evaluate",
    ]) {
      const viaEmpty = await tool.execute(
        { action, url: PUBLIC_URL, script: "1+1" },
        ctxFor("", undefined),
      );
      expect(viaEmpty.error, action).toContain("sessionId");
      const viaNone = await tool.execute({ action, url: PUBLIC_URL, script: "1+1" }, NO_SESSION);
      expect(viaNone.error, action).toContain("sessionId");
    }
    expect(made).toHaveLength(0); // refusal burns no views
    expect(tool.viewCount("")).toBe(0); // the shared "" bucket stays unreachable/empty
  });

  it("list and close with no session are harmless empties", async () => {
    const { tool } = makeTool();
    const list = await tool.execute({ action: "list" }, NO_SESSION);
    expect(list.error).toBeNull();
    expect(list.output).toContain("No views open");
    const close = await tool.execute({ action: "close" }, NO_SESSION);
    expect(close.error).toBeNull();
    expect(close.output).toContain("No views were open.");
  });
});
