// Bridge MCP server tools to native agent tools.
// Each MCP tool becomes an McpTool that forwards calls to the MCP server.

import { McpConnectionHandle } from "./connection.js";

/**
 * A tool that wraps an MCP server tool.
 */
export class McpTool {
  /**
   * Create a new McpTool from an MCP tool definition.
   */
  constructor(serverName, toolDef, connectionHandle) {
    this._serverName = serverName;
    this._toolName = toolDef.name;
    this._toolDef = toolDef;
    this._connection = connectionHandle;
    this._registeredName = `${serverName}/${toolDef.name}`;
  }

  /**
   * Execute the tool by forwarding to the MCP server.
   */
  async execute(input) {
    let args;
    try {
      args = typeof input === "string" ? JSON.parse(input) : input;
    } catch (e) {
      return {
        success: false,
        output: ``,
        error: `Error parsing tool arguments: ${e.message}`,
      };
    }

    try {
      const result = await this._connection.callTool(this._toolName, args);
      return { success: true, output: result };
    } catch (e) {
      return {
        success: false,
        output: ``,
        error: `MCP tool call failed: ${e.message}`,
      };
    }
  }

  /**
   * Convert to a tool definition for the agent API.
   */
  toToolDef() {
    const mcpSchema = this._toolDef.inputSchema || {};
    const properties = convertSchemaProperties(mcpSchema);
    const required = extractRequired(mcpSchema);

    return {
      type: "function",
      function: {
        description: this._toolDef.description || "",
        name: this._registeredName,
        parameters: {
          schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties,
          required,
        },
      },
    };
  }

  /**
   * Display string for tool call.
   */
  callDisplay(input) {
    return `MCP [${this._serverName}] ${input}`;
  }

  /**
   * Get the registered tool name.
   */
  get registeredName() {
    return this._registeredName;
  }
}

/**
 * Extract properties from a JSON Schema object.
 */
function convertSchemaProperties(schema) {
  const properties = {};

  if (!schema || typeof schema !== "object") return properties;

  const props = schema.properties;
  if (!props || typeof props !== "object") return properties;

  for (const [key, value] of Object.entries(props)) {
    if (!value || typeof value !== "object") continue;

    const param = {
      type: value.type || "string",
      description: value.description || "",
    };

    // Add enum if present
    if (Array.isArray(value.enum)) {
      param.enum = value.enum;
    }

    // Add numeric constraints
    if (value.minimum !== undefined) param.minimum = value.minimum;
    if (value.maximum !== undefined) param.maximum = value.maximum;
    if (value.exclusiveMinimum !== undefined) param.exclusiveMinimum = value.exclusiveMinimum;
    if (value.exclusiveMaximum !== undefined) param.exclusiveMaximum = value.exclusiveMaximum;

    // Add string constraints
    if (value.minLength !== undefined) param.minLength = value.minLength;
    if (value.maxLength !== undefined) param.maxLength = value.maxLength;

    // Add pattern
    if (value.pattern) param.pattern = value.pattern;

    properties[key] = param;
  }

  return properties;
}

/**
 * Extract required fields from a JSON Schema object.
 */
function extractRequired(schema) {
  if (!schema || typeof schema !== "object") return [];
  const req = schema.required;
  if (!Array.isArray(req)) return [];
  return req.filter((v) => typeof v === "string");
}
