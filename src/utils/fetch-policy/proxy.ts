// Policy proxy: loopback HTTP/CONNECT mediation for spawned children.
//
// Cooperative boundary -- honest clients (curl, wget, git, pip, npm,
// python-requests, node, Bun) obey HTTP_PROXY/HTTPS_PROXY; a determined
// script bypasses them (raw sockets, --noproxy). What this buys: every
// well-behaved child's connections hit one decision point, the HTTPS
// CONNECT authority is visible without MITM, and denied origins are denied
// before the network is touched.
//
// The transport knows nothing about policy. The extension supplies:
//   authenticate(user, pass) -> attribution | null   (per-session token)
//   admit(origin, attribution) -> null | block text  (decision + prompts)
//
// An unauthenticated caller gets one 407 challenge, then 403 -- a random
// process on the box cannot use this as an open relay. Loopback bind only;
// timeouts are off so tunnels and large uploads are not reaped (the client
// base is authenticated children, not the internet).

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { originOf, type Origin } from "./policy.ts";

export interface ProxyAttribution {
  sessionId: string;
  kind: "connect" | "request";
}

export interface PolicyProxyDeps {
  authenticate(user: string, pass: string): ProxyAttribution | null;
  /**
   * Hard egress tier: connections arriving on a UNIX socket carry their
   * attribution in WHICH socket they came through (per-session path, fs
   * permissions -- no Basic auth header needed, none is possible to forge
   * from inside a jail that owns only its own bind mount).
   */
  authenticateUnixSocket?(localPath: string): ProxyAttribution | null;
  admit(origin: Origin, attribution: ProxyAttribution): Promise<string | null>;
}

export interface PolicyProxy {
  port: number;
  /** Attach an additional UNIX-socket listener (hard egress tier). */
  listenUnix(path: string): Promise<void>;
  stop(): Promise<void>;
}

const PROXY_AGENT = "hotdog";

/** Hop-by-hop headers must not be forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  "proxy-authorization",
  "proxy-connection",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function parseBasic(header: string | string[] | undefined): { user: string; pass: string } | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !/^basic\s+/i.test(value)) return null;
  let text: string;
  try {
    text = Buffer.from(value.replace(/^basic\s+/i, ""), "base64").toString("utf-8");
  } catch {
    return null;
  }
  const colon = text.indexOf(":");
  if (colon === -1) return null;
  return { user: text.slice(0, colon), pass: text.slice(colon + 1) };
}

function denySocket(socket: net.Socket, status: 403 | 407 | 502): void {
  const line =
    status === 407
      ? 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="hotdog"\r\n'
      : status === 502
        ? "HTTP/1.1 502 Bad Gateway\r\n"
        : "HTTP/1.1 403 Forbidden\r\n";
  socket.write(`${line}Proxy-Agent: ${PROXY_AGENT}\r\n\r\n`);
  socket.destroy();
}

/** CONNECT authority -> https origin (the tunnel is opaque TLS; the authority IS the origin). */
export function authorityToOrigin(authority: string): Origin | null {
  return originOf(`https://${authority}`);
}

export async function startPolicyProxy(deps: PolicyProxyDeps): Promise<PolicyProxy> {
  // Hard egress lane: Bun's node:net does not report a unix socket's
  // listen path on accepted connections, so attribution is STAMPED at
  // accept time by the per-path listener (see listenUnix) and read back
  // from this WeakMap in the request handlers.
  // A STAMPED socket is always the hard lane -- even stamped with a null
  // owner (the session ended between accept-time lookup and registration):
  // stamped sockets never get the 407 challenge, they are refused.
  const socketOwners = new WeakMap<net.Socket, ProxyAttribution | null>();
  // One sibling listener per listenUnix path (Bun cannot say WHICH unix
  // handle an accepted socket came through, so the listener that accepted it
  // is what stamps); closed and unlinked when the proxy stops.
  const unixServers: Array<{ server: http.Server; path: string }> = [];
  const attributionFor = (
    socket: net.Socket,
    authHeader: string | string[] | undefined,
  ): { attribution: ProxyAttribution | null; viaUnix: boolean; basic: boolean } => {
    const basic = parseBasic(authHeader);
    const basicAttr = basic ? deps.authenticate(basic.user, basic.pass) : null;
    if (socketOwners.has(socket)) {
      // Hard egress lane: socket AND token must agree on the same owner.
      // A same-uid process that discovered another session's socket has no
      // token for it; a stolen token without the matching socket is only
      // ever the TCP lane, which the jail cannot reach.
      const unixAttr = socketOwners.get(socket) ?? null;
      const match = unixAttr !== null && basicAttr !== null && basicAttr.sessionId === unixAttr.sessionId;
      return { attribution: match ? unixAttr : null, viaUnix: true, basic: basic !== null };
    }
    return { attribution: basicAttr, viaUnix: false, basic: basic !== null };
  };

  const onRequest: http.RequestListener = (req, res) => {
    const rawUrl = req.url ?? "";
    // A proxy sees absolute-form URIs on forwarded requests; https:// here
    // is a client bug (it should CONNECT), origin-form means we are being
    // used as a server.
    if (!/^http:\/\//i.test(rawUrl)) {
      res.writeHead(400, { "Proxy-Agent": PROXY_AGENT });
      res.end("policy proxy: absolute-form http:// requests only\n");
      return;
    }
    const { attribution, viaUnix, basic } = attributionFor(req.socket, req.headers["proxy-authorization"]);
    if (!attribution) {
      // No (usable) credentials: one challenge; bad credentials (or a UNIX
      // socket for an unknown owner -- there is no challenge on that lane):
      // straight 403.
      if (!basic && !viaUnix) {
        res.writeHead(407, {
          "Proxy-Authenticate": 'Basic realm="hotdog"',
          "Proxy-Agent": PROXY_AGENT,
        });
        res.end();
      } else {
        res.writeHead(403, { "Proxy-Agent": PROXY_AGENT });
        res.end();
      }
      return;
    }
    const origin = originOf(rawUrl);
    if (!origin) {
      res.writeHead(403, { "Proxy-Agent": PROXY_AGENT });
      res.end();
      return;
    }
    void deps
      .admit(origin, { ...attribution, kind: "request" })
      .then((block) => {
        if (block) {
          res.writeHead(403, { "Proxy-Agent": PROXY_AGENT });
          res.end();
          return;
        }
        const target = new URL(rawUrl);
        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(req.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
        }
        headers.host = target.host;
        const upReq = http.request(
          {
            method: req.method,
            hostname: target.hostname,
            port: target.port !== "" ? Number(target.port) : 80,
            path: `${target.pathname}${target.search}`,
            headers,
          },
          (upRes) => {
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            upRes.pipe(res);
          },
        );
        upReq.on("error", () => {
          if (!res.headersSent) res.writeHead(502, { "Proxy-Agent": PROXY_AGENT });
          res.end("policy proxy: upstream connection failed\n");
        });
        req.on("error", () => upReq.destroy());
        req.pipe(upReq);
      })
      .catch(() => {
        res.writeHead(403, { "Proxy-Agent": PROXY_AGENT });
        res.end();
      });
  };

  const onConnect = (req: http.IncomingMessage, rawSocket: net.Socket, head: Buffer): void => {
    const clientSocket = rawSocket as net.Socket;
    const { attribution, viaUnix, basic } = attributionFor(clientSocket, req.headers["proxy-authorization"]);
    if (!attribution) {
      denySocket(clientSocket, basic || viaUnix ? 403 : 407);
      return;
    }
    const origin = authorityToOrigin(req.url ?? "");
    if (!origin) {
      denySocket(clientSocket, 403);
      return;
    }
    void deps
      .admit(origin, { ...attribution, kind: "connect" })
      .then((block) => {
        if (block) {
          denySocket(clientSocket, 403);
          return;
        }
        let established = false;
        const upstream = net.connect(origin.port, origin.host, () => {
          established = true;
          clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: hotdog\r\n\r\n");
          if (head && head.length > 0) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on("error", () => {
          if (!established) denySocket(clientSocket, 502);
          else clientSocket.destroy();
        });
        clientSocket.on("error", () => upstream.destroy());
      })
      .catch(() => denySocket(clientSocket, 403));
  };

  const newServer = (): http.Server => {
    const s = http.createServer(onRequest);
    s.on("connect", (req, socket, head) => onConnect(req, socket as net.Socket, head));
    // Tunnels and large uploads must not be reaped; the client base is
    // authenticated loopback children, not the internet.
    s.timeout = 0;
    s.requestTimeout = 0;
    s.keepAliveTimeout = 0;
    return s;
  };
  const server = newServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("policy proxy failed to bind a TCP port");
  }
  return {
    port: address.port,
    listenUnix: (path: string) =>
      new Promise<void>((resolve, reject) => {
        try {
          fs.unlinkSync(path); // stale socket from a previous run
        } catch {
          // nothing there
        }
        const listener = newServer();
        // Stamp at ACCEPT (not listen): an owner registered later is honoured,
        // and a session that already ended stamps null -- refused, not
        // challenged, because the hard lane has no credentials to negotiate.
        listener.on("connection", (sock) => {
          socketOwners.set(sock as net.Socket, deps.authenticateUnixSocket?.(path) ?? null);
        });
        const onError = (e: Error): void => {
          listener.removeListener("listening", onListening);
          reject(e);
        };
        const onListening = (): void => {
          listener.removeListener("error", onError);
          unixServers.push({ server: listener, path });
          resolve();
        };
        listener.once("error", onError);
        listener.once("listening", onListening);
        listener.listen(path);
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        const close = (s: http.Server): Promise<void> =>
          new Promise((done) => {
            (s as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
            s.close(() => done());
          });
        void Promise.all([server, ...unixServers.map((u) => u.server)].map(close)).then(() => {
          for (const { path } of unixServers) {
            try {
              fs.unlinkSync(path);
            } catch {
              // already gone
            }
          }
          unixServers.length = 0;
          resolve();
        });
      }),
  };
}
