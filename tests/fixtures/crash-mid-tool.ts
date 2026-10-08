// Crash fixture for the session-durability DoD: simulates a tool call with a
// side effect that is SIGKILLed mid-execution.
//
//   1. writes the assistant tool_calls entry through the CONTEXT_MESSAGE hook
//      (a plain queued append -- NOT fsynced on its own)
//   2. writes the fsynced tool_started record (the executor's awaited barrier)
//   3. lands the side effect (appends one line to the counter file)
//   4. kills itself before any tool_result record could be written
//
// The test asserts the counter file has exactly one line (the side effect ran
// once), that BOTH log records survived the kill (the started-record fsync
// also carries the preceding assistant entry: same file, same barrier), and
// that replaying the recovered log as-is synthesizes the outcome-unknown
// result -- never a success and never a plain "never ran".

import { create } from "../../src/extensions/session-log/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { appendFileSync } from "node:fs";

const sessionId = process.env.CRASH_SESSION_ID;
const counterPath = process.env.COUNTER_PATH;
if (!sessionId || !counterPath) {
  console.error("CRASH_SESSION_ID and COUNTER_PATH are required");
  process.exit(2);
}

const ext = (await create({ resolved: {} } as never)) as {
  hooks: Record<string, (payload: unknown) => Promise<void>>;
};

// The assistant tool_calls entry, appended like the agent's addMessage does
// (queued, un-fsynced): without the barrier below, this line is exactly what
// a kill -9 could lose, stranding the started record with nothing to pair.
await ext.hooks[HOOKS.CONTEXT_MESSAGE]!({
  message: {
    role: "assistant",
    content: "running the command",
    toolCalls: [
      {
        id: "call_crash",
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command: `echo x >> ${counterPath}` }) },
      },
    ],
  },
  agent: { sessionId },
});

// The barrier: the awaited hook must have landed the record on disk (and, by
// fsync, the preceding entry) before the side effect runs.
await ext.hooks[HOOKS.TOOL_BEFORE_EXECUTE]!({
  toolCallId: "call_crash",
  toolName: "bash",
  input: JSON.stringify({ command: `echo x >> ${counterPath}` }),
  agent: { sessionId },
});

appendFileSync(counterPath, "1\n");

// Die exactly like a power failure: no result record, no cleanup.
process.kill(process.pid, "SIGKILL");
