// Live-config store harness for the B6a/B6b migration suites (design §4.1):
// a REAL createConfigStore(), the createCore accessor shape over it, the only
// publish shape the store allows (swap + its one-shot commit), and a one-shot
// TOOLS_REGISTER against that live core.
//
// Extracted ONCE when the B6b families would have made a third copy of the
// bootStore/publish/register trio inlined in tests/extensions/tools-index.test.ts
// and tests/extensions/bash-tool.test.ts; those suites' local helpers now
// delegate here with identical bodies and their assertion bodies survive
// byte-identical.

import { HOOKS } from '@core/hooks.ts';
import { createConfigStore, type ConfigStore } from '@core/config/store.ts';
import type { CoreConfigWithExtensions } from '@core/config/schema-loader.ts';
import type { CoreContext, ExtensionInstance, ResolvedConfig } from '@core/extensions/types.ts';

/** Boot-adopt a generation into a fresh real store (adopt is boot-only). */
export function bootLiveStore(
  config: Record<string, unknown>,
  resolved: Record<string, unknown> = {},
): ConfigStore {
  const store = createConfigStore();
  store.adopt(config as CoreConfigWithExtensions, resolved as ResolvedConfig);
  return store;
}

/** The only publish shape the store allows: swap + its one-shot commit.
 *  Generations are rebuilt whole per publish (re-resolve semantics). */
export function publishLive(
  store: ConfigStore,
  config: Record<string, unknown>,
  resolved: Record<string, unknown> = {},
): void {
  store.swap({
    config: config as CoreConfigWithExtensions,
    resolved: resolved as ResolvedConfig,
  })();
}

/** Fake core answering config/resolved from the store's CURRENT generation
 *  (the createCore accessor shape, §1.2). `extras` carries whatever else the
 *  extension touches (services, hooks, ...). */
export function liveStoreCore(
  store: ConfigStore,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...extras,
    get config() {
      return store.current().config;
    },
    get resolved() {
      return store.current().resolved;
    },
    configStore: store,
  };
}

/** Create the extension against a live core AND register its tools once
 *  (single TOOLS_REGISTER pass). Returns the instance (for other hooks,
 *  e.g. handoff's TURN_END) plus the name -> tool map. */
export function createWithLiveStore(
  store: ConfigStore,
  create: (core: CoreContext) => ExtensionInstance,
  extras: Record<string, unknown> = {},
): { ext: ExtensionInstance; tools: Map<string, any> } {
  const tools = new Map<string, any>();
  const registry = {
    register: (name: string, tool: unknown) => tools.set(name, tool),
    getAll: () => [],
  };
  const ext = create(liveStoreCore(store, extras) as unknown as CoreContext);
  ext.hooks?.[HOOKS.TOOLS_REGISTER]?.(registry as any);
  return { ext, tools };
}

/** Register an extension's tools ONCE against a live core (a single
 *  TOOLS_REGISTER pass) and return the name -> tool map. The hooks register
 *  synchronously before their first await in every migrated family, so the
 *  map is complete when this returns (same shape the B6a describes used). */
export function registerWithLiveStore(
  store: ConfigStore,
  create: (core: CoreContext) => ExtensionInstance,
  extras: Record<string, unknown> = {},
): Map<string, any> {
  return createWithLiveStore(store, create, extras).tools;
}
