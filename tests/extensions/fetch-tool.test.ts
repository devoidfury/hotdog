import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { FetchTool } from "../../src/extensions/fetch-tool/index.ts";
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
    const tool = new FetchTool();
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
    const tool = new FetchTool();
    const display = tool.callDisplay(
      JSON.stringify({ url: "https://example.com", method: "GET" }),
    );
    expect(display).toContain("GET");
    expect(display).toContain("example.com");
  });

  it("generates call display for POST request", () => {
    const tool = new FetchTool();
    const display = tool.callDisplay(
      JSON.stringify({ url: "https://api.example.com/data", method: "POST" }),
    );
    expect(display).toContain("POST");
  });

  it("truncates long URLs in display", () => {
    const tool = new FetchTool();
    const longUrl = "https://example.com/" + "a".repeat(50);
    const display = tool.callDisplay(JSON.stringify({ url: longUrl }));
    expect(display).toContain("...");
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe("FetchTool input validation", () => {
  it("returns error for missing URL", async () => {
    const tool = new FetchTool();
    const result = await tool.execute(JSON.stringify({ method: "GET" }));
    expect(getDisplay(result)).toContain("Missing required argument: url");
  });

  it("returns error for empty input", async () => {
    const tool = new FetchTool();
    const result = await tool.execute("");
    expect(getDisplay(result)).toContain("Missing required argument: url");
  });

  it("returns error for null input", async () => {
    const tool = new FetchTool();
    const result = await tool.execute(null);
    expect(getDisplay(result)).toContain("Missing required argument: url");
  });

  it("returns error for invalid JSON", async () => {
    const tool = new FetchTool();
    const result = await tool.execute("not valid json");
    expect(getDisplay(result)).toContain("Error parsing arguments");
  });

  it("returns error for invalid HTTP method", async () => {
    const tool = new FetchTool();
    const result = await tool.execute(
      JSON.stringify({ url: `${BASE_URL}/html`, method: "INVALID" }),
    );
    expect(getDisplay(result)).toContain("Invalid HTTP method");
  });

  it("normalizes method to uppercase", async () => {
    const tool = new FetchTool();
    const result = await tool.execute(
      JSON.stringify({ url: `${BASE_URL}/html`, method: "get" }),
    );
    const str = getDisplay(result);
    expect(str).not.toContain("Invalid HTTP method");
    expect(str).not.toContain("Error parsing arguments");
  });

  it("handles object input", async () => {
    const tool = new FetchTool();
    const result = await tool.execute({ url: `${BASE_URL}/html` });
    const str = getDisplay(result);
    expect(str).not.toContain("Error parsing arguments");
  });

  for (const val of [true, false, "true"]) {
    it(`accepts showOriginal: ${JSON.stringify(val)} without parse error`, async () => {
      const tool = new FetchTool();
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/html`, showOriginal: val }),
      );
      const str = getDisplay(result);
      expect(str).not.toContain("Error parsing arguments");
      expect(str).not.toContain("Invalid");
    });
  }
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
      const tool = new FetchTool();
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
      const tool = new FetchTool();
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
      const tool = new FetchTool();
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
      const tool = new FetchTool();
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
      const tool = new FetchTool();
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/echo`, method: "GET" }),
      );
      const data = JSON.parse(result.output);
      expect(data.method).toBe("GET");
    });

    it("sends POST request with body", async () => {
      const tool = new FetchTool();
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
      const tool = new FetchTool();
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
      const tool = new FetchTool();
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
      const tool = new FetchTool();
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/echo`, method: "DELETE" }),
      );
      const data = JSON.parse(result.output);
      expect(data.method).toBe("DELETE");
    });

    it("sends HEAD request", async () => {
      const tool = new FetchTool();
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/html`, method: "HEAD" }),
      );
      // HEAD request should succeed
      expect(result.error).toBeFalsy();
    });
  });

  describe("custom headers", () => {
    it("sends custom headers", async () => {
      const tool = new FetchTool();
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
      const tool = new FetchTool();
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/status/200` }),
      );
      const status = result.metadata?.get("status");
      expect(status).toBe("200");
    });

    it("handles 404 Not Found", async () => {
      const tool = new FetchTool();
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/status/404` }),
      );
      const status = result.metadata?.get("status");
      expect(status).toBe("404");
    });

    it("handles 500 Internal Server Error", async () => {
      const tool = new FetchTool();
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/status/500` }),
      );
      const status = result.metadata?.get("status");
      expect(status).toBe("500");
    });
  });

  describe("metadata", () => {
    it("returns correct metadata fields", async () => {
      const tool = new FetchTool();
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
      const tool = new FetchTool();
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/plaintext` }),
      );
      const bodyLength = Number(result.metadata?.get("body_length"));
      expect(bodyLength).toBe(result.output.length);
    });
  });

  describe("plain text", () => {
    it("returns plain text content unchanged", async () => {
      const tool = new FetchTool();
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
      const tool = new FetchTool();
      const result = await tool.execute(
        JSON.stringify({ url: `${BASE_URL}/empty` }),
      );
      expect(result.output).toBe("");
      const bodyLength = Number(result.metadata?.get("body_length"));
      expect(bodyLength).toBe(0);
    });
  });

  describe("connection errors", () => {
    it("handles unreachable host", async () => {
      const tool = new FetchTool();
      const result = await tool.execute(
        JSON.stringify({ url: "http://localhost:19999/nonexistent" }),
      );
      expect(getDisplay(result)).not.toBe("");
    });
  });
});
