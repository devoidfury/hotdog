/**
 * Shared schema types used by both core config and extension config.
 */

export type CastFn = (v: unknown, ctx?: unknown) => unknown;
export type ComputeFn = (ctx: unknown) => unknown;

export interface SchemaLayer {
  source?: string;
  key?: string;
  path?: string;
  default?: unknown;
  cast?: CastFn | string | null;
  compute?: string;
}

export interface SchemaProperty {
  type?: string;
  description?: string;
  default?: unknown;
  layers?: SchemaLayer[];
  properties?: Record<string, SchemaProperty>;
  cliFlag?: {
    short?: string;
    long: string;
    type?: string;
    description?: string;
  };
}

export type ConfigSchema = Record<string, SchemaProperty>;


/**
 * Unified CLI flag definition used by both core schema and extension registration.
 *
 * - Core schema flags include `key` (maps back to config key) and `hasValue`.
 * - Extension flags may include `default` and `parse` for custom handling.
 * - `hasValue` is derived from `type !== "boolean"` if not explicitly provided.
 */
export interface CliFlagDef {
  key?: string;                     // maps back to config key (schema-loader use)
  short?: string;
  long: string;
  description: string;
  type: string;
  hasValue?: boolean;               // derived from type if not provided
  default?: unknown;                // extension defaults
  parse?: (value: string) => unknown;  // custom parser
}