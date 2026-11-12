import { describe, it, expect, spyOn } from "bun:test";
import { WebSearchTool, ddgSolveService, create as createWebSearchExtension } from "@extensions/web-search/index.ts";
import { resultStr, withMockFetch, jsonResponse, textResponse } from "../helpers.ts";
import { logger } from "@utils/logger.ts";
import { bootLiveStore, publishLive, registerWithLiveStore } from "../mocks/config-live.ts";
import { AssistantRetryableError } from "@core/error.ts";
import { ServiceRegistry } from "@core/extensions/service-registry.ts";
import type { CoreContext } from "@core/extensions/types.ts";

const defaultWebSearchOptions = {
  provider: "duckduckgo" as const,
  maxResults: 5,
  timeout: 15,
  braveApiKey: "",
  tavilyApiKey: "",
  searxngInstanceUrl: "",
};

// Minimal real-shape DDG challenge page (9 tiles would be noisy; 3 suffice).
function challengeHtml(gk = "abcd"): string {
  const action = `//duckduckgo.com/anomaly.js?sv=html&cc=sre&st=1793012753&gk=${gk}&p=f1-f2-f3&q=test`;
  const tile = (h: string) =>
    `<div class="anomaly-modal__box"><input type="checkbox" name="image-check_${h}" id="image-check_${h}"><img class="anomaly-modal__image" alt=" " id="image-${h}" src="../assets/anomaly/images/challenge/${h}.jpg"></div>`;
  return `<html><body>
    <form id="img-form" action="${action.replace("st=", "ti=")}" target="ifr" method="POST"></form>
    <form id="challenge-form" action="${action}" method="POST">
      ${tile("f1")}${tile("f2")}${tile("f3")}
      <button name="challenge-submit" value="${gk}">Submit</button>
    </form></body></html>`;
}

function resultsHtml(): string {
  return `<html><body>
    <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Whittles Pub &amp; Grub</a>
    <a class="result__snippet">Restaurant, Bar</a>
  </body></html>`;
}

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
    const { create } = await import("@extensions/web-search/index.ts");
    const { HOOKS } = await import("@core/hooks.ts");
    const { createToolRegistry } =
      await import("@core/extensions/tool-registry.ts");

    const ext = create({ config: {}, services: new ServiceRegistry() } as unknown as CoreContext);
    const registry = createToolRegistry();
    await ext.hooks![HOOKS.TOOLS_REGISTER]!(registry);
    expect(registry.has("web_search")).toBe(true);
  });

  it("reads provider settings from config", async () => {
    const { create } = await import("@extensions/web-search/index.ts");
    const { HOOKS } = await import("@core/hooks.ts");
    const { createToolRegistry } =
      await import("@core/extensions/tool-registry.ts");

    const ext = create({
      config: { webSearch: { provider: "duckduckgo", maxResults: 3, timeout: 10 } },
      services: new ServiceRegistry(),
    } as unknown as CoreContext);
    const registry = createToolRegistry();
    await ext.hooks![HOOKS.TOOLS_REGISTER]!(registry);

    const tool = registry.get("web_search") as WebSearchTool;
    expect(tool).toBeInstanceOf(WebSearchTool);
    expect(tool.maxResults).toBe(3);
  });

  it("reads API keys from config", async () => {
    const { create } = await import("@extensions/web-search/index.ts");
    const { HOOKS } = await import("@core/hooks.ts");
    const { createToolRegistry } =
      await import("@core/extensions/tool-registry.ts");

    // A tavily key from config must reach the registered tool: with it the
    // search proceeds; without it the tool reports "not configured".
    const ext = create({
      config: {
        webSearch: { provider: "tavily", maxResults: 5, timeout: 15, tavilyApiKey: "test-api-key" },
      },
      services: new ServiceRegistry(),
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

  it("throws AssistantRetryableError with text-relay hint on 202 (no webui mounted)", async () => {
    // No webui base URL set: hint must carry the tile image URLs + tiles arg
    // flow instead of a solve page.
    await withMockFetch(
      async (url) =>
        url.includes("/assets/anomaly/") ? new Response(new Uint8Array([0xff]), { status: 200 }) : textResponse(challengeHtml(), 202, "text/html"),
      async () => {
        const tool = new WebSearchTool({ ...defaultWebSearchOptions });
        let caught: unknown;
        try {
          await tool.execute(JSON.stringify({ query: "test query" }));
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(AssistantRetryableError);
        expect((caught as Error).message).toContain("CAPTCHA");
        const hint = (caught as AssistantRetryableError).hint || "";
        expect(hint).toContain("tiles");
        expect(hint).toContain("assets/anomaly/images/challenge/f1.jpg");
      },
    );
  });

  it("relays a solve-page answer on the next search (webui-mounted)", async () => {
    ddgSolveService.setBaseUrl("http://webui.test:3000");
    try {
      // Round 1: 202 -> challenge registered; hint carries the webui solve URL.
      let solvePath = "";
      await withMockFetch(
        async (url) =>
          url.includes("/assets/anomaly/") ? new Response(new Uint8Array([0xff]), { status: 200 }) : textResponse(challengeHtml(), 202, "text/html"),
        async () => {
          const tool = new WebSearchTool({ ...defaultWebSearchOptions });
          try {
            await tool.execute(JSON.stringify({ query: "test query" }));
            throw new Error("expected challenge error");
          } catch (e) {
            if (!(e instanceof AssistantRetryableError)) throw e;
            solvePath = ((e.hint || "").match(/\/solve\/[0-9a-f]{16}/) || [""])[0];
          }
        },
      );
      expect(solvePath).toMatch(/^\/solve\/[0-9a-f]{16}$/);

      // User picks tiles 1 and 3 on the mounted solve route (the real handler,
      // exactly as the webui server would invoke it).
      const solveHandler = ddgSolveService.routes["/solve/*"]!;
      const pageResp = await solveHandler(new Request(`http://webui.test:3000${solvePath}`));
      const pageHtml = await pageResp.text();
      expect(pageResp.status).toBe(200);
      expect(pageHtml).toContain("image-check_f1");
      expect(pageHtml).toContain("/tiles/"); // images proxied from our host

      const post = await solveHandler(
        new Request(`http://webui.test:3000${solvePath}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "image-check_f1=on&image-check_f3=on",
        }),
      );
      expect(post.status).toBe(200);

      // Round 2: retry. First GET still 202 -> relay POSTs answer (200) -> GET returns results.
      let firstGet = true;
      await withMockFetch(
        async (url, opts) => {
          if ((opts?.method ?? "GET") === "POST" && url.includes("anomaly.js")) return textResponse("ok", 200);
          if (url.includes("html.duckduckgo.com")) return firstGet ? ((firstGet = false), textResponse(challengeHtml(), 202, "text/html")) : textResponse(resultsHtml(), 200);
          return new Response("unexpected " + url, { status: 599 });
        },
        async () => {
          const tool = new WebSearchTool({ ...defaultWebSearchOptions });
          const result = await tool.execute(JSON.stringify({ query: "test query" }));
          expect(result.success).toBe(true);
          expect(resultStr(result)).toContain("Whittles Pub");
        },
      );
    } finally {
      ddgSolveService.setBaseUrl("");
    }
  });

  it("relays a text-only tiles argument without the solve page", async () => {
    // Register a challenge via a 202, then answer it via the tiles arg.
    await withMockFetch(
      async (url) =>
        url.includes("/assets/anomaly/") ? new Response(new Uint8Array([0xff]), { status: 200 }) : textResponse(challengeHtml(), 202, "text/html"),
      async () => {
        const tool = new WebSearchTool({ ...defaultWebSearchOptions });
        try {
          await tool.execute(JSON.stringify({ query: "test query" }));
        } catch {
          /* challenge error expected */
        }
      },
    );

    await withMockFetch(
      async (url, opts) => {
        if ((opts?.method ?? "GET") === "POST" && url.includes("anomaly.js")) return textResponse("ok", 200);
        if (url.includes("html.duckduckgo.com")) return textResponse(resultsHtml(), 200, "text/html");
        return new Response("unexpected " + url, { status: 599 });
      },
      async () => {
        const tool = new WebSearchTool({ ...defaultWebSearchOptions });
        const result = await tool.execute(JSON.stringify({ query: "test query", tiles: "1,3" }));
        expect(result.success).toBe(true);
        expect(resultStr(result)).toContain("Whittles Pub");
      },
    );
  });

  it("rejects out-of-range tiles", async () => {
    await withMockFetch(
      async (url) =>
        url.includes("/assets/anomaly/") ? new Response(new Uint8Array([0xff]), { status: 200 }) : textResponse(challengeHtml(), 202, "text/html"),
      async () => {
        const tool = new WebSearchTool({ ...defaultWebSearchOptions });
        try {
          await tool.execute(JSON.stringify({ query: "test query", tiles: "1,99" }));
        } catch {
          /* register challenge (or error out) either way */
        }
        // Second call with an out-of-range pick against the live challenge.
        const r = await tool.execute(JSON.stringify({ query: "test query", tiles: "99" }));
        expect(r.success).toBe(false);
        expect(resultStr(r)).toContain("out of range");
      },
    );
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

  it("reports the actual result count, not the number of output lines", async () => {
    const mockResponse = {
      results: [
        { title: "A", url: "https://a.example", content: "desc a" },
        { title: "B", url: "https://b.example", content: "desc b" },
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
      // Two results (five output lines); the entry must count results.
      expect(result.metadata?.get("results")).toBe("2");
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

// ── B6b: the live webSearch block moves the NEXT search (design §4.1, §5.2/§5.3) ──
//
// A REAL createConfigStore() drives the fake core's accessors (the createCore
// shape, §1.2): one registration, publishes through adopt+swap+commit, and
// provider/maxResults/timeout AND the keys/endpoint read from the CURRENT
// generation at the next search (§5.2 row: per-search reads incl. secrets).
// REDACTION doctrine UNCHANGED, pinned with canaries: the §5.3 change lines
// name an endpoint HOST only and keys only as set/unset/changed -- a published
// secret must never appear in any log line, however it moves.

describe("B6b live webSearch block (store publishes, one registration)", () => {
  const webResults = (n: number) => ({
    web: {
      results: Array.from({ length: n }, (_, i) => ({
        title: `t${i}`,
        url: `https://e.com/${i}`,
        description: `d${i}`,
      })),
    },
  });
  const warnSpy = () => spyOn(logger, "warn").mockImplementation(() => {});
  const liveLines = (spy: ReturnType<typeof warnSpy>): string[] =>
    spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[config-live]"));

  function braveTool() {
    const store = bootLiveStore({
      webSearch: {
        provider: "brave",
        maxResults: 3,
        timeout: 15,
        braveApiKey: "boot-key-1",
        tavilyApiKey: "",
        searxngInstanceUrl: "",
      },
    });
    const tool = registerWithLiveStore(store, createWebSearchExtension, { services: new ServiceRegistry() }).get(
      WebSearchTool.TOOL_NAME,
    );
    return { store, tool };
  }

  it("maxResults + provider: the NEXT search follows the published block; prior use answered old", async () => {
    const { store, tool } = braveTool();
    const urls: string[] = [];
    await withMockFetch((url) => {
      urls.push(String(url));
      // Brave ships {web:{results}}, SearXNG ships {results} -- the real shapes.
      return String(url).includes("searx")
        ? jsonResponse({ results: Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, url: `https://e.com/${i}`, content: `d${i}` })) })
        : jsonResponse(webResults(8));
    }, async () => {
      // Prior use answers boot: count=3 and a 3-slice.
      const before = await tool.execute(JSON.stringify({ query: "hotdog" }));
      expect(urls[0]).toContain("api.search.brave.com");
      expect(urls[0]).toContain("count=3");
      expect(before.metadata?.get("results")).toBe("3");

      publishLive(store, {
        webSearch: {
          provider: "searxng",
          maxResults: 5,
          timeout: 15,
          braveApiKey: "boot-key-1",
          tavilyApiKey: "",
          searxngInstanceUrl: "http://searx.local/search",
        },
      });
      await tool.execute(JSON.stringify({ query: "hotdog" }));
      expect(urls[1]).toContain("searx.local/search");
      const after = await tool.execute(JSON.stringify({ query: "hotdog" }));
      expect(after.metadata?.get("results")).toBe("5");
    });
  });

  it("braveApiKey: the secret rides the NEXT request, the audit line carries ZERO key bytes (canary)", async () => {
    const spy = warnSpy();
    const CANARY = "BraveCanary-DO-NOT-LOG-9f3a";
    try {
      const store = bootLiveStore({
        webSearch: {
          provider: "brave",
          maxResults: 3,
          timeout: 15,
          braveApiKey: "",
          tavilyApiKey: "",
          searxngInstanceUrl: "",
        },
      });
      const tool = registerWithLiveStore(store, createWebSearchExtension, { services: new ServiceRegistry() }).get(
        WebSearchTool.TOOL_NAME,
      );

      // Prior use answers old (unset): the honest "not configured" refusal.
      const before = await tool.execute(JSON.stringify({ query: "hotdog" }));
      expect(resultStr(before)).toContain("Brave API key not configured");

      publishLive(store, {
        webSearch: {
          provider: "brave",
          maxResults: 3,
          timeout: 15,
          braveApiKey: CANARY,
          tavilyApiKey: "",
          searxngInstanceUrl: "",
        },
      });
      const sentTokens: string[] = [];
      await withMockFetch((_url, opts) => {
        sentTokens.push(String((opts?.headers as Record<string, string>)?.["X-Subscription-Token"]));
        return jsonResponse(webResults(2));
      }, async () => {
        const after = await tool.execute(JSON.stringify({ query: "hotdog" }));
        expect(after.isOk()).toBe(true);
        // The per-search read proves itself: this request carries the canary.
        expect(sentTokens).toEqual([CANARY]);

        // And again: the change line fired ONCE for the change, not per search.
        await tool.execute(JSON.stringify({ query: "hotdog again" }));
      });

      const lines = liveLines(spy);
      expect(lines).toEqual(["[config-live] webSearch.braveApiKey: unset -> set"]);
      // The whole captured log surface carries zero canary bytes.
      expect(lines.join("\n")).not.toContain(CANARY);
    } finally {
      spy.mockRestore();
    }
  });

  it("searxngInstanceUrl: the NEXT search hits the new host; the line names the HOST only", async () => {
    const spy = warnSpy();
    const PATH_SECRET = "pathKey-DO-NOT-LOG";
    try {
      const { store, tool } = braveTool();
      publishLive(store, {
        webSearch: {
          provider: "searxng",
          maxResults: 3,
          timeout: 15,
          braveApiKey: "",
          tavilyApiKey: "",
          searxngInstanceUrl: "http://old.example.org/search",
        },
      });
      // First search SEEDS the baseline silently (the boot posture is not a
      // change) -- even though the block changed since registration.
      await tool.execute(JSON.stringify({ query: "seed" }));
      expect(liveLines(spy)).toEqual([]);

      const urls: string[] = [];
      await withMockFetch((url) => {
        urls.push(String(url));
        return jsonResponse({ results: [] });
      }, async () => {
        await tool.execute(JSON.stringify({ query: "hotdog" }));
        expect(urls[0]).toContain("old.example.org/search");

        publishLive(store, {
          webSearch: {
            provider: "searxng",
            maxResults: 3,
            timeout: 15,
            braveApiKey: "",
            tavilyApiKey: "",
            searxngInstanceUrl: `http://new.example.net:8888/search?k=${PATH_SECRET}`,
          },
        });
        await tool.execute(JSON.stringify({ query: "hotdog" }));
        // The NEXT search hit the new endpoint...
        expect(urls[1]).toContain("new.example.net:8888");
        // ...and the line printed host -> host, never the secret-shaped path.
        expect(liveLines(spy)).toEqual([
          "[config-live] webSearch.searxngInstanceUrl: old.example.org -> new.example.net:8888",
        ]);
        expect(liveLines(spy).join("\n")).not.toContain(PATH_SECRET);
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("static-scalar hosts stay pinned forever (no store behind them)", () => {
    const tool = new WebSearchTool({ ...defaultWebSearchOptions });
    const store = bootLiveStore({
      webSearch: { ...defaultWebSearchOptions, provider: "brave", maxResults: 100 },
    });
    publishLive(store, {
      webSearch: { ...defaultWebSearchOptions, provider: "brave", maxResults: 100, braveApiKey: "x" },
    });
    expect(tool.provider).toBe("duckduckgo");
    expect(tool.maxResults).toBe(5);
    expect(tool.timeout).toBe(15);
    expect(tool.braveApiKey).toBe("");
    // The ctor clamps moved into the reads: scalar answers stay clamped.
    const clamped = new WebSearchTool({ ...defaultWebSearchOptions, maxResults: 100, timeout: 0 });
    expect(clamped.maxResults).toBe(10);
    expect(clamped.timeout).toBe(1);
  });
});
