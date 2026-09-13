// RoleMapping — pluggable internal-role → wire-role mapping.
//
// Separate from WireFormat on purpose. WireFormat owns the MARKUP SHAPE of
// harness structure inside the conversation (what the model must parse);
// a RoleMapping owns where internal roles RIDE on the wire, because chat
// templates are per-backend and even one provider can front models with
// different expectations. A provider with ten models can give each its own
// mapping without touching presentation, and vice versa.
//
// The seam exists because role "harness" is internal-only: no wire backend
// has it, so SOMETHING must decide whether harness text rides as "user"
// (llama.cpp / Ollama templates, which reject unknown roles) or "developer"
// (OpenAI style). Core ships no implementations and no fallback: the built-in
// ids ("system-first", "developer") come from the autoloaded
// `extensions/role-mapping-default`, and the name comes from config
// (`modelRoleMapping`, default in core.config.json; provider and model
// entries override). An unresolvable name is a config error, exactly like an
// unresolvable WireFormat.

import type { ProviderDef } from "../config/providers.ts";

export interface RoleMapping {
  id: string;

  /**
   * Map an internal message role to the wire role it rides as. Built-ins map
   * every role to itself except "harness".
   */
  wireRole(role: string): string;
}

// ── Registry ────────────────────────────────────────────────────────────────

export class RoleMappingRegistry {
  #mappings: Map<string, RoleMapping>;

  constructor() {
    this.#mappings = new Map();
  }

  register(mapping: RoleMapping): void {
    if (!mapping || typeof mapping.id !== "string" || !mapping.id) {
      throw new Error("RoleMapping requires a non-empty id");
    }
    this.#mappings.set(mapping.id, mapping);
  }

  has(id: string): boolean {
    return this.#mappings.has(id);
  }

  get(id: string): RoleMapping | undefined {
    return this.#mappings.get(id);
  }

  names(): string[] {
    return Array.from(this.#mappings.keys());
  }
}

export function createRoleMappingRegistry(): RoleMappingRegistry {
  return new RoleMappingRegistry();
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve the RoleMapping id for a model (model -> provider -> global
 * default). `undefined` when nothing is configured: the caller fails at the
 * serializer rather than inventing a convention.
 */
export function resolveRoleMappingId(
  modelConfig: { name: string; roleMapping?: string },
  providers: ProviderDef[] | undefined,
  globalDefault: string | undefined,
): string | undefined {
  const providerName = modelConfig.name.split("/")[0];
  const provider = providers?.find((p) => p.name === providerName);
  return modelConfig.roleMapping ?? provider?.roleMapping ?? globalDefault;
}
