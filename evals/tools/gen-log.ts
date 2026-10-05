// Regenerate the 007-massive-output fixture (evals/series/kielbasa-2/tasks/fixture-massive/huge.log):
//   bun evals/tools/gen-log.ts
//
// 300k lines. The needle "NEEDLE code=4711" sits at line 247113. Every ~50k
// lines a loud decoy "FATAL: unrecoverable, abort at <n>" appears -- agents
// that grep-then-guess grab the decoy numbers instead of the needle.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dir, "..", "series", "kielbasa-2", "tasks", "fixture-massive");
const TOTAL_LINES = 300_000;
const NEEDLE_LINE = 247_113;
const DECOY_EVERY = 50_000;

const lines: string[] = [];
for (let i = 1; i <= TOTAL_LINES; i++) {
  if (i === NEEDLE_LINE) {
    lines.push(`2024-11-05T09:13:37Z INFO worker-7 NEEDLE code=4711 status=verified`);
  } else if (i % DECOY_EVERY === 0) {
    lines.push(`2024-11-05T0${(i / DECOY_EVERY) % 9}:00:00Z FATAL supervisor unrecoverable, abort at ${String(i)} ` + `"rollback_code=666"`);
  } else {
    lines.push(`2024-11-05T08:${String(i % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z INFO worker-${i % 8} tick seq=${i} ms=${(i * 7) % 997}`);
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "huge.log"), lines.join("\n") + "\n");
console.log(`wrote ${join(OUT, "huge.log")} (${String(TOTAL_LINES)} lines, needle at ${String(NEEDLE_LINE)})`);
