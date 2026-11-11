import { getTokenizer, type SyntaxRun } from "./index.ts";

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
 * bullet/blockquote prefix/hr), "fence" (a ``` / ~~~ rule line), "code_block"
 * (a fenced line with no resolvable language -- rides the text wash),
 * "strong" (`**…**`) and "code" (inline backtick span) inside paragraphs;
 * everything else "default". A
 * fenced line whose language resolves in the registry (`sh|bash|zsh` ->
 * shell, `yml` -> yaml) runs through that tokenizer instead -- its classes
 * (command/operator/key/…) pass through and the sink styles what it knows.
 * Markdown spans are suppressed inside fences.
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

/** Fenced-code state carried across lines (and repaints) by the caller. */
export interface MdStreamState {
  /** The opening fence marker ("```" / "~~~") while inside a fence; null outside. */
  fence: string | null;
  /** Registry language resolved from the fence info string; null = plain code. */
  lang: string | null;
}

export function newMdStreamState(): MdStreamState {
  return { fence: null, lang: null };
}

/** Snapshot for speculative (live-row) passes; never mutates the original. */
export function cloneMdStreamState(state: MdStreamState): MdStreamState {
  return { fence: state.fence, lang: state.lang };
}

/**
 * Classify one COMPLETE line (no line terminator) and advance fence state.
 */
export function tokenizeMarkdownLine(line: string, state: MdStreamState): SyntaxRun[] {
  const runs = classify(line, state);
  // Fence open/close is the only stateful transition, decided after
  // classification so the closing line itself renders as "fence".
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
const QUOTE_RE = /^( {0,3}>+\s?)(.*)$/;
// `1.` and `1)` ordered markers need a digit-run; plain `-`/`*`/`+` need the
// following space, so `**bold**` at line start never reads as a bullet.
const BULLET_RE = /^( *)([-*+]|\d{1,9}[.)])( +)(.*)$/;

// Fence info languages beyond the registry's own names: the aliases models
// actually type. Unknown info strings resolve to null (plain code).
const LANG_ALIASES: Record<string, string> = {
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
};

function resolveLang(info: string): string | null {
  const word = info.trim().split(/\s+/)[0]?.toLowerCase();
  if (!word) return null;
  const name = LANG_ALIASES[word] ?? word;
  return getTokenizer(name) ? name : null;
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
