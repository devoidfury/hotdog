// Fetch tool — make HTTP requests.

import { ToolContext, toolDef, param, toolResult } from './registry.js';

const VALID_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
const METHODS_WITH_BODY = ['POST', 'PUT', 'PATCH'];

export class FetchTool {
  static TOOL_NAME = 'fetch';
  static FIRST_USE_HELP = 'Make HTTP requests to URLs. Supports GET, POST, PUT, DELETE, PATCH, HEAD.';

  static tryNewFromContext(ctx) {
    return new FetchTool();
  }

  toToolDef() {
    return toolDef(
      FetchTool.TOOL_NAME,
      'Perform a web request to a URL. Supports GET, POST, PUT, DELETE, PATCH, HEAD methods with optional headers and body. Returns the response body, status code, and content type.',
      {
        schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          url: param('string', 'The URL to fetch'),
          method: param('string', 'HTTP method to use (GET, POST, PUT, DELETE, PATCH, HEAD). Defaults to GET.', { enum: VALID_METHODS }),
          headers: param('object', 'Optional HTTP headers as key-value pairs'),
          body: param('string', 'Optional request body (for POST, PUT, PATCH)'),
        },
        required: ['url'],
      }
    );
  }

  callDisplay(input) {
    const { args, error } = parseArgs(input);
    if (!args) {
      return typeof input === 'string' ? input : '';
    }
    const url = args.url;
    const urlDisplay = url.length > 40 ? url.slice(0, 40) + '...' : url;
    return `[${args.method}] ${urlDisplay}`;
  }

  firstUseHelp() {
    return FetchTool.FIRST_USE_HELP;
  }

  async execute(input, ctx) {
    const { args, error } = parseArgs(input);
    if (!args) {
      return toolResult(error);
    }

    const { url, method, headers, body } = args;

    try {
      const resp = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: METHODS_WITH_BODY.includes(method) ? body || undefined : undefined,
      });

      const respHeaders = {};
      resp.headers.forEach((value, key) => {
        respHeaders[key] = value;
      });

      const contentType = resp.headers.get('content-type') || '';
      let respBody;
      if (contentType.includes('application/json')) {
        respBody = await resp.json();
      } else {
        respBody = await resp.text();
      }

      const bodyLength = typeof respBody === 'string' ? respBody.length : JSON.stringify(respBody).length;
      const reason = resp.statusText || 'Unknown';
      const truncated = bodyLength > 8000;

      return toolResult({
        status: resp.status,
        status_text: reason,
        method,
        url,
        content_type: contentType,
        body_length: bodyLength,
        ...(truncated ? { truncated: 'true' } : {}),
        body: respBody,
        headers: respHeaders,
      });
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes('timeout') || msg.includes('timed out')) {
        return toolResult(`Request to ${url} timed out`);
      }
      if (msg.includes('connect') || msg.includes('network')) {
        return toolResult(`Connection failed for ${url}: ${msg}`);
      }
      return toolResult(`Error: ${msg}`);
    }
  }
}

/**
 * Parse and validate fetch tool arguments.
 * Returns { args, error } where error is a string if validation failed.
 */
function parseArgs(input) {
  if (!input || (typeof input === 'string' && input.trim().length === 0)) {
    return { args: null, error: 'Missing required argument: url' };
  }

  let json;
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input);
    } catch {
      return { args: null, error: 'Error parsing arguments' };
    }
  } else {
    json = input;
  }

  const url = json.url;
  if (!url || typeof url !== 'string') {
    return { args: null, error: 'Missing required argument: url' };
  }

  // Validate method
  const method = (json.method || 'GET').toUpperCase();
  if (!VALID_METHODS.includes(method)) {
    return {
      args: null,
      error: `Invalid HTTP method: '${method}'. Supported: GET, POST, PUT, DELETE, PATCH, HEAD`,
    };
  }

  const headers = json.headers && typeof json.headers === 'object' ? json.headers : {};
  const body = typeof json.body === 'string' ? json.body : null;

  return { args: { url, method, headers, body }, error: null };
}
