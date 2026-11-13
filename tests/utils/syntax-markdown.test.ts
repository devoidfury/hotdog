// Unit tests for the markdown line tokenizer (src/utils/syntax/markdown.ts):
// block classes, inline spans, fence state advance on the committed pass only,
// live-pass purity, and the lossless contract (concat runs === input).

import { describe, it, expect } from "bun:test";
import {
  tokenizeMarkdownLine,
  tokenizeMarkdownLive,
  newMdStreamState,
  cloneMdStreamState,
} from "@utils/syntax/markdown.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });
const tok = (line: string, s = newMdStreamState()): SyntaxRun[] => tokenizeMarkdownLine(line, s);
const types = (runs: SyntaxRun[]): string[] => runs.map((r) => r.type);

describe("block classes", () => {
  it("marks ATX headings whole-line, up to six hashes, max three indents", () => {
    expect(tok("# Changelog")).toEqual([run("heading", "# Changelog")]);
    expect(tok("###### deep")).toEqual([run("heading", "###### deep")]);
    expect(tok("   ### indented")).toEqual([run("heading", "   ### indented")]);
    // Seven hashes, or no space after, is just text.
    expect(types(tok("####### nope"))[0]).toBe("default");
    expect(types(tok("#!/bin/sh"))[0]).toBe("default");
  });

  it("marks hrs but not bullets or bold openers", () => {
    expect(tok("---")).toEqual([run("marker", "---")]);
    expect(tok("* * *")).toEqual([run("marker", "* * *")]);
    expect(tok("___")).toEqual([run("marker", "___")]);
    expect(types(tok("---- text"))[0]).toBe("default");
  });

  it("marks bullet and ordered list markers, content stays inline-parsed", () => {
    expect(tok("- **core** note")).toEqual([
      run("marker", "-"),
      run("default", " "),
      run("strong", "**core**"),
      run("default", " note"),
    ]);
    expect(tok("  12. item")).toEqual([
      run("default", "  "),
      run("marker", "12."),
      run("default", " "),
      run("default", "item"),
    ]);
    // A bold opener at line start is not a bullet (no space after the star).
    expect(tok("**bold** lead")[0]!.type).toBe("strong");
  });

  it("marks blockquote prefixes and parses the quoted content inline", () => {
    expect(tok("> **note** `x`")).toEqual([
      run("marker", "> "),
      run("strong", "**note**"),
      run("default", " "),
      run("code", "`x`"),
    ]);
    expect(tok(">>> deep")[0]).toEqual(run("marker", ">>> "));
  });
});

describe("inline classes", () => {
  it("marks strong and code spans anywhere in the line", () => {
    expect(tok("a **b** c `d` e")).toEqual([
      run("default", "a "),
      run("strong", "**b**"),
      run("default", " c "),
      run("code", "`d`"),
      run("default", " e"),
    ]);
  });

  it("keeps multi-backtick delimiters honest", () => {
    // Double-tick opener needs a double-tick closer; inner singles ride along.
    expect(tok("`` a ` b `` x")[0]).toEqual(run("code", "`` a ` b ``"));
  });

  it("leaves unclosed openers unstyled (the repaint restyles when they close)", () => {
    expect(types(tok("**unclosed"))).toEqual(["default"]);
    expect(types(tok("`unclosed"))).toEqual(["default"]);
    expect(tok("**unclosed")[0]).toEqual(run("default", "**unclosed"));
  });

  it("treats backslash escapes as literal pairs that never open a span", () => {
    expect(types(tok("\\*not em\\*"))).toEqual(["default"]);
    expect(types(tok('\\`not code\\`'))).toEqual(["default"]);
    // Escapes guard OPENERS only (display candy): an escaped star inside a
    // strong run can still close it, same accepted ambiguity as shell.ts.
    expect(tok("**a\\**b**")[0]).toEqual(run("strong", "**a\\**"));
    expect(tok("**a\\**b**")[1]).toEqual(run("default", "b**"));
  });

  it("code span content is inert (no strong inside code)", () => {
    expect(tok("`**lit**`")).toEqual([run("code", "`**lit**`")]);
  });
});

describe("fence state machine", () => {
  it("opens on a fence line, styles content as code, closes on the marker", () => {
    const s = newMdStreamState();
    expect(tokenizeMarkdownLine("```", s)).toEqual([run("fence", "```")]);
    expect(s.fence).toBe("```");
    expect(tokenizeMarkdownLine("plain code", s)).toEqual([run("code_block", "plain code")]);
    expect(tokenizeMarkdownLine("", s)).toEqual([]);
    expect(tokenizeMarkdownLine("```", s)).toEqual([run("fence", "```")]);
    expect(s.fence).toBeNull();
    // After the close, markdown resumes.
    expect(tokenizeMarkdownLine("# back", s)).toEqual([run("heading", "# back")]);
  });

  it("suppresses markdown styles inside fences", () => {
    const s = newMdStreamState();
    tokenizeMarkdownLine("```md", s);
    expect(tokenizeMarkdownLine("# not a heading **nor bold**", s)).toEqual([
      run("code_block", "# not a heading **nor bold**"),
    ]);
    expect(tokenizeMarkdownLine("```", s)).toEqual([run("fence", "```")]);
  });

  it("routes fence languages through the registry with aliases", () => {
    const s = newMdStreamState();
    tokenizeMarkdownLine("```sh", s);
    expect(s.lang).toBe("shell");
    expect(tokenizeMarkdownLine("ls -la | wc -l", s)).toEqual([
      run("command", "ls"),
      run("default", " "),
      run("default", "-la"),
      run("default", " "),
      run("operator", "|"),
      run("default", " "),
      run("command", "wc"),
      run("default", " "),
      run("default", "-l"),
    ]);
    tokenizeMarkdownLine("```", s);
    tokenizeMarkdownLine("```zsh", s);
    expect(s.lang).toBe("shell");
    tokenizeMarkdownLine("```", s);
    tokenizeMarkdownLine("```yml", s);
    expect(s.lang).toBe("yaml");
    tokenizeMarkdownLine("```", s);
    // Unknown info strings render plain code, never a bogus tokenizer.
    tokenizeMarkdownLine("```cool lang", s);
    expect(s.lang).toBeNull();
    expect(tokenizeMarkdownLine("anything", s)).toEqual([run("code_block", "anything")]);
  });

  it("routes json, css and html fences (aliases included)", () => {
    for (const [info, lang] of [
      ["json", "json"],
      ["jsonc", "json"],
      ["css", "css"],
      ["html", "html"],
      ["htm", "html"],
    ] as const) {
      const s = newMdStreamState();
      tokenizeMarkdownLine(`\`\`\`${info}`, s);
      expect(s.lang).toBe(lang);
    }
    const s = newMdStreamState();
    tokenizeMarkdownLine("```json", s);
    expect(tokenizeMarkdownLine('{"a": true}', s)).toEqual([
      run("operator", "{"),
      run("key", '"a"'),
      run("operator", ":"),
      run("default", " "),
      run("boolean", "true"),
      run("operator", "}"),
    ]);
  });

  it("requires same-char closers of at least the opening width", () => {
    const s = newMdStreamState();
    tokenizeMarkdownLine("````", s);
    expect(tokenizeMarkdownLine("~~~~", s)).toEqual([run("code_block", "~~~~")]);
    expect(tokenizeMarkdownLine("```", s)).toEqual([run("code_block", "```")]);
    expect(tokenizeMarkdownLine("````", s)).toEqual([run("fence", "````")]);
    expect(s.fence).toBeNull();
  });

  it("rejects backtick fences whose info contains a backtick", () => {
    const s = newMdStreamState();
    expect(types(tokenizeMarkdownLine("``` a`b", s))[0]).toBe("default");
    expect(s.fence).toBeNull();
  });
});

describe("live pass purity", () => {
  it("same partial input twice produces the same runs (no repaint flap)", () => {
    const s = newMdStreamState();
    for (const partial of ["# Hel", "a **b", "```sh", "ls | c", "**x** `y"]) {
      const a = tokenizeMarkdownLive(partial, s);
      const b = tokenizeMarkdownLive(partial, s);
      expect(b).toEqual(a);
    }
  });


  it("classifies like the committed pass but never advances state", () => {
    const s = newMdStreamState();
    tokenizeMarkdownLine("```sh", s);
    tokenizeMarkdownLine("ls", s);
    const before = cloneMdStreamState(s);
    // A live "closing" fence line reads as a fence but keeps the fence open.
    expect(tokenizeMarkdownLive("```", s)).toEqual([run("fence", "```")]);
    expect(s).toEqual(before);
    // Inside the shell fence the shell tokenizer owns the classes.
    expect(tokenizeMarkdownLive("**bold", s)).toEqual([run("command", "**bold")]);
    expect(s).toEqual(before);
  });

  it("renders the unterminated row against current state", () => {
    const s = newMdStreamState();
    expect(tokenizeMarkdownLive("# Hel", s)).toEqual([run("heading", "# Hel")]);
    expect(tokenizeMarkdownLive("a **b", s)).toEqual([run("default", "a **b")]);
    expect(tokenizeMarkdownLive("a **b** c", s)).toEqual([
      run("default", "a "),
      run("strong", "**b**"),
      run("default", " c"),
    ]);
  });
});

describe("lossless contract", () => {
  const corpus = [
    "",
    "# h",
    "###",
    "- a",
    "1) x",
    "> q",
    "```",
    "```sh",
    "echo 'hi' | cat",
    "``` ",
    "~~~",
    "a **b** `c` **d `e` f**",
    "**unclosed `span",
    "\\`escaped\\`",
    "text with | pipes | and _underscores_",
    "\t-tabbed",
    "- [ ] task **bold**",
    "```js",
    "const x = `template **lit**`;",
    "```",
    "---- ",
    "***",
    "   ```open",
    "   ```",
    "````close```````",
  ];

  it("run concatenation reproduces every line exactly, both passes", () => {
    for (const line of corpus) {
      const s = newMdStreamState();
      expect(tok(line).map((r) => r.text).join("")).toBe(line);
      expect(tokenizeMarkdownLive(line, s).map((r) => r.text).join("")).toBe(line);
    }
    // And through the state machine end-to-end (fences carry state).
    const s = newMdStreamState();
    for (const line of corpus) {
      expect(tokenizeMarkdownLine(line, s).map((r) => r.text).join("")).toBe(line);
    }
  });

  it("never produces empty runs", () => {
    const s = newMdStreamState();
    for (const line of corpus) {
      for (const runs of [tokenizeMarkdownLine(line, s), tokenizeMarkdownLive(line, s)]) {
        expect(runs.every((r) => r.text !== "")).toBe(true);
      }
    }
  });

  it("seeded fuzz: runs stay lossless and non-empty over random markdown soup", () => {
    // mulberry32: deterministic, so a failure reproduces from the seed.
    let seed = 0x2f6e2b1;
    const rnd = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // Alphabet heavy on the characters the tokenizer branches on, plus the
    // fence info strings that route into the shell/yaml registries.
    const pieces = [
      "#", "## ", "-", "* ", "+ ", "1. ", "2) ", "> ", "---", "***", "___",
      "```", "~~~", "```sh", "~~~yaml", "```` a`b", "`", "``", "**", "\\",
      "\\\\", "a", "|", ";", "&&", " ", "  ", "x:", "\t", "key", "!", "'", '"',
    ];
    const s = newMdStreamState();
    for (let n = 0; n < 500; n++) {
      let line = "";
      const parts = 1 + Math.floor(rnd() * 6);
      for (let p = 0; p < parts; p++) line += pieces[Math.floor(rnd() * pieces.length)]!;
      // Committed pass advances fence state ONCE; the live pass then reads
      // the post-commit state without touching it.
      const committed = tokenizeMarkdownLine(line, s);
      const live = tokenizeMarkdownLive(line, s);
      expect(committed.map((r) => r.text).join("")).toBe(line);
      expect(live.map((r) => r.text).join("")).toBe(line);
      expect(committed.every((r) => r.text !== "")).toBe(true);
      expect(live.every((r) => r.text !== "")).toBe(true);
    }
  });
});
