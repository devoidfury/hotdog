// Egress bridge: TCP accept piped to the policy proxy's unix socket. The
// netns part is the shim's job (gated elsewhere); the wire itself needs no
// namespace and is fully testable here.

import { describe, it, expect } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEgressBridge } from "@utils/egress-bridge.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "egress-bridge-"));
}

/** Unix socket server that prefixes each received chunk. */
function unixPrefixer(prefix: string): Promise<{ server: net.Server; path: string; dir: string }> {
  const dir = tmpRoot();
  const path = join(dir, "u.sock");
  const server = net.createServer((c) => {
    c.on("data", (d) => c.write(prefix + d));
  });
  return new Promise((resolve) => server.listen(path, () => resolve({ server, path, dir })));
}

function tcpRoundtrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, "127.0.0.1", () => c.write(payload));
    let out = "";
    c.on("data", (d) => {
      out += d.toString();
      c.end();
    });
    c.on("close", () => resolve(out));
    c.on("error", reject);
  });
}

describe("egress bridge", () => {
  it("round-trips bytes jail-TCP -> upstream-unix and back", async () => {
    const { server, path, dir } = await unixPrefixer("upstream:");
    const bridge = await startEgressBridge({ unixPath: path, port: 0 });
    try {
      expect(await tcpRoundtrip(bridge.port, "hello")).toBe("upstream:hello");
    } finally {
      await bridge.stop();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing upstream closes the client socket (fail closed, no hang)", async () => {
    const bridge = await startEgressBridge({ unixPath: "/tmp/definitely-not-a-hotdog-sock-4242", port: 0 });
    try {
      const closed = await new Promise<string>((resolve) => {
        const c = net.connect(bridge.port, "127.0.0.1", () => c.write("x"));
        c.on("close", () => resolve("closed"));
        c.on("error", () => resolve("closed"));
        setTimeout(() => resolve("hung"), 1500);
      });
      expect(closed).toBe("closed");
    } finally {
      await bridge.stop();
    }
  });

  it("stop() drops live tunnels", async () => {
    const { server, path, dir } = await unixPrefixer("e:");
    const bridge = await startEgressBridge({ unixPath: path, port: 0 });
    const closed = new Promise<boolean>((resolve) => {
      const c = net.connect(bridge.port, "127.0.0.1", () => c.write("keepalive"));
      // Drain the echo: Bun never fires 'close' on a socket left paused with
      // unread inbound data, even once the peer is gone. Real proxy clients
      // read; a silent one would hide the very event this test asserts.
      c.on("data", () => {});
      c.on("close", () => resolve(true));
    });
    // Let the echo land so the tunnel is genuinely live.
    await new Promise((r) => setTimeout(r, 50));
    await bridge.stop();
    expect(await closed).toBe(true);
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
