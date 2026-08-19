// Fetch-tool extension — provides the fetch tool for making HTTP requests.

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { hotdogFetch, VALID_METHODS, METHODS_WITH_BODY } from "@utils/fetch.ts";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "@core/extensions/tool-utils.ts";
import type { ToolMetadata } from "@core/extensions/tool-registry.ts";
import { htmlToMarkdown } from "@utils/html-to-markdown.ts";
import { TransientError } from "@core/error.ts";
import { HOOKS } from "@core/hooks.ts";
import {
  type CoreContext,
  type ExtensionInstance,
  type ToolContext,
  getExtensionConfig,
} from "@core/extensions/types.ts";

export const DEFAULT_ALLOWED_SCHEMES = ["http", "https"];

/** 3xx statuses with a Location header we may follow (after re-validation). */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Cap on manual redirect hops; deeper chains are almost never legitimate. */
const MAX_REDIRECTS = 5;

interface FetchArgs {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  showOriginal: boolean;
  host: string | null;
}

interface ParseResult {
  args: FetchArgs | null;
  error: string | null;
}

interface FetchToolOptions {
  timeoutMs: number;
  maxBodyLength: number;
  /** URL schemes permitted by the fetch tool. Defaults to http/https. */
  allowedSchemes?: string[];
  /**
   * When false (default), hosts that are -- or resolve to -- private or
   * reserved addresses (loopback, RFC1918, link-local/metadata, ULA, CGNAT,
   * IPv4-mapped) are refused.
   */
  allowPrivateHosts?: boolean;
}

export class FetchTool {
  static readonly TOOL_NAME = "fetch";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 1 };

  readonly timeoutMs: number;
  readonly maxBodyLength: number;
  readonly allowedSchemes: string[];
  readonly allowPrivateHosts: boolean;

  constructor(options: FetchToolOptions) {
    this.timeoutMs = options.timeoutMs;
    this.maxBodyLength = options.maxBodyLength;
    this.allowedSchemes = (options.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES).map((s) => s.toLowerCase());
    this.allowPrivateHosts = options.allowPrivateHosts ?? false;
  }

  toToolDef() {
    const restrictions = [
      `Only these URL schemes are allowed: ${this.allowedSchemes.join(", ")}.`,
      !this.allowPrivateHosts
        ? "Private or reserved hosts (localhost, 10.x, 192.168.x, 169.254.x, etc.) are not allowed, including as redirect targets."
        : null,
    ]
      .filter(Boolean)
      .join(" ");
    return toolDef(
      FetchTool.TOOL_NAME,
      `Perform a web request to a URL. Supports ${VALID_METHODS.join(", ")} methods with optional headers and body. Returns the response body, status code, and content type. When showOriginal is true, returns the raw response body without markdown conversion. ${restrictions}`,
      {
        properties: {
          url: param("string", "The URL to fetch"),
          method: param("string", "HTTP method to use", {
            enum: VALID_METHODS,
            default: "GET",
          }),
          headers: param("object", "Optional HTTP headers as key-value pairs"),
          body: param("string", `Optional request body (for ${METHODS_WITH_BODY.join(", ")})`),
          showOriginal: param(
            "boolean",
            "If true, return the original raw response body without markdown conversion.",
            { default: false },
          ),
        },
        required: ["url"],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(input, (args: Record<string, unknown>) => {
      const url = args.url as string;
      const urlDisplay = url.length > 60 ? url.slice(0, 60) + "..." : url;
      return `[${args.method}] ${urlDisplay}`;
    });
  }

  async execute(input: string | Record<string, unknown> | null, _ctx?: ToolContext): Promise<ToolResult> {
    const { args, error } = parseArgs(input, this.allowedSchemes);
    if (!args) {
      return ToolResult.err(error);
    }

    const { url, method, showOriginal, host } = args;

    if (!this.allowPrivateHosts && host) {
      const hostError = await assertPublicHost(host);
      if (hostError) {
        return ToolResult.err(hostError);
      }
    }

    try {
      // Default fetch() follows redirects blindly, so a public host that 302s
      // to a private one would bypass the private-host gate. With protection
      // on, follow redirects manually and re-validate every hop.
      const resp = this.allowPrivateHosts
        ? await hotdogFetch(url, args, this.timeoutMs)
        : await fetchWithSafeRedirects(url, args, this.timeoutMs, {
            allowedSchemes: this.allowedSchemes,
            checkHost: assertPublicHost,
          });
      const contentType = resp.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");

      // Hard cap on what we read off the wire so a huge or never-ending
      // response cannot exhaust memory before the display cap applies.
      const { text: rawBody, truncated: readTruncated } = await readCappedBody(resp, MAX_RESPONSE_CHARS);

      let respBody = rawBody;
      if (isJson) {
        try {
          respBody = JSON.stringify(JSON.parse(rawBody));
        } catch {
          // Truncated or malformed JSON -- keep the raw text.
        }
      }

      let bodyLength = respBody.length;
      const reason = resp.statusText || "Unknown";

      let truncated = readTruncated || bodyLength > this.maxBodyLength;

      // When showOriginal is not true, convert HTML to GFM using our
      // built-in HTMLRewriter-based converter.
      if (!showOriginal && !isJson && contentType.includes("html")) {
        respBody = htmlToMarkdown(respBody);
        bodyLength = respBody.length;
        truncated = readTruncated || bodyLength > this.maxBodyLength;
      }

      return ToolResult.ok(truncated ? respBody.slice(0, this.maxBodyLength) : respBody).withEntries({
        url,
        method,
        status: String(resp.status),
        status_text: reason,
        content_type: contentType,
        body_length: String(bodyLength),
        ...(truncated ? { truncated: "true" } : {}),
      });
    } catch (e: unknown) {
      const err = e as Error;
      const msg = err.message || String(e);
      if (err.name === "TimeoutError" || msg.includes("timed out") || msg.includes("timeout")) {
        throw new TransientError(`Request to ${url} timed out after ${this.timeoutMs}ms`);
      }
      if (err.name === "AbortError" || msg.includes("aborted")) {
        throw new TransientError(`Request to ${url} was aborted`);
      }
      if (msg.includes("connect") || msg.includes("network")) {
        throw new TransientError(`Connection failed for ${url}: ${msg}`);
      }
      return ToolResult.err(`Error: ${msg}`);
    }
  }
}

export interface SafeRedirectOptions {
  allowedSchemes: string[];
  /** Returns a refusal message for a host that must not be fetched, or null when allowed. */
  checkHost: (host: string) => Promise<string | null>;
  maxRedirects?: number;
}

/**
 * Like hotdogFetch(), but follows redirects manually so every hop's target
 * passes the same scheme + host gate as the original URL.
 *
 * fetch() follows redirects by default, so a public host that 302s to a
 * private one (cloud metadata, localhost services) would bypass the
 * private-host check. Each hop is re-validated before following.
 * @internal Exported for testing.
 */
export async function fetchWithSafeRedirects(
  url: string,
  args: FetchArgs,
  timeoutMs: number,
  { allowedSchemes, checkHost, maxRedirects = MAX_REDIRECTS }: SafeRedirectOptions,
): Promise<Response> {
  let current = url;
  let method = args.method;
  let body = args.body;

  for (let hop = 0; ; hop++) {
    const resp = await hotdogFetch(
      current,
      { ...args, method, body, redirect: "manual" },
      timeoutMs,
    );

    if (!REDIRECT_STATUSES.has(resp.status)) return resp;

    if (hop >= maxRedirects) {
      await discardBody(resp);
      throw new Error(`Too many redirects (limit ${maxRedirects}) starting from ${url}`);
    }

    const location = resp.headers.get("location");
    if (!location) return resp;
    await discardBody(resp);

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error(`Redirect from ${current} has an invalid Location header: ${location}`);
    }

    const scheme = next.protocol.replace(/:$/, "").toLowerCase();
    if (!allowedSchemes.includes(scheme)) {
      throw new Error(`Redirect to disallowed scheme '${scheme}' refused: ${next.href}`);
    }

    const nextHost = next.hostname.replace(/^\[|\]$/g, "");
    if (nextHost) {
      const hostError = await checkHost(nextHost);
      if (hostError) {
        throw new Error(`Redirect refused: ${hostError}`);
      }
    }

    // Per the fetch spec, 303 always becomes a GET, and 301/302 downgrade
    // non-GET/HEAD to GET (dropping the body). 307/308 preserve both.
    if (
      resp.status === 303 ||
      ((resp.status === 301 || resp.status === 302) &&
        method !== "GET" &&
        method !== "HEAD")
    ) {
      method = "GET";
      body = null;
    }

    current = next.href;
  }
}

/** Release a redirect response's body so the connection can be recycled. */
async function discardBody(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel();
  } catch {
    // connection already gone
  }
}

/** Parse and validate fetch tool arguments. */
function parseArgs(input: string | Record<string, unknown> | null, allowedSchemes: string[]): ParseResult {
  if (!input || (typeof input === "string" && input.trim().length === 0)) {
    return { args: null, error: "Missing required argument: url" };
  }

  const json = parseToolInput(input);
  if (!json) {
    return { args: null, error: "Error parsing arguments" };
  }

  const url = json.url;
  if (!url || typeof url !== "string") {
    return { args: null, error: "Missing required argument: url" };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { args: null, error: `Invalid URL: ${url}` };
  }

  // Scheme gate: blocks file:// (local file reads), data://, gopher://, etc.
  const scheme = parsedUrl.protocol.replace(/:$/, "").toLowerCase();
  if (!allowedSchemes.some((s) => s.toLowerCase() === scheme)) {
    return {
      args: null,
      error: `URL scheme '${scheme}' is not allowed. Allowed schemes: ${allowedSchemes.join(", ")}`,
    };
  }

  // Validate method
  const method = ((json.method as string) || "GET").toUpperCase();
  if (!VALID_METHODS.includes(method)) {
    return {
      args: null,
      error: `Invalid HTTP method: '${method}'. Supported: ${VALID_METHODS.join(", ")}`,
    };
  }

  const headers =
    json.headers && typeof json.headers === "object" ? (json.headers as Record<string, string>) : {};
  const body = typeof json.body === "string" ? json.body : null;
  const showOriginal = json.showOriginal === true;

  return {
    // Bun (unlike Node) keeps the brackets in hostname for IPv6 literals.
    args: {
      url,
      method,
      headers,
      body,
      showOriginal,
      host: parsedUrl.hostname.replace(/^\[|\]$/g, "") || null,
    },
    error: null,
  };
}

/**
 * Refuse hosts that are, or resolve to, private/reserved addresses.
 * Returns an error message to hand to the model, or null when the host is
 * public. Fails closed: unresolvable hosts are rejected.
 *
 * Redirect targets are NOT checked here: callers must follow redirects
 * manually and re-validate each hop (see fetchWithSafeRedirects), because
 * fetch() follows redirects blindly by default.
 *
 * Known ceiling: DNS rebinding -- fetch() re-resolves the name when it
 * connects, so a hostile resolver could return a public address here and a
 * private one at connect time. Closing that gap would require pinning the
 * connection to the resolved IP, which breaks SNI/virtual hosting.
 * @internal Exported for testing.
 */
export async function assertPublicHost(host: string): Promise<string | null> {
  if (isIP(host) !== 0) {
    return isPrivateAddress(host) ? privateHostError(host, host) : null;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch (e) {
    return `Could not resolve host '${host}': ${(e as Error).message}. Refusing to fetch unresolved hosts.`;
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      return privateHostError(host, address);
    }
  }
  return null;
}

function privateHostError(host: string, resolved: string): string {
  const detail = resolved !== host ? ` (resolves to ${resolved})` : "";
  return (
    `Host '${host}' is a private or reserved address${detail}. ` +
    "Private hosts are not allowed. Set fetchTool.allowPrivateHosts to true in config to change this."
  );
}

/**  Pure classifier for IP literal text (dotted v4 or v6). Anything not a clean public IP counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);

  if (version === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b, c] = parts as [number, number, number, number];
    return (
      a === 0 || // 0.0.0.0/8 "this network"
      a === 10 || // RFC1918
      a === 127 || // loopback
      a === 255 || // 255.255.255.255/8 broadcast
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 169 && b === 254) || // link-local (cloud metadata lives here)
      (a === 192 && b === 0 && c === 2) || // TEST-NET-1 (documentation)
      (a === 192 && b === 168) || // RFC1918
      (a === 198 && b === 51 && c === 100) || // TEST-NET-2 (documentation)
      (a === 203 && b === 0 && c === 113) // TEST-NET-3 (documentation)
    );
  }

  if (version === 6) {
    const groups = expandIpv6(ip);
    if (!groups) return true; // malformed -- fail closed

    // :: (unspecified) and ::1 (loopback)
    if (groups.every((g) => g === 0)) return true;
    if (groups[6] === 0 && groups[7] === 1 && groups.slice(0, 7).every((g) => g === 0)) {
      return true;
    }

    // IPv4-mapped ::ffff:a.b.c.d -- the last 32 bits carry a v4 address.
    // WHATWG URL parsing normalizes embedded-IPv4 forms to this shape.
    if (
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0xffff
    ) {
      const v4 = `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`;
      return isPrivateAddress(v4);
    }

    // 2001:db8::/32 documentation
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;

    // 2002::/16 6to4 and 64:ff9b::/96 NAT64 embed a v4 address in the low
    // bits, which may itself be private -- refuse the whole prefix.
    if (groups[0] === 0x2002) return true;
    if (groups[0] === 0x0064 && groups[1] === 0xff9b) return true;

    // ff00::/8 multicast (LAN amplification, mDNS/SSDP targets)
    if ((groups[0] & 0xff00) === 0xff00) return true;

    // fe80::/10 link-local, fc00::/7 unique-local
    return (groups[0] & 0xffc0) === 0xfe80 || (groups[0] & 0xfe00) === 0xfc00;
  }

  return true; // not an IP literal
}

/** Expand an IPv6 literal to 8 groups; null if malformed. */
function expandIpv6(ip: string): [number, number, number, number, number, number, number, number] | null {
  const bare = ip.split("%")[0] ?? ip; // strip zone id
  const halves = bare.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  // With "::" the omitted run stands for at least one group; without it all
  // eight groups must be spelled out.
  const omitted = 8 - head.length - tail.length;
  if (halves.length === 2 && omitted < 1) return null; // "::" must omit at least one group
  const parts: string[] =
    halves.length === 2
      ? [...head, ...Array.from({ length: omitted }, () => "0"), ...tail]
      : [...head, ...tail];
  if (parts.length !== 8 || parts.some((p) => p.length > 4)) return null;

  const groups: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups as [number, number, number, number, number, number, number, number];
}

/**
 * Hard cap on characters read from the response body (memory safety).
 * The display cap (maxBodyLength) is much smaller; this only prevents
 * huge responses from being fully materialized in memory.
 */
const MAX_RESPONSE_CHARS = 100_000;

/**
 * Read a response body up to a character cap. Stops reading (and releases
 * the connection) once the cap is exceeded, so huge responses are bounded
 * in memory. Abort/timeout errors from the fetch signal propagate.
 *
 * @param resp - The Response to read.
 * @param maxChars - Maximum characters to accumulate.
 * @returns The (possibly capped) text and whether the body was cut off.
 */
async function readCappedBody(
  resp: Response,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = resp.body;
  if (!body) {
    const text = await resp.text();
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > maxChars) {
      truncated = true;
      break;
    }
  }
  if (truncated) {
    // Stop pulling from the connection once the cap is hit.
    await reader.cancel().catch(() => {});
  } else {
    text += decoder.decode();
  }
  return { text: text.slice(0, maxChars), truncated };
}

/** Extension Entry Point. Create the fetch-tool extension. */
export function create(core: CoreContext): ExtensionInstance {
  // Config defaults come from extension.json configSchema
  const config = getExtensionConfig<{
    maxBodyLength: number;
    fetchTimeoutMs: number;
    allowedSchemes?: string[];
    allowPrivateHosts?: boolean;
  }>(core, "fetchTool");
  const fetchTool = new FetchTool({
    maxBodyLength: config.maxBodyLength,
    timeoutMs: config.fetchTimeoutMs,
    allowedSchemes: config.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES,
    allowPrivateHosts: config.allowPrivateHosts ?? false,
  });

  return {
    hooks: {
      /** Register the fetch tool. */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        registry.register("fetch", fetchTool);
      },
    },

    // Expose for external use
    fetchTool,
  };
}
