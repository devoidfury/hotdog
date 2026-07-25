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
