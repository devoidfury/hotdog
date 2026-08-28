import type { CoreContext, ExtensionInstance } from "../../core/extensions/types.ts";

// Config defaults come from extension.json configSchema; no hooks needed.
export function create(_core: CoreContext): ExtensionInstance {
  return {};
}
