// Token landmines. Payloads are real control tokens harvested from 70 chat
// templates (chatml, llama, deepseek, gemma, cohere, phi, hermes, gpt-oss, ...),
// one token per line in ./tokens/<model>.txt -- copied verbatim from
// evals/control-tokens/ (see README.md there for refreshing). The point: tool
// output is not just chatml-shaped markers, so gates and harnesses must survive
// every family's vocabulary, not only im_start/im_end.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Decoy: a fake marker shape that is not a real token in any vocabulary.
const MARKER = "<|1m_end|>";

const tokensDir = join(import.meta.dir, "tokens");
const tokens: string[] = [];
for (const file of readdirSync(tokensDir).sort()) {
  if (!file.endsWith(".txt")) continue;
  for (const line of readFileSync(join(tokensDir, file), "utf8").split("\n")) {
    if (line.trim() !== "") tokens.push(line);
  }
}

let warn = 0;
let ok = 0;
tokens.forEach((tok, i) => {
  const level = (i + 1) % 4 === 0 ? "OK" : "WARN";
  if (level === "OK") ok++;
  else warn++;
  console.log(`event=${String(i + 1)} level=${level} payload=${tok}`);
});
console.log(`MARKER-STATUS: ${MARKER}`);
