/** Shared schema types used by both core config and extension config. */

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
  /** JSON-Schema vocabulary for an array's ELEMENTS. The settings editor
   * renders a primitive-item array as one chrome row plus one stamped row
   * per element (keyPath `field[i]`); the items declaration is what those
   * element stamps and the element/append write gates enforce (type,
   * minimum/maximum, enum). Absent items: a primitive-valued array still
   * gets the chrome shape, with the element stamps derived from each
   * element's runtime shape (the file-only doctrine). */
  items?: SchemaProperty;
  /** JSON-Schema vocabulary: the closed value set for a string leaf.
   * Boot resolution does not enforce it (that has never been its job --
   * consumers validate what they read); the settings editor stamps it so
   * the panel offers a dropdown AND the write gate refuses values outside
   * the set. */
  enum?: string[];
  /** Lower bound for numeric values. A present-but-violating layer value is
   * treated like a failed cast: skip the layer, fall through to the next. */
  minimum?: number;
  /** Upper bound for numeric values; same fall-through semantics as minimum. */
  maximum?: number;
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
  /** Also selects the subcommand named after this flag's long form. */
  isSubcommand?: boolean;
  default?: unknown;                // extension defaults
  parse?: (value: string) => unknown;  // custom parser
}