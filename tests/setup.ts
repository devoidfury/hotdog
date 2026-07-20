// Global test setup — suppresses noisy console output during tests.
// Tests that need to capture console output should use captureConsole().

const _originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
};

// Suppress all console output by default during tests.
console.log = () => {};
console.warn = () => {};
console.error = () => {};
console.info = () => {};

// Suppress logger output during tests.
// The logger checks HOTDOG_LOG_LEVEL and HOTDOG_LOG_TARGET env vars.
// Tests that need the logger can override these in their own beforeEach.
const _origLogLevel = process.env.HOTDOG_LOG_LEVEL;
const _origLogTarget = process.env.HOTDOG_LOG_TARGET;
process.env.HOTDOG_LOG_LEVEL = "error";
process.env.HOTDOG_LOG_TARGET = "none";

/**
 * Helper to capture console.log output for a callback.
 * Returns the captured output as a string.
 *
 * Usage:
 *   const output = await captureConsole(async () => {
 *     await someFunctionThatLogs();
 *   });
 */
async function captureConsole<T>(fn: () => Promise<T> | T): Promise<{ result: T; output: string }> {
  let output = "";
  console.log = (...args: unknown[]) => {
    output += args.join(" ") + "\n";
  };
  try {
    const result = await Promise.resolve(fn());
    return { result, output };
  } finally {
    console.log = () => {};
  }
}

export {
  _originalConsole as originalConsole,
  _origLogLevel,
  _origLogTarget,
  captureConsole,
};
