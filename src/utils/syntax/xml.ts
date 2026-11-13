import type { SyntaxDef, SyntaxRun } from "./index.ts";
import { tokenizeMarkup } from "./html.ts";

/**
 * XML tokenizer: the html markup scanner (`tokenizeMarkup` in html.ts) over
 * the XML dialect -- tag names keep the spec's charset (colons, dots,
 * dashes: `<soap:Envelope>` is one "name" run, and the scan never case
 * folds, so tag names read case-sensitively the way XML demands), a
 * `<![CDATA[...]]>` section is one "string" run through its closer or end
 * of input, and a processing instruction `<?...?>` rides "doctype" beside
 * the real doctype (both are the file's loud declarations).
 *
 * What is deliberately NOT XML-strict: attribute values may be bare (the
 * tolerant html scan is reused; the spec requires quotes, an unquoted value
 * still classifies), the doctype test stays case-insensitive (the spec
 * spells it uppercase), a PI cuts at the first `>` rather than `?>`, and a
 * DTD internal subset rides the doctype's `>` stop (no DTD parsing). The
 * cross-reading is accepted and symmetric: HTML comments and character
 * references are the same syntax, so each lang's comments/entities classify
 * in the other, and HTML-ish junk (`<!ENTITY`-style decls) rides default
 * until its `>` in both. Everything else holds from html.ts: pure,
 * lossless (concatenating every run reproduces the input exactly, for any
 * input), sane per line, unterminated markup runs to end of input. This is
 * display candy, not an XML parser: no well-formedness, no namespace
 * resolution, no entity validation.
 */
export function tokenizeXml(text: string): SyntaxRun[] {
  return tokenizeMarkup(text, { nameRest: /[A-Za-z0-9:._\-]/, cdata: true, piType: "doctype" });
}

/** The registry entry for this lang (assembly list: index.ts). */
export const XML_SYNTAX: SyntaxDef = {
  lang: "xml",
  tokenize: tokenizeXml,
  extensions: ["xml"],
};
