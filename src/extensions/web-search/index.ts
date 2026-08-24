import { ToolError, TransientError } from "@core/error.ts";
import {
  toolDef,
  param,
  ToolResult,
  truncateOutput,
  parseToolInput,
  defaultCallDisplay,
} from "@core/extensions/tool-utils.ts";
import type { ToolMetadata } from "@core/extensions/tool-registry.ts";

import { HOOKS } from "@core/hooks.ts";

import { getExtensionConfig } from "@core/extensions/types.ts";
import type { CoreContext, ExtensionInstance } from "@core/extensions/types.ts";
import { hotdogFetch } from "@utils/fetch.ts";

// ── Types ───────────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

interface WebSearchToolOptions {
  provider: string;
  maxResults: number;
  timeout: number;
  braveApiKey: string;
  tavilyApiKey: string;
  searxngInstanceUrl: string;
}

interface WebSearchConfig {
  provider: string;
  maxResults: number;
  timeout: number;
  braveApiKey: string;
  tavilyApiKey: string;
  searxngInstanceUrl: string;
}

interface ToolInput {
  query?: string;
  [key: string]: unknown;
}

// ── Provider Implementations ────────────────────────────────────────────────

// No API key required; results are parsed from DDG's HTML endpoint.
async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  timeout: number,
): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await hotdogFetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(timeout * 1000),
  });

  if (!response.ok) {
    throw new ToolError(
      `DuckDuckGo search failed with status ${response.status}`,
    );
  }

  const results: SearchResult[] = [];
  let currentResult: SearchResult | null = null;

  const rewriter = new HTMLRewriter()
    .on("a.result__a", {
      element(el) {
        const href = el.getAttribute("href");
        currentResult = {
          title: "",
          url: href ? decodeDdgUrl(href) : "",
          description: "",
        };
        results.push(currentResult);
      },
      text(text) {
        if (currentResult && text.text.trim()) {
          currentResult.title +=
            (currentResult.title ? " " : "") + text.text.trim();
        }
      },
    })
    .on("a.result__snippet", {
      text(text) {
        if (currentResult && text.text.trim()) {
          currentResult.description +=
            (currentResult.description ? " " : "") + text.text.trim();
        }
      },
    });

  // .blob() consumes the stream; the handlers above already collected the results
  await rewriter.transform(response).blob();

  const trimmed = results.slice(0, maxResults);

  if (trimmed.length === 0) {
    return `No results found for: ${query}`;
  }

  return formatResults(trimmed, query, "DuckDuckGo");
}

/**
 * Decode a DuckDuckGo redirect URL to extract the actual destination.
 * DDG wraps results in https://duckduckgo.com/l/?uddg=ENCODED_URL
 */
function decodeDdgUrl(raw: string): string {
  const idx = raw.indexOf("uddg=");
  if (idx === -1) return raw;
  const encoded = raw.slice(idx + 5).split("&")[0] || "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return raw;
  }
}

async function searchBrave(
  query: string,
  maxResults: number,
  timeout: number,
  apiKey: string,
): Promise<string> {
  if (!apiKey) {
    throw new ToolError(
      "Brave API key not configured. Set webSearch.braveApiKey in config or BRAVE_API_KEY env var.",
    );
  }

  const encoded = encodeURIComponent(query);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encoded}&count=${maxResults}`;

  const response = await hotdogFetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(timeout * 1000),
  });

  if (!response.ok) {
    throw new ToolError(`Brave search failed with status ${response.status}`);
  }

  const json = (await response.json()) as {
    web?: {
      results: Array<{ title?: string; url?: string; description?: string }>;
    };
  };
  const webResults = json?.web?.results || [];

  if (webResults.length === 0) {
    return `No results found for: ${query}`;
  }

  const results: SearchResult[] = webResults.slice(0, maxResults).map((r) => ({
    title: r.title || "No title",
    url: r.url || "",
    description: r.description || "",
  }));

  return formatResults(results, query, "Brave");
}

async function searchTavily(
  query: string,
  maxResults: number,
  timeout: number,
  apiKey: string,
): Promise<string> {
  if (!apiKey) {
    throw new ToolError(
      "Tavily API key not configured. Set webSearch.tavilyApiKey in config or TAVILY_API_KEY env var.",
    );
  }

  const body = JSON.stringify({
    query,
    max_results: maxResults,
    search_depth: "basic",
    include_answer: false,
    include_raw_content: false,
  });

  const response = await hotdogFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    signal: AbortSignal.timeout(timeout * 1000),
  });

  if (!response.ok) {
    throw new ToolError(`Tavily search failed with status ${response.status}`);
  }

  const json = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const items = json?.results || [];

  if (items.length === 0) {
    return `No results found for: ${query}`;
  }

  const results: SearchResult[] = items.slice(0, maxResults).map((r) => ({
    title: r.title || "No title",
    url: r.url || "",
    description: r.content || "",
  }));

  return formatResults(results, query, "Tavily");
}

async function searchSearXNG(
  query: string,
  maxResults: number,
  timeout: number,
  instanceUrl: string,
): Promise<string> {
  if (!instanceUrl) {
    throw new ToolError(
      "SearXNG instance URL not configured. Set webSearch.searxngInstanceUrl in config.",
    );
  }

  const base = instanceUrl.replace(/\/+$/, "");
  const encoded = encodeURIComponent(query);
  const url = `${base}/search?q=${encoded}&format=json&pageno=1`;

  const response = await hotdogFetch(url, {
    headers: {
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(timeout * 1000),
  });

  if (!response.ok) {
    throw new ToolError(`SearXNG search failed with status ${response.status}`);
  }

  const json = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const items = json?.results || [];

  if (items.length === 0) {
    return `No results found for: ${query}`;
  }

  const results: SearchResult[] = items.slice(0, maxResults).map((r) => ({
    title: r.title || "No title",
    url: r.url || "",
    description: r.content || "",
  }));

  return formatResults(results, query, "SearXNG");
}

// ── Result Formatting ───────────────────────────────────────────────────────

function formatResults(
  results: SearchResult[],
  query: string,
  provider: string,
): string {
  const lines: string[] = [`Search results for: ${query} (via ${provider})`];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.description) {
      lines.push(`   ${r.description}`);
    }
  }

  return lines.join("\n");
}

// ── Tool Class ──────────────────────────────────────────────────────────────

export class WebSearchTool {
  static readonly TOOL_NAME = "web_search";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 1 };

  #provider: string;
  #maxResults: number;
  #timeout: number;
  private braveApiKey: string;
  private tavilyApiKey: string;
  private searxngInstanceUrl: string;

  get provider(): string {
    return this.#provider;
  }
  get maxResults(): number {
    return this.#maxResults;
  }
  get timeout(): number {
    return this.#timeout;
  }

  constructor(options: WebSearchToolOptions) {
    this.#provider = options.provider;
    this.#maxResults = Math.min(10, Math.max(1, options.maxResults));
    this.#timeout = Math.max(1, options.timeout);
    this.braveApiKey = options.braveApiKey;
    this.tavilyApiKey = options.tavilyApiKey;
    this.searxngInstanceUrl = options.searxngInstanceUrl;
  }

  toToolDef() {
    return toolDef(
      WebSearchTool.TOOL_NAME,
      "Search the web for information. Returns relevant results with titles, URLs, and descriptions. Use this to find current information, news, or research topics.",
      {
        properties: {
          query: param(
            "string",
            "The search query. Be specific for better results.",
          ),
        },
        required: ["query"],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(
      input,
      (args) => `web_search: ${(args as ToolInput).query}`,
    );
  }

  async execute(
    input: string | Record<string, unknown> | null,
  ): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }

    const query = args.query;
    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return ToolResult.err("Error: query is required and cannot be empty");
    }

    const provider = this.provider.toLowerCase().trim();

    try {
      let result: string;
      switch (provider) {
        case "duckduckgo":
          result = await searchDuckDuckGo(query, this.maxResults, this.timeout);
          break;
        case "brave":
          result = await searchBrave(
            query,
            this.maxResults,
            this.timeout,
            this.braveApiKey,
          );
          break;
        case "tavily":
          result = await searchTavily(
            query,
            this.maxResults,
            this.timeout,
            this.tavilyApiKey,
          );
          break;
        case "searxng":
          result = await searchSearXNG(
            query,
            this.maxResults,
            this.timeout,
            this.searxngInstanceUrl,
          );
          break;
        default:
          return ToolResult.err(`Unknown search provider: ${provider}`);
      }

      const truncated = truncateOutput(result, 600);
      const lines = result.split("\n");
      return ToolResult.ok(truncated).withEntries({
        provider,
        results: String(lines.length - 1 > 0 ? lines.length - 1 : 0),
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (
        msg.includes("timeout") ||
        msg.includes("timed out") ||
        msg.includes("AbortError")
      ) {
        throw new TransientError(`Web search timed out: ${msg}`);
      }
      return ToolResult.err(`Web search failed: ${msg}`);
    }
  }
}

export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<WebSearchConfig>(core, "webSearch");

  return {
    hooks: {
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        const tool = new WebSearchTool({
          provider: config.provider,
          maxResults: config.maxResults,
          timeout: config.timeout,
          braveApiKey: config.braveApiKey,
          tavilyApiKey: config.tavilyApiKey,
          searxngInstanceUrl: config.searxngInstanceUrl,
        });
        registry.register(WebSearchTool.TOOL_NAME, tool);
      },
    },

    WebSearchTool,
  };
}
