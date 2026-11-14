/**
 * Shared syntax tokenizer registry: pure text -> typed token runs, with no
 * palette and no ANSI. Sinks own the coloring (terminal palettes, webui CSS
 * classes); the tokenizers only classify.
 *
 * A language registers as a SyntaxDef: the canonical name, the tokenizer,
 * and the metadata every sink used to hand-maintain its own copy of --
 * fence-info aliases (markdown) and file-name guesses (webui file-view:
 * extensions plus dotless basenames like Dockerfile). Each def lives in
 * the file of the tokenizer it describes; the BUILTINS list below is the
 * single assembly point. A def with no tokenize is a lang driven outside
 * this registry (markdown: its scanner is stateful and lives in
 * markdown.ts) -- guessLangForBase answers the name, getTokenizer answers
 * undefined, and the sink renders plain text.
 *
 * Registration is replace-per-field: re-registering a lang keeps the
 * fields the new def omits, so registerTokenizer(lang, fn) retargets a
 * scanner without wiping its aliases. Canonical names resolve exactly as
 * registered; alias and extension keys index case-insensitively, and a
 * later registration wins a collision. Every lookup is a Map read: a lang
 * name shadowing Object.prototype misses, never resolves.
 *
 * Styling is NOT the registry's job: sinks own their palettes and unknown
 * token classes render unstyled by design -- a custom extension lang
 * renders with structure only until the house knows its classes.
 */

import { C_SYNTAX } from "./c.ts";
import { CS_SYNTAX } from "./cs.ts";
import { CSS_SYNTAX } from "./css.ts";
import { DART_SYNTAX } from "./dart.ts";
import { DOCKERFILE_SYNTAX } from "./dockerfile.ts";
import { ENV_SYNTAX } from "./env.ts";
import { GITIGNORE_SYNTAX } from "./gitignore.ts";
import { GO_SYNTAX } from "./go.ts";
import { GRAPHQL_SYNTAX } from "./graphql.ts";
import { GROOVY_SYNTAX } from "./groovy.ts";
import { HTML_SYNTAX } from "./html.ts";
import { INI_SYNTAX } from "./ini.ts";
import { JAVA_SYNTAX } from "./java.ts";
import { JAVASCRIPT_SYNTAX } from "./javascript.ts";
import { JSON_SYNTAX } from "./json.ts";
import { KOTLIN_SYNTAX } from "./kotlin.ts";
import { LUA_SYNTAX } from "./lua.ts";
import { MAKE_SYNTAX } from "./make.ts";
import { PHP_SYNTAX } from "./php.ts";
import { PYTHON_SYNTAX } from "./python.ts";
import { RUBY_SYNTAX } from "./ruby.ts";
import { RUST_SYNTAX } from "./rust.ts";
import { SHELL_SYNTAX } from "./shell.ts";
import { SQL_SYNTAX } from "./sql.ts";
import { TOML_SYNTAX } from "./toml.ts";
import { TYPESCRIPT_SYNTAX } from "./typescript.ts";
import { XML_SYNTAX } from "./xml.ts";
import { YAML_SYNTAX } from "./yaml.ts";

/** One token run: a contiguous slice of the input sharing a token class. */
export interface SyntaxRun {
  /** Tokenizer-defined class, e.g. "command"/"operator"/"default" for
   * shell. Renderers style the classes they know and pass the rest through
   * unstyled. */
  type: string;
  text: string;
}

/** Splits text into ordered token runs. Contract: concatenating every
 * run's text reproduces the input exactly (lossless, no reordering). */
export type SyntaxTokenizer = (text: string) => SyntaxRun[];

/** A language as the registry knows it: the scanner plus the name metadata
 * the sinks consult. Metadata is data, never callbacks -- guessing stays a
 * table lookup any sink can run blind. */
export interface SyntaxDef {
  /** Canonical lang name (getTokenizer's key; fences resolve to it). */
  lang: string;
  /** The scanner; absent means guess-but-plain (see the header). */
  tokenize?: SyntaxTokenizer;
  /** Fence-info words that resolve to this lang (`py` -> python). Aliases
   * never become file extensions: a source file's extension is the def's
   * own choice, not a spelling accident. */
  aliases?: readonly string[];
  /** Dotless file extensions that guess this lang (`c`, `hpp`). */
  extensions?: readonly string[];
  /** Basenames matching exactly or as a `<name>.` prefix, case-insensitive
   * -- the Dockerfile shape: no extension to guess from, and the variant
   * spelling (`Dockerfile.dev`) must not fall through to a `.dev` guess.
   * Basenames outrank extensions. */
  basenames?: readonly string[];
}

const SYNTAXES = new Map<string, SyntaxDef>();
const ALIASES = new Map<string, string>(); // lowercase alias -> canonical lang
const EXTENSIONS = new Map<string, string>(); // lowercase extension -> canonical lang
const BASENAMES: { name: string; lang: string }[] = []; // lowercase, in registration order

// One entry per scanner family. jsx/tsx are ALIASES of their scanner's
// def, not second names: one def, one place to know the family exists.
const BUILTINS: readonly SyntaxDef[] = [
  SHELL_SYNTAX,
  YAML_SYNTAX,
  JSON_SYNTAX,
  CSS_SYNTAX,
  HTML_SYNTAX,
  TOML_SYNTAX,
  INI_SYNTAX,
  XML_SYNTAX,
  PYTHON_SYNTAX,
  JAVASCRIPT_SYNTAX,
  TYPESCRIPT_SYNTAX,
  C_SYNTAX,
  DOCKERFILE_SYNTAX,
  GO_SYNTAX,
  SQL_SYNTAX,
  MAKE_SYNTAX,
  ENV_SYNTAX,
  GITIGNORE_SYNTAX,
  GRAPHQL_SYNTAX,
  LUA_SYNTAX,
  RUST_SYNTAX,
  PHP_SYNTAX,
  JAVA_SYNTAX,
  CS_SYNTAX,
  RUBY_SYNTAX,
  KOTLIN_SYNTAX,
  GROOVY_SYNTAX,
  DART_SYNTAX,
  // Metadata-only registrations: names the file view guesses honestly
  // while getTokenizer stays undefined (the registry contract). markdown
  // is deliberately stateless-registry-less -- the sink drives its
  // stateful scanner (markdown.ts).
  { lang: "markdown", extensions: ["md", "markdown"] },
];

/** Register (or replace fields of) a language. Provide only what changes:
 * fields the def omits keep their previous values, so a plain
 * re-registration never strips metadata. Aliases/extensions/basenames are
 * REPLACED as a whole, never appended to. */
export function registerSyntax(def: SyntaxDef): void {
  const prev = SYNTAXES.get(def.lang);
  SYNTAXES.set(def.lang, {
    lang: def.lang,
    tokenize: def.tokenize ?? prev?.tokenize,
    aliases: def.aliases ?? prev?.aliases,
    extensions: def.extensions ?? prev?.extensions,
    basenames: def.basenames ?? prev?.basenames,
  });
  reindex();
}

/** Register (or replace) the tokenizer for a lang name; metadata the lang
 * already carries survives. */
export function registerTokenizer(lang: string, tokenizer: SyntaxTokenizer): void {
  registerSyntax({ lang, tokenize: tokenizer });
}

/** Look up a tokenizer by lang name; undefined means no tokenizer --
 * unknown lang or a guess-only def -- and the caller renders plain text. */
export function getTokenizer(lang: string): SyntaxTokenizer | undefined {
  return SYNTAXES.get(lang)?.tokenize;
}

/** Resolve a fence-info word to a canonical lang that HAS a tokenizer
 * (the word itself, or a registered alias; the caller owns any
 * lowercasing). Undefined means the fence renders as plain code. */
export function resolveSyntaxLang(word: string): string | undefined {
  if (SYNTAXES.get(word)?.tokenize) return word;
  const canon = ALIASES.get(word.toLowerCase());
  return canon !== undefined && SYNTAXES.get(canon)?.tokenize ? canon : undefined;
}

/** Guess the lang for one file BASENAME (no path): registered basenames
 * first (exact or `<name>.` prefix, case-insensitive -- `Dockerfile.dev`
 * outranks any lang that might ever claim `.dev`), then the extension
 * after the last dot. A dotless or dot-first name with no basename match
 * misses; an extension no def claims misses. */
export function guessLangForBase(base: string): string | undefined {
  const lower = base.toLowerCase();
  for (const b of BASENAMES) {
    if (lower === b.name || lower.startsWith(b.name + ".")) return b.lang;
  }
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return EXTENSIONS.get(lower.slice(dot + 1));
}

/** Rebuild the alias/extension/basename indexes from the defs. Registration
 * is rare (boot, or an extension author once); guessing is a Map read. */
function reindex(): void {
  ALIASES.clear();
  EXTENSIONS.clear();
  BASENAMES.length = 0;
  for (const def of SYNTAXES.values()) {
    for (const alias of def.aliases ?? []) ALIASES.set(alias.toLowerCase(), def.lang);
    for (const ext of def.extensions ?? []) EXTENSIONS.set(ext.toLowerCase(), def.lang);
    for (const name of def.basenames ?? []) BASENAMES.push({ name: name.toLowerCase(), lang: def.lang });
  }
}

for (const def of BUILTINS) registerSyntax(def);
