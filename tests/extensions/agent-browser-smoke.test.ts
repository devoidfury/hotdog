// agent-browser (experimental): one real-Chromium smoke test through the
// default (production) view factory: open + snapshot + screenshot against a
// local fixture page. Gated on browser presence the house way (Bun.which, cf.
// tests/evals/gitrepo.test.ts); when skipped the reason rides in the describe
// title so a green run still says what did NOT run.
//
// Why a loopback fixture instead of a data: URL: the tool admits https/http
// only (owner ruling -- onNavigated would even egress a data: page to
// about:blank), so the fixture is served on 127.0.0.1 and the session runs
// with allowLoopback: true. That also exercises the one config knob end to end.
// All writes go under a tmp HOTDOG_SESSIONS_DIR.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentBrowserTool, createBunWebView } from "@experimental/agent-browser/index.ts";

const CHROMIUM_CANDIDATES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "microsoft-edge",
  "brave-browser",
];
const HAVE_CHROMIUM =
  Boolean(process.env.BUN_CHROME_PATH) || CHROMIUM_CANDIDATES.some((name) => Bun.which(name) !== null);

const SKIP_NOTE = HAVE_CHROMIUM
  ? ""
  : " -- SKIPPED: no chromium/chrome binary found on PATH and BUN_CHROME_PATH is unset; install chromium to exercise the real-browser path";

const suite = HAVE_CHROMIUM ? describe : describe.skip;

const FIXTURE = `<!DOCTYPE html><html><head><title>Smoke Fixture</title></head><body>
<h1>agent-browser smoke</h1>
<button id="go" class="cta" onclick="document.title='clicked'">Press me</button>
<input name="q" placeholder="search here" type="text">
<a href="about:blank">exit link</a>
</body></html>`;

suite(`agent_browser chromium smoke: open + snapshot + screenshot on a loopback fixture (allowLoopback)${SKIP_NOTE}`, () => {
  const previousSessionsDir = process.env.HOTDOG_SESSIONS_DIR;
  const sessionsTmp = mkdtempSync(join(tmpdir(), "agent-browser-smoke-"));
  process.env.HOTDOG_SESSIONS_DIR = sessionsTmp;

  const server = HAVE_CHROMIUM
    ? Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response(FIXTURE, { headers: { "Content-Type": "text/html" } }),
      })
    : null;

  const tool = HAVE_CHROMIUM
    ? new AgentBrowserTool({ allowLoopback: true, userGateEnabled: false, createView: createBunWebView })
    : null;

  const visionRegistry = { "smoke/vision": { name: "smoke/vision", inputModalities: ["text", "image"] } };
  const ctx = {
    get: (key: string) =>
      key === "agent" ? { sessionId: "smoke", model: "smoke/vision", modelRegistry: visionRegistry } : undefined,
  } as never;

  afterAll(async () => {
    server?.stop(true);
    tool?.closeSession("smoke");
    try {
      Bun.WebView.closeAll();
    } catch {
      /* nothing was ever spawned (skip path) */
    }
    process.env.HOTDOG_SESSIONS_DIR = previousSessionsDir;
    rmSync(sessionsTmp, { recursive: true, force: true });
  });

  it("loads the fixture, snapshots the interactive elements, and screenshots under the byte budget", async () => {
    const base = `http://127.0.0.1:${server!.port}/`;

    const open = await tool!.execute({ action: "open", url: base }, ctx);
    expect(open.error).toBeNull();
    expect(open.output).toContain("Smoke Fixture");

    const snap = await tool!.execute({ action: "snapshot" }, ctx);
    expect(snap.output).toContain("Smoke Fixture"); // title line
    expect(snap.output).toContain("#go"); // id
    expect(snap.output).toContain("Press me"); // text snippet
    expect(snap.output).toContain('aria="search here"'); // placeholder-as-label on the input
    expect(snap.output).toMatch(/button #go \.cta/); // class
    expect(snap.output).toMatch(/\(\d+,\d+\)/); // bounding-box center

    const shot = await tool!.execute({ action: "screenshot" }, ctx);
    expect(shot.error).toBeNull();
    const images = shot.images ?? [];
    expect(images).toHaveLength(1); // vision-capable session: an image part rides along
    const part = images[0] as { type: string; mimeType: string; data: string };
    expect(part.type).toBe("image_url");
    const bytes = Buffer.from(part.data, "base64");
    expect(bytes.byteLength).toBeGreaterThan(500); // a real viewport, not empty
    expect(bytes.byteLength).toBeLessThanOrEqual(1_500_000); // the source-byte cap holds
    expect(bytes[0] === 0x89 || bytes[0] === 0xff).toBe(true); // PNG magic, or JPEG after a budget re-encode

    const saved = readdirSync(sessionsTmp).filter((f) => f.startsWith("agent-browser-smoke-"));
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(sessionsTmp, saved[0]!)).byteLength).toBe(bytes.byteLength);

    const closed = await tool!.execute({ action: "close" }, ctx);
    expect(closed.output).toContain("Closed 1 view(s)");
  }, 60_000);
});
