// Upgrade-origin policy: the pure host-matching core behind the webui's
// /ws gate. Browsers always send Origin on a WebSocket handshake, so the
// policy is a pure header comparison -- no server, no sockets.

import { describe, it, expect } from "bun:test";
import { upgradeOriginAllowed, isLoopbackHost } from "@extensions/websocket/origin.ts";

describe("isLoopbackHost -- raw host contract", () => {
  // webui/server.ts feeds this raw config values; upgradeOriginAllowed falls
  // back to the raw bound string when URL parsing fails (e.g. "::").
  it("keeps wildcard addresses out of the loopback set", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
  });

  it("treats a *.localhost bind as a loopback bind", () => {
    expect(isLoopbackHost("app.localhost")).toBe(true);
    // So loopback names stay interchangeable through a named-loopback bind.
    expect(upgradeOriginAllowed("http://127.0.0.1:3000", "127.0.0.1:3000", "app.localhost")).toBe(true);
  });

  it("normalizes case", () => {
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("App.LocalHost")).toBe(true);
  });
});

describe("upgradeOriginAllowed -- loopback bind", () => {
  it("accepts loopback origins naming the local host", () => {
    expect(upgradeOriginAllowed("http://127.0.0.1:3000", "127.0.0.1:3000", "127.0.0.1")).toBe(true);
    expect(upgradeOriginAllowed("http://localhost:3000", "localhost:3000", "127.0.0.1")).toBe(true);
    expect(upgradeOriginAllowed("http://[::1]:3000", "[::1]:3000", "::1")).toBe(true);
    // Loopback names are interchangeable on a loopback bind.
    expect(upgradeOriginAllowed("http://localhost:3000", "127.0.0.1:3000", "127.0.0.1")).toBe(true);
  });

  it("accepts the whole 127.0.0.0/8 range, not just 127.0.0.1", () => {
    // 127.0.0.0/8 is loopback in its entirety (systemd-resolved answers on
    // 127.0.0.53); browsers reach a loopback-bound server through any of it.
    expect(upgradeOriginAllowed("http://127.0.0.53:3000", "127.0.0.53:3000", "127.0.0.1")).toBe(true);
    expect(upgradeOriginAllowed("http://127.2.3.4:3000", "127.2.3.4:3000", "localhost")).toBe(true);
    // Dotted-quad lookalikes are names, not addresses.
    expect(upgradeOriginAllowed("http://127.evil.example", "127.0.0.1:3000", "127.0.0.1")).toBe(false);
  });

  it("accepts every *.localhost name, which browsers resolve to loopback themselves", () => {
    expect(upgradeOriginAllowed("http://app.localhost:3000", "app.localhost:3000", "127.0.0.1")).toBe(true);
    expect(upgradeOriginAllowed("http://hotdog.localhost:3000", "hotdog.localhost:3000", "localhost")).toBe(true);
    // Lookalikes: not suffix-bounded, so not loopback.
    expect(upgradeOriginAllowed("http://evil.localhost.attacker.tld", "127.0.0.1:3000", "127.0.0.1")).toBe(false);
    expect(upgradeOriginAllowed("http://notlocalhost:3000", "127.0.0.1:3000", "127.0.0.1")).toBe(false);
    expect(upgradeOriginAllowed("http://localhost.attacker.tld:3000", "127.0.0.1:3000", "127.0.0.1")).toBe(false);
  });

  it("refuses a foreign origin", () => {
    expect(upgradeOriginAllowed("http://evil.example", "127.0.0.1:3000", "127.0.0.1")).toBe(false);
  });

  it("refuses the DNS-rebinding shape: attacker domain in BOTH headers", () => {
    // The socket really is local here -- which is exactly why Origin-vs-Host
    // alone is not the check; the bound host set is.
    expect(upgradeOriginAllowed("http://rebound.attacker.tld", "rebound.attacker.tld:3000", "127.0.0.1")).toBe(false);
  });

  it("fails closed on missing or garbage headers", () => {
    expect(upgradeOriginAllowed(null, "127.0.0.1:3000", "127.0.0.1")).toBe(false);
    expect(upgradeOriginAllowed("http://127.0.0.1:3000", null, "127.0.0.1")).toBe(false);
    expect(upgradeOriginAllowed(null, null, "127.0.0.1")).toBe(false);
    expect(upgradeOriginAllowed("", "", "127.0.0.1")).toBe(false);
    expect(upgradeOriginAllowed("not a url", "127.0.0.1:3000", "127.0.0.1")).toBe(false);
    expect(upgradeOriginAllowed("null", "127.0.0.1:3000", "127.0.0.1")).toBe(false); // opaque origin
  });
});

describe("upgradeOriginAllowed -- wildcard bind (0.0.0.0 / ::)", () => {
  it("accepts same-origin (Origin host == Host host)", () => {
    expect(upgradeOriginAllowed("http://192.168.1.7:3000", "192.168.1.7:3000", "0.0.0.0")).toBe(true);
    expect(upgradeOriginAllowed("http://mybox.lan:3000", "mybox.lan:3000", "0.0.0.0")).toBe(true);
  });

  it("refuses cross-origin drive-bys", () => {
    expect(upgradeOriginAllowed("http://evil.example", "192.168.1.7:3000", "0.0.0.0")).toBe(false);
  });
});

describe("upgradeOriginAllowed -- named-host bind", () => {
  it("accepts only that host, whatever port", () => {
    expect(upgradeOriginAllowed("http://hotdog.internal:3000", "hotdog.internal:3000", "hotdog.internal")).toBe(true);
    expect(upgradeOriginAllowed("https://hotdog.internal", "hotdog.internal:3000", "hotdog.internal")).toBe(true);
  });

  it("refuses loopback and foreign names on a named bind", () => {
    expect(upgradeOriginAllowed("http://127.0.0.1:3000", "hotdog.internal:3000", "hotdog.internal")).toBe(false);
    expect(upgradeOriginAllowed("http://evil.example", "hotdog.internal:3000", "hotdog.internal")).toBe(false);
    // The rebinding shape again: Host flattered, but the bind is a name.
    expect(upgradeOriginAllowed("http://evil.example", "evil.example:3000", "hotdog.internal")).toBe(false);
  });
});
