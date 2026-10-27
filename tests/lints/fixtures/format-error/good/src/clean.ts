// Compliant patterns: formatError in catch, typed rejection handlers, empty swallows.
export function formatError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function loadConfig(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch (e: unknown) {
    console.error(`[fixture] config load failed: ${formatError(e)}`);
    return "";
  }
}

export function runCommand(cmd: Promise<void>): void {
  cmd.then(
    () => {},
    (e: unknown) => {
      console.error(formatError(e));
    },
  );
  // intentional fire-and-forget swallow: not flagged (see rule header)
  cmd.catch(() => {});
}
