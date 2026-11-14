import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Nix tokenizer (the Nix expression language: `.nix`, flake.nix and
 * default.nix included).
 *
 * hcl.ts is the parent in shape (it grew the same scan family) but THIS
 * language has real reserved words -- the spec's ten: assert, else, if, in,
 * inherit, let, or, rec, then, with -- so "keyword" exists, and it has
 * `true`/`false` booleans (lowercase exactly; Nix has NO null literal --
 * `null` is a plain identifier and NO "null" class is emitted, the erlang
 * ruling). THE BATCH'S SIGNATURE DEGRADE for hcl and shell readers: `//`
 * is NOT a comment here, it is the attribute-set update OPERATOR (the
 * manual's operator table); comments are `#` lines and star-slash blocks
 * that NEVER nest (the spec says so outright: the first closer ends the
 * comment and the tail re-reads; no closer anywhere runs to end of
 * input). The
 * identifier is `[A-Za-z_][A-Za-z0-9_'-]*` (the spec's grammar): ASCII
 * only -- apostrophe AND hyphen ride words, so `my-var` is one word (like
 * hcl), `a'-b'` is one word, and high unicode is a plain byte (the pinned
 * divergence from the permissive hcl family; the Nix lexer speaks ASCII).
 * Strings are TWO forms. `"`-strings span multiple lines (a pinned cost
 * for readers of the c/hcl family: an unterminated quoted string runs to
 * the END OF INPUT, not the newline -- newlines are legal inside), escapes
 * ride the generic backslash skip, and `${...}` holes RIDE the run (the
 * rust ruling) with the documented hcl cost: a quote inside a hole closes
 * the literal. `''`-strings are the indented multiline form; the scan
 * follows the spec's escape polarity exactly: `''` closes UNLESS followed
 * by `'`, `$`, or `\` (so `''${` is a literal hole opener and `'''` a
 * literal quote, riding the run; `$` alone means nothing to the scan --
 * literal `$` needs no escaping), `''\` skips the escaped character, and
 * holes ride this form too. Paths are literals (class "string", the
 * decide-and-pin: they are value atoms, the sink already colors strings):
 * `/abs/x`, `./rel`, `../up`, `~/home` leads and the bare glued spelling
 * `builder.sh/out.bin` (an identifier-run followed immediately by a `/`
 * where the run reaches a slash) read as ONE string run -- division wants
 * air (`a / b`), so `x/y` really is a path in this language. Bare URIs are
 * strings too: a scheme-shaped word immediately followed by `:` plus a
 * URI character (`http://example.org/x.tar.bz2`) is ONE literal (the
 * grammar matches ANY `scheme:chars`, so `x:x` is a URI too -- pinned).
 * Lookup paths `<nixpkgs>` are NOT scanned (they collide with `<`):
 * operator, word, operator, pinned. Numbers are decimal integers and
 * floats INCLUDING the leading-dot spelling (`.27e13` is in the manual);
 * NO hex, NO octal distinction, NO underscore separators, NO suffixes:
 * `0x1f` is number `0` plus the word `x1f` and `1_0` is number `1` plus
 * the word `_0` (the hcl-pinned degradations). The key reading is the
 * same-line `=` glue (the hcl/json shape narrowed further: the sign must
 * not head `==`), so `foo = 1;` keys `foo` and the attribute path `a.b =
 * c;` keys only the last name (the dot is a wall); `;` terminates, not the
 * newline, but the GLUE is still same-line (pinned cost: a newline between
 * the name and `=` keeps the name a plain word). THE `:` DECISION: `:`
 * arms NOTHING (no key reading) -- it is the lambda arrow (`x: body` makes
 * `x` a plain word), which is the dominant `:`-shape in real files; the
 * hcl doctrine repeats. `...` (the pattern ellipsis) is the only
 * three-char operator and is checked before any two-char (the dart
 * lesson); two-char runs:
 * `==` `!=` `<=` `>=` `&&` `||` `->` `++` `//` and the experimental pair
 * `|>` `<|` (in the manual's table; included per spec, the pinned
 * cost-less call); singles: `= < > + - * / ? : . , ; !` and the brackets;
 * there is NO `%`, `&`, `|`, `~`, `@`, `$` or backtick operator -- they
 * ride default bytes (`$` has no top-level role outside strings, pinned
 * like hcl; `@`-patterns ride a byte). `fn` is the call peek ONLY (a word
 * before `(`, whitespace-tolerant, surviving the dot -- there is no def
 * keyword, so no prevFn arm; keywords and booleans are checked first, so
 * `with (import ...)` keeps `with` a keyword). There is NO type reading
 * and no dot-flag (the hcl family: casing means nothing in Nix).
 * `or` is a keyword unconditionally: the spec admits it leaks as a name
 * in some contexts, and `{ or = 1; }` reading `or` as a keyword is the
 * pinned false-positive cost. Nothing is ever dropped or reordered:
 * concatenating every run reproduces the input exactly, for any input.
 * One run per token; adjacent runs may share a type (sinks coalesce as
 * they like). This is display candy, not a Nix evaluator.
 */
export function tokenizeNix(text: string): SyntaxRun[] {
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
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("comment", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf(CLOSER, i + 2); // NEVER nested: the first closer ends it
      const j = end === -1 ? n : end + 2;
      push("comment", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "'" && text[i + 1] === "'") {
      const end = endOfIndented(text, i);
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
    if (c === "~" && text[i + 1] === "/") {
      const end = scanPath(text, i + 1);
      push("string", text.slice(i, end));
      i = end;
      continue;
    }
    if (c === "/") {
      if (text[i + 1] === "/") {
        push("operator", "//"); // the update operator, NOT a comment (the signature)
        i += 2;
        continue;
      }
      if (PATH_CHAR_RE.test(text[i + 1] ?? "")) {
        const end = scanPath(text, i);
        push("string", text.slice(i, end));
        i = end;
        continue;
      }
      // `/` with air or a non-path follower: the division single below.
    }
    if (c === ".") {
      if (text[i + 1] === "/" || (text[i + 1] === "." && text[i + 2] === "/")) {
        const end = scanPath(text, i); // ./rel and ../up
        push("string", text.slice(i, end));
        i = end;
        continue;
      }
      if (text[i + 1] === "." && text[i + 2] === ".") {
        push("operator", "..."); // the pattern ellipsis: THREE-char, checked first
        i += 3;
        continue;
      }
      if (/[0-9]/.test(text[i + 1] ?? "")) {
        const end = scanNumber(text, i); // .27e13: the manual's own leading-dot float
        push("number", text.slice(i, end));
        i = end;
        continue;
      }
      // else the member dot below (OPERATOR_RE).
    }
    if (IDENT_START_RE.test(c)) {
      const j = scanIdent(text, i);
      const word = text.slice(i, j);
      // Bare path glue: `builder.sh/out` (manual example) -- a slash
      // directly after the word where the path scan reaches one.
      if (text[j] === "/" || text[j] === ".") {
        const end = scanPath(text, i);
        if (end > j && text.slice(i, end).includes("/")) {
          push("string", text.slice(i, end));
          i = end;
          continue;
        }
      }
      // Bare URI literal: a scheme-shaped word plus `:` plus a URI char.
      if (text[j] === ":" && SCHEME_RE.test(word) && URI_CHAR_RE.test(text[j + 1] ?? "")) {
        let k = j;
        while (k < n && URI_CHAR_RE.test(text[k]!)) k++;
        push("string", text.slice(i, k));
        i = k;
        continue;
      }
      push(classify(word, j), word);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const end = scanNumber(text, i);
      push("number", text.slice(i, end)); // the scan's shape is closed: always valid
      i = end;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("operator", two);
      i += 2;
      continue;
    }
    if (OPERATOR_RE.test(c)) {
      push("operator", c);
      i++;
      continue;
    }
    push("default", c); // `$`, `~`, `&`, `|`, `%`, `@`, backtick: no role at top level
    i++;
  }
  return runs;

  /** Booleans (lowercase exactly; there is NO null literal in Nix) ->
   * keywords (the spec's ten, `or` included -- its name-context leak is
   * the pinned false positive) -> key (the same-line `=` glue) -> fn (the
   * call peek) -> default. No types, casing means nothing here. */
  function classify(word: string, after: number): string {
    if (word === "true" || word === "false") return "boolean";
    if (KEYWORDS.has(word)) return "keyword";
    if (peekAssign(text, after)) return "key";
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

/** The same-line `=` glue (the hcl/json reading narrowed for this
 * language): spaces and tabs may sit between the identifier and the sign,
 * a newline may not; the sign must not head `==` (there is no `=>` in
 * Nix). The `:` decision says NO lambda-arrow glue. */
function peekAssign(text: string, from: number): boolean {
  let j = from;
  while (text[j] === " " || text[j] === "\t") j++;
  return text[j] === "=" && text[j + 1] !== "=";
}

/** `"`-string: escapes ride the generic backslash skip, `${...}` holes
 * ride the run unparsed (the rust ruling), and a quote inside a hole
 * closes the literal (the documented hcl cost). Newlines are LEGAL inside
 * (the manual: strings can span multiple lines), so an unterminated
 * literal runs to the end of the input -- NOT to the newline. */
function endOfString(text: string, from: number): number {
  let j = from + 1;
  while (j < text.length) {
    const d = text[j]!;
    if (d === "\\") {
      j += 2;
      continue;
    }
    if (d === '"') return j + 1;
    j++;
  }
  return text.length;
}

/** `''`-string (the indented form): the scan follows the spec's escape
 * table exactly -- `''` CLOSES unless followed by `'` (an escaped quote,
 * 3 chars), `$` (a literal dollar-curly opener, 3 chars) or `\` (an
 * escape pair, 4 chars). `$` means nothing else to the scan: literal `$`
 * needs no escaping and holes ride the run (the rust ruling). No closer
 * anywhere runs to end of input. */
function endOfIndented(text: string, from: number): number {
  let j = from + 2;
  while (j < text.length) {
    const d = text[j]!;
    if (d === "'" && text[j + 1] === "'") {
      const c2 = text[j + 2];
      if (c2 === "'" || c2 === "$") {
        j += 3;
        continue;
      }
      if (c2 === "\\") {
        j += 4;
        continue;
      }
      return j + 2; // the closer
    }
    j++;
  }
  return text.length;
}

/** Path characters plus separators, scanned greedily from `from`. The
 * callers decide path-hood (a `/` in the run); the scan just walks. */
function scanPath(text: string, from: number): number {
  let i = from;
  while (i < text.length && (PATH_CHAR_RE.test(text[i]!) || text[i] === "/")) i++;
  return i;
}

/** `[A-Za-z_][A-Za-z0-9_'-]*` -- the spec's identifier grammar, ASCII
 * only, greedy (dashes and apostrophes ride; the whitespace separates). */
function scanIdent(text: string, from: number): number {
  const n = text.length;
  let j = from;
  if (j < n && IDENT_START_RE.test(text[j]!)) j++;
  while (j < n && IDENT_RE.test(text[j]!)) j++;
  return j;
}

const IDENT_START_RE = /[A-Za-z_]/;
const IDENT_RE = /[A-Za-z0-9_'-]/;
const PATH_CHAR_RE = /[A-Za-z0-9._+\-~]/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.\-]*$/;
const URI_CHAR_RE = /[!$%&'*+,\-./:=?@A-Za-z0-9_~]/;
const CLOSER = "*/";

/** Single-char operators (the manual's table singles plus the structural
 * bracket set). NO `%`, `&`, `|`, `~`, `@`, `$`, `"` or backtick: those
 * ride default bytes. */
const OPERATOR_RE = /[{}()[\],.;:?+\-*/<>=!]/;

/** The two-char operator runs. `//` is the update (NOT a comment), `++`
 * the list concat, `->` the implication; `|>` and `<|` are the manual's
 * experimental pipe pair. There is no `=?` in the current table and no
 * `=>` in the language. */
const TWO_CHAR_OPS = new Set(["==", "!=", "<=", ">=", "&&", "||", "->", "++", "//", "|>", "<|"]);

/** The reserved words, the spec's exact ten. `true`/`false` are literals
 * handled as boolean; `null`, `import`, `toString`, `builtins` are plain
 * identifiers (builtins are values, not keywords -- `import` rides
 * default or the call peek). `or` is listed unconditionally: it leaks as
 * a name in legacy contexts and reads as a keyword there, the pinned
 * false positive. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "assert",
  "else",
  "if",
  "in",
  "inherit",
  "let",
  "or",
  "rec",
  "then",
  "with",
]);

/** The numeric dialect: decimal integers and floats (the manual's
 * `.27e13` included), an optional exponent. The scan is closed -- the dot
 * is consumed only before digits, the exponent only before digits -- so
 * `1_0` splits at the underscore (number plus word) and `0x1f` is number
 * plus word (there is NO hex, NO octal form, NO suffixes). */
function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === ".") {
    i++;
    while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
    return scanExponent(text, i);
  }
  while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
  if (text[i] === "." && text[i + 1]! >= "0" && text[i + 1]! <= "9") {
    i++;
    while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
  }
  return scanExponent(text, i);
}

function scanExponent(text: string, from: number): number {
  let i = from;
  if (text[i] === "e" || text[i] === "E") {
    let j = i + 1;
    if (text[j] === "+" || text[j] === "-") j++;
    if (text[j]! >= "0" && text[j]! <= "9") {
      i = j;
      while (i < text.length && text[i]! >= "0" && text[i]! <= "9") i++;
    }
  }
  return i;
}

/** The registry entry for this lang (assembly list: index.ts). `.nix` is
 * the one extension; no basenames (flake.nix, default.nix and shell.nix
 * land through the extension), no aliases (the canonical name is the
 * fence word). */
export const NIX_SYNTAX: SyntaxDef = {
  lang: "nix",
  tokenize: tokenizeNix,
  extensions: ["nix"],
};
