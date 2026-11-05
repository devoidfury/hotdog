// Session title derivation (pure core) tests.
//
// The title is a deterministic heuristic headline over the first user
// messages: no model call, re-derived on every index rebuild, so these pin
// the rules that the corpus tuning settled on. Each case mirrors a failure
// mode the 518-log sweep found (or the deadbeat class it accepts as null).

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { deriveTitleFromMessages } from "@core/session/session-index.ts";

describe("deriveTitleFromMessages", () => {
  it("titles a plain ask verbatim", () => {
    expect(deriveTitleFromMessages(["review the staged changes"])).toBe("Review the staged changes");
  });

  it("skips trivial openers to the first message that says anything", () => {
    const t = deriveTitleFromMessages(["continue", "ok", "fix the fence check in the session index"]);
    expect(t).toBe("Fix the fence check in the session index");
  });

  it("formats workflow dispatch headers as name · node tiles", () => {
    expect(
      deriveTitleFromMessages([
        "Workflow 'webui-diff-github' run 20261105-0307-webui-diff-github: node 'implement' (attempt 1 of 3). Work in /home/agent/hotdog",
      ]),
    ).toBe("webui-diff-github · implement");
    expect(
      deriveTitleFromMessages([
        "Workflow 'webui-reasoning-toggle' run 20261105-0058-webui-reasoning-toggle: JUDGE node 'audit' for producer 'implement' (attempt 1).",
      ]),
    ).toBe("webui-reasoning-toggle · audit (judge)");
  });

  it("strips code, urls, @-references, and politeness", () => {
    const t = deriveTitleFromMessages([
      "please add https://example.com/mock dark mode to the webui @src/core/theme.ts\n```ts\nconsole.log(settings.theme);\n```",
    ]);
    expect(t).toBe("Add dark mode to the webui");
  });

  it("keeps hyphenated compounds intact (word strips need trailing space)", () => {
    const t = deriveTitleFromMessages(["the state-of-the-art ahead-of-time compiler is slow"]);
    expect(t).toContain("state-of-the-art");
    expect(t).toContain("ahead-of-time");
  });

  it("caps at 12 words on a word boundary with an ellipsis", () => {
    const t = deriveTitleFromMessages([
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon",
    ]);
    expect(t).toBe("Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu…");
  });

  it("picks the content-bearing sentence over a throat-clearing opener", () => {
    const t = deriveTitleFromMessages([
      "I would just like to say hello friend. Add a dark mode toggle to the webui settings panel right away",
    ]);
    expect(t).toBe("Add dark mode toggle to the webui settings panel right away");
  });

  it("keeps a terminal question mark", () => {
    expect(deriveTitleFromMessages(["What's in this dir?"])).toBe("What's in this dir?");
  });

  it("accepts the deadbeat class as untitled", () => {
    expect(deriveTitleFromMessages(["hey", "continue", "ok", "thanks"])).toBeNull();
    expect(deriveTitleFromMessages([])).toBeNull();
    expect(deriveTitleFromMessages(["ok."])).toBeNull();
  });

  it("is deterministic: the same messages yield the same bytes", () => {
    const msgs = [
      "Hey - am working on the hotdog code -- just fixed a bug with the \"question\" tool that seems to drop answers",
    ];
    expect(deriveTitleFromMessages(msgs)).toBe(deriveTitleFromMessages(msgs));
  });
});

// ── indexUserInput: the live set-once title mirror ──────────────────────────
// The registry's CONTEXT_MESSAGE hook titles a live row without waiting for
// a rebuild. Same derivation, but written one message at a time: the first
// title-worthy ask wins forever (matching the rebuild's oldest-first scan),
// and a missing row stays an honest false (creation is the durability commit
// points' job, and their sync derives the title from the log anyway).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import {
  closeSessionIndex,
  getSessionRow,
  indexUserInput,
  syncSessionFromLog,
} from "@core/session/session-index.ts";

describe("indexUserInput (live set-once mirror)", () => {
  const TMP = mkdtempSync(join(TMP_PARENT, "hotdog-live-title-"));
  let prevSessionsDir: string | undefined;

  const fixtureRow = async (id: string, content: unknown): Promise<void> => {
    writeFileSync(
      join(TMP, `${id}.jsonl`),
      JSON.stringify({ ts: "2026-10-20T00:00:00.000Z", session_id: id, source: "input", content }) + "\n",
    );
    await syncSessionFromLog(id);
  };

  beforeAll(() => {
    prevSessionsDir = process.env.HOTDOG_SESSIONS_DIR;
    process.env.HOTDOG_SESSIONS_DIR = TMP;
  });

  afterAll(() => {
    if (prevSessionsDir === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
    else process.env.HOTDOG_SESSIONS_DIR = prevSessionsDir;
    closeSessionIndex();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("titles an existing untitled row from the first title-worthy input", async () => {
    await fixtureRow("live-once", "hi"); // deadbeat: sync derives no title
    expect(getSessionRow("live-once")!.title).toBeNull();

    expect(indexUserInput("live-once", "fix the fence check in the session index")).toBe(true);
    expect(getSessionRow("live-once")!.title).toBe("Fix the fence check in the session index");
  });

  it("is set-once: a later title-worthy input never clobbers and answers false", async () => {
    expect(indexUserInput("live-once", "rename the whole world")).toBe(false);
    expect(getSessionRow("live-once")!.title).toBe("Fix the fence check in the session index");
  });

  it("accepts untrusted parts arrays (the webui wraps user input)", async () => {
    await fixtureRow("live-parts", "hi");
    expect(indexUserInput("live-parts", [{ type: "untrusted", text: "add a mirror to the registry" }])).toBe(true);
    expect(getSessionRow("live-parts")!.title).toBe("Add mirror to the registry");
  });

  it("empty, deadbeat, and non-user content answer false without writing", async () => {
    await fixtureRow("live-none", "hi");
    expect(indexUserInput("live-none", "")).toBe(false);
    expect(indexUserInput("live-none", [{ type: "tool_result", result: "fix the fence check in the index" }])).toBe(false);
    expect(indexUserInput("live-none", "hi")).toBe(false); // deadbeat stays untitled
    expect(getSessionRow("live-none")!.title).toBeNull();
  });

  it("a missing row is an honest false, never a throw", () => {
    expect(indexUserInput("live-ghost", "title the row that was never born")).toBe(false);
    expect(getSessionRow("live-ghost")).toBeNull();
  });
});
