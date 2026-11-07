// The diff algorithm behind every declared `kind: "diff"` display part
// (ToolDisplaySpec / ToolDisplayWire): the common prefix/suffix trim, the
// two-gutter line numbering, the per-side cap, and the all-add rail an
// args-sourced write part needs.
//
// Lifted verbatim from the webui tool block (where it was UI-local) so the
// browser's gutters and the terminal's ANSI block can never disagree about
// what one edit changed. Zero dependencies, no I/O, no color: safe in the
// browser bundle and in the sink alike. Coloring and elision WORDING are sink
// policy (see src/utils/cli/diff-render.ts); this file only decides which
// lines exist, on which side, and at what number.

/**
 * The per-side render cap `computeDiffLines` applies when the caller says
 * nothing: 300, the posture the webui has always used (it can afford it, the
 * rest folds behind an expand affordance). A sink with a smaller budget passes
 * its own number -- the terminal caps at `CLI_MAX_DIFF_LINES` because its
 * scrollback is write-once -- but a caller that says nothing gets this, never
 * an unbounded render. (Not `DEFAULT_*`: that prefix is the config-resolution
 * namespace, and this is a render posture.)
 */
export const MAX_DIFF_LINES = 300;

export interface DiffLine {
  kind: "ctx" | "add" | "del" | "info";
  text: string;
  /** 1-based line number in the OLD file; absent on add/info rows (the side
   *  that line does not exist on renders an empty gutter cell). */
  oldNo?: number;
  /** 1-based line number in the NEW file; absent on del/info rows. */
  newNo?: number;
  /** kind "info" only: how many changed lines this placeholder stands for.
   * Sinks that fold the per-side placeholders into one elision line (the
   * terminal prints a single `… N more changed lines`) read the count
   * instead of parsing the placeholder's text. */
  elided?: number;
}

/**
 * Diff lines for an old/new string pair: common prefix/suffix trimmed, the
 * changed middles rendered as del-then-add with one context line on each
 * side. Far kinder than a positional line-pairing diff for insertions.
 *
 * Numbering (the GitHub body's two gutters), with `start` the trimmed prefix
 * length and `base = (fileStartLine ?? 1) - 1`: removed oldLines[start..endOld-1]
 * number base+start+1+i in the old file, added newLines[start..endNew-1] number
 * base+start+1+i in the new one, the leading context row is line base+start on
 * both sides, the trailing one base+endOld+1 / base+endNew+1. A pure insertion
 * therefore shows only new numbers and a pure deletion only old ones -- the two
 * sides never share a row. The cap placeholders are `info` rows: they say
 * something about the diff, not about a line, so they carry no numbers.
 *
 * `fileStartLine` is the file line of the rendered snippet's FIRST line
 * (edit's `start_line` meta: where oldString matched, context included): it
 * shifts the base, so the gutters read the file, not the snippet. Both sides
 * share the base because everything above the snippet is unchanged:
 * oldString and newString start at the same line in their respective files.
 * Absent (no result fact) -> base 0, the snippet's own 1..N -- the honest
 * fallback, and what a multi-match replace_all renders against (its gutters
 * describe the first match).
 *
 * `maxLines` caps EACH side (del rows and add rows separately) and drops an
 * `info` placeholder per side beyond it; absent means MAX_DIFF_LINES.
 * The number itself is the sink's posture, not this file's policy.
 */
export function computeDiffLines(
  oldText: string,
  newText: string,
  maxLines: number = MAX_DIFF_LINES,
  fileStartLine?: number,
): DiffLine[] {
  const base = (fileStartLine !== undefined && Number.isInteger(fileStartLine) && fileStartLine > 0
    ? fileStartLine
    : 1) - 1;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const removed = oldLines.slice(start, endOld);
  const added = newLines.slice(start, endNew);

  const lines: DiffLine[] = [];
  if (start > 0) lines.push({ kind: "ctx", text: oldLines[start - 1]!, oldNo: base + start, newNo: base + start });
  removed.forEach((text, i) => {
    if (i === maxLines) lines.push({ kind: "info", text: `… ${removed.length - maxLines} more removed`, elided: removed.length - maxLines });
    else if (i < maxLines) lines.push({ kind: "del", text, oldNo: base + start + 1 + i });
  });
  added.forEach((text, i) => {
    if (i === maxLines) lines.push({ kind: "info", text: `… ${added.length - maxLines} more added`, elided: added.length - maxLines });
    else if (i < maxLines) lines.push({ kind: "add", text, newNo: base + start + 1 + i });
  });
  if (endOld < oldLines.length) {
    lines.push({ kind: "ctx", text: oldLines[endOld]!, oldNo: base + endOld + 1, newNo: base + endNew + 1 });
  }
  return lines;
}

/**
 * Every line of a written body as an add row: append/overwrite have no old
 * side to pair against, so their part is all-green and no diff is computed.
 * Line accounting is the house diff idiom: split on `\n` only (a `\r` rides
 * inside the line; a trailing `\n` yields a final empty add row, the same way
 * the file posture counts it).
 *
 * `addStart` is what line of the new file the rail begins at: only a positive
 * integer is a number (overwrite replaces the whole file, so `1` is the
 * truth); anything else -- absent, 0, negative, fractional -- leaves the
 * numbering off. A fake 1..N for an unknown offset is the one lie the gutters
 * exist to prevent (append declares nothing: it lands after content of
 * unknown length). `maxLines` caps the rendered rows like computeDiffLines
 * and reports what it dropped as `elided`.
 */
export function addOnlyDiffLines(
  body: string,
  addStart?: number,
  maxLines: number = Number.POSITIVE_INFINITY,
): { lines: DiffLine[]; elided: number } {
  const start = typeof addStart === "number" && Number.isInteger(addStart) && addStart > 0
    ? addStart
    : undefined;
  const all = body.split("\n");
  const keep = Number.isFinite(maxLines) ? Math.max(0, Math.floor(maxLines)) : all.length;
  const lines: DiffLine[] = all.slice(0, keep).map((text, i) => ({
    kind: "add",
    text,
    ...(start === undefined ? {} : { newNo: start + i }),
  }));
  return { lines, elided: all.length - lines.length };
}

/** The diff's stat: add/del row counts of the resolved lines (info
 *  placeholders are not counted -- they are not lines). */
export function diffStat(lines: DiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.kind === "add") add++;
    else if (l.kind === "del") del++;
  }
  return { add, del };
}
