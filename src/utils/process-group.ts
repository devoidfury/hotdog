// Process-group handling for child processes spawned on the agent's behalf.
//
// The bash tool and the MCP stdio transport spawn processes that can outlive
// their direct child (a shell or server spawning grandchildren). Killing only
// the direct child leaks the rest of the tree.
//
// On POSIX we spawn the child as its own process-group leader (detached) so a
// signal to -pid reaches the whole tree. Windows has no process groups, so
// killProcessGroup() falls back to signaling the child alone.
//
// Known trade-off: a detached child no longer shares the terminal's process
// group, so an unclean death of hotdog itself (SIGKILL, crash) leaves
// running children behind. The orderly paths (tool timeouts,
// SHUTDOWN_CLEANUP) always signal the group.

import type { ChildProcess, SpawnOptions } from "node:child_process";

export const IS_POSIX = process.platform !== "win32";

/**
 * Spawn options that put the child in its own process group (POSIX only).
 * Spread into spawn() options so killProcessGroup() can reach the child's
 * entire tree.
 */
export const OWN_PROCESS_GROUP: Pick<SpawnOptions, "detached"> = {
  detached: IS_POSIX,
};

/**
 * Signal the child's whole process group (POSIX), or the child alone
 * (Windows). Swallows ESRCH -- the group may have exited between the check
 * and the signal.
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (IS_POSIX) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // group already exited; kill raced it
  }
}
