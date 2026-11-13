import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * TOML tokenizer (also the shared sectioned-line scanning core: ini.ts
 * layers its thinner dialect over `tokenizeWithDialect`).
 *
 * One pass, line-aware: `[table]` and `[[array of tables]]` headers are one
 * "section" run each (the loud divider family, like yaml's doc markers); a
 * header without its closer stops at the line end rather than painting the
 * rest of the file. Bare and dotted keys are "key" when a separator (`=`)
 * follows across whitespace -- quoted keys ride through the value reader and
 * still get promoted; a bare word with no separator after it (a malformed
 * line) stays "default". `=` is "operator". Values: "string" for basic,
 * literal and both multi-line forms (`"""`/`'''` run to their closer or end
 * of input, the js-template degradation family, so a file view sees the
 * whole span when it holds it and an honest open string when it does not);
 * "boolean" (true/false); "number" for integers, floats, radix forms,
 * `+inf`/`-inf`/`nan` and every datetime/localtime shape, datetimes riding
 * the scalar-literal family rather than minting a class of their own (the
 * space-separated `1979-05-27 07:32:00` form is re-joined into one run);
 * arrays and inline tables pass through as ONE "default" run, balanced or
 * not (the yaml flow-collection precedent -- no array parser). `#` opens a
 * comment to EOL anywhere outside a string, and a `#` glued to a bare
 * value starts the comment there (`x = 1#c`). Numbers distrust lookalikes:
 * `07`, `1__0` and friends ride "default". Honest limits: keys with spaces
 * around the dot and TOML's stricter underscore/leading-zero laws degrade,
 * and unterminated quotes/brackets run to end of input. Nothing is ever
 * dropped or reordered: concatenating every run reproduces the input
 * exactly, for any input. One run per token; adjacent runs may share a type
 * (sinks coalesce as they like). This is display candy, not a TOML parser:
 * no schema, no validation, no duplicate-key verdicts.
 */
export function tokenizeToml(text: string): SyntaxRun[] {
  return tokenizeWithDialect(text, TOML_DIALECT);
}

/** One value span: end index (>= from) and the class the slice carries;
 * `type: null` means "no value at this position" and the core loop
 * re-enters at the same index (the top-level branches make progress). */
export interface ValueSpan {
  end: number;
  type: string | null;
}

/** The dialect seams over the shared sectioned-line skeleton. */
export interface DialectConfig {
  /** Characters that open a comment outside strings (`#` for toml, `#` and
   * `;` for ini). */
  comment: ReadonlySet<string>;
  /** Characters that glue a key to its value (`=` for toml, `=` and `:` for
   * ini). */
  separators: ReadonlySet<string>;
  /** TOML's `[[array of tables]]` headers; ini reads plain `[section]` only. */
  arrayTables: boolean;
  /** The dialect's own grammar for one value at `from` (and for quoted runs
   * at line level, which the core promotes to "key" when a separator
   * follows). This seam carries everything the two langs disagree on; the
   * skeleton (whitespace, comments, sections, keys, operators) is shared. */
  readValue: (text: string, from: number) => ValueSpan;
}

/** The shared skeleton: whitespace/comment/section/key/operator scanning
 * around a dialect's `readValue`. Called with any input, whole files or
 * single lines alike. */
export function tokenizeWithDialect(text: string, cfg: DialectConfig): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  let lineStart = true; // nothing significant pushed since the last newline
  while (i < n) {
    const c = text[i]!;
    if (isWs(c)) {
      let j = i;
      let sawNewline = false;
      while (j < n && isWs(text[j])) {
        if (text[j] === "\n") sawNewline = true;
        j++;
      }
      push("default", text.slice(i, j));
      i = j;
      if (sawNewline) lineStart = true; // a newline arms the next section; spaces never spend it
      continue;
    }
    if (cfg.comment.has(c)) {
      let j = i;
      while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
      push("comment", text.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }
    if (c === "[" && lineStart) {
      const open = cfg.arrayTables && text.startsWith("[[", i) ? "[[" : "[";
      let j = i + open.length;
      while (j < n && text[j] !== "]" && text[j] !== "\n") j++;
      let end = text[j] === "]" ? j + 1 : j; // closer included; the header stops at the line end
      if (open === "[[" && text[end] === "]") end++; // [[x]] closes with ]]
      push("section", text.slice(i, end));
      i = end;
      lineStart = false;
      continue;
    }
    if (KEY_START_RE.test(c)) {
      let j = i;
      while (j < n && KEY_RE.test(text[j]!)) j++;
      push(cfg.separators.has(text[skipWs(text, j)] ?? "") ? "key" : "default", text.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }
    if (c === '"' || c === "'") {
      // A quoted run at line level: toml's quoted key, or just a stray
      // string. The value reader knows quoting; a glued (spaced) separator
      // after it promotes the run to "key".
      const v = cfg.readValue(text, i);
      if (v.end === i) {
        push("default", c); // a dialect that claims nothing here: make progress
        i++;
      } else {
        push(cfg.separators.has(text[skipWs(text, v.end)] ?? "") ? "key" : (v.type ?? "string"), text.slice(i, v.end));
        i = v.end;
      }
      lineStart = false;
      continue;
    }
    if (cfg.separators.has(c)) {
      push("operator", c);
      i++;
      let j = i;
      while (j < n && isWs(text[j]) && text[j] !== "\n") j++; // inline spacing only
      push("default", text.slice(i, j));
      i = j;
      const v = cfg.readValue(text, i);
      if (v.type !== null && v.end > i) push(v.type, text.slice(i, v.end));
      i = v.end; // a null span re-enters the loop at the same byte (top branches progress)
      lineStart = false;
      continue;
    }
    push("default", c);
    i++;
    lineStart = false;
  }
  return runs;
}

// ── The TOML dialect ─────────────────────────────────────────────────────────

const TOML_DIALECT: DialectConfig = {
  comment: new Set(["#"]),
  separators: new Set(["="]),
  arrayTables: true,
  readValue: readTomlValue,
};

function readTomlValue(text: string, from: number): ValueSpan {
  const n = text.length;
  const c = text[from];
  if (c === undefined || isValueStop(c)) return { end: from, type: null };
  if (c === "[" || c === "{") return { end: scanBalanced(text, from), type: "default" }; // array / inline table
  if (c === '"' || c === "'") return { end: endOfTOMLString(text, from), type: "string" };
  let j = from;
  while (j < n && !isValueStop(text[j]!)) j++;
  // The space-separated datetime form (`1979-05-27 07:32:00`): re-join the
  // time candidate so the literal reads as one scalar run.
  if (DATE_ONLY_RE.test(text.slice(from, j)) && text[j] === " ") {
    let k = j + 1;
    while (k < n && /[0-9:.+\-Zz]/.test(text[k]!)) k++;
    if (TIME_RE.test(text.slice(j + 1, k))) j = k;
  }
  return { end: j, type: classifyTomlScalar(text.slice(from, j)) };
}

/** Bare values end at whitespace, the comment char, or the closer of the
 * collection they sit in. */
const isValueStop = (c: string): boolean => isWs(c) || c === "," || c === "]" || c === "}" || c === "#";

function classifyTomlScalar(word: string): string {
  if (word === "true" || word === "false") return "boolean";
  if (NUM_RE.test(word) || DATETIME_RE.test(word) || TIME_RE.test(word)) return "number";
  return "default";
}

/** End index just past a TOML string opened at `from`. `"""`/`'''` run to
 * their closer or end of input; a single-line string stops before an
 * unescaped newline (the css/js line-wise family). Escapes are honored in
 * the basic (`"`) forms only -- literal strings are raw. */
function endOfTOMLString(text: string, from: number): number {
  const quote = text[from]!;
  const triple = text[from + 1] === quote && text[from + 2] === quote;
  const closer = triple ? quote.repeat(3) : quote;
  let j = from + (triple ? 3 : 1);
  while (j < text.length) {
    const d = text[j]!;
    if (quote === '"' && d === "\\") {
      j += 2;
      continue;
    }
    if (!triple && (d === "\n" || d === "\r")) return j;
    if (text.startsWith(closer, j)) return j + closer.length;
    j++;
  }
  return text.length;
}

/** Array/inline-table passthrough (the yaml flow-collection precedent):
 * depth tracked across quoted runs; unterminated runs to end of input. */
function scanBalanced(text: string, from: number): number {
  let depth = 0;
  let q: string | null = null;
  for (let j = from; j < text.length; j++) {
    const d = text[j]!;
    if (q !== null) {
      if (d === "\\") j++;
      else if (d === q) q = null;
      continue;
    }
    if (d === '"' || d === "'") {
      q = d;
      continue;
    }
    if (d === "[" || d === "{") depth++;
    else if (d === "]" || d === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return text.length;
}

const isWs = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

const skipWs = (text: string, from: number): number => {
  let j = from;
  while (j < text.length && isWs(text[j])) j++;
  return j;
};

const KEY_START_RE = /[A-Za-z0-9_-]/;
const KEY_RE = /[A-Za-z0-9_.\-]/;

/** TOML numerics with underscore separators and sign; leading zeros and
 * doubled underscores distrust back to default. inf/nan need their sign,
 * per spec. */
const NUM_RE =
  /^[+-]?(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?|[+-](?:inf|nan))$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;
const TIME_RE = /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/** The registry entry for this lang (assembly list: index.ts). */
export const TOML_SYNTAX: SyntaxDef = {
  lang: "toml",
  tokenize: tokenizeToml,
  extensions: ["toml"],
};
