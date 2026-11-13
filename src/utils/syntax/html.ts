import type { SyntaxRun } from "./index.ts";

/**
 * HTML tokenizer.
 *
 * One pass over text and markup: outside tags, "&amp;"-style named and
 * numeric character references are "entity" and everything else is
 * "default" prose (script and style bodies ride prose too -- no nested
 * language parsing). `<!--` opens a "comment" through the closer or end of
 * input; `<!DOCTYPE ...>` (any case) is one "doctype" run through the `>`;
 * other `<!`/`<?` decl junk reads as default until its `>`. A tag is
 * `<` (plus optional closing `/`) as "operator", the tag name as "name"
 * (the class avoids the yaml tokenizer's "tag", which means `!!str`),
 * attribute names as "attribute", `=` `/` `>` as "operator", and attribute
 * attribute values as "string" -- quoted (stops at the closing quote or a
 * newline; `>` inside quotes stays inside, like the browsers) or bare (run
 * to whitespace or `>`). A `<`
 * that opens nothing (5 < 6) is plain "default" text. Unterminated markup
 * runs to end of input; nothing is dropped or reordered: concatenating
 * every run reproduces the input exactly, for any input. This is display
 * candy, not an HTML parser: no content model, no entity validation, no
 * raw-text-element awareness.
 */
export function tokenizeHtml(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  const push = (type: string, chunk: string): void => {
    if (chunk !== "") runs.push({ type, text: chunk });
  };

  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      pushProse(text.slice(i), push);
      break;
    }
    if (lt > i) pushProse(text.slice(i, lt), push);
    i = lt;

    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      const j = end === -1 ? n : end + 3;
      push("comment", text.slice(i, j));
      i = j;
      continue;
    }
    if (/^<!doctype\b/i.test(text.slice(i))) {
      const end = text.indexOf(">", i);
      const j = end === -1 ? n : end + 1;
      push("doctype", text.slice(i, j));
      i = j;
      continue;
    }
    if (text.startsWith("<!", i) || text.startsWith("<?", i)) {
      const end = text.indexOf(">", i + 2);
      const j = end === -1 ? n : end + 1;
      push("default", text.slice(i, j));
      i = j;
      continue;
    }
    let j = i + 1;
    let closing = false;
    if (text[j] === "/") {
      closing = true;
      j++;
    }
    if (j >= n || !TAG_NAME_RE.test(text[j]!)) {
      push("default", "<"); // a stray <: prose, not markup
      i++;
      continue;
    }
    push("operator", closing ? "</" : "<");
    const nameStart = j;
    while (j < n && TAG_NAME_RE.test(text[j]!)) j++;
    push("name", text.slice(nameStart, j));
    i = scanTagRest(text, j, push);
  }
  return runs;
}

/** Attribute list through the tag's `>` (or end of input for an
 * unterminated tag). Returns the index after the closer when found. */
function scanTagRest(text: string, from: number, push: (type: string, chunk: string) => void): number {
  const n = text.length;
  let i = from;
  while (i < n) {
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
      let k = i;
      while (k < n && /\s/.test(text[k]!)) k++;
      push("default", text.slice(i, k));
      i = k;
      continue;
    }
    if (c === ">") {
      push("operator", ">");
      return i + 1;
    }
    if (c === "/") {
      push("operator", "/");
      i++;
      continue;
    }
    if (c === "=") {
      push("operator", "=");
      i++;
      // Optional whitespace, then the value (quoted or bare).
      let k = i;
      while (k < n && /\s/.test(text[k]!)) k++;
      if (k > i) push("default", text.slice(i, k));
      i = k;
      if (text[i] === '"' || text[i] === "'") {
        const end = endOfString(text, i);
        push("string", text.slice(i, end));
        i = end;
      } else {
        let e = i;
        while (e < n && !/\s|>/.test(text[e]!)) e++;
        push("string", text.slice(i, e));
        i = e;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      // A stray quote at attribute position (no `=`): read it as a value.
      const end = endOfString(text, i);
      push("string", text.slice(i, end));
      i = end;
      continue;
    }
    let k = i;
    while (k < n && !/\s|=|>|\/|["']/.test(text[k]!)) k++;
    push("attribute", text.slice(i, k));
    i = k;
  }
  return n;
}

/** Prose text: character references split out, everything else one run. */
function pushProse(chunk: string, push: (type: string, text: string) => void): void {
  const n = chunk.length;
  let i = 0;
  let plain = 0;
  while (i < n) {
    if (chunk[i] === "&") {
      const m = ENTITY_RE.exec(chunk.slice(i));
      if (m) {
        push("default", chunk.slice(plain, i));
        push("entity", m[0]);
        i += m[0].length;
        plain = i;
        continue;
      }
    }
    i++;
  }
  push("default", chunk.slice(plain));
}

const TAG_NAME_RE = /[a-zA-Z]/;
const ENTITY_RE = /^&(?:[a-zA-Z][a-zA-Z0-9]{1,30}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/;

/** End index just past the quoted string opened at `from` (quotes
 * included). An unterminated value stops before a newline or the end of
 * input, never at a `>` (quoted values legitimately contain `>`). Entity
 * refs never terminate a value: the scan stops only on the raw quote char. */
function endOfString(text: string, from: number): number {
  const quote = text[from]!;
  let j = from + 1;
  while (j < text.length) {
    const d = text[j]!;
    if (d === "\n" || d === "\r") return j;
    if (d === quote) return j + 1;
    j++;
  }
  return text.length;
}
