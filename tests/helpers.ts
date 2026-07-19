// Shared test helpers — re-exported from focused modules.
//
// For new tests, import directly from the relevant module:
//   - tests/mocks/llm.ts     — MockLLMClient, buildStreamResponse
//   - tests/mocks/tools.ts   — MockTool, simpleTool, failingTool, etc.
//   - tests/mocks/fixtures.ts — createFixture, MockAgent, MockSink, createMockCore, etc.
//   - tests/mocks/io.ts      — tmpDir, cleanupDir, toolCtx, resultStr, etc.

export { MockLLMClient, buildStreamResponse } from './mocks/llm.ts';
export { MockTool, simpleTool, validatedTool, failingTool, metadataTool } from './mocks/tools.ts';
export { createFixture, MockAgent, MockSink, createMockRl, createMockCore } from './mocks/fixtures.ts';
export { resultStr, getDisplay, tmpDir, cleanupDir, toolCtx, setupSessionTestDir, cleanupSessionTest } from './mocks/io.ts';
