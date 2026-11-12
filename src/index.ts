// Package-root entry for embedders -- the "run hotdog programmatically" surface.
//
// Distinction from the SDK: "@read-receipt/hotdog/sdk" is the extension-author
// surface; this root adds the host primitives (boot, core wiring, config
// build) that only the process owner needs. The SDK surface is re-exported
// here too, so an embedder imports from exactly one place.
//
// Version policy matches the SDK: additive within majors, breaking at majors.
// Everything under src/ reached by neither entry is internal.

export * from "./sdk.ts";

export { main, createCore, peekConfigFlags } from "@core/main.ts";
export type { CoreInfrastructure } from "@core/main.ts";
export { buildConfig, loadConfig } from "@core/config/index.ts";
