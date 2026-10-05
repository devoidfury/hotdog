// Regenerate the 010-encoding-swamp fixture (evals/series/kielbasa-2/tasks/fixture-swamp/telemetry.log):
//   bun evals/tools/gen-swamp.ts
//
// A log that punishes sloppy text handling:
//   - UTF-8 BOM at the start of the file
//   - CRLF and LF line endings mixed
//   - one invalid UTF-8 sequence (0xC3 0x28) inside a comment line
//   - a block of records separated by NUL bytes instead of newlines
// Exactly 3 lines carry `status=WAIT`. Decoys: three `status=WAITING` and one
// `status=WEB`, so substring greps for "WAIT" over-count unless anchored.
// Bytes are written via Buffer.from arrays -- never embed raw control-ish
// bytes in source text.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dir, "..", "series", "kielbasa-2", "tasks", "fixture-swamp");

const parts: Buffer[] = [];
const push = (s: string) => parts.push(Buffer.from(s, "utf8"));

// BOM + first lines, CRLF.
parts.push(Buffer.from([0xef, 0xbb, 0xbf]));
push("telemetry v2\r\n");
push("# smokehouse controller log\r\n");
push("t=1 status=WAIT sensor=grill\r\n");

// LF-only section with the WAITING decoys.
push("t=2 status=WEB sensor=cloud\r\n");
push("t=3 status=WAITING sensor=grill\r\n");
push("t=4 status=WAITING sensor=smoker\r\n");

// Invalid UTF-8 inside a comment: the byte pair 0xC3 0x28 (a lone continuation-starter
// byte followed by '('), then continue with valid text. Latin1 decoding maps
// each escape to exactly one byte.
parts.push(Buffer.from("# calibration pass \xC3(", "latin1"));
parts.push(Buffer.from(" t=5 note=ok\n", "utf8"));

// One more WAIT, LF ending.
push("t=6 status=WAIT sensor=smoker\n");

// NUL-separated record block (no newlines between them).
parts.push(
  Buffer.from(
    ["t=7 status=WEB sensor=cloud", "t=8 status=WAITING sensor=grill", "t=9 status=OK sensor=grill"].join("\0"),
    "utf8",
  ),
);
push("\n");

// Final WAIT, CRLF.
push("t=10 status=WAIT sensor=probe\r\n");
// One last WAITING decoy so the file does not end on a match.
push("t=11 status=WAITING sensor=probe\r\n");

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "telemetry.log"), Buffer.concat(parts));
console.log(`wrote ${join(OUT, "telemetry.log")} (3x WAIT, 3x WAITING, 1x WEB)`);
