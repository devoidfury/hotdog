// Global test setup — suppresses noisy console output during tests.
// Tests that need to capture console output should use captureConsole()
// from tests/test-helpers.ts.

// Suppress all console output by default during tests.
console.log = () => {};
console.warn = () => {};
console.error = () => {};
console.info = () => {};

// Suppress logger output during tests.
// The logger checks HOTDOG_LOG_LEVEL and HOTDOG_LOG_TARGET env vars.
// Tests that need the logger can override these in their own beforeEach.
process.env.HOTDOG_LOG_LEVEL = "error";
process.env.HOTDOG_LOG_TARGET = "none";
