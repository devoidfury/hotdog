import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * GraphQL tokenizer.
 *
 * One pass over a document: `#` opens a "comment" to the line end; single
 * quoted and double quoted strings run to their closer or the newline when
 * unterminated (backslash escapes are honored); `"""` block strings run to the
 * closer or end of input; `$name` is "variable"; `@name` is "decorator";
 * known GraphQL words (`type`, `query`, `input`, `fragment`, ...) are
 * "keyword"; `true`/`false` are "boolean" and `null` is "null"; built-in scalar
 * names and Capitalized user types are "type"; a name glued directly to `:`
 * reads as "key"; numbers get "number" when they look like GraphQL scalars,
 * otherwise default; structural punctuation (`...`, `:`, `=`, `!`, `|`, `@`,
 * `$`, parentheses, brackets, braces, commas) is "operator". Honest limits: no
 * schema validation, no executable/query operation detection, and no special
 * handling for block-string interpolation (there is none in the language).
 * Nothing is ever dropped or reordered: concatenating every run reproduces the
 * input exactly, for any input. One run per token; adjacent runs may share a
 * type (sinks coalesce as they like). This is display candy, not a GraphQL
 * parser.
 */
export function tokenizeGraphQL(text: string): SyntaxRun[] {
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
    if (c === '"') {
      const isBlock = text[i + 1] === '"' && text[i + 2] === '"';
      const end = isBlock ? endOfBlockString(text, i) : endOfString(text, i);
      push("string", text.slice(i, end));
      i = end;
      continue;
    }
    if (c === "$" && NAME_START_RE.test(text[i + 1] ?? "")) {
      let j = i + 1;
      while (j < n && NAME_RE.test(text[j]!)) j++;
      push("variable", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "@" && NAME_START_RE.test(text[i + 1] ?? "")) {
      let j = i + 1;
      while (j < n && NAME_RE.test(text[j]!)) j++;
      push("decorator", text.slice(i, j));
      i = j;
      continue;
    }
    if ((c === "+" || c === "-") && text[i + 1] !== undefined && /[0-9]/.test(text[i + 1]!)) {
      const end = scanNumber(text, i);
      const word = text.slice(i, end);
      push(NUM_OK_RE.test(word) ? "number" : "default", word);
      i = end;
      continue;
    }
    if (isNumberStart(c, text[i + 1])) {
      const end = scanNumber(text, i);
      const word = text.slice(i, end);
      push(NUM_OK_RE.test(word) ? "number" : "default", word);
      i = end;
      continue;
    }
    if (NAME_START_RE.test(c)) {
      let j = i;
      while (j < n && NAME_RE.test(text[j]!)) j++;
      const word = text.slice(i, j);
      push(classifyName(word, j, text), word);
      i = j;
      continue;
    }
    if (c === "." && text[i + 1] === "." && text[i + 2] === ".") {
      push("operator", "...");
      i += 3;
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

function endOfBlockString(text: string, from: number): number {
  const closer = text.indexOf('"""', from + 3);
  return closer === -1 ? text.length : closer + 3;
}

function scanNumber(text: string, from: number): number {
  const n = text.length;
  let i = from;
  if (text[i] === "+" || text[i] === "-") i++;
  if (text[i] === "0" && /[xX]/.test(text[i + 1] ?? "")) {
    i += 2;
    while (i < n && /[0-9a-fA-F]/.test(text[i]!)) i++;
    if (text[i] === ".") {
      i++;
      while (i < n && /[0-9a-fA-F]/.test(text[i]!)) i++;
    }
    return i;
  }
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

function classifyName(word: string, after: number, text: string): string {
  if (word === "true" || word === "false") return "boolean";
  if (word === "null") return "null";
  if (KEYWORDS.has(word)) return "keyword";
  if (isType(word)) return "type";
  if (text[after] === ":") return "key";
  if (text[skipWs(text, after)] === "(") return "fn";
  return "default";
}

function isType(word: string): boolean {
  if (BUILTIN_SCALARS.has(word)) return true;
  if (!/^[A-Z]/.test(word)) return false;
  return !/^[A-Z0-9_]+$/.test(word);
}

const skipWs = (text: string, from: number): number => {
  let j = from;
  while (j < text.length && isWs(text[j])) j++;
  return j;
};

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const isNumberStart = (c: string, next: string | undefined): boolean =>
  /[0-9]/.test(c) || (c === "." && next !== undefined && /[0-9]/.test(next));

const NAME_START_RE = /[A-Za-z_]/;
const NAME_RE = /[\w]/;
const OPERATOR_RE = /[!&:(){}[\],|=]/;
const NUM_OK_RE =
  /^[+-]?(?:0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)|(?:(?:0|[1-9]\d*)(?:\.\d+)?))(?:[eE][+-]?\d+)?$/;

const KEYWORDS = new Set([
  "query",
  "mutation",
  "subscription",
  "fragment",
  "on",
  "type",
  "input",
  "enum",
  "interface",
  "union",
  "scalar",
  "schema",
  "directive",
  "extend",
  "implements",
  "repeatable",
]);

const BUILTIN_SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);

/** The registry entry for this lang (assembly list: index.ts). */
export const GRAPHQL_SYNTAX: SyntaxDef = {
  lang: "graphql",
  tokenize: tokenizeGraphQL,
  aliases: ["gql", "graphqls"],
  extensions: ["graphql", "gql", "graphqls"],
};
