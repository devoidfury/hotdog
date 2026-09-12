// extractTargets: what each tool contributes to an approval decision, and the
// persistence hint text. Recognition is the interesting part -- an
// unrecognized tool is an ask, so getting it wrong is either noise or a hole.

import { describe, it, expect } from "bun:test";
import { Workspace } from "@utils/workspace.ts";
import { extractTargets, suggestRuleLine } from "@utils/approvals/index.ts";
import { compileApprovalRules } from "@utils/approvals/rules.ts";

const ws = new Workspace("/ws");
const rules = compileApprovalRules({});

function extract(tool: string, args: Record<string, unknown>, cfg = rules) {
  return extractTargets(tool, args, ws, cfg);
}

describe("recognition", () => {
  it("recognizes bash, the path-shaped params, and the value-param tools", () => {
    expect(extract("bash", { command: "ls" }).recognized).toBe(true);
    expect(extract("read", { path: "a.ts" }).recognized).toBe(true);
    expect(extract("mcp__drive__thing", { file_path: "a/b" }).recognized).toBe(true);
    expect(extract("mcp__drive__thing", { directory: "/tmp" }).recognized).toBe(true);
    expect(extract("fetch", { url: "https://x.test" }).recognized).toBe(true);
    expect(extract("web_search", { query: "hotdog" }).recognized).toBe(true);
  });

  it("does not recognize an unknown tool with unknown params", () => {
    const call = extract("mcp__slack__post", { channel: "C1", text: "hi" });
    expect(call.recognized).toBe(false);
    expect(call.targets).toEqual([]);
  });

  it("userGate.tools declares both recognition and which params are targets", () => {
    const declared = compileApprovalRules({ tools: { "mcp__*": ["statement"], exact_tool: ["body"] } });
    const sql = extract("mcp__db__query", { statement: "DELETE FROM t" }, declared);
    expect(sql.recognized).toBe(true);
    expect(sql.targets).toEqual([{ param: "statement", value: "DELETE FROM t" }]);
    // A tool the pattern does not name stays unrecognized.
    expect(extract("other_tool", { body: "x" }, declared).recognized).toBe(false);
    // Declared path-shaped params keep path semantics under their own name.
    const note = extract("exact_tool", { notebook_path: "nb/one.ipynb" }, compileApprovalRules({ tools: { exact_tool: ["notebook_path"] } }));
    expect(note.targets[0]).toMatchObject({ param: "notebook_path", value: "/ws/nb/one.ipynb", pathy: true });
  });
});

describe("targets", () => {
  it("normalises file-tool path params to `paths`, absolute and root-relative", () => {
    const call = extract("edit", { path: "src/app.ts" });
    expect(call.targets).toEqual([
      { param: "paths", value: "/ws/src/app.ts", relative: "src/app.ts", pathy: true },
    ]);
    const out = extract("overwrite", { path: "/etc/hosts" });
    expect(out.targets[0]!.value).toBe("/etc/hosts");
    expect(out.targets[0]!.relative).toBeUndefined();
  });

  it("handles a paths array and ignores non-strings", () => {
    const call = extract("some_tool", { paths: ["a.ts", 7, "", "b/c.ts"] });
    expect(call.targets.map((t) => t.value)).toEqual(["/ws/a.ts", "/ws/b/c.ts"]);
  });

  it("delegates bash to the command triage, including its bail", () => {
    const ok = extract("bash", { command: "git push" });
    expect(ok.targets.filter((t) => t.param === "cmd")).toEqual([{ param: "cmd", value: "git" }]);
    const bail = extract("bash", { command: "echo $(id)" });
    expect(bail.targets).toEqual([]);
    expect(bail.bailReason).toContain("expansion");
    const missing = extract("bash", {});
    expect(missing.bailReason).toContain("no command string");
  });

  it("does not treat every string argument of a known tool as a target", () => {
    // read has `path` (a target) and `offset`/`limit`; pattern/prompt etc. do not.
    const call = extract("grep", { pattern: "TODO", path: "src" });
    expect(call.targets).toEqual([
      { param: "paths", value: "/ws/src", relative: "src", pathy: true },
    ]);
  });
});

describe("suggestRuleLine", () => {
  it("suggests the exact rule for each required target", () => {
    const call = extract("bash", { command: "git push origin main" });
    expect(suggestRuleLine(call)).toBe('to persist:  "userGate": { "allow": ["bash.cmd=git"] }');
  });

  it("prefers the root-relative path so the rule survives a moved workspace", () => {
    const call = extract("write", { path: "src/a.ts" });
    expect(suggestRuleLine(call)).toContain("write.paths=src/a.ts");
    const out = extract("write", { path: "/etc/hosts" });
    expect(suggestRuleLine(out)).toContain("write.paths=/etc/hosts");
  });

  it("falls back to the bare tool name when there is nothing to match", () => {
    expect(suggestRuleLine(extract("mcp__x__y", { foo: 1 }))).toContain('"mcp__x__y"');
  });
});
