// AUXILIARY descriptor fixture -- never the sole coverage of the wire path.
// Suites that construct `ToolExecBroker` directly hand it the list a host
// with bash-tool + core-tools loaded gets from the real loader; THE zero-
// hand-passed proof lives in tests/core/tool-exec-wire-plane.test.ts and
// does not import this file. The URLs are real module file URLs (not alias
// specs), as the loader stamps them.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WIRE_FACTORIES_EXPORT } from "../../src/core/tool-exec-protocol.ts";
import type { WireToolDescriptor } from "../../src/core/tool-exec-protocol.ts";

const SRC = join(import.meta.dir, "../../src/extensions");

/** The three pool-eligible pilots (execution: "worker") of the built-ins. */
export function poolWireDescriptors(): WireToolDescriptor[] {
  const bash = pathToFileURL(join(SRC, "bash-tool/index.ts")).href;
  const core = pathToFileURL(join(SRC, "core-tools/index.ts")).href;
  return [
    { tool: "bash", module: bash, factory: WIRE_FACTORIES_EXPORT },
    { tool: "read", module: core, factory: WIRE_FACTORIES_EXPORT },
    { tool: "grep", module: core, factory: WIRE_FACTORIES_EXPORT },
  ];
}
