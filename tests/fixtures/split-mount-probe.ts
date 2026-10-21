// Subprocess probe for mountSplitRenderer's real-process path. The §9 gate
// needs BOTH stdio streams TTY, and bun test's stdio is piped, so the parent
// spawns this file and passes the flags explicitly (no PTY needed: the bridge
// only asks the seams for isTTY/size/write).
//
// Everything after the mount happens against THIS process's real globals --
// stdout/stderr/console are patched, so the parent reads the mounted session's
// bytes off the pipe: mode pairs, routed rows, and the restore.
//
// PROBE_MODE=exit-handler skips the explicit shutdown and exits the process
// instead, proving the mount's process.on("exit") last-chance restore runs.

import { mountSplitRenderer, processSignalHost } from "../../src/extensions/ui-interactive-cli/split-bridge.ts";

const bridge = mountSplitRenderer({ knob: "split", stdinIsTTY: true, stdoutIsTTY: true });
if (!bridge) {
  process.stderr.write("MOUNT_FAILED\n");
  process.exit(1);
}

console.log("console-routed-line");
process.stderr.write("stderr-routed-line\n");
process.stdout.write("stdout-routed-line\n");

if (process.env.PROBE_MODE === "crash") {
  // §10 crash route (ledger item D): a throw from a timer callback reaches
  // the uncaughtException handler installCrashTeardown put on the process.
  // The handler must report the error, restore raw mode + bracketed paste,
  // and exit non-zero. The second timer is the anti-swallow tripwire: if the
  // handler ever returned control to the event loop, this process would keep
  // running and print the marker. The never-resolving await parks the module
  // so the timers below decide the outcome.
  setTimeout(() => {
    throw new Error("boom-crash");
  }, 10);
  setTimeout(() => {
    process.stdout.write("SURVIVED-THE-CRASH\n");
    process.exit(0);
  }, 100);
  await new Promise(() => {});
}

if (process.env.PROBE_MODE === "exit-handler") {
  // No shutdown(): the exit listener mount registered must unwind the modes.
  process.exit(0);
}

bridge.shutdown();
console.log("after-restore");
// processSignalHost.exit is the only seam that can end the process; the
// parent asserts the code lands.
processSignalHost.exit(7);
