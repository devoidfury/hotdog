// XML tool format builtin extension.
//
// Registers the core-owned xml ToolFormat (the zero-config default) under
// EXTENSION_PROVIDES.TOOL_FORMATS so extensions can discover it and other
// formats can be selected by config name. The implementation lives in core
// (src/core/extensions/tool-format-xml.ts) to avoid a load-order dependency
// for the default path -- same rationale as keeping the OpenAI protocol in
// core.

import { xmlToolFormat } from "@core/extensions/tool-format-xml.ts";
import type { ExtensionInstance, CoreContext } from "@core/extensions/types.ts";

export { xmlToolFormat };

export function create(core: CoreContext): ExtensionInstance {
  core.toolFormatRegistry.register(xmlToolFormat);
  return {};
}
