// Shared test helpers — re-exported from focused modules.
//
// For new tests, import directly from the relevant module:
//   - tests/mocks/llm.ts     — MockLLMClient, buildStreamResponse
//   - tests/mocks/tools.ts   — MockTool, simpleTool, failingTool, etc.
//   - tests/mocks/fixtures.ts — createFixture, MockAgent, createMockCore, etc.
//   - tests/mocks/io.ts      — tmpDir, cleanupDir, toolCtx, resultStr, etc.
//   - tests/mocks/process.ts — processAlive, waitForExit

export { MockLLMClient, buildStreamResponse } from './mocks/llm.ts';
export { MockTool, simpleTool, validatedTool, failingTool, metadataTool } from './mocks/tools.ts';
export { createFixture, MockAgent, createMockRl, createMockCore } from './mocks/fixtures.ts';
export { resultStr, getDisplay, tmpDir, cleanupDir, toolCtx, TMP_PARENT } from './mocks/io.ts';
export { processAlive, waitForExit } from './mocks/process.ts';
export { withMockFetch, jsonResponse, textResponse } from './mocks/fetch.ts';
export { walLifecycleProbe } from './mocks/wal-lifecycle.ts';
export { bootLiveStore, publishLive, liveStoreCore, createWithLiveStore, registerWithLiveStore } from './mocks/config-live.ts';
