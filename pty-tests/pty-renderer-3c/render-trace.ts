// renderer-pty-3c helper: replay a raw PTY capture through the repo's Grid
// model and dump the rows a reader would have seen (scrollback + screen).
// This is a MODEL replay, not a claim of physical pixels: the Grid is the
// documented test-double terminal (src/utils/cli/renderer/grid.ts) covering
// exactly the sequence subset the CLI emits (plus bun's readline refreshes).
//
// Usage: bun render-trace.ts <capture.raw> <rows> <cols> [out.txt]

import { readFileSync, writeFileSync } from "node:fs";
import { Grid } from "../../src/utils/cli/renderer/grid.ts";

const [path, rowsArg, colsArg, out] = process.argv.slice(2);
if (!path || !rowsArg || !colsArg) {
  console.error("usage: bun render-trace.ts <capture.raw> <rows> <cols> [out.txt]");
  process.exit(2);
}
const rows = Number(rowsArg);
const cols = Number(colsArg);
if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
  console.error("rows/cols must be positive integers");
  process.exit(2);
}

const bytes = readFileSync(path);
const grid = new Grid(rows, cols);
// The capture is latin1-safe: printable UTF-8 survives the Grid's put() path
// byte-for-byte per codepoint only after decoding -- decode UTF-8 first,
// control/escape bytes are ASCII and stay aligned.
grid.feed(bytes.toString("utf-8"));
const snap = grid.snapshot();
const lines = [...snap.scrollback, ...snap.screen];
// Trim trailing blank rows for readability; keep interior history.
while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
const text = lines.map((l) => l.replace(/\s+$/, "")).join("\n") + "\n";
if (out) writeFileSync(out, text);
else process.stdout.write(text);
