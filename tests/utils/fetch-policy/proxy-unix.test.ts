// Policy proxy -- the hard-egress UNIX lane (module-level, no extension):
// socket AND token must agree; the TCP lane keeps its cooperative shape.

import { describe, it, expect, afterAll } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPolicyProxy, type PolicyProxy, type ProxyAttribution } from "@utils/fetch-policy/proxy.ts";
import { type Origin } from "@utils/fetch-policy/policy.ts";

const admitted: Array<{ origin: string; session: string }> = [];
const SESSION = "sess-7";
const TOKEN = "tok-1234567890";

function authenticate(user: string, pass: string): ProxyAttribution | null {
  return user === SESSION && pass === TOKEN ? { sessionId: user, kind: "connect" } : null;
}

const sockets: Record<string, string> = {};

const proxyReady = startPolicyProxy({
  authenticate,
  authenticateUnixSocket: (localPath) => {
    const owner = Object.entries(sockets).find(([, p]) => p === localPath)?.[0];
    return owner ? { sessionId: owner, kind: "connect" } : null;
  },
  admit: async (origin: Origin, attribution: ProxyAttribution) => {
    admitted.push({ origin: origin.origin, session: attribution.sessionId });
    return origin.origin.includes("blocked") ? "policy deny" : null;
  },
});

const dir = mkdtempSync(join(tmpdir(), "policy-unix-"));
const sockPath = join(dir, "s7.sock");

afterAll(async () => {
  (await proxyReady).stop();
  rmSync(dir, { recursive: true, force: true });
});

const b64 = (user: string, pass: string) => Buffer.from(`${user}:${pass}`).toString("base64");

/** One absolute-form GET over the unix socket; resolves with the status line. */
function unixGet(path: string, authHeader: string | null, url = "http://ok.test/x"): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(path, () => {
      c.write(
        `GET ${url} HTTP/1.1\r\nHost: ok.test\r\n${authHeader ? `Proxy-Authorization: ${authHeader}\r\n` : ""}\r\n`,
      );
    });
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      const line = buf.split("\r\n")[0];
      if (line && /^HTTP\//.test(line)) {
        c.destroy();
        resolve(line);
      }
    });
    c.on("error", reject);
    setTimeout(() => {
      c.destroy();
      reject(new Error("no proxy reply"));
    }, 3000);
  });
}

describe("policy proxy unix lane (hard egress)", () => {
  let proxy: PolicyProxy;

  it("attaches a unix listener to the running server", async () => {
    proxy = await proxyReady;
    await proxy.listenUnix(sockPath);
    sockets[SESSION] = sockPath;
    expect(net).toBeTruthy();
  });

  it("socket + matching token attributes the connect to its owner", async () => {
    const line = await unixGet(sockPath, `Basic ${b64(SESSION, TOKEN)}`);
    expect(line).toContain("502");
    // ok.test does not resolve: the upstream dial fails, so 502 is honest.
    // The decision + attribution are what this lane is about.
    const decision = admitted[admitted.length - 1]!;
    expect(decision.session).toBe(SESSION);
  });

  it("socket attribution WITHOUT a token is refused (borrow guard)", async () => {
    admitted.length = 0;
    const line = await unixGet(sockPath, null);
    expect(line).toContain("403");
    expect(admitted).toHaveLength(0);
  });

  it("socket + the WRONG owner's token is refused", async () => {
    admitted.length = 0;
    const line = await unixGet(sockPath, `Basic ${b64("victim", "other-token")}`);
    expect(line).toContain("403");
    expect(admitted).toHaveLength(0);
  });

  it("a denied origin on the unix lane never dials", async () => {
    admitted.length = 0;
    const line = await unixGet(sockPath, `Basic ${b64(SESSION, TOKEN)}`, "http://blocked.test/x");
    expect(line).toContain("403");
    expect(admitted[0]?.origin).toBe("http://blocked.test");
  });

  it("the TCP lane is unchanged: valid Basic works, anonymous gets 407", async () => {
    const line = await new Promise<string>((resolve, reject) => {
      const c = net.connect(proxy.port, "127.0.0.1", () => {
        c.write(`GET http://ok.test/y HTTP/1.1\r\nHost: ok.test\r\nProxy-Authorization: Basic ${b64(SESSION, TOKEN)}\r\n\r\n`);
      });
      let buf = "";
      c.on("data", (d) => {
        buf += d.toString();
        if (/^HTTP\//.test(buf.split("\r\n")[0] ?? "")) {
          c.destroy();
          resolve(buf.split("\r\n")[0]!);
        }
      });
      c.on("error", reject);
    });
    expect(line).toContain("5"); // 502 upstream dial failed (decision was made)
    const anon = await new Promise<string>((resolve, reject) => {
      const c = net.connect(proxy.port, "127.0.0.1", () => {
        c.write("GET http://ok.test/z HTTP/1.1\r\nHost: ok.test\r\n\r\n");
      });
      let buf = "";
      c.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\r\n\r\n")) {
          c.destroy();
          resolve(buf.split("\r\n")[0]!);
        }
      });
      c.on("error", reject);
    });
    expect(anon).toContain("407");
  });
});
