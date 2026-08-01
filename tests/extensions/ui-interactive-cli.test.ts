import { describe, it, expect } from "bun:test";
import { SEND_TO_ASSISTANT_SUFFIX_RE } from "../../src/extensions/ui-interactive-cli/index.ts";

describe("SEND_TO_ASSISTANT_SUFFIX_RE", () => {
  const shouldMatch = [
    "ls -la |@",
    "ls -la | @",
    "ls -la |   @",
    "ls -la|\t@",
    "ls -la | @ ",
    "ls -la | @  ",
    "ls -la |@   ",
    "ls -la |   @   ",
    "ls -la|\t@\t",
    "git diff |@",
    "git diff | @",
    "echo hello | @",
    "|@",
    "| @",
    "ls -la ||@",
  ];

  const shouldNotMatch = [
    "ls -la",
    "ls -la |",
    "ls -la | something",
    "ls -la | foo",
    "ls -la | bar@",
    "ls -la | @@ ",
    "ls -la |@ foo",
    "ls -la @",
    "ls -la ||",
    "",
    "   ",
    "|",
    "@",
  ];

  for (const cmd of shouldMatch) {
    it(`matches "${cmd}"`, () => {
      expect(SEND_TO_ASSISTANT_SUFFIX_RE.test(cmd)).toBe(true);
    });
  }

  for (const cmd of shouldNotMatch) {
    it(`does not match "${cmd}"`, () => {
      expect(SEND_TO_ASSISTANT_SUFFIX_RE.test(cmd)).toBe(false);
    });
  }

  describe("stripping suffix", () => {
    const cases: [input: string, expected: string][] = [
      ["ls -la |@", "ls -la"],
      ["ls -la | @", "ls -la"],
      ["ls -la |   @", "ls -la"],
      ["ls -la | @   ", "ls -la"],
      ["ls -la|\t@\t", "ls -la"],
      ["git diff | @", "git diff"],
      ["|@", ""],
    ];

    for (const [input, expected] of cases) {
      it(`strips suffix from "${input}" to get "${expected}"`, () => {
        const result = input.replace(SEND_TO_ASSISTANT_SUFFIX_RE, "").trim();
        expect(result).toBe(expected);
      });
    }
  });
});
