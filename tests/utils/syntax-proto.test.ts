// Unit tests for the Protobuf tokenizer (src/utils/syntax/protobuf.ts):
// the c.ts family shape (comments, both string quote forms, the call peek
// surviving the dot, the Capitalized-typedef heuristic with member
// refusal) with the spec's departures, all pinned: NO preprocessor (a `#`
// is a plain byte), the operator set is EXACTLY the grammar's punctuation
// (every single char; there is no two-char token -- `2 .. 5` is dot-dot,
// `+ ! ? % @ ~ &` are bytes), the spec's 43 keywords SPLIT (fifteen
// scalars ride type, `inf`/`nan` ride number -- keyword TOKENS but float
// VALUES, the decide-and-pin -- the other twenty-six ride keyword,
// including the barely-used weak/public/export/local/group and the
// editions-era `edition`), `true`/`false` ride boolean though the spec
// makes them identifiers (pinned), `deprecated` is NOT in the closed list
// and rides a plain word (spec over plan), the type heuristic narrowed to
// UpperCamelCase (`SearchRequest` type, `UNKNOWN` a plain word -- the
// proto-spelling correction of the c.ts rule), the TWO-STAGE numeric
// lexical (the greedy scan makes `0.0.0`/`100to3` ONE malformed token
// riding default whole -- no split into number plus word -- while
// decimal/octal/hex/float shapes pass validation, `08` and `0b101` are
// malformed -- there is NO binary), ASCII-only identifiers, and the name
// decision: canonical "protobuf" with "proto" as the fence alias (the
// graphql precedent) and `.proto` the extension. Losslessness plus
// registry pins round it out.

import { describe, it, expect } from "bun:test";
import { getTokenizer, guessLangForBase, resolveSyntaxLang } from "@utils/syntax/index.ts";
import { tokenizeProtobuf } from "@utils/syntax/protobuf.ts";
import type { SyntaxRun } from "@utils/syntax/index.ts";

const run = (type: string, text: string): SyntaxRun => ({ type, text });

// The c-family palette minus preproc/null/key: proto has no directive
// line, no null literal, and no key glue.
const TYPES = new Set([
  "comment",
  "string",
  "keyword",
  "type",
  "boolean",
  "number",
  "fn",
  "operator",
  "default",
]);

const significant = (runs: SyntaxRun[]): SyntaxRun[] =>
  runs.filter((r) => r.type !== "default" || r.text.trim() !== "");

describe("tokenizeProtobuf structure", () => {
  it("message: keywords, scalar types, fields as plain words", () => {
    expect(significant(tokenizeProtobuf("message Foo { optional string name = 1; repeated int32 ids = 2; }"))).toEqual([
      run("keyword", "message"),
      run("type", "Foo"), // DECL_KW: the name after message/enum/service/extend
      run("operator", "{"),
      run("keyword", "optional"),
      run("type", "string"), // the fifteen scalars ride type, not keyword
      run("default", "name"),
      run("operator", "="),
      run("number", "1"),
      run("operator", ";"),
      run("keyword", "repeated"),
      run("type", "int32"),
      run("default", "ids"),
      run("operator", "="),
      run("number", "2"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
    expect(significant(tokenizeProtobuf("map<string, int32> counts = 3;"))).toEqual([
      run("keyword", "map"),
      run("operator", "<"),
      run("type", "string"),
      run("operator", ","),
      run("type", "int32"),
      run("operator", ">"),
      run("default", "counts"),
      run("operator", "="),
      run("number", "3"),
      run("operator", ";"),
    ]);
  });

  it("service and rpc: the call peek names the method (rpc is NOT a decl word)", () => {
    expect(significant(tokenizeProtobuf("service Greeter { rpc SayHello(HelloRequest) returns (HelloReply); }"))).toEqual([
      run("keyword", "service"),
      run("type", "Greeter"),
      run("operator", "{"),
      run("keyword", "rpc"),
      run("fn", "SayHello"), // the call peek wins (pinned: rpc is deliberately not DECL_KW)
      run("operator", "("),
      run("type", "HelloRequest"), // UpperCamelCase: the proto spelling of a type
      run("operator", ")"),
      run("keyword", "returns"),
      run("operator", "("),
      run("type", "HelloReply"),
      run("operator", ")"),
      run("operator", ";"),
      run("operator", "}"),
    ]);
    expect(significant(tokenizeProtobuf("rpc Search(SearchRequest) returns (stream SearchResponse);"))).toEqual([
      run("keyword", "rpc"),
      run("fn", "Search"),
      run("operator", "("),
      run("type", "SearchRequest"),
      run("operator", ")"),
      run("keyword", "returns"),
      run("operator", "("),
      run("keyword", "stream"),
      run("type", "SearchResponse"),
      run("operator", ")"),
      run("operator", ";"),
    ]);
  });

  it("the dot flag: qualified names split and every reading but the call peek is refused", () => {
    expect(significant(tokenizeProtobuf("google.protobuf.Timestamp created = 5; .Kind x = 1;"))).toEqual([
      run("default", "google"),
      run("operator", "."),
      run("default", "protobuf"),
      run("operator", "."),
      run("default", "Timestamp"), // member position: the type reading is refused (the c.ts ruling)
      run("default", "created"),
      run("operator", "="),
      run("number", "5"),
      run("operator", ";"),
      run("operator", "."),
      run("default", "Kind"), // ...and so is the keyword reading after a member dot
      run("default", "x"),
      run("operator", "="),
      run("number", "1"),
      run("operator", ";"),
    ]);
    expect(significant(tokenizeProtobuf("bar.Baz(2)"))).toEqual([
      run("default", "bar"),
      run("operator", "."),
      run("fn", "Baz"), // the call peek survives the dot (the family rule)
      run("operator", "("),
      run("number", "2"),
      run("operator", ")"),
    ]);
  });

  it("numbers: the two-stage lexical, malformed runs ride default WHOLE", () => {
    expect(significant(tokenizeProtobuf("123 0 0741 0x0f6db2 0.5 .123 1. 1.234e-12 5E+40"))).toEqual([
      run("number", "123"),
      run("number", "0"),
      run("number", "0741"), // octal is a real spelling here (unlike nix/hcl)
      run("number", "0x0f6db2"), // and hex (unlike nix)
      run("number", "0.5"),
      run("number", ".123"), // leading-dot float
      run("number", "1."), // trailing-dot float
      run("number", "1.234e-12"),
      run("number", "5E+40"),
    ]);
    // Stage one is GREEDY (the spec's own examples): the malformed token
    // stays ONE run -- the pinned contrast with the hcl/nix degradations.
    expect(significant(tokenizeProtobuf("0b101 08 1e 1.2.3 100to3 0.0.0"))).toEqual([
      run("default", "0b101"), // NO binary form (the c.ts binary arm rejected)
      run("default", "08"), // not decimal (leading 0), not octal (8)
      run("default", "1e"), // exponent without digits
      run("default", "1.2.3"), // ONE malformed token, not 1.2 + . + 3
      run("default", "100to3"), // the spec's own example
      run("default", "0.0.0"), // ...and this one
    ]);
  });

  it("values: boolean pair, inf/nan as number, spec-noise pinned", () => {
    expect(significant(tokenizeProtobuf("true false inf -inf nan"))).toEqual([
      run("boolean", "true"), // NOT spec keywords (identifiers) -- display boolean, pinned
      run("boolean", "false"),
      run("number", "inf"), // spec KEYWORD tokens, float VALUES: the number pin
      run("operator", "-"),
      run("number", "inf"),
      run("number", "nan"),
    ]);
    expect(significant(tokenizeProtobuf("option deprecated = true;"))).toEqual([
      run("keyword", "option"),
      run("default", "deprecated"), // NOT in the spec's closed 43: an option name, a plain word
      run("operator", "="),
      run("boolean", "true"),
      run("operator", ";"),
    ]);
  });

  it("keywords: imports, reserved ranges, and the rarely-used reserveds", () => {
    expect(significant(tokenizeProtobuf('import "b.proto"; import public "c.proto"; import weak "d.proto";'))).toEqual([
      run("keyword", "import"),
      run("string", '"b.proto"'),
      run("operator", ";"),
      run("keyword", "import"),
      run("keyword", "public"),
      run("string", '"c.proto"'),
      run("operator", ";"),
      run("keyword", "import"),
      run("keyword", "weak"),
      run("string", '"d.proto"'),
      run("operator", ";"),
    ]);
    expect(significant(tokenizeProtobuf("reserved 2 to 5, 15 to max;"))).toEqual([
      run("keyword", "reserved"),
      run("number", "2"),
      run("keyword", "to"), // ranges spell `to`...
      run("number", "5"),
      run("operator", ","),
      run("number", "15"),
      run("keyword", "to"),
      run("keyword", "max"),
      run("operator", ";"),
    ]);
    // `2 .. 5` is NOT a range token (the grammar has no `..`): two dots.
    expect(significant(tokenizeProtobuf("2 .. 5"))).toEqual([
      run("number", "2"),
      run("operator", "."),
      run("operator", "."),
      run("number", "5"),
    ]);
    expect(significant(tokenizeProtobuf("optional group Blah = 1 {}"))).toEqual([
      run("keyword", "optional"),
      run("keyword", "group"), // removed from proto3 GRAMMARS, still a reserved word
      run("type", "Blah"),
      run("operator", "="),
      run("number", "1"),
      run("operator", "{"),
      run("operator", "}"),
    ]);
  });

  it("custom options and message literals get no special arms", () => {
    expect(significant(tokenizeProtobuf("option (my.opt) = { a: 1 };"))).toEqual([
      run("keyword", "option"),
      run("operator", "("),
      run("default", "my"),
      run("operator", "."),
      run("default", "opt"),
      run("operator", ")"),
      run("operator", "="),
      run("operator", "{"),
      run("default", "a"), // message-literal fields ride plain words...
      run("operator", ":"), // ...past the colon single
      run("number", "1"),
      run("operator", "}"),
      run("operator", ";"),
    ]);
  });

  it("comments; the byte set where the c family would expect operators", () => {
    expect(significant(tokenizeProtobuf("// line\n/* block */ a /* a /* b */ c */"))).toEqual([
      run("comment", "// line"),
      run("comment", "/* block */"),
      run("default", "a"),
      run("comment", "/* a /* b */"), // NEVER nested
      run("default", "c"),
      run("default", "*"), // `*` is not even an operator here
      run("operator", "/"),
    ]);
    // NO preprocessor and NO arithmetic beyond minus: the c-family traps,
    // pinned as plain bytes:
    expect(significant(tokenizeProtobuf("#include + & | ! ? % ~ @ ^"))).toEqual([
      run("default", "#"),
      run("default", "include"),
      run("default", "+"),
      run("default", "&"),
      run("default", "|"),
      run("default", "!"),
      run("default", "?"),
      run("default", "%"),
      run("default", "~"),
      run("default", "@"),
      run("default", "^"),
    ]);
  });

  it("strings: both quote forms, C escapes, the newline wall", () => {
    expect(significant(tokenizeProtobuf('"a\\nb \\"q\\" \\x41 \u2192" \'sq ok\''))).toEqual([
      run("string", '"a\\nb \\"q\\" \\x41 \u2192"'), // escapes ride the generic backslash skip
      run("string", "'sq ok'"), // single quotes are literals too (no interpolation anywhere)
    ]);
  });

  it("identifiers are ASCII; unicode rides bytes", () => {
    expect(tokenizeProtobuf("a\u00a0b")).toEqual([
      run("default", "a"),
      run("default", "\u00a0"), // the pinned tightening versus the permissive c.ts family
      run("default", "b"),
    ]);
  });
});

describe("tokenizeProtobuf line-wise degradation (the file view tokenizes per line)", () => {
  it("an unterminated string stops at the newline; the next line re-reads", () => {
    expect(tokenizeProtobuf('string x = "abc\ndef;')).toEqual([
      run("type", "string"), // a scalar type, not a keyword
      run("default", " "),
      run("default", "x"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("string", '"abc'),
      run("default", "\n"),
      run("default", "def"),
      run("operator", ";"),
    ]);
  });

  it("a block comment reaches its closer across newlines; unclosed runs on", () => {
    expect(tokenizeProtobuf("x /* open\ny */ 1")).toEqual([
      run("default", "x"),
      run("default", " "),
      run("comment", "/* open\ny */"),
      run("default", " "),
      run("number", "1"),
    ]);
    expect(tokenizeProtobuf("x /* open")).toEqual([
      run("default", "x"),
      run("default", " "),
      run("comment", "/* open"),
    ]);
  });

  it("a backslash before the newline splices the string (the c.ts family)", () => {
    expect(tokenizeProtobuf('a = "x\\\ny";')).toEqual([
      run("default", "a"),
      run("default", " "),
      run("operator", "="),
      run("default", " "),
      run("string", '"x\\\ny"'),
      run("operator", ";"),
    ]);
  });
});

describe("tokenizeProtobuf registry contract", () => {
  it("guesses and fences resolve through the registry", () => {
    expect(guessLangForBase("user.proto")).toBe("protobuf");
    expect(guessLangForBase("USER.PROTO")).toBe("protobuf"); // case-insensitive extension
    expect(guessLangForBase("message.protos")).toBeUndefined();
    expect(guessLangForBase("proto")).toBeUndefined(); // dotless stem
    expect(resolveSyntaxLang("protobuf")).toBe("protobuf"); // canonical
    expect(resolveSyntaxLang("proto")).toBe("protobuf"); // the fence alias (graphql precedent)
    expect(resolveSyntaxLang("PROTO")).toBe("protobuf"); // alias index is case-insensitive
    expect(resolveSyntaxLang("PROTOBUF")).toBeUndefined(); // the canonical name resolves exactly
    expect(resolveSyntaxLang("protocol-buffers")).toBeUndefined(); // a made-up fence word
    expect(getTokenizer("protobuf")).toBe(tokenizeProtobuf);
  });
});

describe("tokenizeProtobuf losslessness", () => {
  const CORPUS: string[] = [
    "",
    " ",
    "\n",
    "\r\n",
    "\r",
    "\u0000\u001b",
    "a".repeat(50000),
    "#",
    "//",
    "/*",
    "*/",
    '"',
    '"unterm',
    "'",
    "'unterm",
    "\\",
    "\\\n",
    "$",
    "%",
    "&",
    "|",
    "@",
    "~",
    "^",
    "?",
    "!",
    "+",
    "*",
    ".",
    "..",
    "...",
    ".5",
    "0x",
    "0b101",
    "08",
    "1e",
    "1e-",
    "1e+5",
    "1.2.3",
    "0.0.0",
    "100to3",
    "100To3",
    "0741",
    "1.",
    "inf",
    "nan",
    "true",
    "false",
    "group",
    "to",
    "max",
    "weak",
    "public",
    "export",
    "local",
    "edition",
    "deprecated",
    "rpc",
    "returns",
    "stream",
    "message",
    "Foo",
    "SearchRequest",
    "UNKNOWN",
    "GtkWidget",
    "Timestamp",
    "a\u00a0b", // NBSP is not the isWs family: it rides its own byte
    "rocket emoji ünïcøde 漢字",
    "syntax",
    "proto3",
    "_x",
    "x1",
    "X",
  ];

  for (const [i, input] of CORPUS.entries()) {
    it(`re-forms corpus entry ${i} (${JSON.stringify(input.slice(0, 48))}) exactly`, () => {
      const runs = tokenizeProtobuf(input);
      expect(runs.map((r) => r.text).join("")).toBe(input);
      for (const r of runs) {
        expect(TYPES.has(r.type)).toBe(true);
        expect(r.text).not.toBe("");
      }
    });
  }

  it("re-forms 400 deterministic fragment mashups exactly", () => {
    const FRAGS = [
      "//",
      "/*",
      "*/",
      '"',
      "'",
      "\\",
      "\n",
      "\r\n",
      " ",
      "#",
      "$",
      "+",
      "-",
      ";",
      ",",
      ".",
      "..",
      ":",
      "=",
      "(",
      ")",
      "{",
      "}",
      "[",
      "]",
      "<",
      ">",
      "?",
      "!",
      "inf",
      "nan",
      "true",
      "false",
      "rpc",
      "returns",
      "stream",
      "message",
      "to",
      "max",
      "0x",
      "0b101",
      "1.2.3",
      ".5",
      "42",
      "1e",
      "Foo",
      "SearchRequest",
      "UNKNOWN",
      "int32",
      "map",
      "option",
      "rocket",
      "x",
    ];
    let seed = 11;
    for (let i = 0; i < 400; i++) {
      let input = "";
      for (let j = 0; j < 18; j++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        input += FRAGS[seed % FRAGS.length];
      }
      const runs = tokenizeProtobuf(input);
      if (runs.map((r) => r.text).join("") !== input) {
        throw new Error(`LOSSLESSNESS VIOLATION at case ${i}: ${JSON.stringify(input)}`);
      }
      for (const r of runs) expect(TYPES.has(r.type)).toBe(true);
    }
  });
});

describe("protobuf tokenizer wiring", () => {
  it("getTokenizer resolves protobuf to tokenizeProtobuf and classes a real proto3 file", () => {
    const code = [
      "// user.proto -- the users service.",
      'syntax = "proto3";',
      "",
      "package example.users;",
      "",
      'import "google/protobuf/timestamp.proto";',
      "",
      'option java_package = "com.example.users";',
      "option (my.validate) = { min_len: 1 };",
      "",
      "message User {",
      "  reserved 2, 15, 9 to 11;",
      '  reserved "foo", "bar";',
      "",
      "  string name = 1;",
      "  optional uint32 age = 3;",
      "  repeated string email = 4;",
      "  map<string, int32> scores = 5;",
      "  google.protobuf.Timestamp created = 6;",
      "  oneof contact {",
      "    string phone = 7;",
      "    bytes address = 8;",
      "  }",
      "",
      "  enum Kind {",
      "    UNKNOWN = 0;",
      "    ADMIN = 1;",
      "  }",
      "  Kind kind = 9;",
      "}",
      "",
      "service UserService {",
      "  rpc Get(GetRequest) returns (User);",
      "  rpc Search(stream SearchRequest) returns (stream User) {",
      "    option deprecated = true;",
      "  }",
      "}",
      "",
      "message GetRequest {",
      '  int64 id = 1 [deprecated = true, json_name = "old_id"];',
      "}",
      "",
      "message SearchRequest {",
      "  string query = 1 [(my.limit).max = 100];",
      "  double boost = 2 [default = nan];",
      "}",
    ].join("\n");
    const runs = getTokenizer("protobuf")!(code);
    expect(runs.map((r) => r.text).join("")).toBe(code); // the registry contract, held
    expect(runs.filter((r) => r.type === "comment").map((r) => r.text)).toEqual([
      "// user.proto -- the users service.",
    ]);
    expect(runs.filter((r) => r.type === "keyword").map((r) => r.text)).toEqual([
      "syntax",
      "package",
      "import",
      "option",
      "option",
      "message",
      "reserved",
      "to",
      "reserved",
      "optional",
      "repeated",
      "map",
      "oneof",
      "enum",
      "service",
      "rpc",
      "returns",
      "rpc",
      "stream",
      "returns",
      "stream",
      "option",
      "message",
      "message",
    ]);
    // NOTE `(my.limit).max`: the `max` there rides DEFAULT (the member
    // refusal after a dot, the documented cost), which is why it does not
    // appear in the keyword list above.
    expect(runs.filter((r) => r.type === "type").map((r) => r.text)).toEqual([
      "User",
      "string",
      "uint32",
      "string",
      "string",
      "int32",
      "string", // oneof's `string phone`... (oneof name itself rides default)
      "bytes",
      "Kind",
      "Kind",
      "UserService",
      "GetRequest",
      "User",
      "SearchRequest",
      "User",
      "GetRequest",
      "int64",
      "SearchRequest",
      "string",
      "double",
    ]);
    expect(runs.filter((r) => r.type === "fn").map((r) => r.text)).toEqual(["Get", "Search"]);
    expect(runs.filter((r) => r.type === "boolean").map((r) => r.text)).toEqual(["true", "true"]);
    expect(runs.filter((r) => r.type === "number").map((r) => r.text)).toEqual([
      "1", // min_len
      "2",
      "15",
      "9",
      "11",
      "1",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "0",
      "1",
      "9",
      "1",
      "1",
      "100",
      "2",
      "nan", // the float literal rides number
    ]);
    expect(runs.filter((r) => r.type === "string").map((r) => r.text)).toEqual([
      '"proto3"',
      '"google/protobuf/timestamp.proto"',
      '"com.example.users"',
      '"foo"',
      '"bar"',
      '"old_id"',
    ]);
    // `Timestamp` sits in the member chain and rides plain words (the dot
    // flag refuses the type reading):
    expect(runs.filter((r) => r.text === "Timestamp")).toEqual([run("default", "Timestamp")]);
    // No null class, no preproc class exist:
    expect(runs.filter((r) => r.type === "null" || r.type === "preproc")).toEqual([]);
  });
});
