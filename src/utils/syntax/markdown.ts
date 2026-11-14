import { getTokenizer, resolveSyntaxLang, type SyntaxRun } from "./index.ts";

/**
 * Markdown line tokenizer for streaming surfaces.
 *
 * Unlike the stateless registry tokenizers, markdown needs line context plus
 * fenced-code state, so this is a per-line function driven by an explicit
 * state object the caller owns: `tokenizeMarkdownLine(line, state)` mutates
 * the state (fence open/close) and must run EXACTLY ONCE per committed line.
 * The unterminated live row is rendered with `tokenizeMarkdownLive`, which
 * classifies against the same state without touching it -- repaint after
 * repaint converges because a line's final classification is the same bytes
 * the live pass produced for it once the closing construct lands.
 *
 * Line classes: "heading" (whole ATX line), "marker" (list bullet/ordered
 * bullet/blockquote prefix/hr), "fence" (a ``` / ~~~ rule line, or a YAML
 * frontmatter delimiter), "code_block"
 * (a fenced line with no resolvable language -- rides the text wash),
 * "strong" (`**…**`) and "code" (inline backtick span) inside paragraphs;
 * everything else "default". A
 * fenced line whose language resolves in the registry (canonical name or a
 * def-shipped alias like `sh`/`py`/`js`; see index.ts) runs
 * through that tokenizer instead -- its classes
 * (command/operator/key/…) pass through and the sink styles what it knows.
 * Markdown spans are suppressed inside fences.
 *
 * YAML frontmatter is an OPT-IN document feature: a state created with
 * `newMdStreamState(true)` starts in "await" and opens a block when line 1
 * is exactly `---`; the delimiter lines ride "fence", the content lines run
 * through the registry's yaml tokenizer (key/string/comment/... pass
 * through -- no second yaml scanner exists), and the block closes on a
 * column-0 `---` or `...`, never reopening. The default state is "off": a
 * streamed assistant message whose first line is `---` means an hr, exactly
 * as before, so no prose surface changes. Static callers that hold their
 * lines prescan with `hasFrontmatter` (opener on line 1 AND a closer
 * exists), which is what stops a leading hr pair from painting its
 * between-block as yaml; streaming has no such lookahead and commits blind.
 * `tokenizeMarkdownDoc(lines, frontmatter)` drives a whole document in one
 * call. Fences are inert inside frontmatter.
 *
 * v1 scope, deliberately: headings, bullet/ordered markers, blockquote
 * prefixes, hrs, fences, `**strong**` and backtick code. No `*em*`/`__`
 * (too many false positives in prose and paths), no links/images, no
 * indented-code blocks. Unclosed spans end unstyled at the line end.
 *
 * Nothing is dropped or reordered: concatenating every run reproduces the
 * line exactly, for any input. One run per token; adjacent runs may share a
 * type (sinks coalesce as they like). This is display candy, not a CommonMark
 * implementation.
 */

/** Fenced-code and frontmatter state carried across lines (and repaints) by the caller. */
export interface MdStreamState {
  /** The opening fence marker ("```" / "~~~") while inside a fence; null outside. */
  fence: string | null;
  /** Registry language resolved from the fence info string; null = plain code. */
  lang: string | null;
  /**
   * YAML frontmatter phase. "off": delimiters never open a block (the
   * streaming-prose default -- a message whose first line is `---` means an
   * hr). "await": line 1 may open a block (document surfaces opt in with
   * `newMdStreamState(true)`, ideally behind the `hasFrontmatter` prescan).
   * "open": inside the block -- markdown is inert and every content line
   * runs through the registry's yaml tokenizer.
   */
  frontmatter: "off" | "await" | "open";
}

export function newMdStreamState(frontmatter = false): MdStreamState {
  return { fence: null, lang: null, frontmatter: frontmatter ? "await" : "off" };
}

/** Snapshot for speculative (live-row) passes; never mutates the original. */
export function cloneMdStreamState(state: MdStreamState): MdStreamState {
  return { fence: state.fence, lang: state.lang, frontmatter: state.frontmatter };
}

/**
 * Prescan for document surfaces that hold their lines: true only when line 1
 * is the opener AND a closer line exists. Streaming cannot afford this (the
 * opener must commit blind); static views can, and do -- it is what keeps a
 * leading hr pair from painting its between-block as yaml.
 */
export function hasFrontmatter(lines: string[]): boolean {
  return lines.length > 1 && FRONTMATTER_OPEN_RE.test(lines[0]!) && lines.slice(1).some((l) => FRONTMATTER_CLOSE_RE.test(l));
}

/**
 * Tokenize a whole document (lines without terminators) with fresh state --
 * fences and (opt-in) frontmatter carry across lines exactly as a live
 * stream would. Frontmatter detection is the caller's choice, normally
 * `hasFrontmatter(lines)`; once every line is visible, a document whose
 * opener never closes still reads as yaml to the end, so prescan first.
 */
export function tokenizeMarkdownDoc(lines: string[], frontmatter = false): SyntaxRun[][] {
  const state = newMdStreamState(frontmatter);
  return lines.map((line) => tokenizeMarkdownLine(line, state));
}

/**
 * Classify one COMPLETE line (no line terminator) and advance fence and
 * frontmatter state.
 */
export function tokenizeMarkdownLine(line: string, state: MdStreamState): SyntaxRun[] {
  const runs = classify(line, state);
  // Stateful transitions are decided after classification so the closing
  // line itself renders as "fence".
  if (state.frontmatter === "open") {
    if (FRONTMATTER_CLOSE_RE.test(line)) state.frontmatter = "off";
  } else if (state.frontmatter === "await") {
    state.frontmatter = FRONTMATTER_OPEN_RE.test(line) ? "open" : "off";
  }
  // Fence grammar is inert inside frontmatter (a ``` line there is yaml text).
  if (state.frontmatter !== "open") {
    if (state.fence === null) {
      const open = FENCE_RE.exec(line);
      if (open && fenceOpens(open[2]!, open[3] ?? "")) {
        state.fence = open[2]!;
        state.lang = resolveLang(open[3] ?? "");
      }
    } else if (isFenceClose(line, state.fence)) {
      state.fence = null;
      state.lang = null;
    }
  }
  return runs;
}

/**
 * Classify the unterminated row currently streaming: same visual rules, but
 * the state is NOT advanced (the committed pass will do that).
 */
export function tokenizeMarkdownLive(line: string, state: MdStreamState): SyntaxRun[] {
  return classify(line, cloneMdStreamState(state));
}

function classify(line: string, state: MdStreamState): SyntaxRun[] {
  if (state.frontmatter === "open") {
    // Inside frontmatter: markdown is inert; the shared yaml tokenizer
    // (the very one fences route `yml` through) owns every content line.
    if (FRONTMATTER_CLOSE_RE.test(line)) return [{ type: "fence", text: line }];
    const yaml = getTokenizer("yaml");
    if (yaml) return yaml(line);
    return line === "" ? [] : [{ type: "default", text: line }];
  }
  if (state.fence !== null) {
    // Inside a fence: markdown spans are inert.
    if (isFenceClose(line, state.fence)) return [{ type: "fence", text: line }];
    if (state.lang !== null) {
      const tok = getTokenizer(state.lang);
      if (tok) return tok(line);
    }
    return line === "" ? [] : [{ type: "code_block", text: line }];
  }
  const open = FENCE_RE.exec(line);
  if (open && fenceOpens(open[2]!, open[3] ?? "")) return [{ type: "fence", text: line }];
  if (state.frontmatter === "await" && FRONTMATTER_OPEN_RE.test(line)) return [{ type: "fence", text: line }];
  if (/^ {0,3}#{1,6}(\s|$)/.test(line)) return [{ type: "heading", text: line }];
  if (HR_RE.test(line)) return [{ type: "marker", text: line }];
  const quote = QUOTE_RE.exec(line);
  if (quote) {
    const runs: SyntaxRun[] = [{ type: "marker", text: quote[1]! }];
    runs.push(...tokenizeInline(quote[2] ?? ""));
    return runs;
  }
  const bullet = BULLET_RE.exec(line);
  if (bullet) {
    const runs: SyntaxRun[] = [];
    if (bullet[1]) runs.push({ type: "default", text: bullet[1] });
    runs.push({ type: "marker", text: bullet[2]! });
    if (bullet[3]) runs.push({ type: "default", text: bullet[3] });
    runs.push(...tokenizeInline(bullet[4] ?? ""));
    return runs;
  }
  return tokenizeInline(line);
}

// A fence is up to 3 leading spaces, three or more identical ` or ~, then an
// info string. A backtick fence's info may not contain a backtick (it would
// swallow the closer); tilde fences carry no such restriction.
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

function fenceOpens(marker: string, info: string): boolean {
  return marker[0] === "~" || !info.includes("`");
}

function isFenceClose(line: string, open: string): boolean {
  const re = open[0] === "`" ? CLOSE_TICK_RE : CLOSE_TILDE_RE;
  const m = re.exec(line);
  return m !== null && m[1]!.length >= open.length;
}

const CLOSE_TICK_RE = /^ {0,3}(`{3,})[ \t]*$/;
const CLOSE_TILDE_RE = /^ {0,3}(~{3,})[ \t]*$/;

const HR_RE = /^ {0,3}(?:([-*_])\s*){3,}$/;
// Frontmatter delimiters are column-0 by YAML convention (no indent, unlike
// the hr's three-space grace); the closer also takes `...` (the yaml
// document-end marker the yaml tokenizer itself styles "marker").
const FRONTMATTER_OPEN_RE = /^---[ \t]*$/;
const FRONTMATTER_CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/;
const QUOTE_RE = /^( {0,3}>+\s?)(.*)$/;
// `1.` and `1)` ordered markers need a digit-run; plain `-`/`*`/`+` need the
// following space, so `**bold**` at line start never reads as a bullet.
const BULLET_RE = /^( *)([-*+]|\d{1,9}[.)])( +)(.*)$/;

// Fence-info languages resolve through the registry: canonical names and
// the aliases shipped on each lang's SyntaxDef (see index.ts). Unknown
// info strings -- and names whose def has no tokenizer -- resolve to
// null (plain code).
function resolveLang(info: string): string | null {
  const word = info.trim().split(/\s+/)[0]?.toLowerCase();
  if (!word) return null;
  return resolveSyntaxLang(word) ?? null;
}

/**
 * Inline pass: `**strong**` and backtick spans, both closed-on-same-line
 * only (an unclosed opener rides "default" and the repaint restyles once it
 * closes). A backslash escape swallows the next character so a literal
 * `\*`/`` \` `` never opens a span.
 */
function tokenizeInline(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };
  let i = 0;
  let plainStart = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\" && i + 1 < text.length) {
      i += 2; // escape pair: literal, stays in the surrounding default run
      continue;
    }
    if (c === "`") {
      let ticks = 0;
      while (text[i + ticks] === "`") ticks++;
      const closer = text.indexOf("`".repeat(ticks), i + ticks);
      if (closer > -1) {
        push("default", text.slice(plainStart, i));
        push("code", text.slice(i, closer + ticks));
        i = closer + ticks;
        plainStart = i;
        continue;
      }
      i += ticks; // unclosed: literal ticks, keep scanning
      continue;
    }
    if (c === "*" && text[i + 1] === "*") {
      const closer = text.indexOf("**", i + 2);
      if (closer > -1) {
        push("default", text.slice(plainStart, i));
        push("strong", text.slice(i, closer + 2));
        i = closer + 2;
        plainStart = i;
        continue;
      }
      i += 2;
      continue;
    }
    i++;
  }
  push("default", text.slice(plainStart));
  return runs;
}
