// Fetch-tool extension — provides the fetch tool for making HTTP requests.

import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.ts";
import { htmlToMarkdown } from "../../utils/html-to-markdown.ts";
import { HOOKS } from "../../core/hooks.ts";
import {
  CoreContext,
  ExtensionInstance,
  ToolsRegisterPayload,
  ToolExecutionContext,
} from "../../core/extensions/types.ts";

const VALID_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"] as const;
const METHODS_WITH_BODY = ["POST", "PUT", "PATCH"] as const;

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

  toToolDef(): Record<string, unknown> {
    return toolDef(
      FetchTool.TOOL_NAME,
      `Perform a web request to a URL. Supports ${VALID_METHODS.join(", ")} methods with optional headers and body. Returns the response body, status code, and content type. When showOriginal is true, returns the raw response body without markdown conversion.`,
      {
        schema: "https://json-schema.org/draft/2020-12/schema",
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
      return `[${args.method as string}] ${urlDisplay}`;
    });
  }

  async execute(input: string | Record<string, unknown> | null, _ctx: ToolExecutionContext): Promise<ToolResult> {
    const { args, error } = parseArgs(input);
    if (!args) {
      return ToolResult.err(error);
    }

    const { url, method, headers, body, showOriginal } = args;

    try {
      const resp = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: (METHODS_WITH_BODY.includes(method as typeof METHODS_WITH_BODY[number]) && body) || undefined,
      });

      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((value, key) => {
        respHeaders[key] = value;
      });

      const contentType = resp.headers.get("content-type") || "";
      let respBody: unknown;
      if (contentType.includes("application/json")) {
        respBody = await resp.json();
      } else {
        respBody = await resp.text();
      }

      const bodyLength =
        typeof respBody === "string"
          ? respBody.length
          : JSON.stringify(respBody).length;
      const reason = resp.statusText || "Unknown";
      const truncated = bodyLength > 8000;

      // If showOriginal is true, return raw body without conversion
      if (showOriginal) {
        const bodyStr =
          typeof respBody === "string" ? respBody : JSON.stringify(respBody);
        return ToolResult.ok(bodyStr).withEntries({
          url,
          method,
          status: String(resp.status),
          status_text: reason,
          content_type: contentType,
          body_length: String(bodyLength),
          ...(truncated ? { truncated: "true" } : {}),
        });
      }

      // When showOriginal is not true, convert HTML to GFM using our
      // built-in HTMLRewriter-based converter.
      let bodyToReturn = respBody;
      if (
        typeof respBody === "string" &&
        (contentType.includes("text/html") ||
          contentType.includes("application/xhtml+xml"))
      ) {
        bodyToReturn = htmlToMarkdown(respBody);
      }

      const finalBodyLength =
        typeof bodyToReturn === "string"
          ? bodyToReturn.length
          : JSON.stringify(bodyToReturn).length;
      const finalTruncated = finalBodyLength > 8000;

      const bodyStr =
        typeof bodyToReturn === "string"
          ? bodyToReturn
          : JSON.stringify(bodyToReturn);
      return ToolResult.ok(bodyStr).withEntries({
        url,
        method,
        status: String(resp.status),
        status_text: reason,
        content_type: contentType,
        body_length: String(finalBodyLength),
        ...(finalTruncated ? { truncated: "true" } : {}),
      });
    } catch (e: unknown) {
      const msg = (e as Error).message || String(e);
      if (msg.includes("timeout") || msg.includes("timed out")) {
        return ToolResult.err(`Request to ${url} timed out`);
      }
      if (msg.includes("connect") || msg.includes("network")) {
        return ToolResult.err(`Connection failed for ${url}: ${msg}`);
      }
      return ToolResult.err(`Error: ${msg}`);
    }
  }
}

/**
 * Parse and validate fetch tool arguments.
 */
function parseArgs(input: string | Record<string, unknown> | null): ParseResult {
  if (!input || (typeof input === "string" && input.trim().length === 0)) {
    return { args: null, error: "Missing required argument: url" };
  }

  const json = parseToolInput(input);
  if (!json) {
    return { args: null, error: "Error parsing arguments" };
  }

  const url = json.url as string | undefined;
  if (!url || typeof url !== "string") {
    return { args: null, error: "Missing required argument: url" };
  }

  // Validate method
  const method = ((json.method as string) || "GET").toUpperCase();
  if (!VALID_METHODS.includes(method as typeof VALID_METHODS[number])) {
    return {
      args: null,
      error: `Invalid HTTP method: '${method}'. Supported: ${VALID_METHODS.join(", ")}`,
    };
  }

  const headers =
    json.headers && typeof json.headers === "object" ? (json.headers as Record<string, string>) : {};
  const body = typeof json.body === "string" ? json.body : null;
  const showOriginal = json.showOriginal === true;

  return { args: { url, method, headers, body, showOriginal }, error: null };
}

// ── Extension Entry Point ───────────────────────────────────────────────────

/**
 * Create the fetch-tool extension.
 */
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
