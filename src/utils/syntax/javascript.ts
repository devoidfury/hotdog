import type { SyntaxRun } from "./index.ts";

/**
 * JavaScript tokenizer (also the shared scanning core: typescript.ts layers
 * its keyword set and type-position pass over `tokenizeWith`).
 *
 * One pass over code: "comment" for `//` (to EOL) and the block form (to
 * the closer or end of input); "string" for `'…'`/`"…"` (escapes honored,
 * an unterminated string stops at the newline like CSS); "template" for
 * `` `…` `` including its `${…}` interpolations (one run; nested braces and
 * strings tracked so an interpolation's `}` is never mistaken for the
 * closer; an unterminated template runs to end of input, so a multi-line
 * template paints its opening line and every line after the closer as code
 * -- the honest line-wise degradation, same family as yaml's unterminated
 * scalars); "number" for decimal/hex/binary/octal, exponent, `_`
 * separators and the BigInt suffix (a lookalike like `1.2.3` rides
 * "default"); "boolean" (true/false), "null" (null/undefined); "keyword"
 * for the reserved plus contextual words (async, get, of, ...); "fn" for a
 * `function`-name or any name directly before `(` (a call reads as a
 * name); "key" for an object key (an identifier with a colon glued right
 * after it, so a spaced ternary `a ? b : c` stays clean; `default:`/`case:`
 * keep the keyword class); "decorator" for `@name`; "regexp" for a regex literal plus flags;
 * "operator" for the punctuation (`=>` as one run); everything else
 * "default". JSX/TSX tag regions deliberately degrade: `<`/`</` read as
 * operator, attribute names ride "default" and quoted values are strings
 * (no JSX parser exists, and a tag name tinted like a plain word
 * is the honest ceiling here). The regex-vs-division call uses the
 * previous significant token (comments and whitespace skipped): `/` opens
 * a regex unless that token ends a value (a plain identifier, a literal,
 * `)`/`]`/`}`), and a candidate with no closing `/` on its line falls back
 * to division; `if (x) /re/.test(y)` therefore reads as division --
 * documented limit, not worth a state machine. Auto-inserted semicolons
 * are not modeled. Nothing is ever dropped or reordered: concatenating
 * every run reproduces the input exactly, for any input. One run per
 * token; adjacent runs may share a type (sinks coalesce as they like).
 * This is display candy, not a JS parser.
 */
export function tokenizeJavaScript(text: string): SyntaxRun[] {
  return tokenizeWith(text, { keywords: JS_KEYWORDS, contextual: JS_CONTEXTUAL });
}

/** What an identifier classifier knows at its position: the source, the
 * index just past the word, and the previous significant token (comments
 * and whitespace already skipped). */
export interface IdentCtx {
  text: string;
  after: number;
  prevType: string | undefined;
  prevText: string;
  /** The previous token was `.` or `?.` -- the word is a property. */
  dot: boolean;
  /** The previous token was the `function` keyword. */
  prevFunction: boolean;
}

/** Optional identifier pass layered on top of the base ladder (literals ->
 * keywords -> hook -> key -> fn). Returning undefined leaves the word
 * "default". The typescript tokenizer adds its keyword set and a type-
 * position hook through this seam. */
export type IdentifyHook = (word: string, ctx: IdentCtx) => string | undefined;

export interface JsScannerConfig {
  /** Reserved words: always "keyword". */
  keywords: ReadonlySet<string>;
  /** Contextual words (let-style): keyword everywhere EXCEPT directly
   * before a colon, where an object key wins (`{ type: x }`). */
  contextual?: ReadonlySet<string>;
  identify?: IdentifyHook;
}

export function tokenizeWith(text: string, cfg: JsScannerConfig): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.` or `?.`
  let prevFunction = false; // the previous token was the `function` keyword
  let prevType: string | undefined; // previous significant token's class
  let prevText = ""; // ...and its text
  let prevTag = false; // the previous token was a degraded JSX `<`/`</` opener

  while (i < n) {
    const c = text[i]!;
    if (isWs(c)) {
      let j = i;
      while (j < n && isWs(text[j])) j++;
      push("default", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/") {
      if (text[i + 1] === "/") {
        let j = i + 2;
        while (j < n && text[j] !== "\n") j++;
        push("comment", text.slice(i, j));
        i = j;
        continue;
      }
      if (text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        const j = end === -1 ? n : end + 2;
        push("comment", text.slice(i, j));
        i = j;
        continue;
      }
      const end = !prevTag && regexAllowed(prevType, prevText) ? scanRegex(text, i) : -1;
      if (end !== -1) {
        push("regexp", text.slice(i, end));
        i = end;
        setPrev("regexp", "/");
        continue;
      }
      push("operator", "/");
      i++;
      setPrev("operator", "/");
      continue;
    }
    // JSX/TSX opening tag, degraded: the bracket reads as operator and the
    // markup after it rides plain identifier/string classes (no JSX parser).
    if (c === "<" && (IDENT_START_RE.test(text[i + 1] ?? "") || text[i + 1] === "/")) {
      const closing = text[i + 1] === "/";
      push("operator", closing ? "</" : "<");
      i += closing ? 2 : 1;
      setPrev("operator", "<");
      prevTag = true; // a `/` right after `</` is markup, never division
      continue;
    }
    if (c === '"' || c === "'") {
      const end = endOfString(text, i);
      push("string", text.slice(i, end));
      i = end;
      setPrev("string", '"');
      continue;
    }
    if (c === "`") {
      const end = scanTemplate(text, i);
      push("template", text.slice(i, end));
      i = end;
      setPrev("template", "`");
      continue;
    }
    if (c === "@" && i + 1 < n && IDENT_START_RE.test(text[i + 1]!)) {
      let j = i + 1;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      push("decorator", text.slice(i, j));
      i = j;
      setPrev("decorator", "@");
      continue;
    }
    if (IDENT_START_RE.test(c)) {
      let j = i;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      const word = text.slice(i, j);
      const type = classifyIdent(word, { text, after: j, prevType, prevText, dot, prevFunction }, cfg);
      push(type, word);
      i = j;
      setPrev(type, word);
      continue;
    }
    if (isNumberStart(c, text[i + 1])) {
      const end = scanNumber(text, i);
      const word = text.slice(i, end);
      // `.5` after a number (`1.2.3`) is a lookalike, not a literal: the
      // json.ts distrust rule, applied to the trailing fragment.
      const lookalike = c === "." && prevType === "number";
      const type = !lookalike && NUM_OK_RE.test(word) ? "number" : "default";
      push(type, word);
      i = end;
      setPrev(type, "0");
      continue;
    }
    if (c === "=" && text[i + 1] === ">") {
      push("operator", "=>");
      i += 2;
      setPrev("operator", "=>");
      continue;
    }
    if (OPERATOR_RE.test(c)) {
      const doubled = (c === "+" || c === "-") && prevType === "operator" && prevText === c;
      push("operator", c);
      const wasDot = c === ".";
      i++;
      setPrev("operator", doubled ? c + c : c); // ++/-- read as value-ending
      dot = wasDot || (c === "?" && text[i] === ".");
      continue;
    }
    push("default", c);
    i++;
    setPrev("default", c);
  }
  return runs;

  function setPrev(type: string, word: string): void {
    prevType = type;
    prevText = word;
    prevTag = false;
    dot = false;
    prevFunction = word === "function";
  }
}

/** The identifier ladder: literals -> key (colon glued right after the
 * word, json.ts's peek tightened so a ternary `a ? b : c` stays clean) ->
 * reserved keywords -> config hook (typescript's type pass) -> contextual
 * keywords -> fn (function-name or name before `(`). After a dot, every
 * class but the literals is refused (`.default`, `.type` are properties,
 * not the words). */
function classifyIdent(word: string, ctx: IdentCtx, cfg: JsScannerConfig): string {
  if (word === "true" || word === "false") return "boolean";
  if (word === "null" || word === "undefined") return "null";
  if (!ctx.dot) {
    if (ctx.text[ctx.after] === ":" && !KEY_EXCEPTIONS.has(word)) return "key";
    if (cfg.keywords.has(word)) return "keyword";
    const hooked = cfg.identify?.(word, ctx);
    if (hooked) return hooked;
    if (cfg.contextual?.has(word)) return "keyword";
  }
  const next = skipWs(ctx.text, ctx.after);
  if (ctx.prevFunction || ctx.text[next] === "(") return "fn";
  return "default";
}

/** Reserved words that legitimately sit before a colon (`default:` in a
 * switch) and must keep the keyword class. */
const KEY_EXCEPTIONS = new Set(["default", "case"]);

/** `/` opens a regex unless the previous significant token ends a value:
 * literals, plain identifiers, and the value-closing punctuation `)`/`]`/
 * `}`. After `=`, `,`, `(`, `return` etc. a `/` opens a regex. */
function regexAllowed(prevType: string | undefined, prevText: string): boolean {
  if (prevType === undefined) return true;
  if (prevType === "operator") return !VALUE_CLOSERS.has(prevText);
  if (prevType === "keyword") return REGEX_PREFIX.has(prevText);
  return !VALUE_ENDING_TYPES.has(prevType);
}

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

const skipWs = (text: string, from: number): number => {
  let j = from;
  while (j < text.length && isWs(text[j])) j++;
  return j;
};

/** Token classes that end an expression, making `/` division. */
const VALUE_ENDING_TYPES = new Set([
  "number",
  "string",
  "template",
  "regexp",
  "boolean",
  "null",
  "default",
  "fn",
  "key",
  "type",
]);

/** Operator tokens that end an expression (`x) / 2` is division). */
const VALUE_CLOSERS = new Set([")", "]", "}", "++", "--"]);

/** Words after which `/` still opens a regex: `return /x/`, `case /a/:`. */
const REGEX_PREFIX = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "void",
  "delete",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const IDENT_START_RE = /[A-Za-z_$\u00a0-\uffff]/;
const IDENT_RE = /[\w$\u00a0-\uffff]/;
const OPERATOR_RE = /[{}()[\];,.:?+\-*/%&|^!~=<>]/;
const NUM_OK_RE = /^(?:0[xX][0-9a-fA-F][0-9a-fA-F_]*n?|0[bB][01][01_]*n?|0[oO][0-7][0-7_]*n?|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)$/;

/** End index just past the string opened at `from` (quotes included). An
 * unterminated string stops before an unescaped newline, like CSS. */
function endOfString(text: string, from: number): number {
  const quote = text[from]!;
  let j = from + 1;
  while (j < text.length) {
    const d = text[j]!;
    if (d === "\\") {
      j += 2;
      continue;
    }
    if (d === "\n" || d === "\r") return j;
    if (d === quote) return j + 1;
    j++;
  }
  return text.length;
}

/** End index just past the template opened at `from`, walking `${…}`
 * interpolations (nested braces and strings tracked). Unterminated means
 * end of input. */
function scanTemplate(text: string, from: number): number {
  const n = text.length;
  let i = from + 1;
  while (i < n) {
    const d = text[i]!;
    if (d === "\\") {
      i += 2;
      continue;
    }
    if (d === "`") return i + 1;
    if (d === "$" && text[i + 1] === "{") {
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        const e = text[j]!;
        if (e === "\\") {
          j++;
          continue;
        }
        if (e === '"' || e === "'") {
          j = endOfString(text, j) - 1;
          continue;
        }
        if (e === "{") depth++;
        else if (e === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (j >= n) return n; // unclosed interpolation: the rest rides the template
      i = j + 1;
      continue;
    }
    i++;
  }
  return n;
}

/** End index just past a regex literal opened at `from` (flags included),
 * or -1 when it is not one (empty body, or no closing `/` before the line
 * end -- then the `/` is division and degrades one character at a time). */
function scanRegex(text: string, from: number): number {
  const n = text.length;
  let i = from + 1;
  let inClass = false;
  while (i < n) {
    const d = text[i]!;
    if (d === "\\") {
      i += 2;
      continue;
    }
    if (d === "\n" || d === "\r") return -1;
    if (inClass) {
      if (d === "]") inClass = false;
      i++;
      continue;
    }
    if (d === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (d === "/") {
      if (i === from + 1) return -1; // empty body: `/ /` reads as division
      let j = i + 1;
      while (j < n && /[a-z]/.test(text[j]!)) j++;
      return j;
    }
    i++;
  }
  return -1;
}

const isNumberStart = (c: string, next: string | undefined): boolean =>
  /[0-9]/.test(c) || (c === "." && next !== undefined && /[0-9]/.test(next));

/** End index just past a numeric literal (radix, separators, exponent,
 * BigInt suffix). Shape validation happens against NUM_OK_RE at the call
 * site, so `1.2.3` or `1_a` degrade to default. */
function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === "0" && /[xXbBoO]/.test(text[i + 1] ?? "")) {
    i += 2;
    while (i < n && /[0-9a-fA-F_]/.test(text[i]!)) i++;
    if (text[i] === "n") i++;
    return i;
  }
  while (i < n && /[0-9_]/.test(text[i]!)) i++;
  if (text[i] === "." && /[0-9]/.test(text[i + 1] ?? "")) {
    i++;
    while (i < n && /[0-9_]/.test(text[i]!)) i++;
  }
  if (text[i] === "e" || text[i] === "E") {
    let j = i + 1;
    if (text[j] === "+" || text[j] === "-") j++;
    if (/[0-9]/.test(text[j] ?? "")) {
      i = j;
      while (i < n && /[0-9_]/.test(text[i]!)) i++;
    }
  }
  if (text[i] === "n") i++;
  return i;
}

/** Reserved words: always "keyword". Contextual words (let, async, get,
 * of, as, ...) live in JS_CONTEXTUAL so object keys like `{ from: x }`
 * keep the key class. */
export const JS_KEYWORDS: ReadonlySet<string> = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** Contextual words: keyword, except directly before a glued colon where
 * the object key wins (`{ from: "y", as: t }`). */
export const JS_CONTEXTUAL: ReadonlySet<string> = new Set([
  "let",
  "async",
  "await",
  "get",
  "set",
  "of",
  "as",
  "from",
  "constructor",
]);
