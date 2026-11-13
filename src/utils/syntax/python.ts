import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Python tokenizer.
 *
 * One pass over code: "#" is "comment" to EOL; "string" covers every quote
 * form (both quote chars, the r/b/u/f prefixes glued to the opening quote,
 * and the triple-quoted forms which run to their closer or end of input
 * like JS templates -- the honest line-wise degradation, same family; an
 * unterminated single-line string stops at the newline. f-string
 * interpolation interiors ride the string run whole, no f-expression
 * parsing); "number" for integers, floats, hex/octal/binary, `_` separators,
 * exponents and the imaginary `j` suffix (a lookalike like `1.2.3` rides
 * "default"); "boolean" (True/False), "null" (None); "keyword" for the
 * reserved words (True/False/None take the literal classes instead; soft
 * keywords like match/case ride through -- `case:` reads as a key); "fn"
 * for a def/class name or any name directly before `(` (a call reads as a
 * name); "key" for an identifier with a colon glued right after it (dict
 * keys and annotations share the reading; keywords keep their class, so
 * `else:` stays keyword); "decorator" for `@name` (a bare `@` -- the matrix
 * operator -- rides default); "operator" for the punctuation; everything
 * else "default". Honest limits: line-continuation backslashes ride
 * default, the continuation line re-tokenizes on its own; no
 * indentation-based structure is modeled; `self`/`cls` are plain words.
 * Nothing is ever dropped or reordered: concatenating every run reproduces
 * the input exactly, for any input. One run per token; adjacent runs may
 * share a type (sinks coalesce as they like). This is display candy, not a
 * Python parser.
 */
export function tokenizePython(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.`
  let prevDecl = false; // the previous token was the def/class keyword
  let prevType: string | undefined;

  while (i < n) {
    const c = text[i]!;
    if (isWs(c)) {
      let j = i;
      while (j < n && isWs(text[j])) j++;
      push("default", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "#") {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
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
    if (c === "@" && i + 1 < n && IDENT_START_RE.test(text[i + 1]!)) {
      let j = i + 1;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      push("decorator", text.slice(i, j));
      i = j;
      setPrev("decorator");
      continue;
    }
    if (IDENT_START_RE.test(c)) {
      let j = i;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      // A string-prefix run glued to a quote (`f"..."`, `rb'...'`): the
      // prefix joins the string run.
      if ((text[j] === '"' || text[j] === "'") && STRING_PREFIXES.has(text.slice(i, j).toLowerCase())) {
        const end = endOfString(text, j);
        push("string", text.slice(i, end));
        i = end;
        setPrev("string");
        continue;
      }
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
      // `.5` right after a number (`1.2.3`) is a lookalike, not a literal.
      const lookalike = c === "." && prevType === "number";
      const type = !lookalike && NUM_OK_RE.test(word) ? "number" : "default";
      push(type, word);
      i = end;
      setPrev(type);
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
    prevDecl = word !== undefined && DECL_KW.has(word);
  }

  /** Literals -> def/class name -> keywords (before the key peek, so
   * `else:` stays keyword) -> key (colon glued right after) -> fn (name
   * before `(`). After a dot, keywords and keys are refused (`.type` is a
   * property). */
  function classifyIdent(word: string, after: number): string {
    if (word === "True" || word === "False") return "boolean";
    if (word === "None") return "null";
    if (prevDecl) return "fn";
    if (!dot) {
      if (KEYWORDS.has(word)) return "keyword";
      if (text[after] === ":") return "key";
    }
    if (text[skipWs(text, after)] === "(") return "fn";
    return "default";
  }
}

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

const skipWs = (text: string, from: number): number => {
  let j = from;
  while (j < text.length && isWs(text[j])) j++;
  return j;
};

/** `def`/`class`: the name right after either is an "fn". */
const DECL_KW = new Set(["def", "class"]);

/** String literals: escapes honored, triple forms run to their closer or
 * end of input, an unterminated single-line string stops before an
 * unescaped newline (the css/js family). Backslash escapes are skipped in
 * every form, raw prefixes included (the display-candy shortcut: an
 * apostrophe after a raw backslash may read one char long). */
function endOfString(text: string, from: number): number {
  const quote = text[from]!;
  const triple = text[from + 1] === quote && text[from + 2] === quote;
  const closer = triple ? quote.repeat(3) : quote;
  let j = from + (triple ? 3 : 1);
  while (j < text.length) {
    const d = text[j]!;
    if (d === "\\") {
      j += 2;
      continue;
    }
    if (!triple && (d === "\n" || d === "\r")) return j;
    if (text.startsWith(closer, j)) return j + closer.length;
    j++;
  }
  return text.length;
}

const isNumberStart = (c: string, next: string | undefined): boolean =>
  /[0-9]/.test(c) || (c === "." && next !== undefined && /[0-9]/.test(next));

/** End index just past a numeric literal (radix, separators, exponent,
 * imaginary suffix). Shape validation happens against NUM_OK_RE at the call
 * site, so `1.2.3` or `0x` degrade to default. */
function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === "0" && /[xXoObB]/.test(text[i + 1] ?? "")) {
    i += 2;
    while (i < n && /[0-9a-fA-F_]/.test(text[i]!)) i++;
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
  if (text[i] === "j") i++;
  return i;
}

const IDENT_START_RE = /[A-Za-z_\u00a0-\uffff]/;
const IDENT_RE = /[\w\u00a0-\uffff]/;
const OPERATOR_RE = /[{}()[\];,.:?+\-*/%&|^!~=<>]/;
const NUM_OK_RE =
  /^(?:0[xX][0-9a-fA-F][0-9a-fA-F_]*|0[oO][0-7][0-7_]*|0[bB][01][01_]*|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?j?)$/;

/** Prefix letters glued to an opening quote (r/b/u/f and the pairs, any
 * case -- checked lowercased at the call site). */
const STRING_PREFIXES = new Set(["r", "b", "u", "f", "rb", "br", "rf", "fr"]);

/** Reserved words (True/False/None are reserved too but take the literal
 * classes). Soft keywords (match, case, ...) stay out so `re.match(x)` and
 * friends read as calls. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

/** The registry entry for this lang (assembly list: index.ts). */
export const PYTHON_SYNTAX: SyntaxDef = {
  lang: "python",
  tokenize: tokenizePython,
  aliases: ["py"],
  extensions: ["py"],
};
