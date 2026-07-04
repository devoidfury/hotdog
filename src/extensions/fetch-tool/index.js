// Fetch-tool extension — provides the fetch tool for making HTTP requests.

import { spawnSync } from "node:child_process";
import {
  toolDef,
  param,
  ToolResult,
  parseToolInput,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.js";

import { HOOKS } from "../../core/hooks.js";

/**
 * Create the fetch-tool extension.
 *
 * @param {Object} core - The core object with hooks, resolved config, etc.
 * @returns {Object} The extension instance.
 */
export function create(core) {
  // Config defaults come from extension.json configSchema
  const config = core.config?.fetchTool || {};

  const fetchTool = new FetchTool();

  return {
    hooks: {
      /**
       * Register the fetch tool.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        registry.register("fetch", fetchTool);
      },
    },

    // Expose for external use
    fetchTool,
  };
}

const VALID_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"];
const METHODS_WITH_BODY = ["POST", "PUT", "PATCH"];

export class FetchTool {
  static TOOL_NAME = "fetch";

  toToolDef() {
    return toolDef(
      FetchTool.TOOL_NAME,
      `Perform a web request to a URL. Supports ${VALID_METHODS.join(", ")} methods with optional headers and body. Returns the response body, status code, and content type. When showOriginal is true, returns the raw response body without pandoc conversion.`,
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

  callDisplay(input) {
    return defaultCallDisplay(input, (args) => {
      const url = args.url;
      const urlDisplay = url.length > 60 ? url.slice(0, 60) + "..." : url;
      return `[${args.method}] ${urlDisplay}`;
    });
  }

  async execute(input, ctx) {
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
        body: (METHODS_WITH_BODY.includes(method) && body) || undefined,
      });

      const respHeaders = {};
      resp.headers.forEach((value, key) => {
        respHeaders[key] = value;
      });

      const contentType = resp.headers.get("content-type") || "";
      let respBody;
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

      // When showOriginal is not true, convert HTML through pandoc to GFM
      let bodyToReturn = respBody;
      if (
        typeof respBody === "string" &&
        (contentType.includes("text/html") ||
          contentType.includes("application/xhtml+xml"))
      ) {
        try {
          const result = spawnSync("pandoc", ["-f", "html", "-t", "gfm"], {
            input: respBody,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
          });
          if (result.error) {
            // pandoc not available or failed to spawn; use original body
            bodyToReturn = respBody;
          } else if (result.status === 0) {
            bodyToReturn = result.stdout;
          } else {
            // pandoc failed for some other reason; use original body
            bodyToReturn = respBody;
          }
        } catch {
          // pandoc not available; use original body
          bodyToReturn = respBody;
        }
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
    } catch (e) {
      const msg = e.message || String(e);
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
 * Returns { args, error } where error is a string if validation failed.
 */
function parseArgs(input) {
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
  const method = (json.method || "GET").toUpperCase();
  if (!VALID_METHODS.includes(method)) {
    return {
      args: null,
      error: `Invalid HTTP method: '${method}'. Supported: ${VALID_METHODS.join(", ")}`,
    };
  }

  const headers =
    json.headers && typeof json.headers === "object" ? json.headers : {};
  const body = typeof json.body === "string" ? json.body : null;
  const showOriginal = json.showOriginal === true;

  return { args: { url, method, headers, body, showOriginal }, error: null };
}
