import { DEFAULT_TICK_MS } from "./tick.ts";

const config = { repeatLimit: undefined as number | undefined };

export function tickInterval(): number {
  return DEFAULT_TICK_MS; // D1: component importing a DEFAULT_* constant
}

export function limit(): number {
  return config.repeatLimit ?? 9; // D2: literal fallback for a schema key
}
