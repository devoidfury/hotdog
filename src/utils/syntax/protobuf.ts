import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Protocol Buffers tokenizer (the proto IDL: `.proto` files, proto2,
 * proto3 and editions alike).
 *
 * The c.ts/cpp.ts family in shape (it grew from the same scan): comments
 * are `//` lines and star-slash blocks that run to the first closer or
 * end of input, NEVER nested (the spec's own words); "string" covers BOTH
 * quote forms with C-style escapes riding the generic backslash skip, an
 * unterminated literal stopping at the newline and a backslash before it
 * splicing (the spec: a raw newline inside a literal is malformed, so the
 * c.ts endOfString fits); "keyword"/"type"/"boolean"/"number"/"fn" and
 * the Capitalized-typedef heuristic with the member-position refusal
 * after `.` (`google.protobuf.Timestamp` splits at the dots and every
 * reading but the call peek is refused, the c.ts ruling) -- narrowed for
 * this language's spelling: a type name is UpperCamelCase with at least
 * one lowercase letter (`Kind`, `SearchRequest`), so the SCREAMING_SNAKE
 * enum values (`UNKNOWN`, `MAX_SIZE`) ride plain words; "fn" is any
 * name directly before `(` (whitespace-tolerant, surviving the dot). The
 * family departures are the spec's: identifiers are ASCII
 * `[A-Za-z_][A-Za-z0-9_]*` (high unicode rides plain bytes -- the pinned
 * tightening versus c.ts, whose grammar speaks Unicode only inside
 * comments and strings); there is NO preprocessor, so `#` is a plain byte
 * (the c-family reader's trap, pinned); the operator set is EXACTLY the
 * grammar's punctuation -- `, . / : ; = - ( ) { } [ ] < >` as singles --
 * and nothing else: there is no two-char operator at all (no `..`: a
 * reserved range spells `to`; `2 .. 5` degrades to dot dot, pinned), and
 * `+ & | ! ? % ~ @` ride plain bytes. The 43 spec keywords SPLIT across
 * three classes: the fifteen scalar type names (bool, bytes, string, the
 * int family, float, double) ride "type" like C primitives; `inf` and
 * `nan` ride "number" (the spec makes them keyword TOKENS, but they are
 * float value literals -- the decide-and-pin); the remaining twenty-six
 * (syntax, edition, import, weak, public, package, option, export, local,
 * message, enum, service, extend, group, oneof, map, extensions,
 * reserved, rpc, stream, returns, to, max, repeated, optional, required)
 * ride "keyword". `true`/`false` are NOT keywords in the spec (they are
 * identifiers the parser blesses as boolean values) and ride "boolean"
 * lowercase exactly; `deprecated` is NOT in the spec's closed list either
 * (it is an option name) and rides a plain word, pinned. "message Foo",
 * "enum Bar", "service Baz" and "extend Foo" name a "type" after the
 * keyword (DECL_KW); "rpc Foo(Bar) returns (stream Baz)" reads rpc as a
 * keyword, Foo as fn (the call peek -- rpc is deliberately NOT a DECL_KW
 * word, the pinned decision), Bar and Baz as Capitalized types, returns
 * and stream as keywords. NUMBERS follow the spec's TWO-STAGE lexical:
 * the scan greedily eats digits, letters, dots and `e`/`E` signs (so
 * `0.0.0` and `100to3` are each ONE malformed token, exactly as the
 * spec's tokenizer forms them) and validation then decides: decimal,
 * octal (`0741`), hex (`0x0f6db2`), and float shapes (`1.`, `.123`,
 * `1.234e-12` all legal) ride "number" while anything else the scan ate
 * (`08`, `0b101` -- there is NO binary form --, `1e`, `1.2.3`) rides
 * "default" whole, NOT split into number plus word (the pinned contrast
 * with the hcl-family degradations). Custom option names in parens
 * (`option (foo.bar) = true;`) get no special arm: the parens are
 * operators, the words ride default past the dot flag. Nothing is ever
 * dropped or reordered: concatenating every run reproduces the input
 * exactly, for any input. One run per token; adjacent runs may share a
 * type (sinks coalesce as they like). This is display candy, not a
 * protoc parser.
 */
export function tokenizeProtobuf(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let dot = false; // the previous token was `.` (the member-position flag)
  let prevDecl = false; // the previous token was message/enum/service/extend

  while (i < n) {
    const c = text[i]!;
    if (isWs(c)) {
      let j = i;
      while (j < n && isWs(text[j])) j++;
      push("default", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("comment", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2); // NEVER nested: the first closer ends it
      const j = end === -1 ? n : end + 2;
      push("comment", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = endOfString(text, i);
      push("string", text.slice(i, end));
      i = end;
      dot = false;
      continue;
    }
    if (IDENT_START_RE.test(c)) {
      let j = i;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      const word = text.slice(i, j);
      const type = classifyIdent(word, j);
      push(type, word);
      i = j;
      prevDecl = DECL_KW.has(word); // read only at non-member positions (the classifier gate)
      dot = false;
      continue;
    }
    if (isNumberStart(c, text[i + 1])) {
      const end = scanNumericLiteral(text, i);
      const word = text.slice(i, end);
      push(NUM_OK_RE.test(word) ? "number" : "default", word); // two-stage: the greedy scan, then validation
      i = end;
      dot = false;
      prevDecl = false;
      continue;
    }
    if (OPERATOR_RE.test(c)) {
      push("operator", c);
      i++;
      dot = c === ".";
      prevDecl = false;
      continue;
    }
    push("default", c); // `+ & | ! ? % ~ @ #`: bytes the grammar never speaks
    i++;
    dot = false;
    prevDecl = false;
  }
  return runs;

  /** Scalar types -> booleans -> inf/nan -> keywords -> the name after
   * message/enum/service/extend -> fn (name before `(`) -> Capitalized
   * type. After a dot, every reading but the call peek is refused (the
   * c.ts ruling; the spec makes keywords context-free, and the refusal
   * after a member dot is the documented, deliberate cost). */
  function classifyIdent(word: string, after: number): string {
    if (!dot) {
      if (PRIMITIVES.has(word)) return "type";
      if (word === "true" || word === "false") return "boolean";
      if (word === "inf" || word === "nan") return "number"; // keyword TOKENS, float VALUES (the pin)
      if (KEYWORDS.has(word)) return "keyword";
      if (prevDecl) return "type";
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

/** `message`/`enum`/`service`/`extend`: the name right after one is a
 * "type". `rpc` is deliberately absent (the rpc NAME takes the call-peek
 * "fn" reading, the pinned decision). */
const DECL_KW = new Set(["message", "enum", "service", "extend"]);

/** String literals, both quote forms (one scan, one class): C-style
 * escapes ride the backslash skip, an unterminated literal stops before
 * an unescaped newline (raw newlines are malformed here), and a backslash
 * before that newline splices the line (the c.ts family). */
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

const IDENT_START_RE = /[A-Za-z_]/; // ASCII per the spec (the pinned tightening vs c.ts)
const IDENT_RE = /[A-Za-z0-9_]/;
// The proto spelling of a type name is UpperCamelCase (single- OR
// multi-word: `Kind`, `SearchRequest`) WITH at least one lowercase letter
// -- the c.ts heuristic narrowed for this language, where the canonical
// type names are exactly the mixed-prefix spellings c.ts rejected and the
// SCREAMING_SNAKE enum values (`UNKNOWN`, `MAX_SIZE`) stay plain words.
const CAPITALIZED_RE = /^[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$/;

/** The grammar's punctuation and operators, all SINGLE chars (the spec's
 * symbol table has no two-char token: ranges spell `to`). NO `+`, `?`,
 * `!`, `&`, `%`, `~`, `@`, `#`. */
const OPERATOR_RE = /[,;./:=\-\(\)\{\}\[\]<>]/;

/** Stage one of the spec's numeric lexical: `[.]digit` then greedily
 * digits, LETTERS, dots, and signs right after `e`/`E` -- so `0.0.0` and
 * `100to3` come out as ONE token each, malformed or not, exactly as the
 * language's tokenizer forms them (no split into number plus word). */
function scanNumericLiteral(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === ".") i++;
  while (i < n) {
    const d = text[i]!;
    if (/[0-9a-zA-Z.]/.test(d)) {
      i++;
      continue;
    }
    if ((d === "+" || d === "-") && /[eE]/.test(text[i - 1] ?? "")) {
      i++;
      continue;
    }
    break;
  }
  return i;
}

const isNumberStart = (c: string, next: string | undefined): boolean =>
  /[0-9]/.test(c) || (c === "." && next !== undefined && /[0-9]/.test(next));

/** Stage two: the int shapes (decimal, octal -- `08` is MALFORMED -- and
 * hex; NO binary) and the float shapes (trailing dot and leading dot
 * legal, exponent with mandatory digits after any sign). A run that
 * validates as neither rides "default" whole. */
const NUM_OK_RE =
  /^(?:0|[1-9][0-9]*|0[0-7]+|0[xX][0-9a-fA-F]+|[0-9]+\.[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+)$/;

/** The scalar type keywords ride "type" (the c.ts PRIMITIVES role). */
const PRIMITIVES: ReadonlySet<string> = new Set([
  "bool",
  "bytes",
  "string",
  "int32",
  "int64",
  "uint32",
  "uint64",
  "sint32",
  "sint64",
  "fixed32",
  "fixed64",
  "sfixed32",
  "sfixed64",
  "float",
  "double",
]);

/** The remaining twenty-six of the spec's 43 keywords (the fifteen
 * scalars ride type above; `inf`/`nan` ride number in the classifier;
 * `true`/`false` are NOT spec keywords and ride boolean; `deprecated` is
 * NOT in the closed list at all). `weak`, `public`, `export`, `local` and
 * `group` are reserved even where the modern grammar barely uses them. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "syntax",
  "edition",
  "import",
  "weak",
  "public",
  "package",
  "option",
  "export",
  "local",
  "message",
  "enum",
  "service",
  "extend",
  "group",
  "oneof",
  "map",
  "extensions",
  "reserved",
  "rpc",
  "stream",
  "returns",
  "to",
  "max",
  "repeated",
  "optional",
  "required",
]);

/** The registry entry for this lang (assembly list: index.ts). Canonical
 * name "protobuf"; "proto" is the fence alias (the graphql precedent:
 * canonical full name, short spelling as an alias, extensions never
 * aliases) and simultaneously the file extension. No basenames. */
export const PROTOBUF_SYNTAX: SyntaxDef = {
  lang: "protobuf",
  tokenize: tokenizeProtobuf,
  aliases: ["proto"],
  extensions: ["proto"],
};
