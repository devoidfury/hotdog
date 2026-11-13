import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * YAML tokenizer.
 *
 * Line-wise with lookahead: a line ending in a block-scalar header (`|`/`>`
 * with optional chomping +/- and indent digit, optional trailing comment)
 * classifies the indicator as an operator and the whole indented body --
 * indentation, newlines and all -- as ONE "string" run, so block content is
 * never shredded. Everything else is scanned per line: "key" for a mapping
 * key at any indentation (a scalar ending at a `:` followed by space/EOL; a
 * quoted key counts too), "string" for quoted scalars (`"a\"b"`, `'it''s'`;
 * an unterminated quote runs to EOL) and for plain scalars, "comment" when a
 * `#` opens the line or follows whitespace (so `http://x#frag` stays whole),
 * "number"/"boolean"/"null" for scalars that read as such (booleans take the
 * conservative YAML 1.1 set true/false/yes/no/on/off in any case), "anchor"
 * (&a), "alias" (*a), "tag" (!!str), "marker" for `---`/`...` at column 0,
 * and "operator" for structural punctuation: list dashes, mapping colons,
 * block indicators. Flow collections ([...] / {...}) pass through as one
 * "default" run, open or not. Indentation, spacing and line terminators are
 * "default". Nothing is ever dropped or reordered: concatenating every run
 * reproduces the input exactly, for any input. One run per token; adjacent
 * runs may share a type (sinks coalesce as they like). This is display
 * candy, not a YAML parser: no schema, no validation, no aliases resolved.
 */
export function tokenizeYaml(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  // Split keeping terminators: body + eol of every entry re-forms the input.
  const lines: Array<{ body: string; eol: string }> = [];
  for (let cut = 0; cut < text.length; ) {
    const nl = text.indexOf("\n", cut);
    if (nl === -1) {
      const body = text.slice(cut);
      lines.push(body.endsWith("\r") ? { body: body.slice(0, -1), eol: "\r" } : { body, eol: "" });
      break;
    }
    const body = text.slice(cut, nl);
    lines.push(body.endsWith("\r") ? { body: body.slice(0, -1), eol: "\r\n" } : { body, eol: "\n" });
    cut = nl + 1;
  }

  for (let k = 0; k < lines.length; k++) {
    const { body, eol } = lines[k]!;
    const n = body.length;
    let i = 0;
    let keyPos = true; // the next scalar may be a mapping key (line start / after a dash)
    let blockHeader = ""; // non-empty once the line's block-scalar indicator consumed

    if (/^---(?=[ \t]|$)/.test(body)) {
      push("marker", "---");
      i = 3;
    } else if (/^\.\.\.(?=[ \t]|$)/.test(body)) {
      push("marker", "...");
      i = 3;
    }

    while (i < n) {
      const c = body[i]!;
      if (isWs(c)) {
        let j = i;
        while (j < n && isWs(body[j])) j++;
        push("default", body.slice(i, j));
        i = j;
      } else if (c === "#") {
        push("comment", body.slice(i));
        i = n;
      } else if (c === "-" && (i + 1 >= n || isWs(body[i + 1]))) {
        push("operator", "-");
        i++;
      } else if (c === ":" && (i + 1 >= n || isWs(body[i + 1]))) {
        push("operator", ":");
        i++;
        keyPos = false;
      } else if (c === "&" || c === "*" || c === "!") {
        let j = i + 1;
        while (j < n && !isWs(body[j]) && !",[]{}".includes(body[j]!)) j++;
        push(c === "&" ? "anchor" : c === "*" ? "alias" : "tag", body.slice(i, j));
        i = j;
      } else if (c === "[" || c === "{") {
        // Flow collection: one honest passthrough run, matched or not.
        let depth = 0;
        let q: string | null = null;
        let j = i;
        for (; j < n; j++) {
          const d = body[j]!;
          if (q !== null) {
            if (q === '"' && d === "\\") j++;
            else if (d === q) q = null;
          } else if (d === '"' || d === "'") {
            q = d;
          } else if (d === "[" || d === "{") {
            depth++;
          } else if (d === "]" || d === "}") {
            depth--;
            if (depth === 0) {
              j++;
              break;
            }
          }
        }
        push("default", body.slice(i, j));
        i = j;
      } else if (c === '"' || c === "'") {
        const quote = c;
        let j = i + 1;
        while (j < n) {
          const d = body[j]!;
          if (quote === '"' && d === "\\") {
            j += 2;
            continue;
          }
          if (d === quote) {
            if (quote === "'" && body[j + 1] === "'") {
              j += 2;
              continue;
            }
            j++;
            break;
          }
          j++;
        }
        if (j > n) j = n; // a trailing escape on an unterminated double quote
        let t = j;
        while (t < n && isWs(body[t])) t++;
        const isKey = keyPos && body[t] === ":" && (t + 1 >= n || isWs(body[t + 1]));
        push(isKey ? "key" : "string", body.slice(i, j));
        i = j;
        if (!isKey) keyPos = false;
      } else if ((c === "|" || c === ">") && BLOCK_HEADER_RE.test(body.slice(i))) {
        const ind = BLOCK_INDICATOR_RE.exec(body.slice(i))![0];
        push("operator", ind);
        i += ind.length;
        blockHeader = ind; // the rest of the line is ws/comment; the body follows below
      } else {
        const start = i;
        let end = i; // exclusive end of the scalar text, trailing whitespace excluded
        while (i < n) {
          const d = body[i]!;
          if (d === ":" && (i + 1 >= n || isWs(body[i + 1]))) break; // block mapping colon
          if (d === "#" && isWs(body[i - 1])) break; // comment only after whitespace
          i++;
          if (!isWs(d)) end = i;
        }
        const word = body.slice(start, end);
        const isKey = i < n && body[i] === ":" && keyPos;
        push(isKey ? "key" : classifyScalar(word), word);
        i = end; // trailing whitespace (if any) re-enters the loop as default
      }
    }
    push("default", eol);

    if (blockHeader !== "") {
      // The body owns every following line indented deeper than the header,
      // plus the blank lines between them; a dedented content line ends it.
      const parent = indentOf(body);
      let first = -1;
      for (let m = k + 1; m < lines.length; m++) {
        const b = lines[m]!.body;
        if (b.trim() === "") continue;
        if (indentOf(b) > parent) first = m;
        break;
      }
      if (first !== -1) {
        let end = lines.length;
        for (let m = first + 1; m < lines.length; m++) {
          const b = lines[m]!.body;
          if (b.trim() !== "" && indentOf(b) <= parent) {
            end = m;
            break;
          }
        }
        let chunk = "";
        for (let m = k + 1; m < end; m++) chunk += lines[m]!.body + lines[m]!.eol;
        push("string", chunk);
        k = end - 1; // the outer loop resumes at the first line after the block
      }
    }
  }
  return runs;
}

const isWs = (c: string | undefined): boolean => c === " " || c === "\t";

/** Leading space/tab count; the indentation yardstick for block bodies. */
const indentOf = (line: string): number => {
  let n = 0;
  while (n < line.length && isWs(line[n])) n++;
  return n;
};

const BOOL_RE = /^(?:true|false|yes|no|on|off)$/i;
const NULL_RE = /^(?:null|~)$/i;
const NUM_RE = /^[-+]?(?:0x[0-9a-fA-F]+|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?)$/;

/** A plain scalar read as one of the scalar classes; everything else is just a string. */
function classifyScalar(word: string): string {
  if (BOOL_RE.test(word)) return "boolean";
  if (NULL_RE.test(word)) return "null";
  if (NUM_RE.test(word)) return "number";
  return "string";
}

// Block header: |/> with chomping and/or an indent digit (either order) and
// an optional trailing comment -- and nothing else to the end of line.
const BLOCK_HEADER_RE = /^[|>](?:[+-]\d|\d[+-]|[+-]|\d)?[ \t]*(?:#.*)?$/;
const BLOCK_INDICATOR_RE = /^[|>](?:[+-]\d|\d[+-]|[+-]|\d)?/;

/** The registry entry for this lang (assembly list: index.ts). */
export const YAML_SYNTAX: SyntaxDef = {
  lang: "yaml",
  tokenize: tokenizeYaml,
  aliases: ["yml"],
  extensions: ["yaml", "yml"],
};
