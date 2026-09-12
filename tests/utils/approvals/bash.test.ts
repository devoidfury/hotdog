// Bash triage: the bail table (everything that could hide an effect => ASK)
// and the honest-command happy paths. Pure -- a lexical Workspace over "/ws"
// stands in for a real one, nothing touches disk.

import { describe, it, expect } from "bun:test";
import { Workspace } from "@utils/workspace.ts";
import { parseCommandline } from "@utils/approvals/bash.ts";

const ws = new Workspace("/ws");

function parse(command: string) {
  return parseCommandline(command, ws);
}

/** Assert a bail and (optionally) that the reason mentions something. */
function expectBail(command: string, mentions?: string) {
  const r = parse(command);
  expect(r.ok, `${command} should bail`).toBe(false);
  if (!r.ok) {
    expect(r.reason.length).toBeGreaterThan(0);
    if (mentions) expect(r.reason.toLowerCase()).toContain(mentions.toLowerCase());
  }
}

function values(r: ReturnType<typeof parse>, param: string): string[] {
  if (!r.ok) throw new Error(`expected ok, got bail: ${r.reason}`);
  return r.targets.filter((t) => t.param === param).map((t) => t.value);
}

describe("bail table (anything unanalyzable is an ASK)", () => {
  it("bails on substitutions and expansions", () => {
    expectBail("echo $(whoami)", "expansion");
    expectBail("echo `id`", "backtick");
    expectBail("echo ${HOME}", "expansion");
    expectBail("echo $HOME", "expansion");
    expectBail('echo "a$b"', "expansion");
    expectBail("echo `date`", "backtick");
  });

  it("bails on groups, brace expansion and globs", () => {
    expectBail("(cd /ws && ls)", "parenthesis");
    expectBail("echo {a,b}", "brace");
    expectBail("ls *.ts", "glob");
    expectBail("ls src[0-9]", "glob");
  });

  it("bails on home expansion, here-documents and unbalanced quotes", () => {
    expectBail("cat ~/.ssh/id_rsa", "home");
    expectBail("cat <<EOF", "here-document");
    expectBail("cat <<< inline", "here-document");
    expectBail('echo "abc', "unbalanced");
    expectBail("echo 'abc", "unbalanced");
  });

  it("bails on the program-running utilities", () => {
    expectBail("xargs rm < files", "xargs");
    expectBail("eval ls", "eval");
    expectBail("env FOO=1 ls", "env");
    expectBail("find . -delete", "find");
    expectBail("find src -exec rm '{}' +", "find");
    expectBail("awk '{print $1}' f", "awk");
  });

  it("bails on inline-code interpreters but not on the same commands without the flag", () => {
    expectBail("bash -c 'rm -rf /tmp/x'", "inline code");
    expectBail("sh -c \"echo hi\"", "inline code");
    expectBail("python -c 'print(1)'", "inline code");
    expectBail("node -e 'process.exit(0)'", "inline code");
    expectBail("perl -E 'say 1'", "inline code");
    expectBail("ruby -e 'puts 1'", "inline code");
    // The same binaries doing ordinary things are fine.
    expect(parse("python script.py").ok).toBe(true);
    expect(parse("node build.js").ok).toBe(true);
    expect(parse("find . -name tmp").ok).toBe(true);
  });

  it("bails on quoting tricks around the command name and on cd escapes", () => {
    expectBail('"git" status', "quoted");
    expectBail("cd / && ls", "leaves the workspace");
    expectBail("cd ../outside && cat x", "leaves the workspace");
    expectBail("cd", "without a directory");
    expectBail("echo hi >", "redirection");
    expectBail("", "nothing to analyze");
  });
});

describe("happy paths", () => {
  it("extracts one command basename", () => {
    expect(values(parse("git status"), "cmd")).toEqual(["git"]);
    expect(values(parse("/usr/bin/git push origin main"), "cmd")).toEqual(["git"]);
  });

  it("checks every segment of a chain or pipeline", () => {
    const r = parse("git add . && git commit -m 'msg' | tee log");
    expect(values(r, "cmd")).toEqual(["git", "tee"]); // repeated values collapse
    expect(values(parse("git status && ls -la"), "cmd")).toEqual(["git", "ls"]);
    expect(values(parse("ls; pwd\necho hi"), "cmd")).toEqual(["ls", "pwd", "echo"]);
    expect(values(parse("cat notes.md | grep todo"), "cmd")).toEqual(["cat", "grep"]);
  });

  it("resolves path arguments against the workspace root", () => {
    const r = parse("cat src/app.ts");
    expect(values(r, "path")).toEqual(["/ws/src/app.ts"]);
    expect(r.ok && r.targets.find((t) => t.param === "path")?.relative).toBe("src/app.ts");
    expect(values(parse("cat /etc/passwd"), "path")).toEqual(["/etc/passwd"]);
    // out-of-root paths have no relative form but stay deny-matchable
    expect(r.ok && r.targets.some((t) => t.param === "path" && t.relative === undefined)).toBe(false);
    const out = parse("cat /etc/passwd");
    expect(out.ok && out.targets.find((t) => t.param === "path")?.relative).toBeUndefined();
  });

  it("retargets the relative base on cd", () => {
    const r = parse("cd src && cat ./app.ts");
    expect(values(r, "path")).toEqual(["/ws/src/app.ts"]);
    expect(values(parse("cd src; cat ../secrets/key.pem"), "path")).toEqual(["/ws/secrets/key.pem"]);
    // cd inside the roots is allowed and is not itself a target
    expect(values(parse("cd build && ls"), "path")).toEqual([]);
  });

  it("treats redirection targets as paths, and ignores inert ones", () => {
    expect(values(parse("echo hi > out.txt"), "path")).toEqual(["/ws/out.txt"]);
    expect(values(parse("echo hi >> /ws/logs/app.log"), "path")).toEqual(["/ws/logs/app.log"]);
    expect(values(parse("npm run build > /dev/null 2>&1"), "path")).toEqual([]);
    expect(values(parse("sort < /ws/in.txt"), "path")).toEqual(["/ws/in.txt"]);
  });

  it("keeps flags and barewords out of the way (opaque, deny-only)", () => {
    const r = parse("grep -rn TODO src/");
    expect(values(r, "path")).toEqual(["/ws/src"]);
    if (!r.ok) throw new Error("unexpected bail");
    const opaque = r.targets.filter((t) => t.param === "arg");
    expect(opaque.map((t) => t.value)).toEqual(["TODO"]);
    expect(opaque.every((t) => t.denyOnly)).toBe(true);
  });

  it("respects quotes: a quoted glob or slash-word is a literal, not magic", () => {
    expect(parse('git commit -m "fix * bug"').ok).toBe(true);
    expect(values(parse('cat "a b/c.txt"'), "path")).toEqual(["/ws/a b/c.txt"]);
    expect(values(parse("grep '*' file"), "arg")).toEqual(["*", "file"]);
  });

  it("treats an escaped glob char as a literal, not magic", () => {
    expect(parse("echo \\*").ok).toBe(true);
  });

  it("joins backslash-continued lines the way bash does", () => {
    // `echo<backslash-newline>hello` is one command, `echohello`.
    expect(values(parse("echo\\\nhello"), "cmd")).toEqual(["echohello"]);
  });

  it("ignores comments and blank segments", () => {
    const r = parse("git status # show me");
    expect(values(r, "cmd")).toEqual(["git"]);
    expect(values(parse("ls && ;; pwd"), "cmd")).toEqual(["ls", "pwd"]);
  });
});
