import { posix } from "node:path";

const DEFAULT_IMPLICIT_PATTERNS = [".git"];

/**
 * Parse a `.gitignore`-style pattern into a regular expression.
 *
 * Handles:
 * - `*` — matches anything except `/`
 * - `**` — matches everything including `/`
 * - `?` — matches any single character except `/`
 * - `[...]` — character classes
 * - `/` in pattern (not trailing) — anchors to root
 * - trailing `/` — directory-only match
 * - leading `!` — negation (re-include)
 * - leading `#` — comment (ignored)
 */
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

  // Determine if the pattern is anchored to root.
  // A pattern is anchored if it contains a `/` (not trailing, which we already stripped).
  const anchored = pattern.includes("/");

  let regexSource = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === undefined) break;

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — matches everything
        if (
          (i === 0 || pattern[i - 1] === "/") &&
          (i + 2 === pattern.length || pattern[i + 2] === "/")
        ) {
          // `**/` or `/**` — match zero or more directories
          regexSource += "(?:.+/)?";
          i += 2;
          // Skip trailing slash if present
          if (i < pattern.length && pattern[i] === "/") i++;
          continue;
        } else {
          // `**` in the middle of a pattern — match everything
          regexSource += ".*";
          i += 2;
          continue;
        }
      } else {
        // `*` — match anything except `/`
        regexSource += "[^/]*";
      }
    } else if (ch === "?") {
      regexSource += "[^/]";
    } else if (ch === "[") {
      // Character class — find closing bracket
      let j = i + 1;
      if (j < pattern.length && pattern[j] === "!") j++;
      if (j < pattern.length && pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j < pattern.length) {
        // Replace `!` with `^` for negated character class
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

  // Build the full regex.
  // When a directory is ignored, all paths under it should also match.
  // We create a pattern that matches both the exact path and any sub-path.
  const basePathRegex = regexSource;

  if (anchored) {
    // Anchored: match from root, optionally followed by /more/path
    regexSource = "^" + basePathRegex + "(?:/.*)?$";
  } else {
    // Unanchored: match anywhere in the path, optionally followed by /more/path
    regexSource = "(?:^|/)" + basePathRegex + "(?:/.*)?$";
  }

  return {
    regex: new RegExp(regexSource),
    negated: isNegated,
    directoryOnly: dirOnly,
  };
}

/**
 * Compile a `.gitignore` file content into a filter predicate.
 *
 * The returned function takes a POSIX-style relative path and returns:
 * - `true` if the path should be **included** (not ignored)
 * - `false` if the path should be **excluded** (ignored)
 *
 * This makes it a drop-in for `paths.filter(shouldInclude)`.
 *
 * ```ts
 * const shouldInclude = compileGitignore(fs.readFileSync(".gitignore", "utf-8"));
 * const visible = allFiles.filter(shouldInclude);
 * ```
 *
 * Rules are processed top-to-bottom; the last matching rule wins.
 * Negation patterns (`!pattern`) re-include previously ignored paths.
 *
 * @param content - Raw `.gitignore` file content
 * @param options - Optional configuration
 * @param options.implicitPatterns - Patterns always applied first (default: [".git"]).
 *   Set to `[]` to disable, or provide additional patterns.
 */
export function compileGitignore(
  content: string,
  options?: { implicitPatterns?: string[] },
): (path: string) => boolean {
  const implicitPatterns = options?.implicitPatterns ?? DEFAULT_IMPLICIT_PATTERNS;

  // Prepend implicit patterns so user rules can override them with negation
  const fullContent =
    implicitPatterns.length > 0
      ? implicitPatterns.join("\n") + "\n" + content
      : content;

  const rules: ReturnType<typeof patternToRegex>[] = [];

  for (const rawLine of fullContent.split("\n")) {
    // Trim trailing whitespace (but preserve leading whitespace — git treats it literally)
    const line = rawLine.replace(/\s+$/, "");

    // Skip blank lines and comments
    if (line === "" || line.startsWith("#")) continue;

    let negated = false;

    // Handle negation
    if (line.startsWith("!")) {
      negated = true;
    }

    const pattern = negated ? line.slice(1) : line;

    if (pattern === "") continue;

    rules.push(patternToRegex(pattern, negated));
  }

  return (testPath: string) => {
    // Normalize to POSIX-style path
    const normalized = posix.normalize(testPath).replace(/\/+$/, "");

    let ignored = false;

    for (const rule of rules) {
      if (rule.directoryOnly) {
        // A directory-only pattern matches if the path is a directory
        // or is a sub-path of a matching directory.
        // We test both the path itself and with a trailing slash.
        if (rule.regex.test(normalized) || rule.regex.test(normalized + "/")) {
          ignored = !rule.negated;
        }
      } else {
        if (rule.regex.test(normalized)) {
          ignored = !rule.negated;
        }
      }
    }

    // Return true if path should be INCLUDED (i.e., NOT ignored)
    return !ignored;
  };
}
