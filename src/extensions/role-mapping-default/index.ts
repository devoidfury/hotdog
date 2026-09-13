// RoleMapping defaults — the built-in internal-role -> wire-role conventions.
//
// Core ships no mapping and no fallback (core/extensions/role-mapping.ts):
// the ids config uses come from here, registered by this autoloaded
// extension. Like the wire-format extension, disabling it turns
// `modelRoleMapping` into an unresolvable name, and serializing throws with
// an actionable config error.
//
//   - "system-first" (llama.cpp / Ollama style): only the first message(s)
//     may be system; harness-injected text rides role "user".
//   - "developer" (OpenAI style): harness-injected text rides role
//     "developer".

import type { RoleMapping } from "@core/extensions/role-mapping.ts";
import type { ExtensionInstance, CoreContext } from "@core/extensions/types.ts";

/** Internal role "harness" rides "user" (templates that reject unknown roles). */
export const systemFirstRoleMapping: RoleMapping = {
  id: "system-first",
  wireRole(role) {
    return role === "harness" ? "user" : role;
  },
};

/** Internal role "harness" rides "developer". */
export const developerRoleMapping: RoleMapping = {
  id: "developer",
  wireRole(role) {
    return role === "harness" ? "developer" : role;
  },
};

export function create(core: CoreContext): ExtensionInstance {
  core.roleMappingRegistry.register(systemFirstRoleMapping);
  core.roleMappingRegistry.register(developerRoleMapping);
  return {};
}
