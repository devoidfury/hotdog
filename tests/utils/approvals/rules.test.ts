// Approval rule engine: precedence truth table, grammar validation, and the
// Workspace-dialect path matching (absolute AND root-relative). Pure layer --
// no UI, no filesystem.

import { describe, it, expect } from "bun:test";
import { ConfigError } from "@core/error.ts";
import {
  compileApprovalRules,
  decide,
  parseRule,
  type ApprovalCall,
  type ApprovalTarget,
  type UserGateConfig,
} from "@utils/approvals/rules.ts";

function call(
  tool: string,
  targets: ApprovalTarget[] = [],
  over: Partial<ApprovalCall> = {},
): ApprovalCall {
  return { tool, recognized: true, targets, ...over };
}

const pathTarget = (value: string, relative?: string): ApprovalTarget => ({
  param: "paths",
  value,
  ...(relative !== undefined ? { relative } : {}),
  pathy: true,
});

describe("parseRule", () => {
  it("parses tool-only and tool.param=glob entries", () => {
    expect(parseRule("bash")).toEqual({ raw: "bash", toolGlob: "bash", param: null, valueGlob: null });
    expect(parseRule("bash.cmd=git")).toEqual({
      raw: "bash.cmd=git",
      toolGlob: "bash",
      param: "cmd",
      valueGlob: "git",
    });
    expect(parseRule("mcp__*.paths=/srv/*")).toEqual({
      raw: "mcp__*.paths=/srv/*",
      toolGlob: "mcp__*",
      param: "paths",
      valueGlob: "/srv/*",
    });
  });

  it("rejects malformed entries with ConfigError (never silently ignored)", () => {
    for (const bad of ["", "   ", "bash.cmd=", ".cmd=git", "bash.=git", "=git", "!bash", "bash.cmd"]) {
      expect(() => parseRule(bad), bad).toThrow(ConfigError);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => parseRule(7 as any)).toThrow(ConfigError);
  });
});

describe("compileApprovalRules", () => {
  it("defaults to ask with empty rule lists", () => {
    const rules = compileApprovalRules(undefined);
    expect(rules.default).toBe("ask");
    expect(rules.allow).toEqual([]);
    expect(rules.deny).toEqual([]);
  });

  it("rejects a bad default, bad tools map, and non-array lists", () => {
    expect(() => compileApprovalRules({ default: "yes" as never })).toThrow(ConfigError);
    expect(() => compileApprovalRules({ allow: "bash" as never })).toThrow(ConfigError);
    expect(() => compileApprovalRules({ deny: { a: 1 } as never })).toThrow(ConfigError);
    expect(() => compileApprovalRules({ tools: [] as never })).toThrow(ConfigError);
    expect(() => compileApprovalRules({ tools: { mcp: "path" as never } })).toThrow(ConfigError);
    expect(() => compileApprovalRules({ tools: { mcp: [""] } })).toThrow(ConfigError);
    expect(() => compileApprovalRules({ allow: ["nope."] })).toThrow(ConfigError);
  });
});

describe("decide precedence", () => {
  const bashGit = call("bash", [{ param: "cmd", value: "git" }]);

  it("ask is the default for a recognized tool with no rules", () => {
    expect(decide(bashGit, compileApprovalRules({})).verdict).toBe("ask");
  });

  it('userGate.default "allow" silences the ask for recognized tools', () => {
    expect(decide(bashGit, compileApprovalRules({ default: "allow" })).verdict).toBe("allow");
  });

  it("a matching allow entry allows; a non-matching one does not", () => {
    expect(decide(bashGit, compileApprovalRules({ allow: ["bash.cmd=git"] })).verdict).toBe("allow");
    expect(decide(bashGit, compileApprovalRules({ allow: ["bash.cmd=jj"] })).verdict).toBe("ask");
    expect(decide(bashGit, compileApprovalRules({ allow: ["bash"] })).verdict).toBe("allow");
  });

  it("deny beats allow (same target, tool-level allow, tool-level deny)", () => {
    const rules = compileApprovalRules({ allow: ["bash.cmd=git"], deny: ["bash.cmd=git"] });
    expect(decide(bashGit, rules).verdict).toBe("deny");

    // Tool-level allow does not rescue a param-level deny hit.
    expect(
      decide(bashGit, compileApprovalRules({ allow: ["bash"], deny: ["bash.cmd=git"] })).verdict,
    ).toBe("deny");
    // Tool-level deny beats tool-level allow.
    expect(
      decide(bashGit, compileApprovalRules({ allow: ["bash"], deny: ["bash"] })).verdict,
    ).toBe("deny");
  });

  it("a deny rule that does not match leaves the verdict alone", () => {
    const d = decide(bashGit, compileApprovalRules({ default: "allow", deny: ["bash.cmd=rm"] }));
    expect(d.verdict).toBe("allow");
  });

  it("every target must be covered: a partial allow still asks", () => {
    const two = call("bash", [
      { param: "cmd", value: "git" },
      { param: "path", value: "/ws/.env", relative: ".env", pathy: true },
    ]);
    expect(decide(two, compileApprovalRules({ allow: ["bash.cmd=git"] })).verdict).toBe("ask");
    expect(
      decide(two, compileApprovalRules({ allow: ["bash.cmd=git", "bash.path=.env*"] })).verdict,
    ).toBe("allow");
  });

  it("denyOnly targets never demand an allow but stay deny-matchable", () => {
    const targets = [
      { param: "cmd", value: "git" },
      { param: "arg", value: "--force", denyOnly: true },
    ];
    expect(decide(call("bash", targets), compileApprovalRules({ allow: ["bash.cmd=git"] })).verdict).toBe(
      "allow",
    );
    expect(
      decide(call("bash", targets), compileApprovalRules({ allow: ["bash.cmd=git"], deny: ["bash.arg=*force*"] }))
        .verdict,
    ).toBe("deny");
  });

  it("unrecognized tools ask unless an allow entry names them", () => {
    const unknown = call("mcp__github__create", [{ param: "query", value: "hi" }], { recognized: false });
    expect(decide(unknown, compileApprovalRules({})).verdict).toBe("ask");
    // default "allow" does not rescue an unrecognized tool.
    expect(decide(unknown, compileApprovalRules({ default: "allow" })).verdict).toBe("ask");
    expect(decide(unknown, compileApprovalRules({ allow: ["mcp__*"] })).verdict).toBe("allow");
    expect(decide(unknown, compileApprovalRules({ allow: ["mcp__github__create.query=hi"] })).verdict).toBe(
      "allow",
    );
    // ...and a param-scoped allow for another value does not.
    expect(decide(unknown, compileApprovalRules({ allow: ["mcp__github__create.query=bye"] })).verdict).toBe(
      "ask",
    );
  });

  it("an unrecognized tool with nothing to match still asks", () => {
    const bare = call("mcp__weird__poke", [], { recognized: false });
    const d = decide(bare, compileApprovalRules({ default: "allow" }));
    expect(d.verdict).toBe("ask");
    expect(d.reasons[0]).toContain("not recognized");
  });

  it("a recognized tool with no targets follows the default", () => {
    expect(decide(call("info"), compileApprovalRules({})).verdict).toBe("ask");
    expect(decide(call("info"), compileApprovalRules({ default: "allow" })).verdict).toBe("allow");
  });

  it("a bail asks, but a tool-level rule still decides", () => {
    const bail = call("bash", [], { bailReason: "command substitution" });
    const d = decide(bail, compileApprovalRules({}));
    expect(d.verdict).toBe("ask");
    expect(d.reasons[0]).toContain("command substitution");
    expect(decide(bail, compileApprovalRules({ allow: ["bash"] })).verdict).toBe("allow");
    expect(decide(bail, compileApprovalRules({ deny: ["bash"] })).verdict).toBe("deny");
  });

  it("rules for other tools never apply", () => {
    expect(decide(bashGit, compileApprovalRules({ allow: ["write"] })).verdict).toBe("ask");
    expect(decide(bashGit, compileApprovalRules({ deny: ["write.paths=.env"] })).verdict).toBe("ask");
  });
});

describe('userGate.default "deny" (allowlist-only)', () => {
  const git = call("bash", [{ param: "cmd", value: "git" }]);

  it("blocks what the allow list does not cover, with no prompt possible", () => {
    const d = decide(git, compileApprovalRules({ default: "deny" }));
    expect(d.verdict).toBe("deny");
    expect(d.deniedBy).toBe("default");
    expect(d.reasons[0]).toContain('"deny"');
  });

  it("an allow entry still allows (tool-level and param-level)", () => {
    expect(decide(git, compileApprovalRules({ default: "deny", allow: ["bash"] })).verdict).toBe("allow");
    expect(
      decide(git, compileApprovalRules({ default: "deny", allow: ["bash.cmd=git"] })).verdict,
    ).toBe("allow");
  });

  it("deny rules still win and are reported as rule denials, not default ones", () => {
    const d = decide(
      git,
      compileApprovalRules({ default: "deny", allow: ["bash.cmd=git"], deny: ["bash.cmd=git"] }),
    );
    expect(d.verdict).toBe("deny");
    expect(d.deniedBy).toBe("rule");
  });

  it("partial coverage denies the call under an allowlist", () => {
    const two = call("bash", [
      { param: "cmd", value: "git" },
      { param: "path", value: "/ws/.env", relative: ".env", pathy: true },
    ]);
    const d = decide(two, compileApprovalRules({ default: "deny", allow: ["bash.cmd=git"] }));
    expect(d.verdict).toBe("deny");
    expect(d.deniedBy).toBe("default");
    expect(d.reasons[0]).toContain(".env");
  });

  it("unverifiable and unrecognized both deny: an allowlist does not ask", () => {
    const bail = call("bash", [], { bailReason: "command substitution" });
    const bd = decide(bail, compileApprovalRules({ default: "deny" }));
    expect(bd.verdict).toBe("deny");
    expect(bd.deniedBy).toBe("default");
    expect(bd.reasons[0]).toContain("command substitution");

    const unknown = call("mcp__x__y", [{ param: "q", value: "v" }], { recognized: false });
    const ud = decide(unknown, compileApprovalRules({ default: "deny" }));
    expect(ud.verdict).toBe("deny");
    expect(ud.deniedBy).toBe("default");
    expect(ud.reasons[0]).toContain("not recognized");
  });

  it("a recognized tool with nothing to match denies too", () => {
    expect(decide(call("info"), compileApprovalRules({ default: "deny" })).verdict).toBe("deny");
  });

  it("rejects any other default value", () => {
    expect(() => compileApprovalRules({ default: "prompt" as never })).toThrow(ConfigError);
  });
});

describe("path matching in the workspace.deny dialect", () => {
  it("matches a rule at any depth of the absolute path", () => {
    const t = call("read", [pathTarget("/home/u/project/.ssh/id_rsa")]);
    expect(decide(t, compileApprovalRules({ deny: ["read.paths=.ssh"] })).verdict).toBe("deny");
  });

  it("matches the root-relative form too", () => {
    const t = call("edit", [pathTarget("/ws/src/app.ts", "src/app.ts")]);
    expect(decide(t, compileApprovalRules({ allow: ["edit.paths=src"] })).verdict).toBe("allow");
    const outside = call("edit", [pathTarget("/ws/app.ts", "app.ts")]);
    expect(decide(outside, compileApprovalRules({ allow: ["edit.paths=src"] })).verdict).toBe("ask");
  });

  it("'*' stays inside one component, so 'src/*.ts' does not match nested files", () => {
    const nested = call("write", [pathTarget("/ws/src/deep/a.ts", "src/deep/a.ts")]);
    expect(decide(nested, compileApprovalRules({ allow: ["write.paths=src/*.ts"] })).verdict).toBe("ask");
    const direct = call("write", [pathTarget("/ws/src/a.ts", "src/a.ts")]);
    expect(decide(direct, compileApprovalRules({ allow: ["write.paths=src/*.ts"] })).verdict).toBe("allow");
  });

  it("non-path values match as plain globs over the whole value", () => {
    const t = call("fetch", [{ param: "url", value: "https://example.com/x" }]);
    expect(decide(t, compileApprovalRules({ allow: ["fetch.url=https://example.com/*"] })).verdict).toBe("allow");
    expect(decide(t, compileApprovalRules({ deny: ["fetch.url=*evil*"] })).verdict).toBe("ask");
  });
});

describe("decision reporting", () => {
  it("reports the matched rule lines and readable reasons", () => {
    const t = call("bash", [{ param: "cmd", value: "rm" }]);
    const d = decide(t, compileApprovalRules({ deny: ["bash.cmd=rm"] }));
    expect(d.matched).toEqual(["bash.cmd=rm"]);
    expect(d.reasons[0]).toContain("bash.cmd=rm");
    expect(d.reasons[0]).toContain("rm");
  });

  it("every verdict carries at least one reason", () => {
    for (const cfg of [{}, { default: "allow" }, { allow: ["bash"] }, { deny: ["bash"] }] as UserGateConfig[]) {
      const d = decide(call("bash", [{ param: "cmd", value: "git" }]), compileApprovalRules(cfg));
      expect(d.reasons.length).toBeGreaterThan(0);
      expect(d.reasons[0]!.length).toBeGreaterThan(0);
    }
  });
});
