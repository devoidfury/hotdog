import { ToolError, TransientError, AssistantRetryableError } from "@core/error.ts";
import {
  toolDef,
  param,
  ToolResult,
  truncateOutput,
  parseToolInput,
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

// ── DDG captcha challenge relay ─────────────────────────────────────────────
//
// DDG answers rate-limited hosts with HTTP 202 + an image challenge (verified
// live): solving it from the SAME host clears the flag -- the pass is
// IP-bound, no cookies involved. The user may be remote (VPN), so the tiles
// cannot come from their browser; they are proxied from our host. The solve
// page is mounted as routes on the webui server (DDG_SOLVE_SERVICE) -- no
// second port to firewall. Text-only UIs skip the page entirely: the model
// passes the user's picks through the `tiles` argument.

const CHALLENGE_TTL_MS = 10 * 60 * 1000; // observed valid >= 10 min after issue

/** Service key: webui mounts `routes` on its own Bun.serve and calls
 *  `setBaseUrl` once listening, so challenge hints carry a reachable URL. */
export const DDG_SOLVE_SERVICE = "ddgSolveRoutes";

interface DdgSolveService {
  routes: Record<string, (req: Request) => Response | Promise<Response>>;
  setBaseUrl(url: string): void;
}

/** Base URL of the hosting webui server, e.g. http://192.168.1.5:3000. */
let solveBaseUrl: string | null = null;

export const ddgSolveService: DdgSolveService = {
  routes: { "/solve/*": handleSolve, "/tiles/*": handleSolve },
  setBaseUrl(url: string) {
    solveBaseUrl = url;
  },
};

interface PendingChallenge {
  nonce: string;
  action: string;
  gk: string;
  tiles: string[]; // tile hashes in page order
  tileBytes: (Uint8Array | null)[];
  createdAt: number;
  answer: string[] | null; // hashes picked via the solve page
}

const challenges = new Map<string, PendingChallenge>();

function parseChallenge(html: string): { action: string; gk: string; tiles: string[] } | null {
  const action = html.match(/<form id="challenge-form" action="([^"]+)"/)?.[1]?.replace(/^\/\//, "https://");
  const gk = html.match(/name="challenge-submit"[^>]*value="([0-9a-f]+)"/)?.[1];
  const tiles = [...html.matchAll(/anomaly-modal__image" alt=" " id="image-([0-9a-f]+)"/g)].map((m) => m[1]!);
  if (!action || !gk || tiles.length === 0) return null;
  return { action, gk, tiles };
}

function pruneChallenges(): void {
  const now = Date.now();
  for (const [nonce, c] of challenges) {
    if (now - c.createdAt > CHALLENGE_TTL_MS) challenges.delete(nonce);
  }
}

function liveChallenges(): PendingChallenge[] {
  pruneChallenges();
  return [...challenges.values()].sort((a, b) => b.createdAt - a.createdAt);
}

async function registerChallenge(parsed: { action: string; gk: string; tiles: string[] }, timeout: number): Promise<PendingChallenge> {
  pruneChallenges();
  // Fetch tile images now so the solve page serves them from our host; a
  // failed fetch just renders a placeholder for that tile.
  const tileBytes = await Promise.all(
    parsed.tiles.map(async (hash) => {
      try {
        const r = await hotdogFetch(`https://duckduckgo.com/assets/anomaly/images/challenge/${hash}.jpg`, {
          signal: AbortSignal.timeout(timeout * 1000),
        });
        if (!r.ok) return null;
        return new Uint8Array(await r.arrayBuffer());
      } catch {
        return null;
      }
    }),
  );
  const challenge: PendingChallenge = {
    nonce: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
    action: parsed.action,
    gk: parsed.gk,
    tiles: parsed.tiles,
    tileBytes,
    createdAt: Date.now(),
    answer: null,
  };
  challenges.set(challenge.nonce, challenge);
  return challenge;
}

function solvePageHtml(c: PendingChallenge): string {
  const tiles = c.tiles
    .map((hash, i) => {
      const img = c.tileBytes[i]
        ? `<img src="/tiles/${c.nonce}/${i}" alt="tile ${i + 1}">`
        : `<div style="width:150px;height:150px;background:#eee;line-height:150px">?</div>`;
      return `<label class="tile"><input type="checkbox" name="image-check_${hash}">${img}<div>${i + 1}</div></label>`;
    })
    .join("\n");
  return `<!doctype html><meta charset=utf-8><title>hotdog: DDG captcha relay</title>
<style>body{font-family:sans-serif;max-width:720px;margin:2rem auto}.tile{display:inline-block;margin:8px;text-align:center;cursor:pointer}.tile img{width:150px;height:150px;display:block}button{font-size:1.2rem;padding:.5em 2em;margin-top:1rem}</style>
<h3>DuckDuckGo challenged hotdog's web search.</h3>
<p>Select <b>all squares containing a duck</b>, then Submit. Your answer is sent to this machine only; hotdog relays it to DuckDuckGo on the next search retry.</p>
<form method="post">
${tiles}
<p><button type="submit">Submit</button></p>
</form>`;
}

const SUBMITTED_HTML = `<!doctype html><meta charset=utf-8><title>submitted</title>
<p style="font-family:sans-serif">Answer recorded. Return to hotdog and retry the search.</p>`;

async function handleSolve(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  const solve = path.match(/^\/solve\/([0-9a-f]{16})$/);
  if (solve) {
    const c = challenges.get(solve[1]!);
    if (!c || Date.now() - c.createdAt > CHALLENGE_TTL_MS) {
      return new Response("challenge expired or unknown; start a new search from hotdog", { status: 404 });
    }
    if (req.method === "POST") {
      if (Number(req.headers.get("content-length") || 0) > 64 * 1024) {
        return new Response("too large", { status: 413 });
      }
      const form = new URLSearchParams(await req.text());
      // Only hashes belonging to this challenge are accepted.
      c.answer = c.tiles.filter((t) => form.get(`image-check_${t}`) !== null);
      return new Response(SUBMITTED_HTML);
    }
    return new Response(solvePageHtml(c), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const tile = path.match(/^\/tiles\/([0-9a-f]{16})\/(\d+)$/);
  if (tile && req.method === "GET") {
    const c = challenges.get(tile[1]!);
    const bytes = c?.tileBytes[Number(tile[2])];
    if (!bytes) return new Response("not found", { status: 404 });
    return new Response(bytes as unknown as BodyInit, { headers: { "content-type": "image/jpeg" } });
  }
  return new Response("not found", { status: 404 });
}

/** POST picked tile hashes to the challenge's anomaly.js action. */
async function postChallengeAnswer(c: PendingChallenge, hashes: string[]): Promise<boolean> {
  const body = new URLSearchParams();
  for (const t of hashes) body.append(`image-check_${t}`, "on");
  body.append("challenge-submit", c.gk);
  const resp = await hotdogFetch(c.action, {
    method: "POST",
    headers: {
      // Verified live: the anomaly endpoint answers 200 for a plain form POST.
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": "https://html.duckduckgo.com/html/",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
    },
    body: body.toString(),
  });
  const ok = resp.status === 200;
  await resp.body?.cancel().catch(() => {});
  if (ok) challenges.delete(c.nonce);
  return ok;
}

/** Relay an answer: explicit `tiles` arg first, then the solve page's picks. */
async function relayChallengeAnswer(tilesArg: string | undefined): Promise<boolean> {
  const open = liveChallenges();
  if (open.length === 0) return false;

  if (tilesArg) {
    const nums = tilesArg.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
    if (nums.some((n) => !Number.isInteger(n))) {
      throw new ToolError(`Invalid tiles argument "${tilesArg}"; expected comma-separated tile numbers like "3,5,6".`);
    }
    const c = open[0]!;
    const hashes = nums.map((n) => c.tiles[n - 1]).filter((t): t is string => !!t);
    if (hashes.length !== nums.length) {
      throw new ToolError(`tiles argument out of range: this challenge has ${c.tiles.length} tiles.`);
    }
    return await postChallengeAnswer(c, hashes);
  }

  const answered = open.find((c) => c.answer !== null);
  if (!answered || answered.answer!.length === 0) return false;
  const ok = await postChallengeAnswer(answered, answered.answer!);
  if (!ok) answered.answer = null; // expired or rejected; let the user re-pick
  return ok;
}

function challengeErrorHint(c: PendingChallenge): string {
  const parts: string[] = [];
  if (solveBaseUrl) {
    parts.push(
      `Relay the challenge to the user: ask them (question tool) to open ${solveBaseUrl}/solve/${c.nonce} ` +
        `(served by this machine's webui server, so it works over VPN without extra ports), select all squares containing a duck, and press Submit. ` +
        `Then retry this search with no extra arguments; hotdog relays the answer to DuckDuckGo from this host.`,
    );
    parts.push(`Text-only UI: ask (question tool) which numbered tiles contain ducks and retry with the tiles argument, e.g. tiles="3,5,6".`);
  } else {
    // No webui server mounted our routes (plain interactive-cli). The tile
    // images are static assets the user's browser can fetch from anywhere.
    const tileList = c.tiles.map((t, i) => `${i + 1}=https://duckduckgo.com/assets/anomaly/images/challenge/${t}.jpg`).join(" ");
    parts.push(
      `Relay the challenge to the user: ask (question tool) which tiles contain a duck; the tile images are: ${tileList}. ` +
        `Then retry this search with their picks as the tiles argument, e.g. tiles="3,5,6"; hotdog relays the answer from this host.`,
    );
  }
  parts.push(`If the user cannot or will not solve it, suggest switching the webSearch provider (brave, tavily, or searxng) in defaults.json.`);
  return parts.join(" ");
}

// ── Provider Implementations ────────────────────────────────────────────────

// No API key required; results are parsed from DDG's HTML endpoint.
async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  timeout: number,
  relay: { tiles?: string },
): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  let response = await hotdogFetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(timeout * 1000),
  });

  // DDG's anomaly-detection answers rate-limited clients with HTTP 202 and a
  // CAPTCHA page (confirmed on html. and lite. endpoints, any UA). The page
  // parses to zero results, so it must never be reported as "No results
  // found". Order: clear the flag with a user answer (tiles arg > solve-page
  // picks), else register the challenge and hand it to the user.
  if (response.status === 202) {
    let body202 = await response.text();
    if (await relayChallengeAnswer(relay.tiles)) {
      response = await hotdogFetch(url, { method: "GET", signal: AbortSignal.timeout(timeout * 1000) });
      body202 = response.status === 202 ? await response.text() : "";
    }
    if (response.status === 202) {
      const parsed = parseChallenge(body202);
      if (!parsed) {
        throw new TransientError(
          "DuckDuckGo is rate-limiting this host (HTTP 202) and the challenge format changed; " +
            "configure another webSearch provider (brave, tavily, or searxng) in defaults.json.",
        );
      }
      // Re-present the existing live challenge rather than churning tiles.
      let c = liveChallenges().find((x) => !x.answer);
      if (!c) c = await registerChallenge(parsed, timeout);
      throw new AssistantRetryableError(
        "DuckDuckGo presented a CAPTCHA challenge (HTTP 202); no real results were returned.",
        challengeErrorHint(c),
      );
    }
  }

  if (!response.ok) {
    throw new ToolError(`DuckDuckGo search failed with status ${response.status}`);
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
          currentResult.title += (currentResult.title ? " " : "") + text.text.trim();
        }
      },
    })
    .on("a.result__snippet", {
      text(text) {
        if (currentResult && text.text.trim()) {
          currentResult.description += (currentResult.description ? " " : "") + text.text.trim();
        }
      },
    });

  // .blob() consumes the stream; the handlers above already collected the results
  await rewriter.transform(response).blob();

  return results.slice(0, maxResults);
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
): Promise<SearchResult[]> {
  if (!apiKey) {
    throw new ToolError(
      "Brave API key not configured. Set webSearch.braveApiKey in config or BRAVE_API_KEY env var.",
    );
  }

  const encoded = encodeURIComponent(query);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encoded}&count=${maxResults}`;

  const response = await hotdogFetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    signal: AbortSignal.timeout(timeout * 1000),
  });

  if (!response.ok) {
    throw new ToolError(`Brave search failed with status ${response.status}`);
  }

  const json = (await response.json()) as {
    web?: { results: Array<{ title?: string; url?: string; description?: string }> };
  };
  const webResults = json?.web?.results || [];

  return webResults.slice(0, maxResults).map((r) => ({
    title: r.title || "No title",
    url: r.url || "",
    description: r.description || "",
  }));
}

async function searchTavily(
  query: string,
  maxResults: number,
  timeout: number,
  apiKey: string,
): Promise<SearchResult[]> {
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
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
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

  return items.slice(0, maxResults).map((r) => ({
    title: r.title || "No title",
    url: r.url || "",
    description: r.content || "",
  }));
}

async function searchSearXNG(
  query: string,
  maxResults: number,
  timeout: number,
  instanceUrl: string,
): Promise<SearchResult[]> {
  if (!instanceUrl) {
    throw new ToolError("SearXNG instance URL not configured. Set webSearch.searxngInstanceUrl in config.");
  }

  const base = instanceUrl.replace(/\/+$/, "");
  const encoded = encodeURIComponent(query);
  const url = `${base}/search?q=${encoded}&format=json&pageno=1`;

  const response = await hotdogFetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeout * 1000),
  });

  if (!response.ok) {
    throw new ToolError(`SearXNG search failed with status ${response.status}`);
  }

  const json = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const items = json?.results || [];

  return items.slice(0, maxResults).map((r) => ({
    title: r.title || "No title",
    url: r.url || "",
    description: r.content || "",
  }));
}

/** Human-readable provider names for the result header (switch key -> label). */
const PROVIDER_LABELS: Record<string, string> = {
  duckduckgo: "DuckDuckGo",
  brave: "Brave",
  tavily: "Tavily",
  searxng: "SearXNG",
};

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
          query: param("string", "The search query. Be specific for better results."),
          tiles: param(
            "string",
            'Answer to a pending DuckDuckGo image challenge: comma-separated tile numbers, e.g. "3,5,6". Only used when a previous call reported a CAPTCHA challenge and the user gave you their picks instead of using the solve page.',
          ),
        },
        required: ["query"],
      },
    );
  }

  async execute(input: string | Record<string, unknown> | null): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }

    const query = args.query;
    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return ToolResult.err("Error: query is required and cannot be empty");
    }

    const tiles = typeof args.tiles === "string" && args.tiles.trim() ? args.tiles.trim() : undefined;
    const provider = this.provider.toLowerCase().trim();

    try {
      let results: SearchResult[];
      switch (provider) {
        case "duckduckgo":
          results = await searchDuckDuckGo(query, this.maxResults, this.timeout, { tiles });
          break;
        case "brave":
          results = await searchBrave(query, this.maxResults, this.timeout, this.braveApiKey);
          break;
        case "tavily":
          results = await searchTavily(query, this.maxResults, this.timeout, this.tavilyApiKey);
          break;
        case "searxng":
          results = await searchSearXNG(query, this.maxResults, this.timeout, this.searxngInstanceUrl);
          break;
        default:
          return ToolResult.err(`Unknown search provider: ${provider}`);
      }

      const label = PROVIDER_LABELS[provider] ?? provider;
      const display =
        results.length === 0
          ? `No results found for: ${query}`
          : formatResults(results, query, label);
      return ToolResult.ok(truncateOutput(display, 600)).withEntries({
        provider,
        results: String(results.length),
      });
    } catch (err) {
      // Let provider-detected control-flow errors (DDG bot challenge,
      // transient failures) reach the executor so its hint/retry semantics apply.
      if (err instanceof TransientError || err instanceof AssistantRetryableError) throw err;
      const msg = (err as Error).message;
      if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("AbortError")) {
        throw new TransientError(`Web search timed out: ${msg}`);
      }
      return ToolResult.err(`Web search failed: ${msg}`);
    }
  }
}

export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<WebSearchConfig>(core, "webSearch");

  // Offer the captcha solve routes to any HTTP front end that wants them
  // (the webui server mounts them on its own port). Plain interactive-cli
  // never registers anything to consume this; the tiles argument path covers it.
  core.services.register(DDG_SOLVE_SERVICE, ddgSolveService);

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
  };
}
