// Best-effort bash command-line triage for the tool-call approvals layer.
//
// WHAT THIS IS: a convenience filter so `git status` and other commands can be allowed without prompting.
// It segments on `;` `&&` `||` `|` `&` and newlines (every segment must pass), tracks `cd` so later segments
// resolve against the right directory, and gives up (BAIL, which means ask or deny depending on config)
// the moment the command contains anything that could hide an effect: expansions, substitutions, groups, globs, heredocs,
// or the interpreters / utilities whose arguments are programs rather than data.
//
// WHAT THIS IS NOT: a security boundary. It is not a shell parser; it does not model aliases, functions,
// PATH tricks or quoting games -- when it is unsure it asks. Nothing below it enforces any boundaries. See docs/config-reference.md "userGate".

import { resolve as resolveAbs } from "node:path";
import type { Workspace } from "@utils/workspace.ts";
import type { ApprovalTarget } from "./rules.ts";

export type BashParse = { ok: true; targets: ApprovalTarget[] } | { ok: false; reason: string };

/**
 * Commands that run programs, or that hide the real argv[0] behind themselves: always bail.
 * The wrappers (`time`, `nohup`, `sudo`, ...) belong here because every check below inspects
 * only argv[0]'s family: `nohup perl -e '...'` must not parse as a clean `nohup` when `perl`
 * is denied, and a `node` allow for `node build.js` must not admit a wrapped payload.
 */
const ALWAYS_BAIL = new Set([
  "eval", "env", "xargs",
  "time", "nohup", "command", "exec", "sudo", "doas", "nice",
  "setsid", "timeout", "stdbuf", "watch", "parallel",
]);

/** Commands that bail when handed an inline-program flag. */
const INLINE_CODE_FLAGS: Record<string, string[]> = {
  sh: ["-c"],
  bash: ["-c"],
  zsh: ["-c"],
  dash: ["-c"],
  python: ["-c"],
  python2: ["-c"],
  python3: ["-c"],
  // `-p`/`--print` eval their argument like `-e` does; startsWith("-p") also
  // catches the bundled `node -pe '...'` form.
  node: ["-e", "--eval", "-p", "--print"],
  perl: ["-e", "-E"],
  ruby: ["-e", "--eval"],
};

/** `awk` takes its program as an argument, always. */
const ALWAYS_INLINE_INTERPRETERS = new Set(["awk", "gawk", "mawk"]);

/** `find` can execute and delete on its own. */
const FIND_BAIL_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete"]);

/** sh-family accepts bundled one-letter flags: `-lc`, `-lxc` all turn on `-c`. */
const SH_FAMILY = new Set(["sh", "bash", "zsh", "dash"]);
/** Any bundled sh flag word containing `c` runs the argument as a program. */
const SH_C_BUNDLE = /^-[a-zA-Z]*c/;
/** perl bundles its code flags too: `-le`, `-lE`, `-MPOSIX -e`-style words ending in a bare `e`/`E`. */
const PERL_E_BUNDLE = /^-[a-zA-Z]*[eE]/;
/** ruby bundles `e` (`-ne`, `-pe`) but only lowercase: `-E` sets the encoding, not the program. */
const RUBY_E_BUNDLE = /^-[a-zA-Z]*e/;

/**
 * Does this argument word turn the interpreter into a code runner? Catches the
 * exact flag, bundled sh forms (`bash -lc '...'`), bundled perl/ruby forms
 * (`perl -le '...'`, `ruby -ne '...'`), and flags glued to their operand
 * (`python -c'print(1)'`, `node -e'...'` -- the tokenizer quotes the glued
 * tail, exact matching alone misses both). Unknown bundlings of these
 * commands bail too: an honest allow-rule workflow never needs them, and when
 * unsure this layer asks.
 */
function runsInlineCode(cmd: string, inlineFlags: string[], text: string): boolean {
  if (!text.startsWith("-")) return false;
  if (SH_FAMILY.has(cmd) && SH_C_BUNDLE.test(text)) return true;
  if (cmd === "perl" && PERL_E_BUNDLE.test(text)) return true;
  if (cmd === "ruby" && RUBY_E_BUNDLE.test(text)) return true;
  return inlineFlags.some((flag) => text.startsWith(flag));
}

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
 * Extract approval targets from a bash command line, or explain why the command cannot be analyzed.
 *
 * - `cmd`: each segment's command basename -- must be allowed. A path-shaped argv[0] (`/tmp/git`, `./run.sh`)
 *          ALSO emits a `path` target for its resolved location: sharing a basename with an allowed command
 *          must not admit a planted binary.
 * - `path`: path-shaped arguments and redirection targets, resolved against the segment's directory (after `cd`) -- must be allowed.
 *           A bare filename with no `/` is NOT an allow-demanded path (it would demand a rule for every `git checkout main`); it lands in `arg`,
 *           and ALSO as a denyOnly `path` target so path deny rules still reach it.
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

    const argv0 = words[0]!.word.text;
    const cmd = basename(argv0);
    if (words[0]!.word.quoted) return { ok: false, reason: "the command name itself is quoted" };
    if (ALWAYS_BAIL.has(cmd)) return { ok: false, reason: `'${cmd}' runs arbitrary programs` };
    if (ALWAYS_INLINE_INTERPRETERS.has(cmd)) return { ok: false, reason: `'${cmd}' takes its program as an argument` };
    const inlineFlags = INLINE_CODE_FLAGS[cmd];
    if (inlineFlags && words.slice(1).some((w) => runsInlineCode(cmd, inlineFlags, w.word.text))) {
      return { ok: false, reason: `'${cmd}' is running inline code` };
    }
    if (cmd === "find" && words.some((w) => FIND_BAIL_FLAGS.has(w.word.text))) {
      return { ok: false, reason: "find is executing or deleting" };
    }

    targets.push({ param: "cmd", value: cmd });
    // A path-shaped argv[0] must also be allow-demanded as a path: sharing a
    // basename with an allowed command must not admit a planted `/tmp/git`.
    if (looksLikePath(argv0)) pushPathTarget(argv0);

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
        // `rm secrets.env` names a file just as much as `rm ./secrets.env`
        // does, and deny is the one verdict that must never miss: also emit
        // the bare word as a denyOnly path target resolved against the
        // cd-tracked base, so `bash.path=**/secrets.env`-style denies reach it.
        // denyOnly keeps allow behavior unchanged (no rule demanded for
        // `git checkout main`).
        const bareFile = resolvePathTarget(workspace, base, text);
        if (bareFile) targets.push({ ...bareFile, denyOnly: true });
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
  // One value reached twice (a bare-word argument and its own redirection) is
  // one ask -- and the STRONGER form wins: an allow-demanded target replaces
  // the denyOnly shadow the bare-word pass emitted for the same path, so
  // `echo hi > out.txt` still demands a path allow.
  const byKey = new Map<string, ApprovalTarget>();
  for (const t of targets) {
    const key = `${t.param}\u0000${t.value}`;
    const prev = byKey.get(key);
    if (!prev || (prev.denyOnly && !t.denyOnly)) byKey.set(key, t);
  }
  return { ok: true, targets: [...byKey.values()] };
}

/** Resolve a path argument to a target, or null for sinks (/dev/null & co). */
function resolvePathTarget(workspace: Workspace, base: string, text: string): ApprovalTarget | null {
  const value = resolveAbs(base, text);
  if (INERT_TARGETS.some((p) => value === p || value.startsWith(`${p}/`))) return null;
  const relative = workspace.relative(value);
  return { param: "path", value, ...(relative !== null ? { relative } : {}), pathy: true };
}
