import { toolDef } from "@core/index.ts";
import type { ToolMetadata } from "@core/extensions/tool-registry.ts";
import { McpConnectionHandle } from "./connection.ts";

/**
 * Raw MCP tool definition at the McpTool boundary. `name` is required; the
 * rest may be missing or malformed (servers are unreliable), and McpTool
 * handles that defensively. McpToolDefinition (types.ts) is the normalized
 * shape after parseMcpToolDefinition() and is assignable to this.
 */
interface McpToolDefinitionInput {
  name: string;
  title?: string | null;
  description?: string | null;
  inputSchema?: Record<string, unknown>;
}

export class McpTool {
  readonly #serverName: string;
  readonly #toolName: string;
  readonly #toolDef: McpToolDefinitionInput;
  readonly #connection: McpConnectionHandle;
  readonly #registeredName: string;
  /** MCP tools default to sideEffects: true (conservative — unknown tools assumed somewhat risky). */
  metadata: ToolMetadata = { sideEffects: true, difficulty: 3 };

  constructor(serverName: string, toolDef: McpToolDefinitionInput, connectionHandle: McpConnectionHandle) {
    this.#serverName = serverName;
    this.#toolName = toolDef.name;
    this.#toolDef = toolDef;
    this.#connection = connectionHandle;
    this.#registeredName = `${serverName}/${toolDef.name}`;
  }

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
      return { success: false, output: ``, error: `MCP tool call failed: ${(e as Error).message}` };
    }
  }

  toToolDef() {
    const mcpSchema = this.#toolDef.inputSchema || {};
    const properties = convertSchemaProperties(mcpSchema);
    const required = extractRequired(mcpSchema);

    return toolDef(this.#registeredName, this.#toolDef.description || "", {
      properties,
      required,
    });
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return `MCP [${this.#serverName}] ${input}`;
  }

  get registeredName(): string {
    return this.#registeredName;
  }
}

function convertSchemaProperties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const properties: Record<string, Record<string, unknown>> = {};

  if (!schema || typeof schema !== "object") return properties;

  const props = schema.properties as Record<string, unknown>;
  if (!props || typeof props !== "object") return properties;

  for (const [key, value] of Object.entries(props)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;

    const param: Record<string, unknown> = {
      type: record.type || "string",
      description: record.description || "",
    };

    if (Array.isArray(record.enum)) {
      param.enum = record.enum;
    }

    if (record.minimum !== undefined) param.minimum = record.minimum;
    if (record.maximum !== undefined) param.maximum = record.maximum;
    if (record.exclusiveMinimum !== undefined) param.exclusiveMinimum = record.exclusiveMinimum;
    if (record.exclusiveMaximum !== undefined) param.exclusiveMaximum = record.exclusiveMaximum;

    if (record.minLength !== undefined) param.minLength = record.minLength;
    if (record.maxLength !== undefined) param.maxLength = record.maxLength;

    if (record.pattern) param.pattern = record.pattern;

    properties[key] = param;
  }

  return properties;
}

function extractRequired(schema: Record<string, unknown>): string[] {
  if (!schema || typeof schema !== "object") return [];
  const req = schema.required as unknown[];
  if (!Array.isArray(req)) return [];
  return req.filter((v) => typeof v === "string");
}
