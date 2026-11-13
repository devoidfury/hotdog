import type { SyntaxRun } from "./index.ts";
import { tokenizeWith, JS_KEYWORDS, JS_CONTEXTUAL, type IdentCtx } from "./javascript.ts";

/**
 * TypeScript tokenizer: the JavaScript scanning core (`tokenizeWith`) over
 * a bigger keyword set plus one type-position pass. Nothing about strings,
 * templates, comments, numbers, regexes or JSX degradation changes -- see
 * javascript.ts for the shared doctrine and its honest limits.
 *
 * What TS adds: "keyword" for interface, enum, implements, declare,
 * namespace, abstract, readonly, keyof, infer, is, satisfies, override,
 * public/private/protected and friends (reserved-flavored; the JS
 * contextual set carries over unchanged, joined by `type`, whose object
 * key `{ type: ... }` still wins), and "type" for an identifier right
 * after a colon whose shape reads as a type: a known primitive
 * (string, number, unknown, never, ...) or a Capitalized name; also after
 * interface/extends/implements/as/is/keyof/infer/satisfies. Object-key
 * detection still wins over type (a colon-glued word is a key first), and
 * after a dot nothing but literals classes apply. Honest limits: a
 * lowercase value in an object literal after a colon (`{ a: Foo }` paints
 * Foo) and ternary alternatives can misread, generics and conditional
 * types ride the angle-bracket degradation, and a lowercase type alias
 * (`x: myType`) stays default. Nothing is ever dropped or reordered:
 * concatenating every run reproduces the input exactly, for any input.
 * This is display candy, not a type checker.
 */
export function tokenizeTypeScript(text: string): SyntaxRun[] {
  return tokenizeWith(text, {
    keywords: TS_KEYWORDS,
    contextual: TS_CONTEXTUAL,
    identify: classifyTypePosition,
  });
}

/** Colon-annotation pass: the word right after `:` that reads as a type,
 * or a Capitalized name right after interface/extends/implements/type. */
function classifyTypePosition(word: string, ctx: IdentCtx): string | undefined {
  const afterColon = ctx.prevType === "operator" && ctx.prevText === ":";
  const afterNameKeyword = ctx.prevType === "keyword" && DECLARE_AHEAD.has(ctx.prevText);
  if (!afterColon && !afterNameKeyword) return undefined;
  if (PRIMITIVE_TYPES.has(word)) return "type";
  return /^[A-Z]/.test(word) ? "type" : undefined;
}

/** The JS reserved set plus the TS ones that are always keywords. */
const TS_KEYWORDS: ReadonlySet<string> = new Set([
  ...JS_KEYWORDS,
  "abstract",
  "declare",
  "enum",
  "implements",
  "infer",
  "interface",
  "is",
  "keyof",
  "namespace",
  "override",
  "private",
  "protected",
  "public",
  "readonly",
  "satisfies",
]);

/** TS contextual words (object keys win before a glued colon) on top of
 * the JS set; `type` is the prominent one. */
const TS_CONTEXTUAL: ReadonlySet<string> = new Set([...JS_CONTEXTUAL, "type", "module", "require"]);

const DECLARE_AHEAD = new Set([
  "interface",
  "extends",
  "implements",
  "enum",
  "type",
  "as",
  "satisfies",
  "is",
  "keyof",
  "infer",
]);

const PRIMITIVE_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "object",
  "unknown",
  "never",
  "any",
  "void",
]);
