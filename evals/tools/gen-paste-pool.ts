// Rewrites the POOL array in the 012-error-paste-landmines fixture from
// evals/control-tokens/*.txt (sorted filenames, one token per line, blank lines
// skipped). Run after any change to the token corpus:
//
//   bun evals/tools/gen-paste-pool.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TOKENS_DIR = join(ROOT, "control-tokens");
const TARGET = join(ROOT, "series/kielbasa-2/tasks/fixture-error-paste/paste.ts");

function main(): void {
  const pool: string[] = [];
  for (const file of readdirSync(TOKENS_DIR).sort()) {
    if (!file.endsWith(".txt")) continue;
    for (const line of readFileSync(join(TOKENS_DIR, file), "utf8").split("\n")) {
      if (line.trim() !== "") pool.push(line);
    }
  }
  if (pool.length < 40) throw new Error(`gen-paste-pool: pool too small (${pool.length} tokens)`);

  const src = readFileSync(TARGET, "utf8");
  const start = src.indexOf("const POOL: string[] = [");
  const end = src.indexOf("\n];", start);
  if (start < 0 || end < 0) throw new Error(`gen-paste-pool: POOL markers not found in ${TARGET}`);
  const body = "const POOL: string[] = [\n" + pool.map((t) => "  " + JSON.stringify(t)).join(",\n") + "\n";
  writeFileSync(TARGET, src.slice(0, start) + body + src.slice(end));
  console.log(`gen-paste-pool: wrote ${pool.length} tokens to ${TARGET}`);
}

main();
