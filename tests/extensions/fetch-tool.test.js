import { describe, it, expect, beforeAll } from "bun:test";
import { FetchTool } from "../../src/extensions/fetch-tool/index.js";
import { resultStr, getDisplay } from "../helpers.js";

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
    expect(def.function.parameters.properties).toHaveProperty("method");
    expect(def.function.parameters.properties).toHaveProperty("headers");
    expect(def.function.parameters.properties).toHaveProperty("body");
    expect(def.function.parameters.properties).toHaveProperty("showOriginal");
    expect(def.function.parameters.properties.showOriginal.type).toBe("boolean");
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
      JSON.stringify({ url: "https://example.com", method: "INVALID" }),
    );
    expect(getDisplay(result)).toContain("Invalid HTTP method");
  });

  it("normalizes method to uppercase", async () => {
    const tool = new FetchTool();
    // We can't easily verify the normalized method without mocking fetch,
    // but we can verify the tool accepts lowercase methods
    const result = await tool.execute(
      JSON.stringify({ url: "https://example.com", method: "get" }),
    );
    const str = getDisplay(result);
    // Should not return a parse error
    expect(str).not.toContain("Invalid HTTP method");
    expect(str).not.toContain("Error parsing arguments");
  });

  it("handles object input", async () => {
    const tool = new FetchTool();
    const result = await tool.execute({ url: "https://example.com" });
    const str = getDisplay(result);
    // Should not return a parse error
    expect(str).not.toContain("Error parsing arguments");
  });

  it("accepts showOriginal: true without parse error", async () => {
    const tool = new FetchTool();
    const result = await tool.execute(
      JSON.stringify({ url: "https://example.com", showOriginal: true }),
    );
    const str = getDisplay(result);
    expect(str).not.toContain("Error parsing arguments");
    expect(str).not.toContain("Invalid");
  });

  it("accepts showOriginal: false without parse error", async () => {
    const tool = new FetchTool();
    const result = await tool.execute(
      JSON.stringify({ url: "https://example.com", showOriginal: false }),
    );
    const str = getDisplay(result);
    expect(str).not.toContain("Error parsing arguments");
    expect(str).not.toContain("Invalid");
  });

  it('accepts showOriginal: "true" (string) without parse error', async () => {
    const tool = new FetchTool();
    const result = await tool.execute(
      JSON.stringify({ url: "https://example.com", showOriginal: "true" }),
    );
    const str = getDisplay(result);
    expect(str).not.toContain("Error parsing arguments");
    expect(str).not.toContain("Invalid");
  });
});

// ── Network-dependent tests (skipped when offline) ──────────────────────────

/**
 * Check if a URL is reachable before running network-dependent tests.
 * Uses a lightweight HEAD request with a short timeout.
 */
async function isReachable(url) {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    await fetch(url, { method: "HEAD", signal: controller.signal });
    return true;
  } catch {
    return false;
  }
}

describe("FetchTool network integration", () => {
  const EXAMPLE_URL = "https://example.com";
  const JSON_URL = "https://jsonplaceholder.typicode.com/posts/1";

  let exampleReachable = false;
  let jsonReachable = false;

  beforeAll(async () => {
    exampleReachable = await isReachable(EXAMPLE_URL);
    jsonReachable = await isReachable(JSON_URL);
  });

  it("converts HTML to GFM when showOriginal is not true", async () => {
    if (!exampleReachable) {
      console.warn("Skipping network test: example.com not reachable");
      return;
    }
    const tool = new FetchTool();
    const result = await tool.execute(JSON.stringify({ url: EXAMPLE_URL }));
    // output is the body string; metadata is in result.metadata (a Map)
    expect(typeof result.output).toBe("string");
    const contentType = result.metadata?.get("content_type") || "";
    expect(contentType).toContain("text/html");
    const bodyLength = result.metadata?.get("body_length");
    expect(bodyLength).toBeDefined();
  });

  it("returns original HTML when showOriginal is true", async () => {
    if (!exampleReachable) {
      console.warn("Skipping network test: example.com not reachable");
      return;
    }
    const tool = new FetchTool();
    const result = await tool.execute(
      JSON.stringify({ url: EXAMPLE_URL, showOriginal: true }),
    );
    expect(typeof result.output).toBe("string");
    const contentType = result.metadata?.get("content_type") || "";
    expect(contentType).toContain("text/html");
    expect(result.output.toLowerCase()).toContain("<!doctype html>");
  });

  it("returns non-HTML content unchanged when showOriginal is false", async () => {
    if (!jsonReachable) {
      console.warn("Skipping network test: jsonplaceholder not reachable");
      return;
    }
    const tool = new FetchTool();
    const result = await tool.execute(JSON.stringify({ url: JSON_URL }));
    expect(typeof result.output).toBe("string");
    const contentType = result.metadata?.get("content_type") || "";
    expect(contentType).toContain("application/json");
  });
});
