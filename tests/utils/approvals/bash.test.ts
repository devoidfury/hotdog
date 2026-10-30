// Bash triage: the bail table (everything that could hide an effect => ASK)
// and the honest-command happy paths. Pure -- a lexical Workspace over "/ws"
// stands in for a real one, nothing touches disk.

import { describe, it, expect } from "bun:test";
import { Workspace } from "@utils/workspace.ts";
import { parseCommandline } from "@utils/approvals/bash.ts";
import { compileApprovalRules, decide } from "@utils/approvals/rules.ts";

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

  it("bails on bundled and glued inline-code flags (bypass corpus)", () => {
    // Exact-word flag matching parsed every form below as clean; each one
    // runs a program: `-lc` bundles `-c`, and a glued tail reads as one
    // quoted word whose text starts with the flag.
    expectBail("bash -lc 'echo hi'", "inline code");
    expectBail("sh -lc \"echo hi\"", "inline code");
    expectBail("bash -lxc 'echo hi'", "inline code");
    expectBail("python -c'print(1)'", "inline code");
    expectBail("python3 -c'import os'", "inline code");
    expectBail("perl -e'print 1'", "inline code");
    expectBail("node -e'process.exit(0)'", "inline code");
    expectBail("ruby -e'puts 1'", "inline code");
    expectBail("node --eval 'process.exit(0)'", "inline code");
    // Ordinary flags on the same binaries stay parseable.
    expect(parse("bash --norc script.sh").ok).toBe(true);
    expect(parse("python -m pytest").ok).toBe(true);
    expect(parse("node --check index.js").ok).toBe(true);
    expect(parse("ruby --version").ok).toBe(true);
  });

  it("bails on node print-as-code and perl/ruby flag bundlings (bypass corpus, round 2)", () => {
    // `--print`/`-p` eval their operand like `-e` does; `-pe` bundles both.
    expectBail(`node --print "require('child_process').execSync('id')"`, "inline code");
    expectBail("node -p 'process.exit(0)'", "inline code");
    expectBail("node -pe 'process.exit(0)'", "inline code");
    // perl bundles its code flag (`-le`, `-lE`, the `-ane` idiom); ruby bundles
    // lowercase `e` (`-ne`, `-pe`) and has the `--eval` long form.
    expectBail("perl -le 'system(q/id/)'", "inline code");
    expectBail("perl -lE 'say 1'", "inline code");
    expectBail("perl -ane 'print $F[0]'", "inline code");
    expectBail("ruby -ne 'puts 1'", "inline code");
    expectBail("ruby -pe 'puts 1'", "inline code");
    expectBail("ruby --eval 'puts 1'", "inline code");
    // Honest use of the same binaries stays parseable. Ruby's `-E` is the
    // encoding flag, not a code runner, so the ruby bundle regex stays lowercase.
    expect(parse("node --check index.js").ok).toBe(true);
    expect(parse("ruby -E utf-8 script.rb").ok).toBe(true);
    expect(parse("perl -v").ok).toBe(true);
  });

  it("bails on command wrappers that hide the real program", () => {
    // Wrappers skip every argv[1]-level check and evade cmd denies: an allowed
    // `node` for build.js plus `nohup` would otherwise run anything unprompted.
    expectBail("nohup perl -e 'system(q/id/)'", "nohup");
    expectBail("time make", "time");
    expectBail("sudo rm -rf /", "sudo");
    expectBail("timeout 5 bash -c 'sleep 1'", "timeout");
    expectBail("watch -n 1 git status", "watch");
    expectBail("nice -n 10 python script.py", "nice");
    expectBail("command git status", "command");
  });

  it("wrappers and print-as-code: cmd allows stop covering them (decide-level)", () => {
    const rules = compileApprovalRules({
      default: "ask",
      allow: ["bash.cmd=node", "bash.cmd=make", "bash.cmd=git"],
      deny: ["bash.cmd=perl"],
    });
    const verdictOf = (command: string) => {
      const r = parse(command);
      if (!r.ok) return "ask"; // unanalyzable => ask under default ask
      return decide({ tool: "bash", recognized: true, targets: r.targets }, rules).verdict;
    };
    // The plain commands still ride their cmd allows.
    expect(verdictOf("node build.js")).toBe("allow");
    expect(verdictOf("make test")).toBe("allow");
    // The bypasses now ask instead of riding those allows.
    expect(verdictOf(`node --print "1+1"`)).toBe("ask");
    expect(verdictOf("time make install")).toBe("ask");
    expect(verdictOf("nohup make")).toBe("ask");
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
    const allowPaths = (command: string) => {
      const r = parse(command);
      if (!r.ok) throw new Error(`unexpected bail: ${r.reason}`);
      return r.targets.filter((t) => t.param === "path" && !t.denyOnly).map((t) => t.value);
    };
    expect(allowPaths("echo hi > out.txt")).toEqual(["/ws/out.txt"]);
    expect(allowPaths("echo hi >> /ws/logs/app.log")).toEqual(["/ws/logs/app.log"]);
    expect(allowPaths("npm run build > /dev/null 2>&1")).toEqual([]);
    expect(allowPaths("sort < /ws/in.txt")).toEqual(["/ws/in.txt"]);
  });

  it("keeps flags out of the way and barewords deny-only", () => {
    const r = parse("grep -rn TODO src/");
    if (!r.ok) throw new Error(`unexpected bail: ${r.reason}`);
    // Allow-demanded paths: only the slashed argument.
    expect(
      r.targets.filter((t) => t.param === "path" && !t.denyOnly).map((t) => t.value),
    ).toEqual(["/ws/src"]);
    const opaque = r.targets.filter((t) => t.param === "arg");
    expect(opaque.map((t) => t.value)).toEqual(["TODO"]);
    expect(opaque.every((t) => t.denyOnly)).toBe(true);
    // The bare word is ALSO deny-reachable as a path: deny must never miss a
    // filename, while allow behavior stays unchanged (no rule demanded).
    const denyPaths = r.targets.filter((t) => t.param === "path" && t.denyOnly);
    expect(denyPaths.map((t) => t.value)).toEqual(["/ws/TODO"]);
  });

  it("bare filenames reach path deny rules (deny never misses)", () => {
    const rules = compileApprovalRules({
      default: "ask",
      allow: ["bash.cmd=rm"],
      deny: ["bash.path=secrets.env"],
    });
    const verdictOf = (command: string) => {
      const r = parse(command);
      if (!r.ok) throw new Error(`unexpected bail: ${r.reason}`);
      return decide({ tool: "bash", recognized: true, targets: r.targets }, rules).verdict;
    };
    // Slashed or not, after a cd or not: the deny rule reaches all of them.
    for (const command of ["rm secrets.env", "rm ./secrets.env", "cd sub && rm secrets.env"]) {
      expect(verdictOf(command), command).toBe("deny");
    }
    // Allow behavior unchanged: a bare word demands no path rule.
    expect(verdictOf("rm notes.txt")).toBe("allow");
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
describe("path-shaped argv[0] is a path target (planted-binary guard)", () => {
  /** All targets for a param, with their denyOnly flag, for allow-demand checks. */
  function pathTargets(r: ReturnType<typeof parse>): Array<{ value: string; denyOnly?: boolean }> {
    if (!r.ok) throw new Error(`unexpected bail: ${r.reason}`);
    return r.targets.filter((t) => t.param === "path").map((t) => ({ value: t.value, denyOnly: t.denyOnly }));
  }

  it("keeps the cmd basename but ALSO demands the binary's location", () => {
    const r = parse("/tmp/git status");
    expect(r.ok).toBe(true);
    expect(values(r, "cmd")).toEqual(["git"]);
    // The planted binary must be allow-demanded as a path, not shadowed denyOnly.
    expect(pathTargets(r)).toContainEqual({ value: "/tmp/git" });
  });

  it("a cmd:git allow no longer admits /tmp/git (the bypass is closed)", () => {
    const rules = compileApprovalRules({ default: "ask", allow: ["bash.cmd=git"] });
    const verdictOf = (command: string) => {
      const r = parse(command);
      if (!r.ok) throw new Error(`unexpected bail: ${r.reason}`);
      return decide({ tool: "bash", recognized: true, targets: r.targets }, rules).verdict;
    };
    expect(verdictOf("/tmp/git status")).toBe("ask");
    expect(verdictOf("/usr/bin/git push origin main")).toBe("ask");
    // Same basename without a path shape still rides the cmd rule.
    expect(verdictOf("git status")).toBe("allow");
  });

  it("a path allow for the exact location closes the loop", () => {
    const rules = compileApprovalRules({ default: "ask", allow: ["bash.cmd=git", "bash.path=/usr/bin/git"] });
    const r = parse("/usr/bin/git status");
    if (!r.ok) throw new Error(`unexpected bail: ${r.reason}`);
    expect(decide({ tool: "bash", recognized: true, targets: r.targets }, rules).verdict).toBe("allow");
  });

  it("a path deny reaches argv[0] (a quarantine dir stays quarantined)", () => {
    const rules = compileApprovalRules({ default: "ask", allow: ["bash.cmd=git", "bash.path=**"], deny: ["bash.path=/tmp/**"] });
    const r = parse("/tmp/git status");
    if (!r.ok) throw new Error(`unexpected bail: ${r.reason}`);
    expect(decide({ tool: "bash", recognized: true, targets: r.targets }, rules).verdict).toBe("deny");
  });

  it("relative argv[0] resolves against the cd-tracked base like every other path", () => {
    expect(pathTargets(parse("./git status"))).toContainEqual({ value: "/ws/git" });
    expect(pathTargets(parse("cd sub && ./deploy.sh"))).toContainEqual({ value: "/ws/sub/deploy.sh" });
    // The cmd side still sees the basename for rule matching.
    expect(values(parse("./git status"), "cmd")).toEqual(["git"]);
  });

  it("a tool-level bash allow still covers path-shaped invocations", () => {
    // decide() short-circuits on a whole-tool allow; pinning that this fix
    // did not sneak a path demand in front of the human's explicit "yes".
    const rules = compileApprovalRules({ default: "ask", allow: ["bash"] });
    const r = parse("/tmp/git status");
    if (!r.ok) throw new Error(`unexpected bail: ${r.reason}`);
    expect(decide({ tool: "bash", recognized: true, targets: r.targets }, rules).verdict).toBe("allow");
  });
});
