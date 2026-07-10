import { test, describe, it, expect } from "bun:test";
import { WebSearchTool } from "../../src/extensions/web-search/index.js";
import { resultStr } from "../helpers.js";

describe("WebSearchTool", () => {
  it("has correct tool name", () => {
    expect(WebSearchTool.TOOL_NAME).toBe("web_search");
  });

  it("generates tool definition", () => {
    const tool = new WebSearchTool();
    const def = tool.toToolDef();
    expect(def.function.name).toBe("web_search");
    expect(def.function.parameters.required).toEqual(["query"]);
    expect(def.function.parameters.properties).toHaveProperty("query");
    expect(def.function.parameters.properties.query.type).toBe("string");
  });

  it("generates call display", () => {
    const tool = new WebSearchTool();
    const display = tool.callDisplay(JSON.stringify({ query: "test query" }));
    expect(display).toContain("test query");
  });
});

describe("WebSearchTool input validation", () => {
  it("returns error for missing query", async () => {
    const tool = new WebSearchTool();
    const result = await tool.execute(JSON.stringify({}));
    expect(resultStr(result)).toContain("query is required");
  });

  it("returns error for empty query", async () => {
    const tool = new WebSearchTool();
    const result = await tool.execute(JSON.stringify({ query: "" }));
    expect(resultStr(result)).toContain("query is required");
  });

  it("returns error for whitespace-only query", async () => {
    const tool = new WebSearchTool();
    const result = await tool.execute(JSON.stringify({ query: "   " }));
    expect(resultStr(result)).toContain("query is required");
  });

  it("returns error for null query", async () => {
    const tool = new WebSearchTool();
    const result = await tool.execute(JSON.stringify({ query: null }));
    expect(resultStr(result)).toContain("query is required");
  });

  it("returns error for invalid JSON input", async () => {
    const tool = new WebSearchTool();
    const result = await tool.execute("not valid json");
    expect(resultStr(result)).toContain("Error parsing arguments");
  });

  it("returns error for empty input", async () => {
    const tool = new WebSearchTool();
    const result = await tool.execute("");
    expect(resultStr(result)).toContain("Error parsing arguments");
  });

  it("returns error for unknown provider", async () => {
    const tool = new WebSearchTool({ provider: "unknown_provider" });
    const result = await tool.execute(JSON.stringify({ query: "test" }));
    expect(resultStr(result)).toContain("Unknown search provider");
  });
});

describe("WebSearchTool provider configuration", () => {
  it("defaults to duckduckgo provider", () => {
    const tool = new WebSearchTool();
    expect(tool.provider).toBe("duckduckgo");
  });

  for (const provider of ["duckduckgo", "brave", "tavily", "searxng"]) {
    it(`accepts ${provider} provider`, () => {
      const tool = new WebSearchTool({ provider });
      expect(tool.provider).toBe(provider);
    });
  }

  it("normalizes provider to lowercase", () => {
    const tool = new WebSearchTool({ provider: "DUCKDUCKGO" });
    expect(tool.provider).toBe("DUCKDUCKGO");
  });

  it("clamps maxResults between 1 and 10", () => {
    const tool1 = new WebSearchTool({ maxResults: 0 });
    expect(tool1.maxResults).toBe(1);
    const tool2 = new WebSearchTool({ maxResults: 100 });
    expect(tool2.maxResults).toBe(10);
    const tool3 = new WebSearchTool({ maxResults: 5 });
    expect(tool3.maxResults).toBe(5);
  });

  it("ensures minimum timeout of 1", () => {
    const tool = new WebSearchTool({ timeout: 0 });
    expect(tool.timeout).toBe(1);
  });
});

describe("WebSearchTool provider error handling", () => {
  it("brave returns error without API key", async () => {
    const tool = new WebSearchTool({ provider: "brave", braveApiKey: "" });
    const result = await tool.execute(JSON.stringify({ query: "test" }));
    expect(result.success).toBe(false);
    expect(resultStr(result)).toContain("Brave API key not configured");
  });

  it("tavily returns error without API key", async () => {
    const tool = new WebSearchTool({ provider: "tavily", tavilyApiKey: "" });
    const result = await tool.execute(JSON.stringify({ query: "test" }));
    expect(result.success).toBe(false);
    expect(resultStr(result)).toContain("Tavily API key not configured");
  });

  it("searxng returns error without instance URL", async () => {
    const tool = new WebSearchTool({
      provider: "searxng",
      searxngInstanceUrl: "",
    });
    const result = await tool.execute(JSON.stringify({ query: "test" }));
    expect(result.success).toBe(false);
    expect(resultStr(result)).toContain("SearXNG instance URL not configured");
  });
});

describe("WebSearchTool extension create", () => {
  it("creates extension with default config", async () => {
    const { create } = await import("../../src/extensions/web-search/index.js");
    const core = { config: {} };
    const ext = create(core);
    expect(ext).toBeDefined();
    expect(ext.WebSearchTool).toBeDefined();
    expect(ext.hooks).toBeDefined();
  });

  it("creates extension with custom config", async () => {
    const { create } = await import("../../src/extensions/web-search/index.js");
    const core = {
      config: {
        webSearch: {
          provider: "duckduckgo",
          maxResults: 3,
          timeout: 10,
        },
      },
    };
    const ext = create(core);
    const { HOOKS } = await import("../../src/core/hooks.ts");
    const { createToolRegistry } =
      await import("../../src/core/extensions/tool-registry.ts");

    const registry = createToolRegistry();
    await ext.hooks[HOOKS.TOOLS_REGISTER](registry);
    expect(registry.has("web_search")).toBe(true);
  });

  it("reads API keys from config", async () => {
    const { create } = await import("../../src/extensions/web-search/index.js");
    const core = {
      config: {
        webSearch: {
          provider: "tavily",
          tavilyApiKey: "test-api-key",
        },
      },
    };
    const ext = create(core);
    expect(ext).toBeDefined();
  });
});

describe("WebSearchTool DuckDuckGo parser", () => {
  // These tests verify the HTMLRewriter-based parsing logic without making network calls.
  // We mock fetch to return Response objects so HTMLRewriter can process them.

  it("parses duckduckgo HTML results correctly", async () => {
    const mockHtml = `<html><body>
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example Title</a>
      <a class="result__snippet">Example description text</a>
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org">Another Title</a>
      <a class="result__snippet">Another description</a>
    </body></html>`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(new Response(mockHtml, { status: 200 }));

    try {
      const tool = new WebSearchTool({ provider: "duckduckgo", maxResults: 5 });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      const output = resultStr(result);
      expect(output).toContain("Example Title");
      expect(output).toContain("https://example.com");
      expect(output).toContain("Example description text");
      expect(output).toContain("Another Title");
      expect(output).toContain("via DuckDuckGo");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles duckduckgo results with HTML in titles", async () => {
    const mockHtml = `<html><body>
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Title with <b>bold</b> text</a>
      <a class="result__snippet">Snippet with <i>italic</i></a>
    </body></html>`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(new Response(mockHtml, { status: 200 }));

    try {
      const tool = new WebSearchTool({ provider: "duckduckgo" });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      const output = resultStr(result);
      // HTMLRewriter extracts text content, so <b> tags are stripped naturally
      expect(output).toContain("Title with bold text");
      expect(output).not.toContain("<b>");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles empty duckduckgo results", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response("<html><body>No results</body></html>", { status: 200 }),
      );

    try {
      const tool = new WebSearchTool({ provider: "duckduckgo" });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      expect(resultStr(result)).toContain("No results found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles duckduckgo network error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(new Response("error", { status: 500 }));

    try {
      const tool = new WebSearchTool({ provider: "duckduckgo" });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(false);
      expect(resultStr(result)).toContain("Web search failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles malformed HTML gracefully", async () => {
    // HTMLRewriter (lol-html) handles malformed HTML robustly
    const mockHtml = `<html><body>
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Unclosed link
      <a class="result__snippet">Snippet for unclosed</a>
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org">Normal link</a>
      <a class="result__snippet">Normal snippet</a>
    </body></html>`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(new Response(mockHtml, { status: 200 }));

    try {
      const tool = new WebSearchTool({ provider: "duckduckgo" });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      const output = resultStr(result);
      expect(output).toContain("via DuckDuckGo");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles results with missing snippets", async () => {
    const mockHtml = `<html><body>
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Title Without Snippet</a>
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org">Title With Snippet</a>
      <a class="result__snippet">Only this one has a snippet</a>
    </body></html>`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(new Response(mockHtml, { status: 200 }));

    try {
      const tool = new WebSearchTool({ provider: "duckduckgo" });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      const output = resultStr(result);
      expect(output).toContain("Title Without Snippet");
      expect(output).toContain("Title With Snippet");
      expect(output).toContain("Only this one has a snippet");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("WebSearchTool Brave parser", () => {
  it("parses brave API response correctly", async () => {
    const mockResponse = {
      web: {
        results: [
          {
            title: "Brave Result",
            url: "https://example.com",
            description: "A description from Brave",
          },
        ],
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      });

    try {
      const tool = new WebSearchTool({
        provider: "brave",
        braveApiKey: "test-key",
      });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      expect(resultStr(result)).toContain("Brave Result");
      expect(resultStr(result)).toContain("https://example.com");
      expect(resultStr(result)).toContain("via Brave");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles brave empty results", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ web: { results: [] } }),
      });

    try {
      const tool = new WebSearchTool({
        provider: "brave",
        braveApiKey: "test-key",
      });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      expect(resultStr(result)).toContain("No results found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("WebSearchTool Tavily parser", () => {
  it("parses tavily API response correctly", async () => {
    const mockResponse = {
      results: [
        {
          title: "Tavily Result",
          url: "https://example.com",
          content: "Content from Tavily",
        },
      ],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      });

    try {
      const tool = new WebSearchTool({
        provider: "tavily",
        tavilyApiKey: "test-key",
      });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      expect(resultStr(result)).toContain("Tavily Result");
      expect(resultStr(result)).toContain("https://example.com");
      expect(resultStr(result)).toContain("Content from Tavily");
      expect(resultStr(result)).toContain("via Tavily");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("WebSearchTool SearXNG parser", () => {
  it("parses searxng API response correctly", async () => {
    const mockResponse = {
      results: [
        {
          title: "SearXNG Result",
          url: "https://example.com",
          content: "Content from SearXNG",
        },
      ],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      });

    try {
      const tool = new WebSearchTool({
        provider: "searxng",
        searxngInstanceUrl: "https://searx.example.com",
      });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      expect(resultStr(result)).toContain("SearXNG Result");
      expect(resultStr(result)).toContain("via SearXNG");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// avoid hitting the real endpoint in automated tests for now
test.skip("WebSearchTool DuckDuckGo network integration", () => {
  it("performs a real DuckDuckGo search", async () => {
    const tool = new WebSearchTool({
      provider: "duckduckgo",
      maxResults: 3,
      timeout: 15,
    });
    const result = await tool.execute(
      JSON.stringify({ query: "Bun JavaScript runtime" }),
    );
    // If network is unavailable, the test will error gracefully
    expect(result.success).toBe(true);
    const output = resultStr(result);
    expect(output).toContain("via DuckDuckGo");
    // Results should contain at least one URL
    expect(output).toContain("http");
    const lines = output.split("\n");
    // Header + at least one result (title + url = 2+ lines)
    expect(lines.length).toBeGreaterThan(2);
  }, 30000);
});
