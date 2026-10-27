// Exempt constructs: prose mentions, message-only RESULT (not logged),
// expression-bodied rejection handler.

// Never write console.error(e.message) directly -- the rule text itself.

const bannedExample = "logger.warn(`${e.message}`)"; // string literal, masked

export function load(path: string): { ok: boolean; error?: string } {
  try {
    if (!path) throw new Error("empty path");
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message }; // returned, not logged
  }
}

export function attempt(p: Promise<string>): Promise<string> {
  return p.then(
    (v) => v,
    () => fallback(), // expression body: outcome propagates through the chain
  );
}

function fallback(): string {
  return bannedExample;
}
