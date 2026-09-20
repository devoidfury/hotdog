import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create as createFileWatch } from "@experimental/file-watch/index.ts";
import { HOOKS } from "@core/hooks.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

const FULL_CONFIG = { enabled: true, notify: true, writeGuard: true, ignore: [] as string[] };

function makeCore(fileWatchOverrides: Record<string, unknown> = {}) {
  return {
    config: { fileWatch: { ...FULL_CONFIG, ...fileWatchOverrides } },
  } as any;
}

function makeAgent(sessionId = "s1") {
  // addMessage records what the extension persists into the session context
  // (the real Agent fires CONTEXT_MESSAGE so the session log writes it too).
  const logged: any[] = [];
  return { sessionId, isRestoring: false, logged, addMessage: (msg: any) => logged.push(msg) } as any;
}

type Handlers = any;

function handlers(inst: any): Handlers {
  return inst.hooks;
}

async function track(
  h: Handlers,
  toolName: string,
  path: string,
  agent: any,
  success = true,
): Promise<void> {
  await h[HOOKS.TOOL_AFTER_EXECUTE]({
    toolCallId: "tc-1",
    toolName,
    input: JSON.stringify({ path }),
    agent,
    result: "",
    success,
  });
}

async function runContext(h: Handlers, agent: any, messages: any[] = []): Promise<any> {
  return h[HOOKS.CONTEXT]({ messages, agent });
}

function noticeOf(contextResult: any): { message: any; text: string } | null {
  const messages = contextResult?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const msg = messages[messages.length - 1];
  if (!msg || !Array.isArray(msg.content)) return null;
  const part = msg.content[0];
  if (part?.type !== "system-notice") return null;
  return { message: msg, text: part.text };
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe("file-watch extension", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "file-watch-"));
    file = join(dir, "foo.ts");
    await writeFile(file, "one\n");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("create()", () => {
    it("returns no hooks when disabled", async () => {
      const inst = createFileWatch(makeCore({ enabled: false }));
      expect(inst.hooks).toBeUndefined();
    });
  });

  describe("tracking & notices", () => {
    it("tracks reads and injects a system notice on external modification", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();

      await track(h, "read", file, agent);
      expect(await runContext(h, agent)).toBeUndefined();

      await writeFile(file, "two two two\n");
      const result = await runContext(h, agent);
      const notice = noticeOf(result);
      expect(notice).not.toBeNull();
      expect(notice!.message.role).toBe("harness");
      expect(notice!.message.source).toBe("harness");
      expect(notice!.text).toContain("foo.ts");
      expect(notice!.text).toContain("modified");
      // The notice is persisted into the session, not just shaped onto the
      // request, and it is never repeated for the same unresolved change.
      expect(agent.logged.length).toBe(1);
      expect(agent.logged[0]).toBe(result.messages[result.messages.length - 1]);
      expect(await runContext(h, agent)).toBeUndefined();
      expect(agent.logged.length).toBe(1);
    });

    it("appends the notice without touching existing messages", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "changed content\n");

      const original = [{ role: "user" }];
      const result = await runContext(h, agent, original);
      expect(result.messages.length).toBe(2);
      expect(result.messages[0]).toBe(original[0]);
    });

    it("context replacement (compaction/rewind) resets the session's beliefs", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "external change\n");
      expect(noticeOf(await runContext(h, agent))).not.toBeNull();

      // What agent.replaceContext() fires when compaction (or a session
      // load/rewind) rewrites the context wholesale.
      await h[HOOKS.CONTEXT_REPLACED]({ agent, oldContext: [], newContext: [] });

      // The stale belief lived in the replaced conversation: notice gone...
      expect(await runContext(h, agent)).toBeUndefined();
      // ...and the guard releases with it -- no in-conversation copy left to
      // clobber from.
      expect(
        await h[HOOKS.TOOL_CALL]({
          toolCallId: "tc",
          toolName: "overwrite",
          input: JSON.stringify({ path: file, content: "post-compaction write" }),
          agent,
        }),
      ).toBeUndefined();

      // Tracking rebuilds from the next read: the file is watched again.
      await track(h, "read", file, agent);
      await writeFile(file, "another external change\n");
      expect(noticeOf(await runContext(h, agent))).not.toBeNull();
    });

    it("re-reading a changed file resolves the notice", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "changed\n");
      expect(noticeOf(await runContext(h, agent))).not.toBeNull();

      await track(h, "read", file, agent);
      expect(await runContext(h, agent)).toBeUndefined();
    });

    it("self-writes via tracked tools rebaseline silently", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);

      await writeFile(file, "mine now, different size\n");
      await track(h, "overwrite", file, agent);
      expect(await runContext(h, agent)).toBeUndefined();
    });

    it("failed tool executions do not rebaseline", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "external change\n");

      await track(h, "overwrite", file, agent, false);
      expect(noticeOf(await runContext(h, agent))).not.toBeNull();
    });

    it("reports external deletion", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await rm(file);

      const notice = noticeOf(await runContext(h, agent));
      expect(notice).not.toBeNull();
      expect(notice!.text).toContain("deleted");
    });

    it("a failed read of a gone file clears the deleted flag (no bash window)", async () => {
      // Outside a bash window the flag lives in the MANIFEST, not `pending`:
      // the session observed the absence, so the notice must not haunt it
      // forever and the write guard must release the (nonexistent) path.
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await rm(file);
      expect(noticeOf(await runContext(h, agent))).not.toBeNull();

      await track(h, "read", file, agent, false);
      expect(await runContext(h, agent)).toBeUndefined();

      const gate = await h[HOOKS.TOOL_CALL]({
        toolCallId: "tc",
        toolName: "overwrite",
        input: JSON.stringify({ path: file, content: "recreate" }),
        agent,
      });
      expect(gate).toBeUndefined();
    });

    it("a failed read of an EXISTING file keeps the manifest flag (no bash window)", async () => {
      // Symmetry check: a permission/IO failure on a file that is merely
      // modified taught the session nothing; the flag survives.
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "external change\n");
      expect(noticeOf(await runContext(h, agent))).not.toBeNull();

      await track(h, "read", file, agent, false);
      // The one-shot notice is already spent, but the flag survives:
      // the write guard is still armed.
      const gate = await h[HOOKS.TOOL_CALL]({
        toolCallId: "tc",
        toolName: "overwrite",
        input: JSON.stringify({ path: file, content: "clobber" }),
        agent,
      });
      expect(gate?.action).toBe("block");
    });

    it("does not flag touch without content change", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);

      const st = await stat(file);
      await utimes(file, new Date(st.atimeMs), new Date(st.mtimeMs + 10_000));

      expect(await runContext(h, agent)).toBeUndefined();
      // Second pass rides the refreshed stat fast path.
      expect(await runContext(h, agent)).toBeUndefined();
    });

    it("caps the notice list and reports overflow", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      const files: string[] = [];
      for (let i = 0; i < 12; i++) {
        const f = join(dir, `f${i}.ts`);
        await writeFile(f, `content ${i}`);
        files.push(f);
        await track(h, "read", f, agent);
      }
      for (const f of files) await writeFile(f, "a completely different body of text");

      const notice = noticeOf(await runContext(h, agent));
      expect(notice).not.toBeNull();
      expect(notice!.text).toContain("...and 2 more");
    });

    it("skips unparseable tool inputs without throwing", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await h[HOOKS.TOOL_AFTER_EXECUTE]({
        toolCallId: "tc",
        toolName: "read",
        input: "not json {{{",
        agent,
        result: "",
        success: true,
      });
      expect(await runContext(h, agent)).toBeUndefined();
    });

    it("re-notifies after a resolve and a fresh external change", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "changed\n");
      expect(noticeOf(await runContext(h, agent))).not.toBeNull();

      await track(h, "read", file, agent);
      expect(await runContext(h, agent)).toBeUndefined();

      await writeFile(file, "changed again\n");
      const notice = noticeOf(await runContext(h, agent));
      expect(notice).not.toBeNull();
      expect(agent.logged.length).toBe(2);
    });

    it("one message covers all changed files; a later lone change gets its own", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      const other = join(dir, "bar.ts");
      await writeFile(other, "b\n");
      await track(h, "read", file, agent);
      await track(h, "read", other, agent);

      await writeFile(file, "changed\n");
      await writeFile(other, "changed\n");
      const notice = noticeOf(await runContext(h, agent));
      expect(notice).not.toBeNull();
      expect(notice!.text).toContain("foo.ts");
      expect(notice!.text).toContain("bar.ts");
      expect(agent.logged.length).toBe(1);

      // Both notified; while unresolved they stay quiet even if touched
      // again -- the session already has a persisted notice about them.
      await writeFile(other, "changed again\n");
      expect(await runContext(h, agent)).toBeUndefined();
      expect(agent.logged.length).toBe(1);

      // Resolve bar by re-reading; a fresh change then gets its own notice.
      await track(h, "read", other, agent);
      expect(await runContext(h, agent)).toBeUndefined();
      await writeFile(other, "changed once more\n");
      const second = noticeOf(await runContext(h, agent));
      expect(second).not.toBeNull();
      expect(second!.text).toContain("bar.ts");
      expect(second!.text).not.toContain("foo.ts");
      expect(agent.logged.length).toBe(2);
    });
  });

  describe("bash windows", () => {
    async function beforeBash(h: Handlers, agent: any): Promise<void> {
      await h[HOOKS.TOOL_BEFORE_EXECUTE]({
        toolCallId: "tc",
        toolName: "bash",
        input: JSON.stringify({ command: "true" }),
        agent,
      });
    }

    async function afterBash(h: Handlers, agent: any, success = true): Promise<void> {
      await h[HOOKS.TOOL_AFTER_EXECUTE]({
        toolCallId: "tc",
        toolName: "bash",
        input: JSON.stringify({ command: "true" }),
        agent,
        result: "",
        success,
      });
    }

    it("keeps pre-bash external changes visible after the post-bash rebuild", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);

      // External change lands, no CONTEXT pass sees it before bash starts.
      await writeFile(file, "another agent edited this\n");
      await beforeBash(h, agent);
      await afterBash(h, agent);

      const notice = noticeOf(await runContext(h, agent));
      expect(notice).not.toBeNull();
      expect(notice!.text).toContain("foo.ts");
      expect(notice!.text).toContain("modified");
    });

    it("absorbs changes made during the bash window as self-caused", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);

      await beforeBash(h, agent);
      // The window itself: bash rewrites the file (sed, git, ...).
      await writeFile(file, "rewritten by this session's own bash command\n");
      await afterBash(h, agent);

      expect(await runContext(h, agent)).toBeUndefined();
    });

    it("absorbs window changes even when bash exits non-zero", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);

      await beforeBash(h, agent);
      await writeFile(file, "partial work from a failing command\n");
      await afterBash(h, agent, false);

      expect(await runContext(h, agent)).toBeUndefined();
    });

    it("re-reading resolves a retained pre-bash notice", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "external change\n");
      await beforeBash(h, agent);
      await afterBash(h, agent);
      expect(noticeOf(await runContext(h, agent))).not.toBeNull();

      await track(h, "read", file, agent);
      expect(await runContext(h, agent)).toBeUndefined();
    });

    it("a failed read attempt resolves a retained notice (missing is an observation)", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await rm(file);
      await beforeBash(h, agent);
      await afterBash(h, agent);
      const notice = noticeOf(await runContext(h, agent));
      expect(notice).not.toBeNull();
      expect(notice!.text).toContain("deleted");

      // Read of the gone file fails -- the attempt itself resolves the flag.
      await track(h, "read", file, agent, false);
      expect(await runContext(h, agent)).toBeUndefined();
    });

    it("a failed read of an EXISTING file does not resolve the notice", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "external change\n");
      await beforeBash(h, agent);
      await afterBash(h, agent);
      expect(noticeOf(await runContext(h, agent))).not.toBeNull();

      // Failed read (permission/IO), but the file is still there: the session
      // learned nothing, so the flag survives. The one-shot notice is already
      // spent -- the guard is the observable proof.
      await track(h, "read", file, agent, false);
      const gate = await h[HOOKS.TOOL_CALL]({
        toolCallId: "tc",
        toolName: "overwrite",
        input: JSON.stringify({ path: file, content: "clobber" }),
        agent,
      });
      expect(gate?.action).toBe("block");

      // A successful read finally resolves it.
      await track(h, "read", file, agent);
      expect(await runContext(h, agent)).toBeUndefined();
    });

    it("guards overwrite while a retained notice is unresolved, despite the rebuilt index", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "external change\n");
      await beforeBash(h, agent);
      await afterBash(h, agent);

      // Disk now matches the rebuilt baseline -- detectChange finds nothing.
      const gate = await h[HOOKS.TOOL_CALL]({
        toolCallId: "tc",
        toolName: "overwrite",
        input: JSON.stringify({ path: file, content: "clobber" }),
        agent,
      });
      expect(gate?.action).toBe("block");

      await track(h, "read", file, agent);
      expect(
        await h[HOOKS.TOOL_CALL]({
          toolCallId: "tc",
          toolName: "overwrite",
          input: JSON.stringify({ path: file, content: "fair now" }),
          agent,
        }),
      ).toBeUndefined();
    });

    it("overwrite resolves a retained notice when the guard is disabled", async () => {
      const h = handlers(createFileWatch(makeCore({ writeGuard: false })));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "external change\n");
      await beforeBash(h, agent);
      await afterBash(h, agent);
      expect(noticeOf(await runContext(h, agent))).not.toBeNull();

      await writeFile(file, "overwritten from memory, believe it or not\n");
      await track(h, "overwrite", file, agent);
      expect(await runContext(h, agent)).toBeUndefined();
    });

    it("context replacement releases a retained pre-bash pending notice and guard", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "external change\n");
      await beforeBash(h, agent);
      await afterBash(h, agent);
      expect(noticeOf(await runContext(h, agent))).not.toBeNull();

      await h[HOOKS.CONTEXT_REPLACED]({ agent, oldContext: [], newContext: [] });
      expect(await runContext(h, agent)).toBeUndefined();
      expect(
        await h[HOOKS.TOOL_CALL]({
          toolCallId: "tc",
          toolName: "overwrite",
          input: JSON.stringify({ path: file, content: "post-compaction write" }),
          agent,
        }),
      ).toBeUndefined();
    });

    it("pre-window diff leaves no flag when nothing changed", async () => {      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await beforeBash(h, agent);
      await afterBash(h, agent);
      expect(await runContext(h, agent)).toBeUndefined();
    });

    it("is a no-op for non-window tools and unknown sessions", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "external change\n");
      await h[HOOKS.TOOL_BEFORE_EXECUTE]({
        toolCallId: "tc",
        toolName: "read",
        input: JSON.stringify({ path: file }),
        agent,
      });
      // Not absorbed: still detected live by the notice pass.
      expect(noticeOf(await runContext(h, agent))).not.toBeNull();
      // No manifest for this session: must not throw.
      await beforeBash(h, makeAgent("never-tracked"));
    });
  });

  describe("bash reads", () => {
    let changeCount = 0;
    async function stalePending(h: Handlers, agent: any): Promise<void> {
      // Freeze external motion into `pending` with a bash window, then spend
      // the one-shot notice so only the guard/flag state is observable.
      await track(h, "read", file, agent);
      // Unique payload per call: a repeat of identical bytes would not flag.
      await writeFile(file, `external change ${++changeCount}\n`);
      const input = JSON.stringify({ command: "true" });
      await h[HOOKS.TOOL_BEFORE_EXECUTE]({ toolCallId: "tc", toolName: "bash", input, agent });
      await h[HOOKS.TOOL_AFTER_EXECUTE]({
        toolCallId: "tc",
        toolName: "bash",
        input,
        agent,
        result: "",
        success: true,
      });
      expect(noticeOf(await runContext(h, agent))).not.toBeNull();
    }

    async function bash(h: Handlers, agent: any, command: string, success = true): Promise<void> {
      const input = JSON.stringify({ command });
      await h[HOOKS.TOOL_BEFORE_EXECUTE]({ toolCallId: "tc", toolName: "bash", input, agent });
      await h[HOOKS.TOOL_AFTER_EXECUTE]({
        toolCallId: "tc",
        toolName: "bash",
        input,
        agent,
        result: "",
        success,
      });
    }

    async function guardAction(h: Handlers, agent: any): Promise<string | undefined> {
      const gate = await h[HOOKS.TOOL_CALL]({
        toolCallId: "tc",
        toolName: "overwrite",
        input: JSON.stringify({ path: file, content: "clobber" }),
        agent,
      });
      return (gate as any)?.action;
    }

    it("cat of a stale tracked path counts as going and looking", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await stalePending(h, agent);

      await bash(h, agent, `cat ${file}`);
      expect(await guardAction(h, agent)).toBeUndefined();
      expect(await runContext(h, agent)).toBeUndefined();

      // Tracked and re-baselined: a fresh change surfaces with a new notice.
      await writeFile(file, "changed again\n");
      expect(noticeOf(await runContext(h, agent))).not.toBeNull();
    });

    it("grep counts", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await stalePending(h, agent);
      await bash(h, agent, `grep -n TODO ${file}`);
      expect(await guardAction(h, agent)).toBeUndefined();
    });

    it("print-sed counts, in-place sed does not", async () => {
      const print = handlers(createFileWatch(makeCore()));
      const a = makeAgent();
      await stalePending(print, a);
      await bash(print, a, `sed -n '1,10p' ${file}`);
      expect(await guardAction(print, a)).toBeUndefined();

      const inplace = handlers(createFileWatch(makeCore()));
      const b = makeAgent();
      await stalePending(inplace, b);
      await bash(inplace, b, `sed -i 's/one/1/' ${file}`);
      expect(await guardAction(inplace, b)).toBe("block");
    });

    it("git diff/status naming the path counts; a bare git diff does not", async () => {
      const withPath = handlers(createFileWatch(makeCore()));
      const a = makeAgent();
      await stalePending(withPath, a);
      await bash(withPath, a, `git diff ${file}`);
      expect(await guardAction(withPath, a)).toBeUndefined();

      const status = handlers(createFileWatch(makeCore()));
      const b = makeAgent();
      await stalePending(status, b);
      await bash(status, b, `git status ${file}`);
      expect(await guardAction(status, b)).toBeUndefined();

      const bare = handlers(createFileWatch(makeCore()));
      const c = makeAgent();
      await stalePending(bare, c);
      await bash(bare, c, `git diff`);
      expect(await guardAction(bare, c)).toBe("block");
    });

    it("a failed bash does not count as a read", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await stalePending(h, agent);
      await bash(h, agent, `cat ${file}`, false);
      expect(await guardAction(h, agent)).toBe("block");
    });

    it("reads of untracked files are a no-op", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await bash(h, agent, `cat ${join(dir, "never-tracked.ts")}`);
      expect(await runContext(h, agent)).toBeUndefined();
      await track(h, "read", file, agent);
      expect(await guardAction(h, agent)).toBeUndefined();
    });
  });

  describe("write windows (edit/append)", () => {
    async function beforeWrite(
      h: Handlers,
      toolName: "edit" | "append",
      path: string,
      agent: any,
    ): Promise<void> {
      await h[HOOKS.TOOL_BEFORE_EXECUTE]({
        toolCallId: "tc",
        toolName,
        input: JSON.stringify({ path }),
        agent,
      });
    }

    async function bashWindow(h: Handlers, agent: any): Promise<void> {
      const input = JSON.stringify({ command: "true" });
      await h[HOOKS.TOOL_BEFORE_EXECUTE]({ toolCallId: "tc", toolName: "bash", input, agent });
      await h[HOOKS.TOOL_AFTER_EXECUTE]({
        toolCallId: "tc",
        toolName: "bash",
        input,
        agent,
        result: "",
        success: true,
      });
    }

    it("keeps pre-edit external changes visible after the post-edit rebaseline", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);

      // External change lands in a region the session's edit does not touch.
      // Without the pre-write freeze the post-edit rebaseline swallows it --
      // notice gone, write guard disarmed, stale belief intact.
      await writeFile(file, "one\n// another agent added this\n");
      await beforeWrite(h, "edit", file, agent);
      // The edit's own write (inside the window) is absorbed as self-caused.
      await writeFile(file, "one\n// another agent added this\n+ session edit\n");
      await track(h, "edit", file, agent);

      const notice = noticeOf(await runContext(h, agent));
      expect(notice).not.toBeNull();
      expect(notice!.text).toContain("foo.ts");
      expect(notice!.text).toContain("modified");
    });

    it("keeps pre-append external changes visible after the post-append rebaseline", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);

      await writeFile(file, "one\n// another agent edited the middle\n");
      await beforeWrite(h, "append", file, agent);
      await writeFile(file, "one\n// another agent edited the middle\n+ session append\n");
      await track(h, "append", file, agent);

      const notice = noticeOf(await runContext(h, agent));
      expect(notice).not.toBeNull();
      expect(notice!.text).toContain("modified");
    });

    it("a clean edit or append does not flag its own write", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);

      await beforeWrite(h, "edit", file, agent);
      await writeFile(file, "one\n+ session edit\n");
      await track(h, "edit", file, agent);
      expect(await runContext(h, agent)).toBeUndefined();

      await beforeWrite(h, "append", file, agent);
      await writeFile(file, "one\n+ session edit\n+ session append\n");
      await track(h, "append", file, agent);
      expect(await runContext(h, agent)).toBeUndefined();
    });

    it("the write guard stays armed across an edit rebaseline", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "one\n// foreign edit\n");
      await beforeWrite(h, "edit", file, agent);
      await writeFile(file, "one\n// foreign edit\n+ session edit\n");
      await track(h, "edit", file, agent);

      const gate = await h[HOOKS.TOOL_CALL]({
        toolCallId: "tc",
        toolName: "overwrite",
        input: JSON.stringify({ path: file, content: "clobber" }),
        agent,
      });
      expect(gate?.action).toBe("block");

      // A successful read finally resolves it and releases the guard.
      await track(h, "read", file, agent);
      const after = await h[HOOKS.TOOL_CALL]({
        toolCallId: "tc",
        toolName: "overwrite",
        input: JSON.stringify({ path: file, content: "fresh" }),
        agent,
      });
      expect(after).toBeUndefined();
    });

    it("a failed edit still freezes pre-edit motion", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "external change\n");

      // The edit fails (its oldString no longer matches -- exactly because of
      // that external motion). No rebaseline on failure, but the freeze must
      // still survive a later window's rebuild.
      await beforeWrite(h, "edit", file, agent);
      await track(h, "edit", file, agent, false);

      await bashWindow(h, agent);

      const notice = noticeOf(await runContext(h, agent));
      expect(notice).not.toBeNull();
      expect(notice!.text).toContain("modified");
    });
  });

  describe("ignore patterns", () => {
    it("never tracks files matching an ignore pattern", async () => {
      const h = handlers(createFileWatch(makeCore({ ignore: ["node_modules/"] })));
      const agent = makeAgent();
      const dep = join(dir, "node_modules", "pkg", "index.js");
      await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
      await writeFile(dep, "module.exports = 1");
      await track(h, "read", dep, agent);
      await writeFile(dep, "module.exports = 2 // changed");

      expect(await runContext(h, agent)).toBeUndefined();
    });

    it("matches on segment boundaries, not raw substrings", async () => {
      // "dist/" ignores dir/dist/x.ts but NOT dir/mydist/x.ts.
      const h = handlers(createFileWatch(makeCore({ ignore: ["dist/"] })));
      const agent = makeAgent();
      const ignoredFile = join(dir, "dist", "x.ts");
      const lookalike = join(dir, "mydist", "x.ts");
      await mkdir(join(dir, "dist"), { recursive: true });
      await mkdir(join(dir, "mydist"), { recursive: true });
      await writeFile(ignoredFile, "a");
      await writeFile(lookalike, "b");

      await track(h, "read", ignoredFile, agent);
      await track(h, "read", lookalike, agent);
      await writeFile(ignoredFile, "changed");
      await writeFile(lookalike, "changed");

      const notice = noticeOf(await runContext(h, agent));
      expect(notice).not.toBeNull();
      // Only the lookalike is listed (compare whole entries, "mydist/x.ts"
      // would substring-match a naive "dist/x.ts" check).
      const listed = notice!.text.split("\n").filter((l) => l.startsWith("- "));
      expect(listed.length).toBe(1);
      expect(listed[0]).toContain("mydist");
    });

    it("multi-segment patterns match consecutive segments", async () => {
      const h = handlers(createFileWatch(makeCore({ ignore: ["src/generated/"] })));
      const agent = makeAgent();
      const gen = join(dir, "src", "generated", "api.ts");
      await mkdir(join(dir, "src", "generated"), { recursive: true });
      await writeFile(gen, "a");
      await track(h, "read", gen, agent);
      await writeFile(gen, "changed");

      expect(await runContext(h, agent)).toBeUndefined();
    });

    it("file-name patterns match that file anywhere", async () => {
      const h = handlers(createFileWatch(makeCore({ ignore: ["config.local.json"] })));
      const agent = makeAgent();
      const nested = join(dir, "sub", "config.local.json");
      const lookalike = join(dir, "config.local.json5");
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(nested, "a=1");
      await writeFile(lookalike, "b=2");

      await track(h, "read", nested, agent);
      await track(h, "read", lookalike, agent);
      await writeFile(nested, "a=9");
      await writeFile(lookalike, "b=9");

      const notice = noticeOf(await runContext(h, agent));
      expect(notice).not.toBeNull();
      // Exact segment equality: the lookalike with the extra char is tracked.
      const listed = notice!.text.split("\n").filter((l) => l.startsWith("- "));
      expect(listed.length).toBe(1);
      expect(listed[0]).toContain("config.local.json5");
    });

    it("ignored paths are never write-guarded", async () => {
      const h = handlers(createFileWatch(makeCore({ ignore: ["vendor/"] })));
      const agent = makeAgent();
      const vfile = join(dir, "vendor", "pkg.js");
      await mkdir(join(dir, "vendor"), { recursive: true });
      await writeFile(vfile, "module.exports = 1");
      await track(h, "read", vfile, agent);
      await writeFile(vfile, "module.exports = 2 // external change");

      expect(await runContext(h, agent)).toBeUndefined();
      const gate = await h[HOOKS.TOOL_CALL]({
        toolCallId: "tc",
        toolName: "overwrite",
        input: JSON.stringify({ path: vfile, content: "clobber" }),
        agent,
      });
      expect(gate).toBeUndefined();
    });
  });

  describe("write guard", () => {
    async function staleSetup(overrides: Record<string, unknown> = {}) {
      const h = handlers(createFileWatch(makeCore(overrides)));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      await writeFile(file, "someone else edited this\n");
      return { h, agent };
    }

    it("blocks overwrite onto a stale target", async () => {
      const { h, agent } = await staleSetup();
      const gate = await h[HOOKS.TOOL_CALL]({
        toolCallId: "tc",
        toolName: "overwrite",
        input: JSON.stringify({ path: file, content: "clobber" }),
        agent,
      });
      expect(gate?.action).toBe("block");
      expect(String(gate.result)).toContain("file-watch");
      expect(String(gate.result)).toContain("foo.ts");
    });

    it("passes overwrite when the file is unchanged", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const agent = makeAgent();
      await track(h, "read", file, agent);
      const gate = await h[HOOKS.TOOL_CALL]({
        toolCallId: "tc",
        toolName: "overwrite",
        input: JSON.stringify({ path: file, content: "fine" }),
        agent,
      });
      expect(gate).toBeUndefined();
    });

    it("returns nothing (not 'continue') when it has no opinion, so other gates survive", async () => {
      const { h, agent } = await staleSetup();
      // edit/append/read are not guarded, and an untracked path is not either.
      expect(
        await h[HOOKS.TOOL_CALL]({
          toolCallId: "tc",
          toolName: "edit",
          input: JSON.stringify({ path: file, oldString: "x", newString: "y" }),
          agent,
        }),
      ).toBeUndefined();
      expect(
        await h[HOOKS.TOOL_CALL]({
          toolCallId: "tc",
          toolName: "overwrite",
          input: JSON.stringify({ path: join(dir, "untracked.ts"), content: "x" }),
          agent,
        }),
      ).toBeUndefined();
    });

    it("still blocks when notify is disabled", async () => {
      const { h, agent } = await staleSetup({ notify: false });
      const gate = await h[HOOKS.TOOL_CALL]({
        toolCallId: "tc",
        toolName: "overwrite",
        input: JSON.stringify({ path: file, content: "clobber" }),
        agent,
      });
      expect(gate?.action).toBe("block");
      const ctx = await runContext(h, agent);
      expect(ctx).toBeUndefined();
    });

    it("allows overwrite once the session re-reads the file", async () => {
      const { h, agent } = await staleSetup();
      await track(h, "read", file, agent);
      expect(
        await h[HOOKS.TOOL_CALL]({
          toolCallId: "tc",
          toolName: "overwrite",
          input: JSON.stringify({ path: file, content: "now fair" }),
          agent,
        }),
      ).toBeUndefined();
    });
  });

  describe("unreadable files", () => {
    // Permission bits are ignored for root; these scenarios need a real EACCES.
    const skipIfRoot = typeof process.getuid === "function" && process.getuid() === 0;

    it.skipIf(skipIfRoot)(
      "reports unreadable, not deleted, when a changed file loses read access",
      async () => {
        const h = handlers(createFileWatch(makeCore()));
        const agent = makeAgent();
        await track(h, "read", file, agent);
        await writeFile(file, "someone else edited this\n");
        await chmod(file, 0o000);
        try {
          const notice = noticeOf(await runContext(h, agent));
          expect(notice).not.toBeNull();
          expect(notice!.text).toContain("unreadable");
          expect(notice!.text).not.toContain("deleted");

          // The write guard arms too, without falsely claiming deletion.
          const gate = await h[HOOKS.TOOL_CALL]({
            toolCallId: "tc",
            toolName: "overwrite",
            input: JSON.stringify({ path: file, content: "clobber" }),
            agent,
          });
          expect(gate?.action).toBe("block");
          expect(String(gate.result)).toContain("can no longer be read");
        } finally {
          await chmod(file, 0o600);
        }
      },
    );

    it.skipIf(skipIfRoot)(
      "does not claim deletion on a transient stat error",
      async () => {
        const h = handlers(createFileWatch(makeCore()));
        const agent = makeAgent();
        await track(h, "read", file, agent);
        // Unsearchable parent: stat on the file now fails with EACCES, not
        // ENOENT -- the session must be told it could not look, not that the
        // file is gone.
        await chmod(dir, 0o000);
        try {
          const notice = noticeOf(await runContext(h, agent));
          expect(notice).not.toBeNull();
          expect(notice!.text).toContain("unreadable");
          expect(notice!.text).not.toContain("deleted");
        } finally {
          await chmod(dir, 0o700);
        }
      },
    );
  });

  describe("session isolation", () => {
    it("one session's reads do not expose another session's notices", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const a = makeAgent("s1");
      const b = makeAgent("s2");
      await track(h, "read", file, a);
      await writeFile(file, "changed while neither looked\n");

      expect(noticeOf(await runContext(h, a))).not.toBeNull();
      expect(await runContext(h, b)).toBeUndefined();
    });

    it("context replacement clears only the replacing session's maps", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const a = makeAgent("s1");
      const b = makeAgent("s2");
      await track(h, "read", file, a);
      await track(h, "read", file, b);
      await writeFile(file, "changed while neither looked\n");

      await h[HOOKS.CONTEXT_REPLACED]({ agent: a, oldContext: [], newContext: [] });
      expect(await runContext(h, a)).toBeUndefined();
      expect(noticeOf(await runContext(h, b))).not.toBeNull();
    });
  });

  describe("session teardown", () => {
    it("session:end reclaims the session's manifest and pending maps", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const a = makeAgent("gone");
      const b = makeAgent("alive");
      await track(h, "read", file, a);
      await track(h, "read", file, b);
      await writeFile(file, "changed while neither looked\n");

      await h[HOOKS.SESSION_END]({ sessionId: "gone" });
      expect(await runContext(h, a)).toBeUndefined();
      expect(noticeOf(await runContext(h, b))).not.toBeNull();
    });

    it("session:end releases the write guard for the dead session only", async () => {
      const h = handlers(createFileWatch(makeCore()));
      const a = makeAgent("gone");
      const b = makeAgent("alive");
      await track(h, "read", file, a);
      await track(h, "read", file, b);
      await writeFile(file, "changed while neither looked\n");

      await h[HOOKS.SESSION_END]({ sessionId: "gone" });
      const input = JSON.stringify({ path: file, content: "clobber" });
      expect(await h[HOOKS.TOOL_CALL]({ toolCallId: "tc", toolName: "overwrite", input, agent: a })).toBeUndefined();
      const blocked = await h[HOOKS.TOOL_CALL]({ toolCallId: "tc", toolName: "overwrite", input, agent: b });
      expect((blocked as any)?.action).toBe("block");
    });
  });
});
