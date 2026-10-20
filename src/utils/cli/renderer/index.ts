// Self-contained CLI renderer core (stage 2a of
// /home/agent/hotdog-cli-renderer-design-2026-10-19.md). Nothing in the
// running CLI imports this module set yet; wiring lands in stage 2b.

export type { Clock, KeySource, SignalHost, Terminal } from "./seams.ts";
export { ProcessTerminal, StdinKeySource } from "./terminal.ts";
export { SystemClock } from "./clock.ts";
export { FakeClock } from "./fake-clock.ts";
export { MemoryKeySource } from "./memory-keysource.ts";
export { Grid, GridTerminal, type GridSnapshot } from "./grid.ts";
export { charWidth, visibleWidth, wrapToWidth } from "./width.ts";
export { BoundedWriter, MAX_WRITE_BYTES } from "./writer.ts";
export { FrameScheduler, MIN_RENDER_INTERVAL_MS } from "./scheduler.ts";
export { RendererCore, type RendererCoreOptions } from "./commit.ts";
export { TeardownGuard, TerminalModes, type TeardownDeps } from "./teardown.ts";
