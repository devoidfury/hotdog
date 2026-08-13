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

export class FetchTool {
  static readonly TOOL_NAME = "fetch";
  metadata: ToolMetadata = { sideEffects: true, difficulty: 1 };

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
      const resp = await hotdogFetch(url, args);
      const contentType = resp.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");

      let respBody: string;
      if (isJson) {
        const rawBody = await resp.json();
        respBody = JSON.stringify(rawBody);
      } else {
        respBody = await resp.text();
      }

      let bodyLength = respBody.length;
      const reason = resp.statusText || "Unknown";

      // TODO: move this constant to setting
      const MAX_BODY_LEN = 8000;
      let truncate = bodyLength > MAX_BODY_LEN;

      // When showOriginal is not true, convert HTML to GFM using our
      // built-in HTMLRewriter-based converter.
      if (!showOriginal && !isJson && contentType.includes("html")) {
        respBody = htmlToMarkdown(respBody);
        truncate = respBody.length > MAX_BODY_LEN;
        bodyLength = respBody.length;
      }

      return ToolResult.ok(
        truncate ? respBody.slice(0, MAX_BODY_LEN) : respBody,
      ).withEntries({
        url,
        method,
        status: String(resp.status),
        status_text: reason,
        content_type: contentType,
        body_length: String(bodyLength),
        ...(truncate ? { truncated: "true" } : {}),
      });
    } catch (e: unknown) {
      const msg = (e as Error).message || String(e);
      if (msg.includes("timeout") || msg.includes("timed out")) {
        throw new TransientError(`Request to ${url} timed out`);
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

/** Extension Entry Point. Create the fetch-tool extension. */
export function create(_core: CoreContext): ExtensionInstance {
  const fetchTool = new FetchTool();

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
