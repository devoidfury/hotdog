// Planted violations: F1 (.message logged in catch) + F3 (discarded rejection).
export function reset(): void {
  // no-op cleanup
}

export async function loadConfig(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch (e: unknown) {
    console.error(`[fixture] config load failed: ${(e as Error).message}`); // F1
    return "";
  }
}

export function runCommand(cmd: Promise<void>): void {
  cmd.then(
    () => {
      reset();
    },
    () => {
      reset(); // F3: rejection reason discarded silently
    },
  );
}
