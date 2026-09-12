// Best-effort bash command-line triage for the tool-call approvals layer.
//
// WHAT THIS IS: a convenience filter so an honest `git push` can be allowed
// without prompting. It segments on `;` `&&` `||` `|` `&` and newlines (every
// segment must pass), tracks `cd` so later segments resolve against the right
// directory, and gives up -- BAIL, which means ASK -- the moment the command
// contains anything that could hide an effect: expansions, substitutions,
// groups, globs, heredocs, or the interpreters/utilities whose arguments are
// programs rather than data.
//
// WHAT THIS IS NOT: a security boundary. It is not a shell parser; it does not
// model aliases, functions, PATH tricks or quoting games, and it never has to
// be right -- when it is unsure it asks. Enforcement is the sysbox fence
// (`bashTool.sandbox: "fence"`), which applies whether or not approvals are
// on. See docs/config-reference.md "userGate".

import { resolve as resolveAbs } from "node:path";
import type { Workspace } from "@utils/workspace.ts";
import type { ApprovalTarget } from "./rules.ts";

export type BashParse = { ok: true; targets: ApprovalTarget[] } | { ok: false; reason: string };

/** Commands that run programs or rewrite the command stream: always bail. */
const ALWAYS_BAIL = new Set(["eval", "env", "xargs"]);

/** Commands that bail when handed an inline-program flag. */
const INLINE_CODE_FLAGS: Record<string, string[]> = {
  sh: ["-c"],
  bash: ["-c"],
  zsh: ["-c"],
  dash: ["-c"],
  python: ["-c"],
  python2: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
};

/** `awk` takes its program as an argument, always. */
const ALWAYS_INLINE_INTERPRETERS = new Set(["awk", "gawk", "mawk"]);

/** `find` can execute and delete on its own. */
const FIND_BAIL_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete"]);

/** Redirection targets that discard or replay output instead of data at risk. */
const INERT_TARGETS = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/fd"];

interface Word {
  text: string;
  /** Some part came from a quote, so the shell sees it literally. */
  quoted: boolean;
}

type Token = { type: "word"; word: Word } | { type: "op"; op: string };

const SEPARATORS = new Set([";", "&&", "||", "|", "&"]);
const REDIRECTS = new Set([">", ">>", "<", "<<", "<<<", "<>", ">&", "<&"]);

/**
 * Shell-ish tokenizer: quotes, backslash escapes, comments, operators. The
 * bail rules are checked here, at character level, because this is the only
 * place quoting is known (a `*` inside quotes is a filename, outside it is a
 * glob).
 */
function tokenize(src: string): Token[] | { ok: false; reason: string } {
  const tokens: Token[] = [];
  let word: Word | null = null;

  const pushWord = () => {
    if (word) {
      tokens.push({ type: "word", word });
      word = null;
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    if (ch === " " || ch === "\t" || ch === "\r") {
      pushWord();
      i++;
      continue;
    }
    if (ch === "\n") {
      pushWord();
      tokens.push({ type: "op", op: ";" });
      i++;
      continue;
    }
    // Comments start a comment only at a word boundary, as in bash.
    if (ch === "#" && !word) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }

    const w: Word = word ?? { text: "", quoted: false };

    if (ch === "\\") {
      const next = src[i + 1];
      if (next === undefined) return { ok: false, reason: "trailing backslash" };
      // Line continuation joins the lines; any other escape is a literal char.
      if (next !== "\n") w.text += next;
      word = w;
      i += 2;
      continue;
    }

    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return { ok: false, reason: "unbalanced single quote" };
      w.text += src.slice(i + 1, end);
      w.quoted = true;
      word = w;
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let body = "";
      let closed = false;
      while (j < src.length) {
        if (src[j] === "\\") {
          body += src[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          closed = true;
          break;
        }
        // Expansions stay live inside double quotes.
        if (src[j] === "$" || src[j] === "`") {
          return { ok: false, reason: `shell expansion inside double quotes ("${src[j]}")` };
        }
        body += src[j];
        j++;
      }
      if (!closed) return { ok: false, reason: "unbalanced double quote" };
      w.text += body;
      w.quoted = true;
      word = w;
      i = j + 1;
      continue;
    }

    if (ch === "`") return { ok: false, reason: "command substitution (backticks)" };
    if (ch === "$") return { ok: false, reason: "shell expansion ($...)" };
    if (ch === "(" || ch === ")") return { ok: false, reason: "subshell or parenthesised group" };
    if (ch === "{" || ch === "}") return { ok: false, reason: "brace group or brace expansion" };
    if (ch === "~") return { ok: false, reason: "home-directory (~) expansion" };
    if (ch === "*" || ch === "?" || ch === "[" || ch === "]") {
      return { ok: false, reason: "unquoted glob pattern" };
    }

    // Operators, longest match first (so `<<<` beats `<<` beats `<`).
    let matchedOp: string | null = null;
    for (const len of [3, 2, 1]) {
      const slice = src.slice(i, i + len);
      if (REDIRECTS.has(slice) || SEPARATORS.has(slice)) {
        matchedOp = slice;
        break;
      }
    }
    if (matchedOp) {
      pushWord();
      tokens.push({ type: "op", op: matchedOp });
      i += matchedOp.length;
      continue;
    }

    w.text += ch;
    word = w;
    i++;
  }
  pushWord();
  return tokens;
}

/** True when a word looks like a filesystem path rather than a plain word. */
function looksLikePath(text: string): boolean {
  return text.startsWith("/") || text.startsWith("./") || text.startsWith("../") || text.includes("/");
}

function basename(text: string): string {
  const parts = text.split("/");
  return parts[parts.length - 1] || text;
}

function isDigits(text: string): boolean {
  return /^\d+$/.test(text);
}

/**
 * Extract approval targets from a bash command line, or explain why the
 * command cannot be analyzed (the caller turns that into an ASK).
 *
 * - `cmd`: each segment's command basename -- must be allowed.
 * - `path`: path-shaped arguments and redirection targets, resolved against
 *   the segment's directory (after `cd`) -- must be allowed. A bare filename
 *   with no `/` is NOT treated as a path (it would demand a rule for every
 *   `git checkout main`); it lands in `arg`.
 * - `arg`: flags and non-path words -- opaque, deny-matchable only.
 */
export function parseCommandline(command: string, workspace: Workspace): BashParse {
  if (typeof command !== "string") return { ok: false, reason: "command is not a string" };
  const tokenized = tokenize(command);
  if (!Array.isArray(tokenized)) return tokenized;

  // Split into segments on the control operators.
  const segments: Token[][] = [[]];
  for (const tok of tokenized) {
    if (tok.type === "op" && SEPARATORS.has(tok.op)) {
      segments.push([]);
      continue;
    }
    segments[segments.length - 1]!.push(tok);
  }

  const targets: ApprovalTarget[] = [];
  let base = workspace.root;
  let analyzed = 0;

  const pushPathTarget = (text: string) => {
    const target = resolvePathTarget(workspace, base, text);
    if (target) targets.push(target);
  };

  for (const segment of segments) {
    if (segment.length === 0) continue;
    const words = segment.filter((t): t is { type: "word"; word: Word } => t.type === "word");
    if (words.length === 0) return { ok: false, reason: "dangling operator" };
    analyzed++;

    const cmd = basename(words[0]!.word.text);
    if (words[0]!.word.quoted) return { ok: false, reason: "the command name itself is quoted" };
    if (ALWAYS_BAIL.has(cmd)) return { ok: false, reason: `'${cmd}' runs arbitrary programs` };
    if (ALWAYS_INLINE_INTERPRETERS.has(cmd)) return { ok: false, reason: `'${cmd}' takes its program as an argument` };
    const inlineFlags = INLINE_CODE_FLAGS[cmd];
    if (inlineFlags && words.slice(1).some((w) => inlineFlags.includes(w.word.text))) {
      return { ok: false, reason: `'${cmd}' is running inline code` };
    }
    if (cmd === "find" && words.some((w) => FIND_BAIL_FLAGS.has(w.word.text))) {
      return { ok: false, reason: "find is executing or deleting" };
    }

    targets.push({ param: "cmd", value: cmd });

    let cdHandled = false;
    for (const { text, quoted } of words.slice(1).map((w) => w.word)) {
      if (text === "") continue;
      if (text.startsWith("-") && !quoted) continue; // flags are not targets

      if (cmd === "cd" && !cdHandled) {
        cdHandled = true;
        const next = resolveAbs(base, text);
        if (!workspace.contains(next)) {
          return { ok: false, reason: `cd leaves the workspace roots (${next})` };
        }
        base = next;
        continue;
      }

      if (looksLikePath(text)) {
        pushPathTarget(text);
      } else {
        targets.push({ param: "arg", value: text, denyOnly: true });
      }
    }

    if (cmd === "cd" && !cdHandled) {
      return { ok: false, reason: "cd without a directory target (it would leave the workspace)" };
    }

    // Redirections are writes (or reads) with a nameable target.
    for (let ti = 0; ti < segment.length; ti++) {
      const tok = segment[ti]!;
      if (tok.type !== "op" || !REDIRECTS.has(tok.op)) continue;
      if (tok.op === "<<" || tok.op === "<<<") return { ok: false, reason: "here-document / here-string" };

      const next = segment.slice(ti + 1).find((t) => t.type === "word") as
        | { type: "word"; word: Word }
        | undefined;
      if (!next || next.word.text === "") {
        return { ok: false, reason: `redirection '${tok.op}' without a plain file target` };
      }
      // `>&1` / `<&0` duplicate descriptors: no file involved.
      if ((tok.op === ">&" || tok.op === "<&") && isDigits(next.word.text)) continue;
      pushPathTarget(next.word.text);
    }
  }

  if (analyzed === 0) return { ok: false, reason: "nothing to analyze" };
  // One value reached twice (an argument and its own redirection) is one ask.
  const seen = new Set<string>();
  return {
    ok: true,
    targets: targets.filter((t) => {
      const key = `${t.param}\u0000${t.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

/** Resolve a path argument to a target, or null for sinks (/dev/null & co). */
function resolvePathTarget(workspace: Workspace, base: string, text: string): ApprovalTarget | null {
  const value = resolveAbs(base, text);
  if (INERT_TARGETS.some((p) => value === p || value.startsWith(`${p}/`))) return null;
  const relative = workspace.relative(value);
  return { param: "path", value, ...(relative !== null ? { relative } : {}), pathy: true };
}
