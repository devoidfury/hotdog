// Reads .env and prints STATUS=<value>.
// Known-buggy parser: it splits on "=" and keeps the raw value, quotes and all,
// so a quoted entry like STATUS="ok" prints STATUS="ok" instead of STATUS=ok.
import { readFileSync } from "node:fs";

const env: Record<string, string> = {};
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  env[t.slice(0, eq)] = t.slice(eq + 1);
}

console.log(`STATUS=${env.STATUS}`);
