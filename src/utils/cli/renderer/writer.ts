// Bounded final writer (design note §1, pi BoundedTerminalWriter precedent):
// oversized strings are flushed in chunks capped at 1 MiB of UTF-8, and a
// boundary that would land between a surrogate pair backs off one code unit
// so a pair never straddles a write.

export const MAX_WRITE_BYTES = 1024 * 1024;

/** UTF-8 bytes this code unit contributes. A low surrogate rides in its pair's 4 bytes (counted at the high surrogate) and contributes 0; a LONE low surrogate encodes as U+FFFD under TextEncoder, so it costs 3. */
function unitBytes(s: string, i: number): number {
  const u = s.charCodeAt(i);
  if (u < 0x80) return 1;
  if (u < 0x800) return 2;
  if (u >= 0xd800 && u <= 0xdbff) return 4;
  if (u >= 0xdc00 && u <= 0xdfff) {
    const prev = i > 0 ? s.charCodeAt(i - 1) : 0;
    return prev >= 0xd800 && prev <= 0xdbff ? 0 : 3;
  }
  return 3;
}

/** Largest end > start such that s.slice(start, end) fits the byte budget and never splits a surrogate pair. */
function splitAtBudget(s: string, start: number, budget: number): number {
  let bytes = 0;
  let i = start;
  for (; i < s.length; i++) {
    const add = unitBytes(s, i);
    if (bytes + add > budget) break;
    bytes += add;
  }
  // The budget-break can land right after a high surrogate (its pair-part
  // would have added 0 bytes on the next unit). Back off: pairs stay whole.
  if (i > start && s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff) i--;
  return i;
}

/**
 * Writes through `sink` in chunks whose UTF-8 length never exceeds
 * MAX_WRITE_BYTES, with surrogate-safe boundaries. Input that fits the cap
 * is exactly one pass and one write.
 */
export class BoundedWriter {
  constructor(private readonly sink: (chunk: string) => void) {}

  write(s: string): void {
    if (s.length === 0) return;
    let pos = 0;
    while (pos < s.length) {
      const next = splitAtBudget(s, pos, MAX_WRITE_BYTES);
      // next === pos only when the budget cannot fit the code unit at pos --
      // impossible here: the cap exceeds any single codepoint's 4 bytes.
      this.sink(s.slice(pos, next));
      pos = next;
    }
  }
}
