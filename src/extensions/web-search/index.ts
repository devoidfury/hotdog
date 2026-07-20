// Web search tool — search the internet via DuckDuckGo, Brave, Tavily, or SearXNG.

import { ToolError } from "../../core/error.ts";
import {
  toolDef,
  param,
  ToolResult,
  truncateOutput,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";

import { HOOKS } from "../../core/hooks.ts";

import extensionData from "./extension.json" with { type: "json" };

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── Types ───────────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

interface WebSearchToolOptions {
  provider?: string;
  maxResults?: number;
  timeout?: number;
  braveApiKey?: string;
  tavilyApiKey?: string;
  searxngInstanceUrl?: string;
}

interface WebSearchConfig {
  provider?: string;
  maxResults?: number;
  timeout?: number;
  braveApiKey?: string;
  tavilyApiKey?: string;
  searxngInstanceUrl?: string;
}

interface ToolInput {
  query?: string;
  [key: string]: unknown;
}

// ── Provider Implementations ────────────────────────────────────────────────

/**
 * Search DuckDuckGo using HTMLRewriter for proper DOM parsing.
 * No API key required.
 */
async function searchDuckDuckGo(query: string, maxResults: number, timeout: number): Promise<string> {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(timeout * 1000),
  });

  if (!response.ok) {
    throw new ToolError(`DuckDuckGo search failed with status ${response.status}`);
  }

  const results: SearchResult[] = [];
  let currentResult: SearchResult | null = null;

  const rewriter = new HTMLRewriter()
    // Extract result links: <a class="result__a" href="...">Title</a>
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
          currentResult.title += (currentResult.title ? " " : "") + text.text.trim();
        }
      },
    })
    // Extract result snippets: <a class="result__snippet">...</a>
    .on("a.result__snippet", {
      text(text) {
        if (currentResult && text.text.trim()) {
          currentResult.description += (currentResult.description ? " " : "") + text.text.trim();
        }
      },
    });

  // Process the streaming response — discard the blob, we collected results in handlers
  await rewriter.transform(response).blob();

  // Trim to maxResults
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

/**
 * Search via Brave Search API.
 * Requires BRAVE_API_KEY.
 */
async function searchBrave(query: string, maxResults: number, timeout: number, apiKey: string): Promise<string> {
  if (!apiKey) {
    throw new ToolError(
      "Brave API key not configured. Set webSearch.braveApiKey in config or BRAVE_API_KEY env var."
    );
  }

  const encoded = encodeURIComponent(query);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encoded}&count=${maxResults}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(timeout * 1000),
  });

  if (!response.ok) {
    throw new ToolError(`Brave search failed with status ${response.status}`);
  }

  const json = await response.json() as { web?: { results: Array<{ title?: string; url?: string; description?: string }> } };
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

/**
 * Search via Tavily API.
 * Requires TAVILY_API_KEY.
 */
async function searchTavily(query: string, maxResults: number, timeout: number, apiKey: string): Promise<string> {
  if (!apiKey) {
    throw new ToolError(
      "Tavily API key not configured. Set webSearch.tavilyApiKey in config or TAVILY_API_KEY env var."
    );
  }

  const body = JSON.stringify({
    query,
    max_results: maxResults,
    search_depth: "basic",
    include_answer: false,
    include_raw_content: false,
  });

  const response = await fetch("https://api.tavily.com/search", {
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

  const json = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
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

/**
 * Search via a self-hosted SearXNG instance.
 * Requires SEARXNG_INSTANCE_URL.
 */
async function searchSearXNG(query: string, maxResults: number, timeout: number, instanceUrl: string): Promise<string> {
  if (!instanceUrl) {
    throw new ToolError(
      "SearXNG instance URL not configured. Set webSearch.searxngInstanceUrl in config."
    );
  }

  const base = instanceUrl.replace(/\/+$/, "");
  const encoded = encodeURIComponent(query);
  const url = `${base}/search?q=${encoded}&format=json&pageno=1`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(timeout * 1000),
  });

  if (!response.ok) {
    throw new ToolError(`SearXNG search failed with status ${response.status}`);
  }

  const json = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
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

function formatResults(results: SearchResult[], query: string, provider: string): string {
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

  #provider: string;
  #maxResults: number;
  #timeout: number;
  private braveApiKey: string;
  private tavilyApiKey: string;
  private searxngInstanceUrl: string;

  get provider(): string { return this.#provider; }
  get maxResults(): number { return this.#maxResults; }
  get timeout(): number { return this.#timeout; }

  constructor(options: WebSearchToolOptions = {}) {
    this.#provider = options.provider ?? "duckduckgo";
    this.#maxResults = Math.min(10, Math.max(1, options.maxResults ?? 5));
    this.#timeout = Math.max(1, options.timeout ?? 15);
    this.braveApiKey = options.braveApiKey ?? "";
    this.tavilyApiKey = options.tavilyApiKey ?? "";
    this.searxngInstanceUrl = options.searxngInstanceUrl ?? "";
  }

  toToolDef() {
    return toolDef(
      WebSearchTool.TOOL_NAME,
      "Search the web for information. Returns relevant results with titles, URLs, and descriptions. Use this to find current information, news, or research topics.",
      {
        properties: {
          query: param("string", "The search query. Be specific for better results."),
        },
        required: ["query"],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(input, (args) => `web_search: ${(args as ToolInput).query}`);
  }

  async execute(input: string | Record<string, unknown> | null): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }

    const query = args.query;
    if (!query || (typeof query === "string" && query.trim().length === 0)) {
      return ToolResult.err("Error: query is required and cannot be empty");
    }

    const provider = this.provider.toLowerCase().trim();

    try {
      let result: string;
      switch (provider) {
        case "duckduckgo":
          result = await searchDuckDuckGo(query as string, this.maxResults, this.timeout);
          break;
        case "brave":
          result = await searchBrave(query as string, this.maxResults, this.timeout, this.braveApiKey);
          break;
        case "tavily":
          result = await searchTavily(query as string, this.maxResults, this.timeout, this.tavilyApiKey);
          break;
        case "searxng":
          result = await searchSearXNG(query as string, this.maxResults, this.timeout, this.searxngInstanceUrl);
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
      return ToolResult.err(`Web search failed: ${(err as Error).message}`);
    }
  }
}

// ── Extension Entry Point ───────────────────────────────────────────────────

import type { CoreContext, ExtensionInstance } from "../../core/extensions/types.ts";

/**
 * Create the web-search extension.
 */
export function create(core: CoreContext): ExtensionInstance {
  const config = (core.config?.webSearch as WebSearchConfig) || {};

  const provider =
    config.provider ||
    (extensionData.configSchema?.webSearch?.properties?.provider?.default as string);

  // API keys are resolved declaratively via extension.json config layers —
  // no imperative env var fallback needed here.
  const braveApiKey = config.braveApiKey || "";
  const tavilyApiKey = config.tavilyApiKey || "";
  const searxngInstanceUrl = config.searxngInstanceUrl || "";

  return {
    hooks: {
      [HOOKS.TOOLS_REGISTER]: async (registry: { register: (name: string, tool: unknown) => void }) => {
        const tool = new WebSearchTool({
          provider,
          maxResults: config.maxResults,
          timeout: config.timeout,
          braveApiKey,
          tavilyApiKey,
          searxngInstanceUrl,
        });
        registry.register(WebSearchTool.TOOL_NAME, tool);
      },
    },

    WebSearchTool,
  };
}
