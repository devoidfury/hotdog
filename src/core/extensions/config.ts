import { ConfigError } from "../error.ts";
import { validate } from "../../utils/json-schema.ts";
import type { SchemaLayer, CliFlagDef } from "../config/schema-types.ts";


export interface ConfigParamDef {
  key: string;
  description: string;
  defaults: Record<string, unknown>;
  schema?: Record<string, unknown>;
  layers?: SchemaLayer[];
}

export class ConfigRegistry {
  #cliFlags: CliFlagDef[] = [];
  #configParams: ConfigParamDef[] = [];
  #configSchemas: Map<string, Record<string, unknown>> | null = null;

  registerCliFlags(flags: CliFlagDef[]): void {
    if (!Array.isArray(flags)) {
      throw new TypeError("flags must be an array");
    }
    for (const flag of flags) {
      if (!flag.long && !flag.short) {
        throw new ConfigError("Each CLI flag must have a short or long form");
      }
      if (!flag.type) {
        flag.type = "string";
      }
      this.#cliFlags.push(flag);
    }
  }

  registerConfigParams(params: ConfigParamDef[]): void {
    if (!Array.isArray(params)) {
      throw new TypeError("params must be an array");
    }
    for (const param of params) {
      if (!param.key) {
        throw new ConfigError("Each config param must have a key");
      }
      if (!param.defaults || typeof param.defaults !== "object") {
        throw new ConfigError(
          `Config param '${param.key}' must have a defaults object`,
        );
      }
      this.#configParams.push(param);
    }
  }

  getCliFlags(): CliFlagDef[] {
    return [...this.#cliFlags];
  }

  getConfigParams(): ConfigParamDef[] {
    return [...this.#configParams];
  }

  getCliHelpText(): string {
    const lines: string[] = [];
    for (const flag of this.#cliFlags) {
      const parts: string[] = [];
      if (flag.short && flag.long) {
        parts.push(`${flag.short}, ${flag.long}`);
      } else if (flag.short) {
        parts.push(flag.short);
      } else {
        parts.push(flag.long);
      }

      if (flag.type !== "boolean") {
        parts.push(`<${flag.type === "array" ? "value,..." : "value"}>`);
      }

      const help = parts.join(" ");
      const desc = flag.description || "";
      lines.push(`  ${help.padEnd(35)} ${desc}`);
    }
    return lines.join("\n");
  }

  buildDefaults(): Record<string, Record<string, unknown>> {
    const defaults: Record<string, Record<string, unknown>> = {};
    for (const param of this.#configParams) {
      defaults[param.key] = { ...param.defaults };
    }
    return defaults;
  }

  validateConfig(
    config: unknown,
    schema: Record<string, unknown>,
  ): { valid: boolean; errors: string[] } {
    const errors = validate(config, schema, "");
    return { valid: errors.length === 0, errors };
  }

  registerConfigSchema(key: string, schema: Record<string, unknown>): void {
    if (!key || typeof key !== "string") {
      throw new TypeError("key must be a non-empty string");
    }
    if (!schema || typeof schema !== "object") {
      throw new TypeError("schema must be a non-null object");
    }
    if (!this.#configSchemas) {
      this.#configSchemas = new Map();
    }
    this.#configSchemas.set(key, schema);
  }

  getConfigSchema(key: string): Record<string, unknown> | null {
    if (!this.#configSchemas) return null;
    return this.#configSchemas.get(key) || null;
  }

  validateConfigByKey(
    key: string,
    config: unknown,
  ): { valid: boolean; errors: string[] } {
    const schema = this.getConfigSchema(key);
    if (schema) {
      return this.validateConfig(config, schema);
    }

    for (const param of this.#configParams) {
      if (param.key === key && param.schema) {
        return this.validateConfig(config, param.schema);
      }
    }

    return { valid: true, errors: [] };
  }
}


export interface SchemaDefaultEntry {
  key: string;
  description?: string;
  defaults: unknown;
  schema?: Record<string, unknown>;
  layers?: unknown;
}

export function extractSchemaDefaults(
  schema: Record<string, unknown> | null | undefined,
): SchemaDefaultEntry[] {
  if (!schema || typeof schema !== "object") return [];

  const result: SchemaDefaultEntry[] = [];
  for (const [keyName, keySchemaRaw] of Object.entries(schema)) {
    const keySchema = keySchemaRaw as Record<string, unknown>;
    let defaults: unknown;
    if ((keySchema.type as string) === "object" && keySchema.properties) {
      defaults = {};
      for (const [propName, propRaw] of Object.entries(
        keySchema.properties as Record<string, unknown>,
      )) {
        const prop = propRaw as Record<string, unknown>;
        if (prop.default !== undefined && prop.default !== null) {
          (defaults as Record<string, unknown>)[propName] = prop.default;
        }
      }
    } else if (keySchema.default !== undefined) {
      defaults = keySchema.default;
    }

    const entry: SchemaDefaultEntry = {
      key: keyName,
      description: (keySchema.description as string) || "",
      defaults,
      schema: keySchema,
    };
    if (keySchema.layers) {
      entry.layers = keySchema.layers;
    }
    result.push(entry);
  }
  return result;
}
