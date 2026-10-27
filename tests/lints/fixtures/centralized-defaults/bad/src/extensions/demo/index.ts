import { type CoreContext, getExtensionConfig } from "@core/extensions/types.ts";

const DEFAULT_PING = 9; // D3: backup default constant in a config consumer

export function create(core: CoreContext): { ping: () => number } {
  const config = getExtensionConfig<{ pingLimit?: number }>(core, "demo");
  return {
    ping: () => config.pingLimit ?? DEFAULT_PING, // D2: DEFAULT_ fallback for a schema key
  };
}
