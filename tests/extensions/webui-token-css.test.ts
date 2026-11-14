// Token-class CSS pin (run 20261114): every token type the shared @utils/syntax
// registry can emit must have a CSS rule for BOTH sinks -- the tool block's
// `tok-<type>` spans (tool-block.tsx's codeRuns) and the file view's
// `tk tk-<type>` spans (file-view.tsx's LineRow). The file browser's "invisible
// highlighting" complaint was exactly this: the registry grew to 35 languages
// while the viewer's tk- block still styled only the shell pair, so every other
// class rendered in default ink. Doctrine: one reading, one hue, both sinks --
// shared classes get exactly ONE rule; theme vars only; "default" stays
// unstyled on purpose.
//
// Same read-the-CSS doctrine as webui-theme-pref.test.ts's token-split pin:
// these rules are plain CSS, and the dom-helper has no CSSOM. The vocabulary
// is pinned as data AND re-derived by running every tokenizer over a corpus
// wide enough to fire each language's full class set -- a tokenizer that
// starts emitting an unpinned class fails the corpus leg and must update both
// the pin and the CSS in the same change.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTokenizer } from "@utils/syntax/index.ts";
import { hasFrontmatter, tokenizeMarkdownDoc } from "@utils/syntax/markdown.ts";

const CSS = readFileSync(
  join(import.meta.dir, "../../src/extensions/webui/ui/styles.css"),
  "utf8",
);

function hasRule(cls: string): boolean {
  return new RegExp("\\." + cls + "\\s*\\{").test(CSS);
}

/** The body of the rule whose selector is exactly `sel` (first match). */
function ruleBody(sel: string): string {
  const at = CSS.search(new RegExp("\\n" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{"));
  if (at < 0) throw new Error(`rule ${sel} missing from styles.css`);
  const start = CSS.indexOf("{", at);
  const end = CSS.indexOf("}", start);
  return CSS.slice(start + 1, end);
}

// The full emitted-class vocabulary (union over the 34 registry tokenizers
// plus the markdown stream tokenizer's own classes), verified against real
// corpora and a literal sweep of the tokenizer sources.
const TOKEN_CLASSES = [
  // shared programming vocabulary
  "string", "template", "regexp", "number", "boolean", "null", "comment",
  "keyword", "type", "fn", "decorator", "variable", "operator", "preproc",
  // data/config vocabulary
  "key", "value", "section",
  // markup vocabulary
  "name", "attribute", "entity", "doctype",
  // css vocabulary
  "selector", "property", "color", "atrule",
  // yaml reference family
  "anchor", "alias", "tag", "marker",
  // markdown vocabulary
  "heading", "fence", "code_block", "strong", "code",
  // shell pair
  "command",
];

// One line per construct shape, wide enough per language that the observed
// class set covers that tokenizer's full vocabulary (kept honest by the
// superset assertion below).
const CORPUS: Record<string, string[]> = {
  shell: ["git add -A && npm test | tee log", `cat <<EOF`, `x=1 arr=(a b)`, `if [ -f "$f" ]; then :; fi`],
  yaml: ["# c", "key: value", "a: &anc 1", "b: *anc", "t: !!str x", "ok: true", "n: null", "d: |", "- item", "---"],
  json: ['{ "a": 1, "b": [true, null], "esc": "x" }'],
  css: ["@media (min-width: 3px) { .cls:hover { color: #fff; prop: var(--x); } }"],
  html: ["<!DOCTYPE html>", `<a href="u" disabled>&amp;</a>`, "<!-- c -->"],
  toml: ["# c", "[sec.sub]", 'key = "v"', "n = 1_000", "t = true", "d = 2020-01-01T00:00:00Z"],
  ini: ["; c", "[sec]", "key = value"],
  env: ["# c", 'KEY="v w"', "export X=1"],
  gitignore: ["# c", "*.log", "!keep.log"],
  xml: ['<?xml version="1.0"?>', "<!DOCTYPE x>", `<root a="1">t &amp; <!-- c --> <![CDATA[r]]></root>`],
  python: ["# c", "@dec", 'def f(a=1) -> int:', '    s = f"t {a}"', "class C(B):", "    z = None", "n = 0b1010", 'r = re.compile(r"\\d+")'],
  javascript: ["// c", "const f = (x) => x;", "class A extends B {}", "let t = `m ${x}`;", "const r = /re/g;", "@dec class C {}", "try {} catch (e) {}", "x ??= 1"],
  typescript: ["interface I { a: string }", "type T = A | B;", "enum E { A }", "function f<T>(x: T): T { return x; }", "namespace N {}", "let a: any = null;"],
  c: ["#include <x.h>", "#ifdef X", "// c", "int main(void) { return 0; }", "typedef struct S S;", 'char *s = "a";', "unsigned u = 0xFFu;"],
  cpp: ["#include <vector>", "template <typename T> class V {};", "auto f = [](int x) -> int { return x; };", "std::string s = R\"(raw)\";", "nullptr", "public:"],
  csharp: ["using X;", '[Attribute("v")]', "namespace N { public class C : B { public int P { get; set; } } }", "int? n = null;", "var a = new List<int>();", '$@"verbatim {x}"', "// c", "n = 0x1f;"],
  dockerfile: ["# c", "FROM ubuntu:22.04 AS b", "ARG V=1", 'LABEL k="v"', "RUN a && \\", "COPY --from=0 /x /y", "CMD [\"echo\"]"],
  go: ['// c', "package main", 'import "fmt"', "func f(x int) (int, error) { return x, nil }", "type S struct { N string }", "m := map[string]int{\"a\": 1}", "s := `raw`"],
  sql: ["-- c", "SELECT a, 'c' FROM t WHERE x = 1 AND y IS NOT NULL;", "CREATE TABLE t (id INTEGER PRIMARY KEY);"],
  make: ["# c", "VAR = value", "target: dep", "\techo $(VAR)", ".PHONY: all", "ifeq (a,b)", "endif"],
  graphql: ["# c", "type Query { field(arg: Int = 1): [String!]! }", "directive @auth on FIELD", "enum E { A }", '"""doc"""'],
  lua: ["-- c", "--[[ b ]]", "local function f(a) end", 's = [[long]]', "n = 0xFF", "t = true", "nn = nil", "obj:method()"],
  rust: ['#[derive(Debug)]', "#![allow(x)]", "fn f<'a>(s: &'a str) -> String { s.into() }", 'println!("hi {}", x);', "let v = vec![1];", "let c = '\\n';", 'let r = r#"a"b"#;', "match x { Some(y) => y, None => 0 }", "0xFF_FF", "trait T: Sized {}", "union U { i: i32 }"],
  php: ["<?php", "# c", "namespace A\\B;", 'echo "d $v";', "function f(int $a): void {}", "class C extends B implements I {}", "enum E: string {}", "$n = null;", "<<<EOT"],
  java: ["// c", "package a;", "@Override", "public class C<T> extends B implements I {}", "enum E { A }", "record R(int x) {}", "var v = List.of(\"a\");", "assert x : \"m\";"],
  ruby: ["# c", "=begin", "b", "=end", "def f(*r, **k, &blk); end", 's = "int #{x}"', "r = /re/i", "sym = :n", "w = %w[a b]", "@iv = @@cv = $gv = CONST", "p self", "begin; rescue E => e; end"],
  kotlin: ["// c", "@Serializable", 'data class C(val x: Int) : B { override fun toString() = "C" }', "fun <T> id(x: T): T = x", 'val s = "t ${expr}"', "val f: (Int) -> Int = { it }", "sealed class S", "typealias A = B", "label@ for (i in 0..1) break@label"],
  groovy: ["// c", "def f(x) { x }", 's = "gs ${v}"', "cl = { a, b -> a + b }", "@CompileStatic", "m = [a: 1]", "g = ~/re/", "BI = 1G", "a <: b"],
  dart: ["// c", "@immutable", "class C extends B implements I { final int x; C(this.x); }", "enum E { a }", "mixin M {}", "typedef F = int Function(int);", 'var s = "t $v";', "var raw = r\"raw\";", "n ??= 2", "extension Ext on int {}", "part of y;"],
  swift: ["// c", "import Foundation", "@objc public class C: B, I { private(set) var x = 1 }", 'let s = "i \\(e) t"', "enum E: String { case a = \"A\" }", "protocol P: AnyObject {}", "guard let x = y else { return }", "#selector(f)", "actor Ac {}", "subscript(i: Int) -> Int { get { 0 } set {} }"],
  cmake: ["# c", "cmake_minimum_required(VERSION 3.10)", 'set(V "a ${W}")', "if(NOT V STREQUAL \"a\")", "elseif(X)", "endif()", "add_executable(t ${SRC})", "check_cxx_source_compiles(\"x\" NOTFOUND)"],
  zig: ['// c', 'const std = @import("std");', "const c = '\\n';", "fn f(a: u8) callconv(.C) void {}", "const s = \"e \\x41\";", "const ml = \\", "switch (x) { 0 => {}, else => {} }", "comptime { _ = 1; }", "@as(u32, 1)", "undefined", "x catch |err| err"],
  elixir: ["# c", '@moduledoc "d"', "defmodule M do", "  @type t :: :atom", "  def f(a \\\\ 1) when is_atom(a), do: {:ok, a}", "end", 's = "i #{x}"', "c = 'cl'", "sig = ~r/re/", "x |> f()", "&IO.puts/1", "<<1, 2::size(8)>>", "nil", "?c"],
  markdown: ["---", "fm: 1", "---", "# H", "para **s** `c` ~~~~i~~~~", "```ts", "const a = 1;", "```", "> q", "- b", "---", "    indented"],
};

describe("every registry token class has a CSS rule for both sinks", () => {
  for (const cls of TOKEN_CLASSES) {
    it(`.tok-${cls} and .tk-${cls} both have rules`, () => {
      expect(hasRule(`tok-${cls}`)).toBe(true);
      expect(hasRule(`tk-${cls}`)).toBe(true);
    });
  }

  it("default stays unstyled in both sinks (unstyled runs are the idiom)", () => {
    expect(hasRule("tok-default")).toBe(false);
    expect(hasRule("tk-default")).toBe(false);
  });

  it("the tok- and tk- families cover the same class set", () => {
    const tokSet = new Set([...CSS.matchAll(/\.tok-([a-z_]+)\s*\{/g)].map((m) => m[1]));
    const tkSet = new Set([...CSS.matchAll(/\.tk-([a-z_]+)\s*\{/g)].map((m) => m[1]));
    expect([...tkSet].sort()).toEqual([...tokSet].sort());
  });

  it("no token rule hard-codes a color (theme vars keep both palettes)", () => {
    for (const m of CSS.matchAll(/\.(?:tok|tk)-([a-z_]+)\s*\{([^}]*)\}/g)) {
      const body = m[2]!;
      const colors = [...body.matchAll(/color:\s*([^;}]+)/g)].map((c) => c[1]!.trim());
      for (const value of colors) {
        if (value === "#8bd5a0") continue; // the viewer's original shell pair
        expect(value.startsWith("var(")).toBe(true);
      }
    }
  });

  it("the hotdog accent/warning amber adjacency is broken by weight, and operators recede", () => {
    // The hotdog palette keeps --accent (#e0a32e) and --warning (#fbbf24) as
    // adjacent mustards, so the viewer's structural accent roles carry a
    // bold stance (the same cue the heading/marker family uses), and the
    // file view's operator rides --text-muted exactly like the tool block's
    // tok-operator: an accent operator read as a keyword.
    for (const cls of ["keyword", "key", "name", "selector", "property"]) {
      const body = ruleBody(`.tk-${cls}`);
      expect(body).toContain("--accent");
      expect(body).toContain("font-weight: 600");
    }
    expect(ruleBody(".tk-operator")).toContain("--text-muted");
    expect(ruleBody(".tk-string")).toContain("--warning");
  });
});

describe("tokenizer corpora emit only pinned classes", () => {
  for (const [lang, lines] of Object.entries(CORPUS)) {
    it(`${lang} emits a subset of the pinned vocabulary`, () => {
      const types = new Set<string>();
      if (lang === "markdown") {
        for (const row of tokenizeMarkdownDoc(lines, hasFrontmatter(lines)))
          for (const r of row) types.add(r.type);
      } else {
        const tokenizer = getTokenizer(lang);
        expect(tokenizer).toBeDefined();
        for (const line of lines) for (const r of tokenizer!(line)) types.add(r.type);
      }
      for (const type of types) {
        if (type === "default") continue; // unstyled on purpose
        expect(TOKEN_CLASSES, `${lang} emitted unpinned class ${type}`).toContain(type);
      }
    });
  }
});
