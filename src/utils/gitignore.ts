import { posix } from "node:path";

const DEFAULT_IMPLICIT_PATTERNS = [".git"];

/**
 * Pattern tokens. Matching is done by walking tokens against the path string
 * with a failure memo, never by building a RegExp: a regex with several
 * wildcards in one segment (`*a*a*a*a*a*b`, legal gitignore syntax) blows up
 * catastrophically on non-matching inputs, and .gitignore content is
 * attacker-reachable.
 */
type Token =
  | { kind: "lit"; ch: string }
  | { kind: "star" } // `*`: any run of non-`/` chars
  | { kind: "any" } // `?`: one non-`/` char
  | { kind: "class"; negated: boolean; members: string[]; ranges: [string, string][] }
  | { kind: "crossStar" } // `**` NOT adjacent to a `/` boundary: house dialect, matches any run INCLUDING `/`
  | { kind: "dirGlob" } // boundary `**/`: zero or more whole segments
  | { kind: "deepInside" }; // trailing `/.../**`: `/` plus at least one more char ("everything inside")

interface Rule {
  tokens: Token[];
  anchored: boolean;
  negated: boolean;
  /** True for bodies that tokenize empty (e.g. the pattern `//`): match nothing. */
  neverMatch: boolean;
}

/** Parse a gitignore pattern body into tokens. Mirrors the classic scanner:
 * `[` opens a class only if a closing `]` exists (`!` and a leading `]` are
 * handled per git), `**` only gets whole-segment semantics adjacent to `/`. */
function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const boundary =
          (i === 0 || pattern[i - 1] === "/") &&
          (i + 2 === pattern.length || pattern[i + 2] === "/");
        if (!boundary) {
          tokens.push({ kind: "crossStar" });
          i += 2;
          continue;
        }
        if (i + 2 === pattern.length) {
          // Trailing `**`. With a preceding literal `/` it becomes
          // "everything inside" (git's `a/**` does not match `a` itself).
          // Otherwise (bare `**`, or the slash was eaten by a `**/`) it is a
          // greedy wildcard matching the whole remainder.
          const prev = tokens[tokens.length - 1];
          if (prev && prev.kind === "lit" && prev.ch === "/") {
            tokens[tokens.length - 1] = { kind: "deepInside" };
          } else {
            tokens.push({ kind: "crossStar" });
          }
          i += 2;
          continue;
        }
        // `**/`: zero or more whole directories; consume the trailing slash.
        tokens.push({ kind: "dirGlob" });
        i += 3;
        continue;
      }
      tokens.push({ kind: "star" });
      i++;
      continue;
    }
    if (ch === "?") {
      tokens.push({ kind: "any" });
      i++;
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      let negated = false;
      if (j < pattern.length && pattern[j] === "!") {
        negated = true;
        j++;
      }
      if (j < pattern.length && pattern[j] === "]") j++; // leading `]` is a literal member
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j < pattern.length) {
        const cls = pattern.slice(i + 1 + (negated ? 1 : 0), j);
        const members: string[] = [];
        const ranges: [string, string][] = [];
        for (let k = 0; k < cls.length; ) {
          // `x-y` is a range only when a char follows the dash; `-` at the
          // class edges is a literal (a reversed range simply matches nothing).
          if (k + 2 < cls.length && cls[k + 1] === "-") {
            ranges.push([cls[k]!, cls[k + 2]!]);
            k += 3;
          } else {
            members.push(cls[k]!);
            k += 1;
          }
        }
        tokens.push({ kind: "class", negated, members, ranges });
        i = j + 1;
        continue;
      }
      tokens.push({ kind: "lit", ch: "[" });
      i++;
      continue;
    }
    tokens.push({ kind: "lit", ch });
    i++;
  }
  return tokens;
}

/**
 * Match tokens against `path` (already normalized). Anchored patterns match
 * from position 0; unanchored ones may start at any segment boundary. A
 * successful match must end at the path end or at a `/`, so an ignored
 * directory also ignores everything beneath it.
 *
 * Backwards DP over path positions (one boolean row per token, two rows
 * reused): worst case O(tokens x pathLen), so patterns like
 * `*a*a*a*a*a*b` -- catastrophic under regex backtracking -- stay linear-ish.
 */
function matchTokens(tokens: Token[], path: string, anchored: boolean): boolean {
  const n = path.length;
  // `cur[k]`: true when the already-processed token suffix matches from
  // position k such that the overall match ends at the end or at a `/`.
  let cur = new Uint8Array(n + 1);
  let next = new Uint8Array(n + 1);
  cur[n] = 1;
  for (let k = 0; k < n; k++) cur[k] = path.charCodeAt(k) === 47 /* / */ ? 1 : 0;

  for (let ti = tokens.length - 1; ti >= 0; ti--) {
    const tok = tokens[ti]!;
    switch (tok.kind) {
      case "lit": {
        const cc = tok.ch.charCodeAt(0);
        for (let k = 0; k < n; k++) next[k] = path.charCodeAt(k) === cc ? (cur[k + 1] ?? 0) : 0;
        next[n] = 0;
        break;
      }
      case "any":
        for (let k = 0; k < n; k++) next[k] = path.charCodeAt(k) !== 47 ? (cur[k + 1] ?? 0) : 0;
        next[n] = 0;
        break;
      case "class": {
        // A class never matches `/` (git semantics; the old regex leaked that).
        for (let k = 0; k < n; k++) {
          const c = path[k]!;
          if (c === "/") {
            next[k] = 0;
            continue;
          }
          let hit = tok.members.includes(c);
          if (!hit) {
            for (const [lo, hi] of tok.ranges) {
              if (c >= lo && c <= hi) {
                hit = true;
                break;
              }
            }
          }
          next[k] = hit !== tok.negated ? (cur[k + 1] ?? 0) : 0;
        }
        next[n] = 0;
        break;
      }
      case "star": {
        // S[k] = cur[k] (empty run) or extend one non-`/` char and stay.
        next[n] = cur[n] ?? 0;
        for (let k = n - 1; k >= 0; k--) {
          next[k] = cur[k] || (path.charCodeAt(k) !== 47 && next[k + 1]) ? 1 : 0;
        }
        break;
      }
      case "crossStar": {
        // S[k] = any cur[j] for j >= k (any run, `/` included).
        let seen = 0;
        for (let k = n; k >= 0; k--) {
          if (cur[k]) seen = 1;
          next[k] = seen;
        }
        break;
      }
      case "dirGlob": {
        // Zero directories (cur[k]), or the end of any non-empty chunk that
        // reaches a `/` (the old `(?:.+/)?`): slash q >= k+1 with cur[q+1].
        next[n] = cur[n] ?? 0;
        let run = 0;
        for (let k = n - 1; k >= 0; k--) {
          next[k] = cur[k] || run ? 1 : 0;
          if (path.charCodeAt(k) === 47 && cur[k + 1]) run = 1;
        }
        break;
      }
      case "deepInside": {
        // `/` plus at least one more char; consumes everything (it is always
        // the final token).
        for (let k = 0; k <= n; k++) {
          next[k] = path.charCodeAt(k) === 47 && k + 2 <= n ? 1 : 0;
        }
        break;
      }
    }
    const tmp = cur;
    cur = next;
    next = tmp;
  }

  if (anchored) return cur[0] === 1;
  if (cur[0] === 1) return true;
  for (let s = 1; s < n; s++) {
    if (path.charCodeAt(s - 1) === 47 && cur[s] === 1) return true;
  }
  return false;
}

/** Parse one `.gitignore`-style pattern line body (after `!`-strip). */
function patternToRule(pattern: string, isNegated: boolean): Rule {
  // Trailing slash means "directory only". This matcher never consults the
  // fs, and every rule already matches the path AND everything beneath it, so
  // the flag changes nothing for normalized paths -- kept for documentation.
  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);

  // A `/` anywhere in the body anchors the pattern to the root -- including a
  // LEADING slash, which git strips from the matched text but keeps as an
  // anchor. Compute `anchored` before stripping. Only ONE leading slash is
  // stripped: git keeps `//build` matching nothing, so the extra slashes stay
  // literal.
  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);

  if (pattern === "") {
    return { tokens: [], anchored, negated: isNegated, neverMatch: true };
  }
  return { tokens: tokenize(pattern), anchored, negated: isNegated, neverMatch: false };
}

/**
 * Compile `.gitignore` content into an include predicate for
 * POSIX-style relative paths (true = keep, false = ignored), usable as a
 * drop-in for `paths.filter(shouldInclude)`.
 *
 * Rules are processed top-to-bottom; the last matching rule wins, and
 * negation patterns (`!pattern`) re-include previously ignored paths.
 *
 * Note on directory-only rules (`build/`): this predicate has no filesystem
 * knowledge, so it ignores the matched path and everything below it, whether
 * or not the matched path is actually a directory (git would consult the
 * index/fs).
 *
 * @param options.implicitPatterns - Patterns applied first (default: [".git"]).
 *   Set to `[]` to disable. User rules can override them via negation.
 */
export function compileGitignore(
  content: string,
  options?: { implicitPatterns?: string[] },
): (path: string) => boolean {
  const implicitPatterns = options?.implicitPatterns ?? DEFAULT_IMPLICIT_PATTERNS;

  // Prepend so user rules can override the defaults with negation.
  const fullContent =
    implicitPatterns.length > 0
      ? implicitPatterns.join("\n") + "\n" + content
      : content;

  const rules: Rule[] = [];

  for (const rawLine of fullContent.split("\n")) {
    // Trailing whitespace is stripped; leading whitespace is kept -- git
    // treats it literally.
    const line = rawLine.replace(/\s+$/, "");

    if (line === "" || line.startsWith("#")) continue;

    const negated = line.startsWith("!");
    const pattern = negated ? line.slice(1) : line;

    if (pattern === "") continue;

    rules.push(patternToRule(pattern, negated));
  }

  return (testPath: string) => {
    const normalized = posix.normalize(testPath).replace(/\/+$/, "");

    let ignored = false;

    for (const rule of rules) {
      if (rule.neverMatch) continue;
      if (matchTokens(rule.tokens, normalized, rule.anchored)) {
        ignored = !rule.negated;
      }
    }

    return !ignored;
  };
}
