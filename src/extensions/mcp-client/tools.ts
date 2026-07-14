// Bridge MCP server tools to native agent tools.
// Each MCP tool becomes an McpTool that forwards calls to the MCP server.

import { McpConnectionHandle } from "./connection.ts";

interface McpToolDefinition {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
}

/**
 * A tool that wraps an MCP server tool.
 */
export class McpTool {
  private readonly #serverName: string;
  private readonly #toolName: string;
  private readonly #toolDef: McpToolDefinition;
  private readonly #connection: McpConnectionHandle;
  private readonly #registeredName: string;

  /**
   * Create a new McpTool from an MCP tool definition.
   */
  constructor(serverName: string, toolDef: McpToolDefinition, connectionHandle: McpConnectionHandle) {
    this.#serverName = serverName;
    this.#toolName = toolDef.name;
    this.#toolDef = toolDef;
    this.#connection = connectionHandle;
    this.#registeredName = `${serverName}/${toolDef.name}`;
  }

  /**
   * Execute the tool by forwarding to the MCP server.
   */
  async execute(input: string | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    let args: Record<string, unknown>;
    try {
      args = typeof input === "string" ? JSON.parse(input) : (input as Record<string, unknown>);
    } catch (e: unknown) {
      return {
        success: false,
        output: ``,
        error: `Error parsing tool arguments: ${(e as Error).message}`,
      };
    }

    try {
      const result = await this.#connection.callTool(this.#toolName, args);
      return { success: true, output: result };
    } catch (e: unknown) {
      return {
        success: false,
        output: ``,
        error: `MCP tool call failed: ${(e as Error).message}`,
      };
    }
  }

  /**
   * Convert to a tool definition for the agent API.
   */
  toToolDef() {
    const mcpSchema = this.#toolDef.inputSchema || {};
    const properties = convertSchemaProperties(mcpSchema);
    const required = extractRequired(mcpSchema);

    return {
      type: "function",
      function: {
        description: this.#toolDef.description || "",
        name: this.#registeredName,
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
  callDisplay(input: string | Record<string, unknown> | null): string {
    return `MCP [${this.#serverName}] ${input}`;
  }

  /**
   * Get the registered tool name.
   */
  get registeredName(): string {
    return this.#registeredName;
  }
}

/**
 * Extract properties from a JSON Schema object.
 */
function convertSchemaProperties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const properties: Record<string, Record<string, unknown>> = {};

  if (!schema || typeof schema !== "object") return properties;

  const props = schema.properties as Record<string, unknown>;
  if (!props || typeof props !== "object") return properties;

  for (const [key, value] of Object.entries(props)) {
    if (!value || typeof value !== "object") continue;

    const param: Record<string, unknown> = {
      type: (value as Record<string, unknown>).type || "string",
      description: (value as Record<string, unknown>).description || "",
    };

    // Add enum if present
    if (Array.isArray((value as Record<string, unknown>).enum)) {
      param.enum = (value as Record<string, unknown>).enum;
    }

    // Add numeric constraints
    if ((value as Record<string, unknown>).minimum !== undefined) param.minimum = (value as Record<string, unknown>).minimum;
    if ((value as Record<string, unknown>).maximum !== undefined) param.maximum = (value as Record<string, unknown>).maximum;
    if ((value as Record<string, unknown>).exclusiveMinimum !== undefined) param.exclusiveMinimum = (value as Record<string, unknown>).exclusiveMinimum;
    if ((value as Record<string, unknown>).exclusiveMaximum !== undefined) param.exclusiveMaximum = (value as Record<string, unknown>).exclusiveMaximum;

    // Add string constraints
    if ((value as Record<string, unknown>).minLength !== undefined) param.minLength = (value as Record<string, unknown>).minLength;
    if ((value as Record<string, unknown>).maxLength !== undefined) param.maxLength = (value as Record<string, unknown>).maxLength;

    // Add pattern
    if ((value as Record<string, unknown>).pattern) param.pattern = (value as Record<string, unknown>).pattern;

    properties[key] = param;
  }

  return properties;
}

/**
 * Extract required fields from a JSON Schema object.
 */
function extractRequired(schema: Record<string, unknown>): string[] {
  if (!schema || typeof schema !== "object") return [];
  const req = (schema.required as unknown[]);
  if (!Array.isArray(req)) return [];
  return req.filter((v: unknown) => typeof v === "string") as string[];
}
