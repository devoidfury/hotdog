// Upload ceilings accessor: webui uploads (websocket) and @refs
// (file-attachment) enforce the same numbers from the same resolved source.
// The values are a root config key (core.config.json uploadLimits, legacy
// fileAttachment.* alias), so they exist regardless of which extensions are
// enabled -- an upload posture must not be one extension's private business.

import { ConfigError } from "../error.ts";
import type { CoreContext, ResolvedConfig } from "../extensions/types.ts";

export function uploadLimits(core: CoreContext): ResolvedConfig["uploadLimits"] {
  const limits = core.resolved?.uploadLimits;
  if (
    !limits ||
    typeof limits.maxFileSize !== "number" ||
    typeof limits.maxImageSize !== "number" ||
    typeof limits.maxFiles !== "number"
  ) {
    // A resolved bag without a well-formed uploadLimits means the host never
    // ran config resolution (or the config carried junk where the object
    // belongs): fail loud rather than compare sizes against undefined. Echo
    // the actual value so the diagnosis points at the config, not resolveAll.
    throw new ConfigError(
      `resolved.uploadLimits missing or malformed (got ${JSON.stringify(limits)}): ` +
        "config resolution (resolveAll) must populate the root uploadLimits key",
    );
  }
  return limits;
}
