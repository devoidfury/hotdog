import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * SQL tokenizer.
 *
 * One pass, dialect-neutral: keyword matching is case-insensitive against
 * a curated closed superset (SELECT..END, the DDL/DML/transaction words --
 * the dockerfile-instruction precedent applied mid-sentence, since SQL is
 * not line-structured); NULL/TRUE/FALSE ride the literal classes
 * "null"/"boolean" (house rule), every other match rides "keyword". A
 * double dash opens a "comment" to EOL and the slash-star block form runs
 * to its closer or end of input (no postgres nesting; the language's core
 * dialect does not nest either); "string" covers both quote forms -- 'text' with
 * the '' doubling escape, and "quoted identifiers" ride "string" too,
 * because MySQL leniency makes that spelling show up in real data even
 * though the standard calls it an identifier (documented misread, one
 * warm family is the honest display) -- an unterminated literal stops at
 * the newline or end of input; a backslash is a LITERAL byte here, unlike
 * the c/js scans, because standard SQL gives it no escape power. "fn" is
 * any name glued directly before `(` (COUNT, NOW -- no function registry,
 * the peek is the whole reading; the peek does NOT cross whitespace,
 * because `CREATE TABLE t (` would otherwise paint every table name as a
 * call); "number" is plain integers/decimals/exponent
 * (no suffix zoo); `;` `.` `,` are the "operator" accent -- the
 * structural punctuation of statements and qualified names -- while
 * arithmetic, comparison and parentheses ride "default" (there is no
 * operator color to fight for in a query's prose). `$1` positional and
 * `@@version`-style prefixed words are scanned as one "default" run;
 * `:name` bind params ride a default colon plus a default word. Honest
 * limits: `#` comments (MySQL) are not comments here; a keyword as a bare
 * column name (`"order"`, or naked `end` after `.`) still reads keyword;
 * dialect syntax beyond the shared words is plain words. Nothing is ever
 * dropped or reordered: concatenating every run reproduces the input
 * exactly, for any input. One run per token; adjacent runs may share a
 * type (sinks coalesce as they like). This is display candy, not a SQL
 * parser.
 */
export function tokenizeSql(text: string): SyntaxRun[] {
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
    if (c === "-" && text[i + 1] === "-") {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("comment", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      push("comment", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = endOfString(text, i);
      push("string", text.slice(i, end));
      i = end;
      continue;
    }
    if (IDENT_START_RE.test(c)) {
      let j = i;
      while (j < n && IDENT_RE.test(text[j]!)) j++;
      const word = text.slice(i, j);
      const lower = word.toLowerCase();
      const type = KEYWORDS.get(lower) ?? (text[j] === "(" ? "fn" : "default");
      push(type, word);
      i = j;
      continue;
    }
    if (c === "$" || c === "@" || c === "?") {
      // Prefixed variables/params ($1, @var, @@version, ? placeholder):
      // the whole glued word is one plain run.
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$@]/.test(text[j]!)) j++;
      push("default", text.slice(i, j));
      i = j;
      continue;
    }
    if (isNumberStart(c, text[i + 1])) {
      const end = scanNumber(text, i);
      const word = text.slice(i, end);
      push(NUM_OK_RE.test(word) ? "number" : "default", word);
      i = end;
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
}

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

/** Quoted literal/identifier: the doubling escape (`'it''s'`, `"a""b"`)
 * keeps the quote inside; a backslash is literal bytes (standard SQL). An
 * unterminated literal stops before a newline or runs to end of input. */
function endOfString(text: string, from: number): number {
  const quote = text[from]!;
  let j = from + 1;
  while (j < text.length) {
    const d = text[j]!;
    if (d === "\n" || d === "\r") return j;
    if (d === quote) {
      if (text[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return text.length;
}

const IDENT_START_RE = /[A-Za-z_\u00a0-\uffff]/;
const IDENT_RE = /[\w\u00a0-\uffff]/;

/** The structural accent only (per the batch ruling): statement ends,
 * qualified-name dots, list commas. Everything else is prose. */
const OPERATOR_RE = /[;,.]/;

/** Plain numeric literal (integers, decimals, exponent). Shape validation
 * at the call site sends tails like `1e` back to default. */
const NUM_OK_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const isNumberStart = (c: string, next: string | undefined): boolean =>
  /[0-9]/.test(c) || (c === "." && next !== undefined && /[0-9]/.test(next));

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  while (i < n && /[0-9]/.test(text[i]!)) i++;
  if (text[i] === ".") {
    i++;
    while (i < n && /[0-9]/.test(text[i]!)) i++;
  }
  if (text[i] === "e" || text[i] === "E") {
    let j = i + 1;
    if (text[j] === "+" || text[j] === "-") j++;
    if (/[0-9]/.test(text[j] ?? "")) {
      i = j;
      while (i < n && /[0-9]/.test(text[i]!)) i++;
    }
  }
  return i;
}

/** Curated closed superset: the shared SQL words every major dialect
 * speaks (queries, DML, DDL, transactions, CASE..END). Data type names
 * (INT, VARCHAR) ride plain words -- claiming them invites dialect
 * fights. NULL/TRUE/FALSE answer with their literal classes (house rule);
 * everything else rides "keyword". Matched on the lowercased word,
 * whole-word only (`SELECTED` is not SELECT). */
const KEYWORDS: ReadonlyMap<string, string> = buildKeywords([
    "add",
    "all",
    "alter",
    "and",
    "any",
    "as",
    "asc",
    "backup",
    "begin",
    "between",
    "by",
    "cascade",
    "case",
    "cast",
    "check",
    "column",
    "commit",
    "constraint",
    "create",
    "cross",
    "database",
    "default",
    "delete",
    "desc",
    "distinct",
    "drop",
    "else",
    "end",
    "except",
    "exclusive",
    "exists",
    "foreign",
    "from",
    "full",
    "grant",
    "group",
    "having",
    "if",
    "ilike",
    "in",
    "index",
    "inner",
    "insert",
    "intersect",
    "into",
    "is",
    "join",
    "key",
    "left",
    "like",
    "limit",
    "natural",
    "not",
    "offset",
    "on",
    "or",
    "order",
    "outer",
    "primary",
    "references",
    "rename",
    "replace",
    "revoke",
    "right",
    "rollback",
    "savepoint",
    "schema",
    "select",
    "set",
    "table",
    "then",
    "transaction",
    "trigger",
    "truncate",
    "union",
    "unique",
    "update",
    "using",
    "values",
    "view",
    "when",
    "where",
    "with",
]);

/** The curated words ride keyword; the three literals ride the house
 * literal classes. */
function buildKeywords(words: readonly string[]): ReadonlyMap<string, string> {
  const m = new Map<string, string>();
  for (const w of words) m.set(w, "keyword");
  m.set("null", "null");
  m.set("true", "boolean");
  m.set("false", "boolean");
  return m;
}

/** The registry entry for this lang (assembly list: index.ts). */
export const SQL_SYNTAX: SyntaxDef = {
  lang: "sql",
  tokenize: tokenizeSql,
  extensions: ["sql"],
};
