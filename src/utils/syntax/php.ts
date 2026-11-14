import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * PHP tokenizer.
 *
 * One pass over code (the c.ts/rust.ts family): `<?php`, `<?=` and `?>`
 * are one "preproc" run each (the loud tag delimiters), and the honest
 * ceiling is that the WHOLE file gets the PHP wash -- the per-line
 * statelessness of the file view forbids tracking in/out-of-tag state, so
 * an inline-HTML template reads as PHP throughout (bare `<?` short tags
 * and ASP `<%` are not tags here, they ride plain punctuation; no
 * declare/directory nonsense). `//` and `#` open a "comment" to EOL --
 * PHP has two line-comment spellings -- and the block form runs to its
 * closer or end of input, NEVER nested (unlike rust, the language is not);
 * `#[` glued to a name is the PHP 8 attribute and rides "decorator"
 * through the bracket-balanced closer (the rust endOfAttribute shape:
 * strings and comments inside skipped so their brackets cannot cut the
 * run short, no closer anywhere runs to end of input; a `#` that is not an
 * attribute opener is the line comment). "string" covers both quote forms
 * with escapes honored -- a backslash before an unescaped newline splices
 * the line and the scan carries on (the c.ts endOfString), and
 * interpolation (`"a$b"`, `"{$x}"`) stays inside the string run, the rust
 * format-string ruling; heredoc/nowdoc `<<<IDENT` and `<<<'EOT'` run to
 * the line whose first non-space token is the closer (matching the opener
 * spelling case-sensitively, with the PHP 7.3 indented-closer tolerance,
 * semicolon included) -- when the whole document is in the input, which
 * is what the tool-block pass hands the tokenizer; a never-closed opener
 * runs to end of input, and per-line file-view calls degrade predictably
 * (each line scans alone; document the ceiling, do not add state);
 * `$name` (including `$this`, one reading with no keyword special-case) is
 * "variable"; "keyword" for the reserved words CASE-INSENSITIVELY (PHP
 * keywords are case-insensitive -- `FUNCTION` reads as a keyword), with
 * `true`/`false` riding "boolean" and `null` riding "null", also
 * case-insensitively (the json/graphql class pair); "type" for the
 * lowercase primitives (int, float, string, bool, void, mixed, never,
 * iterable, callable, object, array -- `array` IS a primitive here, the
 * plan's ruling; the set does the work, not Capitalization), the name
 * directly after class/interface/trait/enum/extends/implements, and
 * Capitalized names (`Widget` reads as a class, `MAX_SIZE` stays a plain
 * word -- the c.ts heuristic); "fn" for any name directly before `(` and
 * the name directly after `function` (the call peek survives the dot, like
 * c.ts; reserved constructs like `isset(` never reach the peek, the
 * keyword reading wins first); "number" for decimal/hex/octal (the `0o`
 * spelling and the legacy
 * `0NNN`)/binary with PHP 7.4 `_` separators and floats with exponent --
 * shape validation sends the half-literals (`0x`, a trailing `_`, legacy
 * octal with a stray 8 or 9) back to default, and the c.ts lookalike rule
 * keeps `1.2.3` out of the literal business; `?->`, `->`, `=>`, `::`,
 * `<=>`, `===`, `!==`, `??`, `?:`, `==`, `!=`, `<=`, `>=`, `&&`, `||` and
 * `...` are one "operator" run each -- `..` is NOT a PHP operator (no
 * range op: two adjacent dots never form one run, and the second dot
 * joins a following digit as the float it spells), and the
 * rest of the punctuation is single-char "operator"; after `.`, `->` or
 * `::` the keyword/type/boolean readings are refused (a member name rides
 * default or the call peek). Honest limits: `?:` assumes a colon follows
 * the `?` (the elvis, not a stray ternary question glued to something
 * else), `match` never gets the call reading (it is reserved), backtick
 * shell-exec strings ride plain punctuation with their contents scanned as
 * code, and `T_RUE`-style all-caps constants are plain words. Nothing is ever
 * dropped or reordered: concatenating every run reproduces the input
 * exactly, for any input. One run per token; adjacent runs may share a
 * type (sinks coalesce as they like). This is display candy, not a PHP
 * parser.
 */
export function tokenizePhp(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.`, `->` or `::`
  let prevDecl = false; // the previous token was class/interface/trait/enum/extends/implements
  let prevFn = false; // the previous token was the `function` keyword
  let prevType: string | undefined;

  while (i < n) {
    const c = text[i]!;
    if (isWs(c)) {
      let j = i;
      while (j < n && isWs(text[j])) j++;
      push("default", text.slice(i, j));
      i = j;
      prevType = undefined; // a gap breaks the `1.2.3` lookalike chain
      continue;
    }
    const tag = openTagLen(text, i);
    if (tag !== 0) {
      push("preproc", text.slice(i, i + tag));
      i += tag;
      setPrev("preproc");
      continue;
    }
    if (c === "?" && text[i + 1] === ">") {
      push("preproc", "?>");
      i += 2;
      setPrev("preproc");
      continue;
    }
    if (c === "#" && text[i + 1] === "[" && (IDENT_START_RE.test(text[i + 2] ?? "") || text[i + 2] === "\\")) {
      const end = endOfAttribute(text, i);
      push("decorator", text.slice(i, end));
      i = end;
      setPrev("decorator");
      continue;
    }
    if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("comment", text.slice(i, j));
      i = j;
      setPrev("comment");
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      push("comment", text.slice(i, j));
      i = j;
      setPrev("comment");
      continue;
    }
    if (c === '"' || c === "'") {
      const end = endOfString(text, i);
      push("string", text.slice(i, end));
      i = end;
      setPrev("string");
      continue;
    }
    if (text.startsWith("<<<", i)) {
      const end = endOfHeredoc(text, i);
      if (end !== -1) {
        push("string", text.slice(i, end));
        i = end;
        setPrev("string");
        continue;
      }
      // `<<<` with no label to close on (or the `<< <` comparison
      // sandwich): the operator arm below eats it one char at a time.
    }
    if (c === "$" && IDENT_START_RE.test(text[i + 1] ?? "")) {
      let j = i + 1;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      push("variable", text.slice(i, j));
      i = j;
      setPrev("variable");
      continue;
    }
    if (IDENT_START_RE.test(c)) {
      let j = i;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      const word = text.slice(i, j);
      const type = classifyIdent(word, j);
      push(type, word);
      i = j;
      setPrev(type, word);
      continue;
    }
    if (isNumberStart(c, text[i + 1])) {
      const end = scanNumber(text, i);
      const word = text.slice(i, end);
      // `.5` right after a number (`1.2.3`) is a version lookalike, not a
      // literal (the c.ts rule).
      const lookalike = c === "." && prevType === "number";
      const type = !lookalike && NUM_OK_RE.test(word) ? "number" : "default";
      push(type, word);
      i = end;
      setPrev(type);
      continue;
    }
    if (c === "-" && text[i + 1] === ">") {
      push("operator", "->");
      i += 2;
      setPrev("operator");
      dot = true; // a member access: `$o->next` is not the word `next` of any class
      continue;
    }
    const three = text.slice(i, i + 3);
    if (three === "?->" || three === "<=>" || three === "===" || three === "!==" || three === "...") {
      push("operator", three);
      i += 3;
      setPrev("operator");
      dot = false; // spread and spaceship are not member gestures
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("operator", two);
      i += 2;
      setPrev("operator");
      dot = two === "::"; // a static member access is a member position too
      continue;
    }
    if (OPERATOR_RE.test(c)) {
      push("operator", c);
      i++;
      setPrev("operator");
      dot = c === ".";
      continue;
    }
    push("default", c);
    i++;
    setPrev("default");
  }
  return runs;

  function setPrev(type: string, word?: string): void {
    prevType = type;
    if (type !== "operator") dot = false;
    prevDecl = word !== undefined && DECL_KW.has(word.toLowerCase());
    prevFn = word !== undefined && word.toLowerCase() === "function";
  }

  /** Booleans/null (case-insensitive) -> primitives -> keywords (case-
   * insensitive) -> the name after class/interface/... -> the name after
   * `function` -> fn (name before `(`, refused for the reserved
   * constructs) -> Capitalized type. After a dot, every reading but the
   * call peek is refused. */
  function classifyIdent(word: string, after: number): string {
    const lower = word.toLowerCase();
    if (!dot) {
      if (lower === "true" || lower === "false") return "boolean";
      if (lower === "null") return "null";
      if (PRIMITIVES.has(lower)) return "type";
      if (KEYWORDS.has(lower)) return "keyword";
      if (prevDecl) return "type";
      if (prevFn) return "fn";
    }
    if (text[skipWs(text, after)] === "(") return "fn";
    if (!dot && CAPITALIZED_RE.test(word)) return "type";
    return "default";
  }
}

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

const skipWs = (text: string, from: number): number => {
  let j = from;
  while (j < text.length && isWs(text[j])) j++;
  return j;
};

/** `<?php` / `<?=` (word-boundary checked so `<?phpx` is not a tag); 0
 * means no tag at `from`, -1 would do too but 0 keeps the call site a
 * plain truthiness test. The full `<?` short tag is NOT here: it is
 * dead-deprecated and guessing it would misread XML headers. */
function openTagLen(text: string, from: number): number {
  if (text[from] !== "<" || text[from + 1] !== "?") return 0;
  if (text[from + 2] === "=") return 3;
  if (/^php(?![\w])/i.test(text.slice(from + 2, from + 6))) return 5;
  return 0;
}

/** `class`/`interface`/`trait`/`enum`/`extends`/`implements` (lowercased at
 * the call site): the name right after one is a "type". */
const DECL_KW = new Set(["class", "interface", "trait", "enum", "extends", "implements"]);

/** Strings: escapes honored (a backslash before an unescaped newline
 * splices the line and the scan carries on to the closer or end of input,
 * the c.ts/js family); an unterminated literal stops at the newline.
 * Interpolation (`$var`, `{$expr}`) inside double quotes rides the string
 * run -- the rust format-string ruling. */
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

/** Heredoc/nowdoc from `<<<`: an optional label (quoted or bare), then the
 * line whose first non-space token is the same label (case-sensitive, as
 * the language is); the closer's trailing semicolon joins the run, the
 * PHP 7.3 indented-closer tolerance included. Returns the end index, or -1
 * when there is no label at all (`<<<` without a name is not a heredoc --
 * the caller lets the operator arm eat the characters); a never-closed
 * opener runs to end of input. */
function endOfHeredoc(text: string, from: number): number {
  let j = from + 3;
  while (j < text.length && isWs(text[j]) && text[j] !== "\n" && text[j] !== "\r") j++;
  let quote: string | undefined;
  if (text[j] === "'" || text[j] === '"') {
    quote = text[j];
    j++;
  }
  const idStart = j;
  while (j < text.length && IDENT_RE.test(text[j]!)) j++;
  const label = text.slice(idStart, j);
  if (label === "") return -1;
  if (quote !== undefined) {
    if (text[j] !== quote) return -1; // unterminated label quote: not a readable heredoc
    j++;
  }
  let line = j;
  while (line < text.length) {
    const nl = text.indexOf("\n", line);
    const lineEnd = nl === -1 ? text.length : nl + 1;
    let k = line;
    while (k < lineEnd && (text[k] === " " || text[k] === "\t")) k++;
    if (text.startsWith(label, k) && !IDENT_RE.test(text[k + label.length] ?? "")) {
      let e = k + label.length;
      if (text[e] === ";") e++;
      return e; // the newline after the closer rides the next whitespace run
    }
    line = lineEnd;
  }
  return text.length;
}

/** `#[...]` through the bracket-balanced closer (the rust endOfAttribute):
 * strings and comments inside are skipped so their brackets cannot cut the
 * run short; no closer anywhere runs to the end of input. */
function endOfAttribute(text: string, from: number): number {
  let j = from + 1; // spend the `#`; the `[` joins via the depth count
  let depth = 0;
  while (j < text.length) {
    const d = text[j]!;
    if (d === "[") {
      depth++;
      j++;
    } else if (d === "]") {
      depth--;
      j++;
      if (depth === 0) return j;
    } else if (d === '"' || d === "'") {
      j = endOfString(text, j);
    } else if (d === "/" && text[j + 1] === "/") {
      while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++;
    } else if (d === "#") {
      while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++;
    } else if (d === "/" && text[j + 1] === "*") {
      const end = text.indexOf("*/", j + 2);
      j = end === -1 ? text.length : end + 2;
    } else j++;
  }
  return text.length;
}

const IDENT_START_RE = /[A-Za-z_\u0080-\uffff]/;
const IDENT_RE = /[\w\u0080-\uffff]/;
const OPERATOR_RE = /[{}()[\];,.:?+\-*/%&|^!~=<>]/;

/** Two-char operators. `..` is deliberately absent: PHP has no range
 * operator, and two adjacent dots scan as two single-dot operators. */
const TWO_CHAR_OPS = new Set(["=>", "::", "==", "!=", "<=", ">=", "&&", "||", "??", "?:"]);

/** Capitalized name (`Widget`, `Thing2`), NOT an all-caps constant
 * (`MAX_SIZE`) and not a mixed-case name (`GtkWidget`) -- the c.ts
 * typedef heuristic. */
const CAPITALIZED_RE = /^[A-Z][a-z0-9_]*$/;

/** The numeric dialect: radix forms with `_` separators, the `0o` octal
 * spelling and the legacy `0NNN`, decimals and floats with exponent. The
 * call site also applies the c.ts lookalike rule (`1.2.3`). Validation
 * sends `0x`, `1_`, a trailing `_`, and legacy octal with a stray 8 or 9
 * back to default. */
const NUM_OK_RE =
  /^(?:0[xX][0-9a-fA-F](?:[0-9a-fA-F_]*[0-9a-fA-F])?|0[bB][01](?:[01_]*[01])?|0[oO][0-7](?:[0-7_]*[0-7])?|0[0-7](?:[0-7_]*[0-7])?|(?:0|[1-9](?:\d|_\d)*)(?:\.\d(?:[\d_]*\d)?)?(?:[eE][+-]?\d(?:[\d_]*\d)?)?|\.\d(?:[\d_]*\d)?(?:[eE][+-]?\d(?:[\d_]*\d)?)?)$/;

const isNumberStart = (c: string, next: string | undefined): boolean =>
  /[0-9]/.test(c) || (c === "." && next !== undefined && /[0-9]/.test(next));

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === "0" && /[xXbBoO]/.test(text[i + 1] ?? "")) {
    i += 2;
    while (i < n && /[0-9a-fA-F_]/.test(text[i]!)) i++;
    return i;
  }
  while (i < n && /[0-9_]/.test(text[i]!)) i++;
  if (text[i] === "." && /[0-9_]/.test(text[i + 1] ?? "")) {
    // covers the leading-`.5` form too (the digit run lives after the dot)
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
  return i;
}

/** Primitive type names ride "type" (lowercase, so the set does the work,
 * not Capitalization). `array` is a primitive, not a keyword; `true`,
 * `false` and `null` are handled separately as boolean/null. */
const PRIMITIVES: ReadonlySet<string> = new Set([
  "int",
  "float",
  "string",
  "bool",
  "void",
  "mixed",
  "never",
  "iterable",
  "callable",
  "object",
  "array",
]);

/** Reserved words, matched lowercased (PHP keywords are case-
 * insensitive), minus true/false/null which ride boolean/null and the
 * primitives which ride type. `match` is reserved -- it never gets the
 * call reading. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "function",
  "class",
  "interface",
  "trait",
  "enum",
  "extends",
  "implements",
  "namespace",
  "use",
  "new",
  "clone",
  "return",
  "if",
  "else",
  "elseif",
  "for",
  "foreach",
  "as",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "try",
  "catch",
  "finally",
  "throw",
  "echo",
  "print",
  "global",
  "static",
  "public",
  "protected",
  "private",
  "abstract",
  "final",
  "readonly",
  "const",
  "var",
  "instanceof",
  "yield",
  "fn",
  "match",
  "require",
  "require_once",
  "include",
  "include_once",
  "die",
  "exit",
  "unset",
  "isset",
  "empty",
  "endswitch",
  "endfor",
  "endforeach",
  "endif",
]);

/** The registry entry for this lang (assembly list: index.ts). No
 * aliases: the canonical name is the fence word. */
export const PHP_SYNTAX: SyntaxDef = {
  lang: "php",
  tokenize: tokenizePhp,
  extensions: ["php"],
};
