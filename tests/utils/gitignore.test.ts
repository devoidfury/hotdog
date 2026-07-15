import { describe, it, expect } from "bun:test";
import { compileGitignore } from "../../src/utils/gitignore.ts";

describe("compileGitignore", () => {
  const gitignore = (content: string) => compileGitignore(content);

  describe("basic patterns", () => {
    it("includes everything when gitignore is empty", () => {
      const filter = gitignore("");
      expect(filter("src/index.ts")).toBe(true);
      expect(filter("README.md")).toBe(true);
      expect(filter("a/b/c/d.txt")).toBe(true);
    });

    it("ignores files matching a simple name pattern", () => {
      const filter = gitignore("*.log");
      expect(filter("app.log")).toBe(false);
      expect(filter("debug.log")).toBe(false);
      expect(filter("src/app.log")).toBe(false);
      expect(filter("app.js")).toBe(true);
      expect(filter("README.md")).toBe(true);
    });

    it("ignores exact filenames", () => {
      const filter = gitignore("Thumbs.db");
      expect(filter("Thumbs.db")).toBe(false);
      expect(filter("src/Thumbs.db")).toBe(false);
      expect(filter("other.db")).toBe(true);
    });

    it("ignores directory names", () => {
      const filter = gitignore("node_modules");
      expect(filter("node_modules")).toBe(false);
      expect(filter("node_modules/index.js")).toBe(false);
      expect(filter("src/node_modules/pkg/index.js")).toBe(false);
      expect(filter("src/index.js")).toBe(true);
    });

    it("handles directory-only patterns with trailing slash", () => {
      const filter = gitignore("build/");
      expect(filter("build")).toBe(false);
      expect(filter("build/output.js")).toBe(false);
      expect(filter("src/build")).toBe(false);
      expect(filter("src/build/output.js")).toBe(false);
      expect(filter("buildfile.txt")).toBe(true);
    });
  });

  describe("wildcard patterns", () => {
    it("handles single-character wildcard ?", () => {
      const filter = gitignore("?.txt");
      expect(filter("a.txt")).toBe(false);
      expect(filter("b.txt")).toBe(false);
      expect(filter("ab.txt")).toBe(true);
      expect(filter(".txt")).toBe(true);
    });

    it("handles ** for recursive matching", () => {
      const filter = gitignore("**/test");
      expect(filter("test")).toBe(false);
      expect(filter("src/test")).toBe(false);
      expect(filter("a/b/c/test")).toBe(false);
      expect(filter("testing")).toBe(true);
    });

    it("handles **/ prefix pattern", () => {
      const filter = gitignore("**/node_modules");
      expect(filter("node_modules")).toBe(false);
      expect(filter("src/node_modules")).toBe(false);
      expect(filter("a/b/node_modules/pkg")).toBe(false);
    });

    it("handles character classes", () => {
      const filter = gitignore("*.[oa]");
      // Pattern ".*[oa]" matches files with .o or .a extension
      expect(filter("file.o")).toBe(false);
      expect(filter("file.a")).toBe(false);
      expect(filter("file.b")).toBe(true);
    });
  });

  describe("anchored patterns", () => {
    it("patterns with / are anchored to root", () => {
      const filter = gitignore("src/build");
      expect(filter("src/build")).toBe(false);
      expect(filter("src/build/output.js")).toBe(false);
      expect(filter("other/src/build")).toBe(true);
    });

    it("patterns without / match anywhere", () => {
      const filter = gitignore("build");
      expect(filter("build")).toBe(false);
      expect(filter("src/build")).toBe(false);
      expect(filter("a/b/build")).toBe(false);
    });
  });

  describe("negation patterns", () => {
    it("re-includes files with ! negation", () => {
      const filter = gitignore("*.log\n!important.log");
      expect(filter("debug.log")).toBe(false);
      expect(filter("app.log")).toBe(false);
      expect(filter("important.log")).toBe(true);
    });

    it("negation is processed in order (last match wins)", () => {
      const filter = gitignore("*.log\n!important.log\n!secret.log\n*.log");
      // Last rule (*.log) wins for all .log files
      expect(filter("debug.log")).toBe(false);
      expect(filter("important.log")).toBe(false);
      expect(filter("secret.log")).toBe(false);
    });

    it("negation works with recursive patterns", () => {
      const filter = gitignore("build/\n!important.log");
      expect(filter("build/output.js")).toBe(false);
      expect(filter("important.log")).toBe(true);
    });
  });

  describe("comments and blank lines", () => {
    it("ignores comment lines", () => {
      const filter = gitignore("# This is a comment\n*.log");
      expect(filter("app.log")).toBe(false);
      expect(filter("app.js")).toBe(true);
    });

    it("ignores blank lines", () => {
      const filter = gitignore("\n\n*.log\n\n");
      expect(filter("app.log")).toBe(false);
      expect(filter("app.js")).toBe(true);
    });

    it("trims trailing whitespace from patterns", () => {
      const filter = gitignore("*.log   ");
      expect(filter("app.log")).toBe(false);
    });
  });

  describe("complex real-world scenarios", () => {
    it("handles a typical gitignore", () => {
      const filter = gitignore(`
# Dependencies
node_modules/

# Build output
dist/
build/

# Environment files
.env
.env.local

# IDE
.vscode/
.idea/

# OS files
.DS_Store
*.swp

# Logs
*.log

# Re-include important env
!.env.example
`);

      expect(filter("src/index.ts")).toBe(true);
      expect(filter("README.md")).toBe(true);
      expect(filter("node_modules/lodash/index.js")).toBe(false);
      expect(filter("dist/bundle.js")).toBe(false);
      expect(filter("build/output.css")).toBe(false);
      expect(filter(".env")).toBe(false);
      expect(filter(".env.local")).toBe(false);
      expect(filter(".env.example")).toBe(true);
      expect(filter(".vscode/settings.json")).toBe(false);
      expect(filter(".idea/workspace.xml")).toBe(false);
      expect(filter(".DS_Store")).toBe(false);
      expect(filter("debug.log")).toBe(false);
      expect(filter("app.js.swp")).toBe(false);
    });

    it("handles nested directory patterns", () => {
      const filter = gitignore("src/__tests__/coverage");
      expect(filter("src/__tests__/coverage/lcov.info")).toBe(false);
      expect(filter("__tests__/coverage")).toBe(true);
    });

    it("works as a .filter() predicate", () => {
      const filter = gitignore("*.log\nnode_modules/");

      const files = [
        "src/index.ts",
        "src/utils.ts",
        "debug.log",
        "node_modules/lodash/index.js",
        "README.md",
        "build.log",
        "src/helper.ts",
      ];

      const visible = files.filter(filter);
      expect(visible).toEqual([
        "src/index.ts",
        "src/utils.ts",
        "README.md",
        "src/helper.ts",
      ]);
    });
  });

  describe("edge cases", () => {
    it("handles paths with multiple slashes", () => {
      const filter = gitignore("*.log");
      expect(filter("src//index//app.log")).toBe(false);
      expect(filter("src//index.ts")).toBe(true);
    });

    it("handles single-character filenames", () => {
      const filter = gitignore("a");
      expect(filter("a")).toBe(false);
      expect(filter("b")).toBe(true);
    });

    it("returns true for paths when no rules match", () => {
      const filter = gitignore("*.log");
      expect(filter("anything.xyz")).toBe(true);
    });
  });

  describe("implicit patterns", () => {
    it("ignores .git by default", () => {
      const filter = compileGitignore("");
      expect(filter(".git")).toBe(false);
      expect(filter(".git/HEAD")).toBe(false);
      expect(filter(".git/objects/pack")).toBe(false);
      expect(filter("src/index.ts")).toBe(true);
    });

    it("user rules can override implicit patterns with negation", () => {
      const filter = compileGitignore("!.git");
      expect(filter(".git")).toBe(true);
      expect(filter(".git/HEAD")).toBe(true);
    });

    it("allows custom implicit patterns", () => {
      const filter = compileGitignore("", { implicitPatterns: ["node_modules", ".venv"] });
      expect(filter("node_modules/lodash/index.js")).toBe(false);
      expect(filter(".venv/bin/python")).toBe(false);
      expect(filter("src/index.ts")).toBe(true);
    });

    it("disables implicit patterns when set to empty array", () => {
      const filter = compileGitignore("", { implicitPatterns: [] });
      expect(filter(".git")).toBe(true);
      expect(filter(".git/HEAD")).toBe(true);
      expect(filter("src/index.ts")).toBe(true);
    });

    it("implicit patterns are applied before user rules (so user negation works)", () => {
      // .git is implicitly ignored, but user explicitly ignores *.log too
      const filter = compileGitignore("*.log\n!important.log");
      expect(filter(".git/config")).toBe(false);
      expect(filter("debug.log")).toBe(false);
      expect(filter("important.log")).toBe(true);
    });
  });
});
