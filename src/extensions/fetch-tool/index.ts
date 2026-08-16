// Fetch-tool extension — provides the fetch tool for making HTTP requests.

import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import type { ToolMetadata } from "../../core/extensions/tool-registry.ts";
import { htmlToMarkdown } from "../../utils/html-to-markdown.ts";
import { TransientError } from "../../core/error.ts";
import { HOOKS } from "../../core/hooks.ts";
import {
  CoreContext,
  ExtensionInstance,
  ToolsRegisterPayload,
  ToolContext,
  getExtensionConfig,
} from "../../core/extensions/types.ts";

import { hotdogFetch, VALID_METHODS, METHODS_WITH_BODY } from "@utils/fetch.ts";

interface FetchArgs {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  showOriginal: boolean;
}

interface ParseResult {
  args: FetchArgs | null;
  error: string | null;
}

interface FetchToolOptions {
  timeoutMs: number;
  maxBodyLength: number;
}

export class FetchTool {
  static readonly TOOL_NAME = "fetch";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 1 };

  readonly timeoutMs: number;
  readonly maxBodyLength: number;

  constructor(options: FetchToolOptions) {
    this.timeoutMs = options.timeoutMs;
    this.maxBodyLength = options.maxBodyLength;
  }

  toToolDef() {
    return toolDef(
      FetchTool.TOOL_NAME,
      `Perform a web request to a URL. Supports ${VALID_METHODS.join(", ")} methods with optional headers and body. Returns the response body, status code, and content type. When showOriginal is true, returns the raw response body without markdown conversion.`,
      {
        properties: {
          url: param("string", "The URL to fetch"),
          method: param("string", "HTTP method to use", {
            enum: VALID_METHODS,
            default: "GET",
          }),
          headers: param("object", "Optional HTTP headers as key-value pairs"),
          body: param(
            "string",
            `Optional request body (for ${METHODS_WITH_BODY.join(", ")})`,
          ),
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

  async execute(
    input: string | Record<string, unknown> | null,
    _ctx?: ToolContext,
  ): Promise<ToolResult> {
    const { args, error } = parseArgs(input);
    if (!args) {
      return ToolResult.err(error);
    }

    const { url, method, showOriginal } = args;

    try {
      const resp = await hotdogFetch(url, args, this.timeoutMs);
      const contentType = resp.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");

      // Hard cap on what we read off the wire so a huge or never-ending
      // response cannot exhaust memory before the display cap applies.
      const { text: rawBody, truncated: readTruncated } =
        await readCappedBody(resp, MAX_RESPONSE_CHARS);

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

      return ToolResult.ok(
        truncated ? respBody.slice(0, this.maxBodyLength) : respBody,
      ).withEntries({
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
      if (
        err.name === "TimeoutError" ||
        msg.includes("timed out") ||
        msg.includes("timeout")
      ) {
        throw new TransientError(
          `Request to ${url} timed out after ${this.timeoutMs}ms`,
        );
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

/** Parse and validate fetch tool arguments. */
function parseArgs(
  input: string | Record<string, unknown> | null,
): ParseResult {
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

  // Validate method
  const method = ((json.method as string) || "GET").toUpperCase();
  if (!VALID_METHODS.includes(method)) {
    return {
      args: null,
      error: `Invalid HTTP method: '${method}'. Supported: ${VALID_METHODS.join(", ")}`,
    };
  }

  const headers =
    json.headers && typeof json.headers === "object"
      ? (json.headers as Record<string, string>)
      : {};
  const body = typeof json.body === "string" ? json.body : null;
  const showOriginal = json.showOriginal === true;

  return { args: { url, method, headers, body, showOriginal }, error: null };
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
  }>(core, "fetchTool");
  const fetchTool = new FetchTool({
    maxBodyLength: config.maxBodyLength,
    timeoutMs: config.fetchTimeoutMs,
  });

  return {
    hooks: {
      /**
       * Register the fetch tool.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry: ToolsRegisterPayload) => {
        registry.register("fetch", fetchTool);
      },
    },

    // Expose for external use
    fetchTool,
  };
}
