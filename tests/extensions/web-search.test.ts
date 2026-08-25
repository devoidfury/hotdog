import { describe, it, expect } from "bun:test";
import { WebSearchTool } from "../../src/extensions/web-search/index.ts";
import { resultStr, withMockFetch, jsonResponse } from "../helpers.ts";
import type { CoreContext } from "../../src/core/extensions/types.ts";

const defaultWebSearchOptions = {
  provider: "duckduckgo" as const,
  maxResults: 5,
  timeout: 15,
  braveApiKey: "",
  tavilyApiKey: "",
  searxngInstanceUrl: "",
};

describe("WebSearchTool", () => {
  it("has correct tool name", () => {
    expect(WebSearchTool.TOOL_NAME).toBe("web_search");
  });

  it("generates tool definition", () => {
    const tool = new WebSearchTool({ ...defaultWebSearchOptions });
    const def = tool.toToolDef();
    expect(def.function.name).toBe("web_search");
    expect(def.function.parameters.required).toEqual(["query"]);
    const props = def.function.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty("query");
    expect((props.query as Record<string, string>).type).toBe("string");
  });

  it("generates call display", () => {
    const tool = new WebSearchTool({ ...defaultWebSearchOptions });
    const display = tool.callDisplay(JSON.stringify({ query: "test query" }));
    expect(display).toContain("test query");
  });
});

describe("WebSearchTool input validation", () => {
  it("returns error for missing query", async () => {
    const tool = new WebSearchTool({ ...defaultWebSearchOptions });
    const result = await tool.execute(JSON.stringify({}));
    expect(resultStr(result)).toContain("query is required");
  });

  it("returns error for empty query", async () => {
    const tool = new WebSearchTool({ ...defaultWebSearchOptions });
    const result = await tool.execute(JSON.stringify({ query: "" }));
    expect(resultStr(result)).toContain("query is required");
  });

  it("returns error for whitespace-only query", async () => {
    const tool = new WebSearchTool({ ...defaultWebSearchOptions });
    const result = await tool.execute(JSON.stringify({ query: "   " }));
    expect(resultStr(result)).toContain("query is required");
  });

  it("returns error for null query", async () => {
    const tool = new WebSearchTool({ ...defaultWebSearchOptions });
    const result = await tool.execute(JSON.stringify({ query: null }));
    expect(resultStr(result)).toContain("query is required");
  });

  it("returns error for invalid JSON input", async () => {
    const tool = new WebSearchTool({ ...defaultWebSearchOptions });
    const result = await tool.execute("not valid json");
    expect(resultStr(result)).toContain("Error parsing arguments");
  });

  it("returns error for empty input", async () => {
    const tool = new WebSearchTool({ ...defaultWebSearchOptions });
    const result = await tool.execute("");
    expect(resultStr(result)).toContain("Error parsing arguments");
  });

  it("returns error for unknown provider", async () => {
    const tool = new WebSearchTool({ ...defaultWebSearchOptions, provider: "unknown_provider" });
    const result = await tool.execute(JSON.stringify({ query: "test" }));
    expect(resultStr(result)).toContain("Unknown search provider");
  });
});

describe("WebSearchTool provider configuration", () => {
  it("defaults to duckduckgo provider", () => {
    const tool = new WebSearchTool({ ...defaultWebSearchOptions });
    expect(tool.provider).toBe("duckduckgo");
  });

  it("treats the provider name case-insensitively at execution time", async () => {
    const mockHtml = `<html><body>
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example</a>
      <a class="result__snippet">Snippet</a>
    </body></html>`;

    await withMockFetch(async () => new Response(mockHtml, { status: 200 }), async () => {
      const tool = new WebSearchTool({ ...defaultWebSearchOptions, provider: "DUCKDUCKGO" });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      // "DUCKDUCKGO" must be recognized, not rejected as unknown.
      expect(result.success).toBe(true);
      expect(resultStr(result)).not.toContain("Unknown search provider");
      expect(resultStr(result)).toContain("Example");
    });
  });

  it("clamps maxResults between 1 and 10", () => {
    const tool1 = new WebSearchTool({ ...defaultWebSearchOptions, maxResults: 0 });
    expect(tool1.maxResults).toBe(1);
    const tool2 = new WebSearchTool({ ...defaultWebSearchOptions, maxResults: 100 });
    expect(tool2.maxResults).toBe(10);
    const tool3 = new WebSearchTool({ ...defaultWebSearchOptions, maxResults: 5 });
    expect(tool3.maxResults).toBe(5);
  });

  it("ensures minimum timeout of 1", () => {
    const tool = new WebSearchTool({ ...defaultWebSearchOptions, timeout: 0 });
    expect(tool.timeout).toBe(1);
  });
});

describe("WebSearchTool provider error handling", () => {
  it("brave returns error without API key", async () => {
    const tool = new WebSearchTool({ ...defaultWebSearchOptions, ...defaultWebSearchOptions,
        provider: "brave", braveApiKey: "" });
    const result = await tool.execute(JSON.stringify({ query: "test" }));
    expect(result.success).toBe(false);
    expect(resultStr(result)).toContain("Brave API key not configured");
  });

  it("tavily returns error without API key", async () => {
    const tool = new WebSearchTool({ ...defaultWebSearchOptions, provider: "tavily", tavilyApiKey: "" });
    const result = await tool.execute(JSON.stringify({ query: "test" }));
    expect(result.success).toBe(false);
    expect(resultStr(result)).toContain("Tavily API key not configured");
  });

  it("searxng returns error without instance URL", async () => {
    const tool = new WebSearchTool({
      ...defaultWebSearchOptions,
      provider: "searxng",
      searxngInstanceUrl: "",
    });
    const result = await tool.execute(JSON.stringify({ query: "test" }));
    expect(result.success).toBe(false);
    expect(resultStr(result)).toContain("SearXNG instance URL not configured");
  });
});

describe("WebSearchTool extension create", () => {
  it("creates extension with default config and registers the tool", async () => {
    const { create } = await import("../../src/extensions/web-search/index.ts");
    const { HOOKS } = await import("../../src/core/hooks.ts");
    const { createToolRegistry } =
      await import("../../src/core/extensions/tool-registry.ts");

    const ext = create({ config: {} } as unknown as CoreContext);
    const registry = createToolRegistry();
    await ext.hooks![HOOKS.TOOLS_REGISTER]!(registry);
    expect(registry.has("web_search")).toBe(true);
  });

  it("reads provider settings from config", async () => {
    const { create } = await import("../../src/extensions/web-search/index.ts");
    const { HOOKS } = await import("../../src/core/hooks.ts");
    const { createToolRegistry } =
      await import("../../src/core/extensions/tool-registry.ts");

    const ext = create({
      config: { webSearch: { provider: "duckduckgo", maxResults: 3, timeout: 10 } },
    } as unknown as CoreContext);
    const registry = createToolRegistry();
    await ext.hooks![HOOKS.TOOLS_REGISTER]!(registry);

    const tool = registry.get("web_search") as WebSearchTool;
    expect(tool).toBeInstanceOf(WebSearchTool);
    expect(tool.maxResults).toBe(3);
  });

  it("reads API keys from config", async () => {
    const { create } = await import("../../src/extensions/web-search/index.ts");
    const { HOOKS } = await import("../../src/core/hooks.ts");
    const { createToolRegistry } =
      await import("../../src/core/extensions/tool-registry.ts");

    // A tavily key from config must reach the registered tool: with it the
    // search proceeds; without it the tool reports "not configured".
    const ext = create({
      config: {
        webSearch: { provider: "tavily", maxResults: 5, timeout: 15, tavilyApiKey: "test-api-key" },
      },
    } as unknown as CoreContext);
    const registry = createToolRegistry();
    await ext.hooks![HOOKS.TOOLS_REGISTER]!(registry);

    const tool = registry.get("web_search") as WebSearchTool;
    await withMockFetch(async () => jsonResponse({ results: [] }), async () => {
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      expect(resultStr(result)).not.toContain("not configured");
    });
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

    await withMockFetch(async () => new Response(mockHtml, { status: 200 }), async () => {
      const tool = new WebSearchTool({ ...defaultWebSearchOptions });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      const output = resultStr(result);
      expect(output).toContain("Example Title");
      expect(output).toContain("https://example.com");
      expect(output).toContain("Example description text");
      expect(output).toContain("Another Title");
      expect(output).toContain("via DuckDuckGo");
    });
  });

  it("handles duckduckgo results with HTML in titles", async () => {
    const mockHtml = `<html><body>
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Title with <b>bold</b> text</a>
      <a class="result__snippet">Snippet with <i>italic</i></a>
    </body></html>`;

    await withMockFetch(async () => new Response(mockHtml, { status: 200 }), async () => {
      const tool = new WebSearchTool({ ...defaultWebSearchOptions });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      const output = resultStr(result);
      // HTMLRewriter extracts text content, so <b> tags are stripped naturally
      expect(output).toContain("Title with bold text");
      expect(output).not.toContain("<b>");
    });
  });

  it("handles empty duckduckgo results", async () => {
    await withMockFetch(async () => new Response("<html><body>No results</body></html>", { status: 200 }), async () => {
      const tool = new WebSearchTool({ ...defaultWebSearchOptions });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      expect(resultStr(result)).toContain("No results found");
    });
  });

  it("handles duckduckgo network error", async () => {
    await withMockFetch(async () => new Response("error", { status: 500 }), async () => {
      const tool = new WebSearchTool({ ...defaultWebSearchOptions });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(false);
      expect(resultStr(result)).toContain("Web search failed");
    });
  });

  it("handles malformed HTML gracefully", async () => {
    // HTMLRewriter (lol-html) handles malformed HTML robustly
    const mockHtml = `<html><body>
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Unclosed link
      <a class="result__snippet">Snippet for unclosed</a>
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org">Normal link</a>
      <a class="result__snippet">Normal snippet</a>
    </body></html>`;

    await withMockFetch(async () => new Response(mockHtml, { status: 200 }), async () => {
      const tool = new WebSearchTool({ ...defaultWebSearchOptions });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      const output = resultStr(result);
      expect(output).toContain("via DuckDuckGo");
    });
  });

  it("handles results with missing snippets", async () => {
    const mockHtml = `<html><body>
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Title Without Snippet</a>
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org">Title With Snippet</a>
      <a class="result__snippet">Only this one has a snippet</a>
    </body></html>`;

    await withMockFetch(async () => new Response(mockHtml, { status: 200 }), async () => {
      const tool = new WebSearchTool({ ...defaultWebSearchOptions });
      const result = await tool.execute(JSON.stringify({ query: "test" }));
      expect(result.success).toBe(true);
      const output = resultStr(result);
      expect(output).toContain("Title Without Snippet");
      expect(output).toContain("Title With Snippet");
      expect(output).toContain("Only this one has a snippet");
    });
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

    await withMockFetch(async () => jsonResponse(mockResponse), async () => {
      const tool = new WebSearchTool({
      ...defaultWebSearchOptions,
      provider: "brave",
      braveApiKey: "test-key",
    });
    const result = await tool.execute(JSON.stringify({ query: "test" }));
    expect(result.success).toBe(true);
    expect(resultStr(result)).toContain("Brave Result");
    expect(resultStr(result)).toContain("https://example.com");
    expect(resultStr(result)).toContain("via Brave");
    });
  });

  it("handles brave empty results", async () => {
    await withMockFetch(async () => jsonResponse({ web: { results: [] } }), async () => {
      const tool = new WebSearchTool({
      ...defaultWebSearchOptions,
      provider: "brave",
      braveApiKey: "test-key",
    });
    const result = await tool.execute(JSON.stringify({ query: "test" }));
    expect(result.success).toBe(true);
    expect(resultStr(result)).toContain("No results found");
    });
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

    await withMockFetch(async () => jsonResponse(mockResponse), async () => {
      const tool = new WebSearchTool({
      ...defaultWebSearchOptions,
      provider: "tavily",
      tavilyApiKey: "test-key",
    });
    const result = await tool.execute(JSON.stringify({ query: "test" }));
    expect(result.success).toBe(true);
    expect(resultStr(result)).toContain("Tavily Result");
    expect(resultStr(result)).toContain("https://example.com");
    expect(resultStr(result)).toContain("Content from Tavily");
    expect(resultStr(result)).toContain("via Tavily");
    });
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

    await withMockFetch(async () => jsonResponse(mockResponse), async () => {
      const tool = new WebSearchTool({
      ...defaultWebSearchOptions,
      provider: "searxng",
      searxngInstanceUrl: "https://searx.example.com",
    });
    const result = await tool.execute(JSON.stringify({ query: "test" }));
    expect(result.success).toBe(true);
    expect(resultStr(result)).toContain("SearXNG Result");
    expect(resultStr(result)).toContain("via SearXNG");
    });
  });
});
