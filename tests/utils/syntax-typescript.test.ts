// Unit tests for the TypeScript tokenizer (src/utils/syntax/typescript.ts):
// the JavaScript core plus the TS keyword set and the type-position pass.
// Exact class+span fixtures, degradation pins shared with the JS core are
// NOT re-pinned here (see syntax-javascript.test.ts); what matters is the
// delta: type annotations, interface/extends names, `as`/`satisfies`
// casts, contextual `type`, and the losslessness sweep + registry wiring.

import { describe, it, expect } from "bun:test";
import { getTokenizer, resolveSyntaxLang, type SyntaxRun } from "@utils/syntax/index.ts";
import { tokenizeTypeScript } from "@utils/syntax/typescript.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

/** The tokenizer's declared class vocabulary (every run must live here). */
const TYPES = new Set([
  "keyword",
  "fn",
  "string",
  "template",
  "number",
  "boolean",
  "null",
  "comment",
  "decorator",
  "regexp",
  "key",
  "type",
  "operator",
  "default",
]);

/** Drop the whitespace/newline passthrough to assert the interesting runs. */
const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeTypeScript annotations", () => {
  it("types after colons: primitives and Capitalized names", () => {
    expect(significant(tokenizeTypeScript('function f(a: string): Promise<void> { return x; }'))).toEqual([
      run("keyword", "function"),
      run("fn", "f"),
      run("operator", "("),
      run("key", "a"),
      run("operator", ":"),
      run("type", "string"),
      run("operator", ")"),
      run("operator", ":"),
      run("type", "Promise"),
      run("operator", "<"),
      run("keyword", "void"),
      run("operator", ">"),
      run("operator", "{"),
      run("keyword", "return"),
      run("default", "x"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
  });

  it("interface names and members", () => {
    expect(significant(tokenizeTypeScript('interface Shape { kind: "a"; area(): number }'))).toEqual([
      run("keyword", "interface"),
      run("type", "Shape"),
      run("operator", "{"),
      run("key", "kind"),
      run("operator", ":"),
      run("string", '"a"'),
      run("operator", ";"),
      run("fn", "area"),
      run("operator", "("),
      run("operator", ")"),
      run("operator", ":"),
      run("type", "number"),
      run("operator", "}"),
    ]);
  });

  it("as/satisfies/is casts paint the type", () => {
    expect(significant(tokenizeTypeScript("const y = x as Foo;"))).toEqual([
      run("keyword", "const"),
      run("default", "y"),
      run("operator", "="),
      run("default", "x"),
      run("keyword", "as"),
      run("type", "Foo"),
      run("operator", ";"),
    ]);
    expect(significant(tokenizeTypeScript("function is(t: unknown): t is Foo { return true; }")))
      .toContainEqual(run("type", "Foo"));
  });

  it("type aliases and generics in declarations", () => {
    expect(significant(tokenizeTypeScript("type Handler = (e: Event) => void;"))).toEqual([
      run("keyword", "type"),
      run("type", "Handler"),
      run("operator", "="),
      run("operator", "("),
      run("key", "e"),
      run("operator", ":"),
      run("type", "Event"),
      run("operator", ")"),
      run("operator", "=>"),
      run("keyword", "void"),
      run("operator", ";"),
    ]);
  });

  it("a lowercase non-primitive after a colon stays default (no false type)", () => {
    const runs = significant(tokenizeTypeScript("const cfg = { retry: count };"));
    expect(runs.some((r) => r.type === "type")).toBe(false);
    expect(runs).toContainEqual(run("key", "retry"));
  });

  it("`type` and friends are object keys before they are keywords", () => {
    expect(significant(tokenizeTypeScript('const o = { type: "a", readonly: true };'))).toEqual([
      run("keyword", "const"),
      run("default", "o"),
      run("operator", "="),
      run("operator", "{"),
      run("key", "type"),
      run("operator", ":"),
      run("string", '"a"'),
      run("operator", ","),
      run("key", "readonly"),
      run("operator", ":"),
      run("boolean", "true"),
      run("operator", "}"),
      run("operator", ";"),
    ]);
  });

  it("access modifiers, enums, implements, generics degrade sanely", () => {
    expect(significant(tokenizeTypeScript("class Dog extends Animal implements Pet { private name: string }")))
      .toEqual([
        run("keyword", "class"),
        run("default", "Dog"),
        run("keyword", "extends"),
        run("type", "Animal"),
        run("keyword", "implements"),
        run("type", "Pet"),
        run("operator", "{"),
        run("keyword", "private"),
        run("key", "name"),
        run("operator", ":"),
        run("type", "string"),
        run("operator", "}"),
      ]);
  });

  it("tsx tag regions degrade exactly like jsx (brackets operator, markup plain)", () => {
    const runs = significant(tokenizeTypeScript("const el = <Btn onClick={f} />;"));
    expect(runs.filter((r) => r.type === "operator" && (r.text === "<" || r.text === "/>")).map((r) => r.text))
      .toEqual(["<"]);
    expect(runs.some((r) => r.type === "type")).toBe(false); // Btn rides default, honestly
  });
});


describe("tokenizeTypeScript losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "x".repeat(50000),
    "`".repeat(500),
    "/".repeat(999),
    "\\",
    '"\\',
    "`${}",
    "`${",
    "/*/",
    "</",
    "=>",
    ":<,>",
    "as as as",
    "type type type",
    "interface extends implements keyof infer satisfies readonly",
    "x: Foo<Bar<Baz>>[] | null & undefined",
    "// c\n: T",
    "/* : T */",
    '"a:" b',
    "`a: ${b}: c`",
    "🚀 漢字 é: Type",
    "const x: { a: () => Promise<string[]> } = f();",
    "enum E { A = 1, B }",
    "declare module \"x\" { const y: number }",
    "function g<T extends object>(x: T): T { return x; }",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeTypeScript(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      ":",
      ";",
      ",",
      "<",
      ">",
      "|",
      "&",
      "[",
      "]",
      "{",
      "}",
      "=>",
      "interface",
      "type",
      "extends",
      "implements",
      "as",
      "is",
      "keyof",
      "readonly",
      "Foo",
      "Bar",
      "string",
      "number",
      "void",
      "x",
      "1",
      '"s"',
      "`t${x}`",
      "//c\n",
      "/*c*/",
      "/*",
      "'",
      "/",
      " ",
      "\n",
      "\r\n",
      "🚀",
      "@",
      '"unterminated',
      "`unterm",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeTypeScript(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("typescript tokenizer wiring", () => {
  it("getTokenizer resolves typescript; tsx is a def alias, not a second name", () => {
    expect(getTokenizer("typescript")).toBe(tokenizeTypeScript);
    expect(resolveSyntaxLang("tsx")).toBe("typescript");
    expect(getTokenizer("tsx")).toBeUndefined(); // resolve the alias, fetch by canonical name
    const sample = 'import type { X } from "./y"; const v: Foo = g(); // tsc';
    const runs = getTokenizer("typescript")!(sample);
    expect(runs.map((r) => r.text).join("")).toBe(sample); // the registry contract, held
    expect(significant(runs)).toContainEqual(run("comment", "// tsc"));
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual(["Foo"]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "import",
      "type",
      "from",
      "const",
    ]);
  });
});
