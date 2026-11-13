import type { SyntaxDef, SyntaxRun } from "./index.ts";

/**
 * Shell tokenizer.
 *
 * Token order: quoted strings, then the two-word operators (before their one-word prefixes),
 * then | ; & singly, then whitespace, then plain words (&|; excluded so glued operators split),
 * then a stray quote. Command words (line start, after &&, ||, | or ;) are typed "command";
 * control operators "operator"; everything else "default". An env-assignment prefix (`FOO=1 cmd`)
 * is default but keeps the command position armed; a quoted word reads as itself and spends the position.
 * A lone `&` (background, `2>&1`) is not treated as an operator and passes through verbatim.
 * Backticks/$(...) are NOT parsed: this is display candy, not a shell. One run per token;
 * adjacent runs may share a type (sinks coalesce as they like).
 */
export function tokenizeShell(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  let cmdPos = true;
  for (const [t] of text.matchAll(
    /('[^']*'|"(?:[^"\\]|\\.)*"|\|\||&&|[|;&]|\s+|[^\s'";|&]+|['"])/g,
  )) {
    let type: string;
    if (t === "&&" || t === "||" || t === "|" || t === ";") {
      type = "operator";
      cmdPos = true;
    } else if (cmdPos && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      type = "default"; // env prefix: default, still command position
    } else if (cmdPos && /^["']/.test(t)) {
      type = "default"; // quoted word reads as itself; the position is spent
      cmdPos = false;
    } else if (cmdPos && !/^\s/.test(t)) {
      type = "command";
      cmdPos = false;
    } else {
      type = "default";
    }
    runs.push({ type, text: t });
  }
  return runs;
}

/** The registry entry for this lang (assembly list: index.ts). */
export const SHELL_SYNTAX: SyntaxDef = {
  lang: "shell",
  tokenize: tokenizeShell,
  aliases: ["sh", "bash", "zsh"],
  extensions: ["sh", "bash", "zsh"],
  // Dotfiles miss the last-dot rule; the basename index claims them.
  basenames: [".bashrc", ".bash_profile", ".zshrc", ".zshenv", ".profile"],
};
