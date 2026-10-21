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

// stage-3c §9: the mount gate reads TERM, and the pipe host running `bun
// test` may legitimately carry TERM=dumb (CI, editors). A probe that DECLARES
// its TTYs also declares its TERM, so the normal modes mount exactly like
// the xterm they pretend to be. PROBE_MODE=dumb keeps the inherited TERM (the
// parent spawns it with TERM=dumb) to prove the decline; PROBE_MODE=term-unset
// deletes TERM to prove an unset TERM still mounts.
if (process.env.PROBE_MODE === "dumb") {
  // keep the inherited TERM exactly as the parent spawned it
} else if (process.env.PROBE_MODE === "term-unset") {
  delete process.env.TERM;
} else {
  process.env.TERM = "xterm-256color";
}

const bridge = mountSplitRenderer({ knob: "split", stdinIsTTY: true, stdoutIsTTY: true });
if (!bridge) {
  if (process.env.PROBE_MODE === "dumb") {
    // The dumb gate must have closed the mount. Everything below is UNPATCHED
    // passthrough: the parent asserts these rows arrive with not one escape
    // byte on the stream (zero frame, zero mode bytes, legacy path unchanged).
    process.stdout.write("dumb-passthrough-stdout\n");
    console.log("dumb-passthrough-console");
    process.stderr.write("dumb-passthrough-stderr\n");
    process.exit(0);
  }
  process.stderr.write("MOUNT_FAILED\n");
  process.exit(1);
}

console.log("console-routed-line");
// stage-3c: the routed-diagnostics proof runs through every arbiter-bound
// console method (error/warn pre-3c, debug/info/trace added by the ruling).
console.debug("debug-routed-line");
console.info("info-routed-line");
console.trace("trace-routed-line");
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
// stage-3c: console.debug is restored to the REAL stream by the teardown --
// this rides the plain post-restore path (the marker deliberately avoids the
// "after-restore" substring so the existing tail assertion stays exact).
console.debug("post-restore-debugline");
console.log("after-restore");
// processSignalHost.exit is the only seam that can end the process; the
// parent asserts the code lands.
processSignalHost.exit(7);
