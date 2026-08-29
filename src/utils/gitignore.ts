import { posix } from "node:path";

const DEFAULT_IMPLICIT_PATTERNS = [".git"];

/** Parse a `.gitignore`-style pattern into a regular expression. */
function patternToRegex(pattern: string, isNegated: boolean): {
  regex: RegExp;
  negated: boolean;
  directoryOnly: boolean;
} {
  let dirOnly = false;

  // Trailing slash means "directory only"
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }

  // A `/` anywhere in the body anchors the pattern to the root.
  const anchored = pattern.includes("/");

  let regexSource = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === undefined) break;

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (
          (i === 0 || pattern[i - 1] === "/") &&
          (i + 2 === pattern.length || pattern[i + 2] === "/")
        ) {
          // `**/` or `/**` — zero or more whole directories
          regexSource += "(?:.+/)?";
          i += 2;
          if (i < pattern.length && pattern[i] === "/") i++;
          continue;
        } else {
          regexSource += ".*";
          i += 2;
          continue;
        }
      } else {
        // `*` never crosses `/`
        regexSource += "[^/]*";
      }
    } else if (ch === "?") {
      regexSource += "[^/]";
    } else if (ch === "[") {
      let j = i + 1;
      if (j < pattern.length && pattern[j] === "!") j++;
      if (j < pattern.length && pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j < pattern.length) {
        const cls = pattern.slice(i + 1, j).replace(/^!/, "^");
        regexSource += `[${cls}]`;
        i = j;
      } else {
        regexSource += "\\[";
      }
    } else if (".+^${}|()\\\\".includes(ch)) {
      regexSource += "\\" + ch;
    } else {
      regexSource += ch;
    }

    i++;
  }

  // An ignored directory also ignores everything beneath it, so both the
  // exact path and any sub-path must match.
  const basePathRegex = regexSource;

  if (anchored) {
    regexSource = "^" + basePathRegex + "(?:/.*)?$";
  } else {
    regexSource = "(?:^|/)" + basePathRegex + "(?:/.*)?$";
  }

  return {
    regex: new RegExp(regexSource),
    negated: isNegated,
    directoryOnly: dirOnly,
  };
}

/**
 * Compile `.gitignore` content into an include predicate for
 * POSIX-style relative paths (true = keep, false = ignored), usable as a
 * drop-in for `paths.filter(shouldInclude)`.
 *
 * Rules are processed top-to-bottom; the last matching rule wins, and
 * negation patterns (`!pattern`) re-include previously ignored paths.
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

  const rules: ReturnType<typeof patternToRegex>[] = [];

  for (const rawLine of fullContent.split("\n")) {
    // Trailing whitespace is stripped; leading whitespace is kept -- git
    // treats it literally.
    const line = rawLine.replace(/\s+$/, "");

    if (line === "" || line.startsWith("#")) continue;

    const negated = line.startsWith("!");
    const pattern = negated ? line.slice(1) : line;

    if (pattern === "") continue;

    rules.push(patternToRegex(pattern, negated));
  }

  return (testPath: string) => {
    const normalized = posix.normalize(testPath).replace(/\/+$/, "");

    let ignored = false;

    for (const rule of rules) {
      if (rule.directoryOnly) {
        // Test both the path itself and with a trailing slash, since the
        // caller may not know whether it is a directory.
        if (rule.regex.test(normalized) || rule.regex.test(normalized + "/")) {
          ignored = !rule.negated;
        }
      } else {
        if (rule.regex.test(normalized)) {
          ignored = !rule.negated;
        }
      }
    }

    return !ignored;
  };
}
