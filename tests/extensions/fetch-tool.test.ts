import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  FetchTool,
  isPrivateAddress,
  assertPublicHost,
  fetchWithSafeRedirects,
} from "../../src/extensions/fetch-tool/index.ts";
import { TransientError } from "../../src/core/error.ts";
import { resultStr, getDisplay } from "../helpers.ts";

// ── Local Test Server ──────────────────────────────────────────────────────

const TEST_PORT = 18932;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.serve> | null = null;

const sampleHtml = `<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body><h1>Hello World</h1><p>This is a test page.</p></body>
</html>`;

const sampleJson = { id: 1, title: "Test Post", body: "Lorem ipsum", userId: 1 };

function startTestServer(): void {
  server = Bun.serve({
    port: TEST_PORT,
    fetch(req) {
      const url = new URL(req.url);
      const method = req.method;

      // /html — serves HTML content
      if (url.pathname === "/html") {
        return new Response(sampleHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // /json — serves JSON content
      if (url.pathname === "/json") {
        return new Response(JSON.stringify(sampleJson), {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }

      // /echo — echoes back request details (method, headers, body)
      if (url.pathname === "/echo") {
        const headers: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          headers[key] = value;
        });
        let body: string | null = null;
        if (["POST", "PUT", "PATCH"].includes(method)) {
          body = ""; // will be filled below
        }
        return req.text().then((text) => {
          body = text || null;
          return new Response(JSON.stringify({ method, headers, body }), {
            headers: { "Content-Type": "application/json" },
          });
        });
      }

      // /status/:code — returns a specific HTTP status code
      if (url.pathname.startsWith("/status/")) {
        const code = parseInt(url.pathname.split("/")[2] ?? "404", 10);
        return new Response(`Status ${code}`, {
          status: code,
          headers: { "Content-Type": "text/plain" },
        });
      }

      // /headers — returns the request headers as JSON
      if (url.pathname === "/headers") {
        const headers: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return new Response(JSON.stringify(headers), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // /plaintext — serves plain text
      if (url.pathname === "/plaintext") {
        return new Response("Hello, plain text!", {
          headers: { "Content-Type": "text/plain" },
        });
      }

      // /empty — returns empty body
      if (url.pathname === "/empty") {
        return new Response("", {
          headers: { "Content-Type": "text/plain" },
        });
      }

      // /slow — responds after a 2s delay (timeout tests)
      if (url.pathname === "/slow") {
        return new Promise<Response>((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response("slow", {
                  headers: { "Content-Type": "text/plain" },
                }),
              ),
            2000,
          ),
        );
      }

      // /huge — large response body (memory cap + truncation tests)
      if (url.pathname === "/huge") {
        return new Response("x".repeat(500_000), {
          headers: { "Content-Type": "text/plain" },
        });
      }

      // /redirect/* — redirect endpoints for SSRF redirect-protection tests
      if (url.pathname === "/redirect/ok") {
        return new Response(null, { status: 302, headers: { Location: "/json" } });
      }
      if (url.pathname === "/redirect/private") {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1:1/none" },
        });
      }
      if (url.pathname === "/redirect/scheme") {
        return new Response(null, {
          status: 302,
          headers: { Location: "file:///etc/passwd" },
        });
      }
      if (url.pathname === "/redirect/loop") {
        return new Response(null, {
          status: 302,
          headers: { Location: "/redirect/loop" },
        });
      }
      if (url.pathname === "/redirect/post303") {
        return new Response(null, { status: 303, headers: { Location: "/echo" } });
      }
      if (url.pathname === "/redirect/keep307") {
        return new Response(null, { status: 307, headers: { Location: "/echo" } });
      }

      // Default: 404
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    },
  });
}

async function stopTestServer(): Promise<void> {
  if (server) {
    server.stop();
    server = null;
  }
}

// ── Tool Definition ─────────────────────────────────────────────────────────

describe("FetchTool", () => {
  it("has correct tool name", () => {
    expect(FetchTool.TOOL_NAME).toBe("fetch");
  });

  it("generates tool definition with all HTTP methods", () => {
    const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
    const def = tool.toToolDef();
    expect(def.function.name).toBe("fetch");
    expect(def.function.parameters.required).toEqual(["url"]);
    const props = def.function.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty("method");
    expect(props).toHaveProperty("headers");
    expect(props).toHaveProperty("body");
    expect(props).toHaveProperty("showOriginal");
    expect((props.showOriginal as Record<string, unknown>).type).toBe("boolean");
  });

  it("generates call display for GET request", () => {
    const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
    const display = tool.callDisplay(
      JSON.stringify({ url: "https://example.com", method: "GET" }),
    );
    expect(display).toContain("GET");
    expect(display).toContain("example.com");
  });

  it("generates call display for POST request", () => {
    const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
    const display = tool.callDisplay(
      JSON.stringify({ url: "https://api.example.com/data", method: "POST" }),
    );
    expect(display).toContain("POST");
  });

  it("truncates long URLs in display", () => {
    const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
    const longUrl = "https://example.com/" + "a".repeat(50);
    const display = tool.callDisplay(JSON.stringify({ url: longUrl }));
    expect(display).toContain("...");
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe("FetchTool input validation", () => {
  it("returns error for missing URL", async () => {
    const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
    const result = await tool.execute(JSON.stringify({ method: "GET" }));
    expect(getDisplay(result)).toContain("Missing required argument: url");
  });

  it("returns error for empty input", async () => {
    const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
    const result = await tool.execute("");
    expect(getDisplay(result)).toContain("Missing required argument: url");
  });

  it("returns error for null input", async () => {
    const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
    const result = await tool.execute(null);
    expect(getDisplay(result)).toContain("Missing required argument: url");
  });

  it("returns error for invalid JSON", async () => {
    const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
    const result = await tool.execute("not valid json");
    expect(getDisplay(result)).toContain("Error parsing arguments");
  });

  it("returns error for invalid HTTP method", async () => {
    const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
    const result = await tool.execute(
      JSON.stringify({ url: `${BASE_URL}/html`, method: "INVALID" }),
    );
    expect(getDisplay(result)).toContain("Invalid HTTP method");
  });

  it("normalizes method to uppercase", async () => {
    const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
    let result: unknown;
    let threw = false;
    try {
      result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/html`, method: "get" }),
      );
    } catch (e) {
      threw = true;
      result = e;
    }
    const str = threw ? (result as Error).message : getDisplay(result as Record<string, unknown>);
    expect(str).not.toContain("Invalid HTTP method");
    expect(str).not.toContain("Error parsing arguments");
  });

  it("handles object input", async () => {
    const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
    let result: unknown;
    let threw = false;
    try {
      result = await tool.execute({ url: `${BASE_URL}/html` });
    } catch (e) {
      threw = true;
      result = e;
    }
    const str = threw ? (result as Error).message : getDisplay(result as Record<string, unknown>);
    expect(str).not.toContain("Error parsing arguments");
  });

  for (const val of [true, false, "true"]) {
    it(`accepts showOriginal: ${JSON.stringify(val)} without parse error`, async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      let result: unknown;
      let threw = false;
      try {
        result = await tool.execute(
          JSON.stringify({ url: `${BASE_URL}/html`, showOriginal: val }),
        );
      } catch (e) {
        threw = true;
        result = e;
      }
      const str = threw ? (result as Error).message : getDisplay(result as Record<string, unknown>);
      expect(str).not.toContain("Error parsing arguments");
      expect(str).not.toContain("Invalid");
    });
  }
});

// ── URL restrictions (scheme gate + private host gate) ─────────────────────

describe("FetchTool URL restrictions", () => {
  const PRIVATE_V4 = [
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "255.255.255.255",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
  ];
  const PUBLIC_V4 = [
    "8.8.8.8",
    "93.184.216.34",
    "11.0.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "192.0.1.1",
    "192.0.3.1",
    "254.1.2.3",
  ];
  const PRIVATE_V6 = [
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "ff02::1",
    "ff0e::1",
    "2001:db8::1",
    "2002::1",
    "64:ff9b::1",
  ];
  const PUBLIC_V6 = [
    "2606:2800:220:1:248:1893:25c8:1946",
    "2001:4860:4860::8888",
    "2001:db9::1",
    "2003::1",
    "64:ff9c::1",
  ];

  describe("isPrivateAddress (pure classifier)", () => {
    for (const ip of PRIVATE_V4) {
      it(`treats ${ip} as private`, () => {
        expect(isPrivateAddress(ip)).toBe(true);
      });
    }
    for (const ip of PUBLIC_V4) {
      it(`treats ${ip} as public`, () => {
        expect(isPrivateAddress(ip)).toBe(false);
      });
    }
    for (const ip of PRIVATE_V6) {
      it(`treats [${ip}] as private`, () => {
        expect(isPrivateAddress(ip)).toBe(true);
      });
    }
    for (const ip of PUBLIC_V6) {
      it(`treats [${ip}] as public`, () => {
        expect(isPrivateAddress(ip)).toBe(false);
      });
    }
    for (const bad of ["", "garbage", "999.1.1.1", "1.2.3", "12345:::1", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8::"]) {
      it(`fails closed on malformed input ${JSON.stringify(bad)}`, () => {
        expect(isPrivateAddress(bad)).toBe(true);
      });
    }
    it("treats a full-form public IPv6 as public", () => {
      // Full (uncompressed) form of 2001:4860:4860::8888 -- exercises
      // expandIpv6's no-:: path, outside every reserved prefix.
      expect(isPrivateAddress("2001:0486:0486:0000:0000:0000:0000:0888")).toBe(false);
    });
    it("treats a full-form documentation IPv6 as private", () => {
      expect(isPrivateAddress("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(true);
    });
  });

  describe("scheme gate", () => {
    it("rejects file:// URLs (local file read vector)", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000 });
      const result = await tool.execute(JSON.stringify({ url: "file:///etc/hostname" }));
      const display = getDisplay(result);
      expect(display).toContain("scheme 'file' is not allowed");
      expect(display).toContain("http, https");
    });

    it("rejects ftp:// by default", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000 });
      const result = await tool.execute(JSON.stringify({ url: "ftp://example.com/file" }));
      expect(getDisplay(result)).toContain("scheme 'ftp' is not allowed");
    });

    it("rejects data:// by default", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000 });
      const result = await tool.execute(
        JSON.stringify({ url: "data:text/plain,hello" }),
      );
      expect(getDisplay(result)).toContain("scheme 'data' is not allowed");
    });

    it("accepts a configured additional scheme (no scheme error)", async () => {
      const tool = new FetchTool({
        timeoutMs: 30000,
        maxBodyLength: 8000,
        allowedSchemes: ["http", "https", "ftp"],
      });
      // localhost still trips the private-host gate (default) -- the point
      // here is that the error is NOT a scheme rejection.
      const result = await tool.execute(JSON.stringify({ url: "ftp://localhost/pub" }));
      const display = getDisplay(result);
      expect(display).not.toContain("is not allowed. Allowed schemes");
      expect(display).toContain("private or reserved");
    });

    it("rejects an unparseable URL", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000 });
      const result = await tool.execute(JSON.stringify({ url: "not a url" }));
      expect(getDisplay(result)).toContain("Invalid URL");
    });
  });

  describe("private host gate", () => {
    for (const ip of PRIVATE_V4) {
      it(`rejects ${ip} (literal)`, async () => {
        const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000 });
        const result = await tool.execute(JSON.stringify({ url: `http://${ip}/` }));
        expect(getDisplay(result)).toContain("private or reserved");
      });
    }

    for (const ip of PRIVATE_V6) {
      it(`rejects [${ip}] (literal)`, async () => {
        const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000 });
        const result = await tool.execute(JSON.stringify({ url: `http://[${ip}]/` }));
        expect(getDisplay(result)).toContain("private or reserved");
      });
    }

    it("passes public IP literals through the gate (no fetch, no DNS)", async () => {
      // IP literals short-circuit before any network access, so this is safe
      // offline.
      for (const ip of [...PUBLIC_V4, ...PUBLIC_V6]) {
        expect(await assertPublicHost(ip)).toBeNull();
      }
    });

    it("blocks private IP literals at the gate level", async () => {
      for (const ip of [...PRIVATE_V4, ...PRIVATE_V6]) {
        const err = await assertPublicHost(ip);
        expect(err).not.toBeNull();
        expect(err).toContain("private or reserved");
      }
    });

    it("rejects localhost by name (resolves to loopback)", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000 });
      const result = await tool.execute(
        JSON.stringify({ url: "http://localhost:18932/html" }),
      );
      const display = getDisplay(result);
      expect(display).toContain("private or reserved");
      expect(display).toContain("resolves to");
    });

    it("fails closed on an unresolvable host", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000 });
      const result = await tool.execute(
        JSON.stringify({ url: "http://nonexistent.invalid/" }),
      );
      expect(getDisplay(result)).toContain("Could not resolve host");
    });

    it("allows localhost when allowPrivateHosts is true", async () => {
      // Closed port on localhost: the point is that the request is not
      // stopped by the private-host gate (error is connection-level, not
      // "private or reserved").
      const tool = new FetchTool({
        timeoutMs: 30000,
        maxBodyLength: 8000,
        allowPrivateHosts: true,
      });
      const result = await tool.execute(
        JSON.stringify({ url: "http://localhost:19999/x" }),
      ).catch((e: unknown) => e);
      const display = result instanceof Error ? result.message : getDisplay(result);
      expect(display).not.toContain("private or reserved");
    });
  });
});

// ── Integration tests (local server) ────────────────────────────────────────

describe("FetchTool integration", () => {
  beforeAll(() => {
    startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
  });

  describe("HTML handling", () => {
    it("converts HTML to GFM when showOriginal is not true", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/html` }),
      );
      expect(typeof result.output).toBe("string");
      const contentType = result.metadata?.get("content_type") || "";
      expect(contentType).toContain("text/html");
      const bodyLength = result.metadata?.get("body_length");
      expect(bodyLength).toBeDefined();
      // Should be converted to markdown — no raw HTML or DOCTYPE
      expect(result.output).not.toContain("<!DOCTYPE html>");
      expect(result.output).not.toContain("<body>");
      expect(result.output).not.toContain("</body>");
    });

    it("returns original HTML when showOriginal is true", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/html`, showOriginal: true }),
      );
      expect(typeof result.output).toBe("string");
      const contentType = result.metadata?.get("content_type") || "";
      expect(contentType).toContain("text/html");
      expect(result.output.toLowerCase()).toContain("<!doctype html>");
    });
  });

  describe("JSON handling", () => {
    it("returns JSON content as-is regardless of showOriginal", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/json` }),
      );
      expect(typeof result.output).toBe("string");
      const contentType = result.metadata?.get("content_type") || "";
      expect(contentType).toContain("application/json");
      const parsed = JSON.parse(result.output);
      expect(parsed.id).toBe(1);
      expect(parsed.title).toBe("Test Post");
    });

    it("returns JSON content unchanged when showOriginal is true", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/json`, showOriginal: true }),
      );
      expect(typeof result.output).toBe("string");
      const contentType = result.metadata?.get("content_type") || "";
      expect(contentType).toContain("application/json");
      const parsed = JSON.parse(result.output);
      expect(parsed.id).toBe(1);
    });
  });

  describe("HTTP methods", () => {
    it("sends GET request", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/echo`, method: "GET" }),
      );
      const data = JSON.parse(result.output);
      expect(data.method).toBe("GET");
    });

    it("sends POST request with body", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({
          url: `${BASE_URL}/echo`,
          method: "POST",
          body: '{"hello":"world"}',
        }),
      );
      const data = JSON.parse(result.output);
      expect(data.method).toBe("POST");
      expect(data.body).toBe('{"hello":"world"}');
    });

    it("sends PUT request with body", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({
          url: `${BASE_URL}/echo`,
          method: "PUT",
          body: '{"id":1}',
        }),
      );
      const data = JSON.parse(result.output);
      expect(data.method).toBe("PUT");
      expect(data.body).toBe('{"id":1}');
    });

    it("sends PATCH request with body", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({
          url: `${BASE_URL}/echo`,
          method: "PATCH",
          body: '{"name":"updated"}',
        }),
      );
      const data = JSON.parse(result.output);
      expect(data.method).toBe("PATCH");
      expect(data.body).toBe('{"name":"updated"}');
    });

    it("sends DELETE request", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/echo`, method: "DELETE" }),
      );
      const data = JSON.parse(result.output);
      expect(data.method).toBe("DELETE");
    });

    it("sends HEAD request", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/html`, method: "HEAD" }),
      );
      // HEAD request should succeed
      expect(result.error).toBeFalsy();
    });
  });

  describe("custom headers", () => {
    it("sends custom headers", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({
          url: `${BASE_URL}/headers`,
          headers: { "X-Custom-Header": "test-value" },
        }),
      );
      const data = JSON.parse(result.output);
      expect(data["x-custom-header"]).toBe("test-value");
    });
  });

  describe("status codes", () => {
    it("handles 200 OK", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/status/200` }),
      );
      const status = result.metadata?.get("status");
      expect(status).toBe("200");
    });

    it("handles 404 Not Found", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/status/404` }),
      );
      const status = result.metadata?.get("status");
      expect(status).toBe("404");
    });

    it("handles 500 Internal Server Error", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/status/500` }),
      );
      const status = result.metadata?.get("status");
      expect(status).toBe("500");
    });
  });

  describe("metadata", () => {
    it("returns correct metadata fields", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/json` }),
      );
      expect(result.metadata?.get("url")).toBe(`${BASE_URL}/json`);
      expect(result.metadata?.get("method")).toBe("GET");
      expect(result.metadata?.get("status")).toBe("200");
      expect(result.metadata?.get("content_type")).toContain("application/json");
      expect(result.metadata?.get("body_length")).toBeDefined();
    });

    it("reports body_length correctly", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/plaintext` }),
      );
      const bodyLength = Number(result.metadata?.get("body_length"));
      expect(bodyLength).toBe(result.output.length);
    });
  });

  describe("plain text", () => {
    it("returns plain text content unchanged", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/plaintext` }),
      );
      expect(result.output).toBe("Hello, plain text!");
      const contentType = result.metadata?.get("content_type") || "";
      expect(contentType).toContain("text/plain");
    });
  });

  describe("empty responses", () => {
    it("handles empty response body", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/empty` }),
      );
      expect(result.output).toBe("");
      const bodyLength = Number(result.metadata?.get("body_length"));
      expect(bodyLength).toBe(0);
    });
  });

  describe("connection errors", () => {
    it("throws TransientError on unreachable host", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      await expect(
        tool.execute(JSON.stringify({ url: "http://localhost:19999/nonexistent" }))
      ).rejects.toThrow(/Connection failed/);
    });
  });

  describe("timeouts and large bodies", () => {
    it("aborts slow responses with TransientError when the timeout fires", async () => {
      const tool = new FetchTool({ timeoutMs: 300, maxBodyLength: 8000, allowPrivateHosts: true });
      const t0 = Date.now();
      await expect(
        tool.execute(JSON.stringify({ url: `${BASE_URL}/slow` })),
      ).rejects.toThrow(/timed out/);
      // Must not wait for the server's full 2s delay.
      expect(Date.now() - t0).toBeLessThan(1500);
    });

    it("caps large response reads and truncates the display", async () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000, allowPrivateHosts: true });
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/huge` }),
      );
      expect(result.output.length).toBeLessThanOrEqual(8000);
      expect(result.metadata?.get("truncated")).toBe("true");
      // body_length reports the body before display truncation.
      const bodyLength = Number(result.metadata?.get("body_length"));
      expect(bodyLength).toBeGreaterThan(8000);
    });
  });

  describe("redirect SSRF protection", () => {
    const allowAll = async () => null;

    function args(overrides: { method?: string; body?: string | null } = {}) {
      return {
        url: "",
        method: (overrides.method || "GET") as "GET",
        headers: {},
        body: overrides.body ?? null,
        showOriginal: false,
        host: null,
      };
    }

    const opts = (checkHost: (host: string) => Promise<string | null>) => ({
      allowedSchemes: ["http", "https"],
      checkHost,
    });

    it("follows a relative redirect when the target passes the gates", async () => {
      const resp = await fetchWithSafeRedirects(
        `${BASE_URL}/redirect/ok`,
        args(),
        5000,
        opts(allowAll),
      );
      expect(resp.status).toBe(200);
      expect(await resp.text()).toContain("Lorem ipsum");
    });

    it("refuses a redirect to a private host", async () => {
      await expect(
        fetchWithSafeRedirects(
          `${BASE_URL}/redirect/private`,
          args(),
          5000,
          opts(assertPublicHost),
        ),
      ).rejects.toThrow(/private or reserved/);
    });

    it("refuses a redirect to a disallowed scheme", async () => {
      await expect(
        fetchWithSafeRedirects(
          `${BASE_URL}/redirect/scheme`,
          args(),
          5000,
          opts(allowAll),
        ),
      ).rejects.toThrow(/disallowed scheme 'file'/);
    });

    it("stops at the redirect hop limit", async () => {
      await expect(
        fetchWithSafeRedirects(
          `${BASE_URL}/redirect/loop`,
          args(),
          5000,
          { ...opts(allowAll), maxRedirects: 3 },
        ),
      ).rejects.toThrow(/Too many redirects \(limit 3\)/);
    });

    it("downgrades a 303 POST to a GET without body", async () => {
      const resp = await fetchWithSafeRedirects(
        `${BASE_URL}/redirect/post303`,
        args({ method: "POST", body: "payload" }),
        5000,
        opts(allowAll),
      );
      const echoed = (await resp.json()) as { method: string; body: unknown };
      expect(echoed.method).toBe("GET");
      expect(echoed.body).toBeNull();
    });

    it("preserves method and body on a 307", async () => {
      const resp = await fetchWithSafeRedirects(
        `${BASE_URL}/redirect/keep307`,
        args({ method: "POST", body: "payload" }),
        5000,
        opts(allowAll),
      );
      const echoed = (await resp.json()) as { method: string; body: unknown };
      expect(echoed.method).toBe("POST");
      expect(echoed.body).toBe("payload");
    });

    it("returns a redirect without a Location header as-is, body intact", async () => {
      const resp = await fetchWithSafeRedirects(
        `${BASE_URL}/status/302`,
        args(),
        5000,
        opts(allowAll),
      );
      expect(resp.status).toBe(302);
      expect(resp.headers.get("location")).toBeNull();
      expect(await resp.text()).toBe("Status 302");
    });

    it("tool description advertises redirect checking when protection is on", () => {
      const tool = new FetchTool({ timeoutMs: 30000, maxBodyLength: 8000 });
      expect(tool.toToolDef().function.description).toContain("redirect targets");

      const openTool = new FetchTool({
        timeoutMs: 30000,
        maxBodyLength: 8000,
        allowPrivateHosts: true,
      });
      expect(openTool.toToolDef().function.description).not.toContain("redirect targets");
    });
  });
});
