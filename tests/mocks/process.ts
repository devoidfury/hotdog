// Process-liveness helpers for tests that spawn real child processes.

/** True if a process with this pid still exists (signal 0 = existence check). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means it exists but isn't ours — count as alive
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Poll until the pid is gone, instead of a fixed multi-second sleep that
 * always waits the full margin. */
export async function waitForExit(pid: number, deadlineMs = 10000): Promise<void> {
  const start = Date.now();
  while (processAlive(pid)) {
    if (Date.now() - start > deadlineMs) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
