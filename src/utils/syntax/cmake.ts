import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * CMake tokenizer.
 *
 * One pass over code, shaped like the dockerfile.ts line family (it is
 * the closest relative: command-ish words, `$` references, no expression
 * grammar): a word directly before `(` is a "fn" (the c.ts call peek,
 * whitespace-tolerant -- real CMake forbids the gap, but the files
 * written at 2am do not and the display loses nothing), and the
 * block/flow vocabulary is "keyword" CASE-INSENSITIVELY, because command
 * names are case-insensitive in this language: if/elseif/else/endif,
 * foreach/endforeach, while/endwhile, function/endfunction,
 * macro/endmacro, block/endblock, return/break/continue, plus the if
 * operators and/or/not. The rest of the if-operator zoo (STREQUAL,
 * VERSION_LESS, MATCHES, DEFINED...) is deliberately NOT listed: it is
 * argument-position sugar a plain word can equally be, so it rides
 * default (the documented rejection, the groovy doctrine).
 * Case-insensitively, true/false/on/off/yes/no ride "boolean" (the
 * option() spellings are as boolean as the true/false ones; a variable
 * that happens to spell ON reads boolean too, the dockerfile's cheerful
 * false positive, pinned) and NOTFOUND rides "null". "number" is the
 * closed integer set: decimal or 0x hex, and NOTHING else -- `3.10` and
 * `3.10.2` are version arguments, not numbers, and `1e5` and `1_000` are
 * not cmake numbers at all (all ride default; `0xZZ` rides default whole,
 * there is no split scan here). There is NO operator class beyond the
 * structural characters `()[]{}` and `;`: CMake has no arithmetic
 * operators, so `-Wall`, `+`, `::` and the path separators are
 * argument-bytes, and a colon inside a word keeps `foo::bar` one run
 * (the identifier charset here is letters, digits, `_`, `.`, `+`, `-`,
 * `:` and the high unicode -- the unquoted-argument alphabet plus the
 * letters the lexer actually tolerates). `$` arms references the
 * dockerfile way (`variable`, the css custom-property reading): `${VAR}`
 * to the closing brace or the line end, `$ENV{...}` and `$CACHE{...}`,
 * and the nested generator expression `$<...>` to its matching `>`
 * (depth-counted, unclosed runs to the line end -- genexes are the most
 * CMake thing there is, and one run over `$<$<CONFIG:Debug>:DBG>` is the
 * candy). A `$` that opens none of these is plain: a bare `$FOO` is NOT
 * a reference in this language (the pin that separates the house from
 * dockerfile.ts). "string" is the double-quoted form with escapes
 * honored (unterminated stops at the newline, a backslash before it
 * splices past, the c.ts endOfString) and `${...}` holes riding inside
 * the run (the rust/dart ruling -- the holes are not parsed); and the
 * bracket argument `[=[...]=]` (any number of `=` marks, the closer the
 * matching `]...]=]`) is one raw string across any number of lines with
 * NO escape processing, no variable expansion, no quote or `#` inside
 * able to cut it short (unclosed runs to end of input). `#` opens a
 * "comment" to EOL -- and `#[[` / `#[=[` open the bracket comment form,
 * raw like the bracket argument. Single quotes are NOT strings here (a
 * lone quote rides default -- the honest split from the c/js families);
 * `ENV{...}` inside `if(DEFINED)` is a bare word, not a reference. There
 * is NO type reading at all: the Capitalized heuristic would misfire in
 * a language whose variables are conventionally SCREAMING_CASE and whose
 * targets are lowercase, so no name is a "type" (documented, pinned).
 * Honest line-wise cost: the file view tokenizes per line, so a bracket
 * argument or bracket comment opened on one line swallows the rest of
 * THAT line and the tail re-reads as fresh junk on the next (lossless
 * either way, the c.ts block-comment story). Nothing is ever dropped or
 * reordered: concatenating every run reproduces the input exactly, for
 * any input. One run per token; adjacent runs may share a type (sinks
 * coalesce as they like). This is display candy, not a CMake parser.
 */
export function tokenizeCmake(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;

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
      if (bracketOpenAt(text, i + 1) !== -1) {
        const end = endOfBracket(text, i + 1);
        push("comment", text.slice(i, end));
        i = end;
        continue;
      }
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("comment", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "[" && bracketOpenAt(text, i) !== -1) {
      const end = endOfBracket(text, i);
      push("string", text.slice(i, end));
      i = end;
      continue;
    }
    if (c === '"') {
      const end = endOfString(text, i);
      push("string", text.slice(i, end));
      i = end;
      continue;
    }
    if (c === "$") {
      const end = endOfVariable(text, i);
      push(end > i + 1 ? "variable" : "default", text.slice(i, end));
      i = end;
      continue;
    }
    if (WORD_RE.test(c)) {
      let j = i;
      while (j < n && WORD_RE.test(text[j]!)) j++;
      const word = text.slice(i, j);
      push(classify(word, j), word);
      i = j;
      continue;
    }
    if (OPERATOR_RE.test(c)) {
      push("operator", c);
      i++;
      continue;
    }
    push("default", c);
    i++;
  }
  return runs;

  /** Keywords (case-insensitive) -> booleans -> NOTFOUND -> numbers ->
   * fn (word before `(`, whitespace tolerated) -> default. No type
   * reading exists in this language (see the header). */
  function classify(word: string, after: number): string {
    const lower = word.toLowerCase();
    if (KEYWORDS.has(lower)) return "keyword";
    if (BOOLEANS.has(lower)) return "boolean";
    if (lower === "notfound") return "null";
    if (NUM_OK_RE.test(word)) return "number";
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

/** The `=`-marked bracket opener at `from` (`[[`, `[=[`, `[==[`): the
 * index of the inner `[`, or -1 when this `[` is just a bracket. */
function bracketOpenAt(text: string, from: number): number {
  if (text[from] !== "[") return -1;
  let j = from + 1;
  while (text[j] === "=") j++;
  return text[j] === "[" ? j : -1;
}

/** Bracket argument / bracket comment from its outer `[` (the caller has
 * verified the opener): runs to the matching `]` + same marks + `]` or
 * end of input. Raw: escapes, quotes, `#` and `${}` inside are bytes. */
function endOfBracket(text: string, from: number): number {
  let j = from + 1;
  let marks = 0;
  while (text[j] === "=") {
    marks++;
    j++;
  }
  const closer = "]" + "=".repeat(marks) + "]";
  const end = text.indexOf(closer, j + 1);
  return end === -1 ? text.length : end + closer.length;
}

/** `$` references (the dockerfile arm, narrowed to what CMake expands):
 * `${VAR}`, `$ENV{VAR}`, `$CACHE{VAR}` to the closing brace or the line
 * end, and the generator expression `$<...>` to its matching `>` (nested
 * `<>` counted), also line-bounded when unclosed. Returns from + 1 when
 * the `$` opens none of them (a bare `$FOO` is plain text HERE). */
function endOfVariable(text: string, from: number): number {
  const n = text.length;
  let k = from + 1;
  if (text.startsWith("ENV", k)) k += 3;
  else if (text.startsWith("CACHE", k)) k += 5;
  if (text[k] === "<") {
    let j = k + 1;
    let depth = 1;
    while (j < n && text[j] !== "\n" && text[j] !== "\r") {
      if (text[j] === "<") depth++;
      else if (text[j] === ">") {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return j;
  }
  if (text[k] !== "{") return from + 1;
  let j = k + 1;
  while (j < n && text[j] !== "}" && text[j] !== "\n" && text[j] !== "\r") j++;
  return text[j] === "}" ? j + 1 : j;
}

/** Quoted argument: escapes honored (a backslash before the newline
 * splices past it), unterminated stops before the newline, `${...}`
 * holes ride the run (the c.ts endOfString verbatim). */
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

/** The word alphabet: the unquoted-argument characters plus the colon
 * (so `foo::bar` is one run) and the high unicode range the house
 * identifier carries. `/` is NOT in here (paths fragment into words and
 * bytes -- all default either way, invisible in the render). */
const WORD_RE = /[A-Za-z0-9._+:\u00a0-\uffff-]/;

/** Structural punctuation only -- CMake has no operator language, so
 * `-`, `+`, `:`, `,` etc. are argument bytes riding default. */
const OPERATOR_RE = /[(){}\[\];]/;

/** The closed number set: decimal or 0x hex integers. No floats (a
 * dotted word is a version), no separators, no exponents, no suffixes;
 * an ill-formed hex like `0x1g` rides default whole. */
const NUM_OK_RE = /^(?:0[xX][0-9a-fA-F]+|\d+)$/;

/** The block/flow vocabulary (lowercase; matched case-insensitively, as
 * command names are). The if-operator zoo (STREQUAL, VERSION_LESS,
 * MATCHES, DEFINED, EXISTS...) is deliberately absent; so are the plain
 * commands (set, message, add_executable...), which take the call peek
 * as fn like any user-defined command. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "and",
  "block",
  "break",
  "continue",
  "elseif",
  "else",
  "endblock",
  "endforeach",
  "endfunction",
  "endif",
  "endmacro",
  "endwhile",
  "foreach",
  "function",
  "if",
  "macro",
  "not",
  "or",
  "return",
  "while",
]);

/** Truth values, matched case-insensitively like everything else here
 * (the option() spellings on/off/yes/no are as boolean as true/false).
 * IGNORE is a plain word; NOTFOUND is handled as null at the call site. */
const BOOLEANS: ReadonlySet<string> = new Set(["false", "no", "off", "on", "true", "yes"]);

/** The registry entry for this lang (assembly list: index.ts). The
 * basename claim is the Dockerfile shape: `CMakeLists.txt` (and the
 * variant spelling `CMakeLists.txt.in`, which the prefix rule catches).
 * `.cmake` is the only extension; CMakeCache.txt is NOT claimed (it is
 * generated, ini-shaped, and honestly nobody's reading it for fun). No
 * aliases: the canonical name is the fence word. */
export const CMAKE_SYNTAX: SyntaxDef = {
  lang: "cmake",
  tokenize: tokenizeCmake,
  extensions: ["cmake"],
  basenames: ["CMakeLists.txt"],
};
