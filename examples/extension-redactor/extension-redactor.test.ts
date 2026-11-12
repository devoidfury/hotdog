// Boots the redactor extension through the REAL discovery + loader path and
// drives the tool:result pipeline through the live HookSystem: manifest +
// config defaults, the question seam (toolCtx.get("input")), every fail-closed
// verdict path, the session memo, and point-of-use config reads.

import { describe, it, expect } from "bun:test";
import { dirname, join } from "node:path";

import {
  createTestCore,
  discoverExtensions,
  ExtensionLoader,
  fakeQuestionSeam,
  getExtensionConfigDefaults,
  HOOKS,
  makeToolContext,
  sdkCompatibilityWarning,
  ToolContext,
  ToolResult,
  toolResultPayload,
  type TestCore,
} from "@read-receipt/hotdog/testing";
import pkgJson from "@package.json";

const REDACTOR_DIR = import.meta.dir;
const EXAMPLES_DIR = dirname(REDACTOR_DIR);

/** Matches the default "aws-access-key" pattern (AKIA + 16 alnum). */
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

type RedactorConfig = {
  enabled: boolean;
  prompt: boolean;
  patterns: Record<string, string>;
};

// The test core has no schema layer, so the test hands over the FULL bag the
// way resolveConfig would (house rule: the extension itself keeps no backup
// defaults).
function redactorConfig(over: Partial<RedactorConfig> = {}): RedactorConfig {
  return {
    enabled: true,
    prompt: true,
    patterns: { "aws-access-key": "AKIA[0-9A-Z]{16}" },
    ...over,
  };
}

async function loadRedactor(over: Partial<RedactorConfig> = {}) {
  const core = createTestCore({
    config: { extensionRedactor: redactorConfig(over) },
  });
  const loader = new ExtensionLoader(core);
  const inst = await loader.load("extension-redactor", join(REDACTOR_DIR, "index.ts"));
  expect(inst).not.toBeNull();
  return { core };
}

async function run(
  core: TestCore,
  result: unknown,
  opts: { toolName?: string; sessionId?: string | null; toolCtx?: ToolContext } = {},
) {
  const payload = toolResultPayload({
    result,
    toolName: opts.toolName,
    sessionId: opts.sessionId,
    toolCtx: opts.toolCtx,
  });
  await core.hooks.runHookPipeline<unknown, "tool:result">(HOOKS.TOOL_RESULT, payload);
  return payload.result;
}

// ── Discovery ───────────────────────────────────────────────────────────────

describe("extension-redactor: discovery", () => {
  it("loads from a direct extensionPaths entry", async () => {
    const discovered = await discoverExtensions([REDACTOR_DIR]);
    expect(discovered).toHaveLength(1);
    const meta = discovered[0]!;
    expect(meta.name).toBe("extension-redactor");
    expect(meta.manifestError).toBeUndefined();
    expect(meta.sdk).toBe(">=0.16");
    expect(sdkCompatibilityWarning(meta, pkgJson.version)).toBeNull();
    expect(meta.configSchema).not.toBeNull();
  });

  it("is found alongside the starter when scanning the examples bundle root", async () => {
    const discovered = await discoverExtensions([EXAMPLES_DIR]);
    expect(discovered.map((d) => d.name).sort()).toEqual([
      "extension-redactor",
      "extension-starter",
    ]);
  });

  it("extracts config defaults from extension.json alone", async () => {
    const defaults = await getExtensionConfigDefaults([EXAMPLES_DIR]);
    const entry = defaults.find((d) => d.key === "extensionRedactor");
    expect(entry).toBeDefined();
    expect(entry!.defaults).toEqual({
      enabled: true,
      prompt: true,
      patterns: {
        "aws-access-key": "AKIA[0-9A-Z]{16}",
        "github-token": "gh[pousr]_[A-Za-z0-9]{36,}",
        "private-key-header": "-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----",
      },
    });
  });
});

// ── The pipeline ────────────────────────────────────────────────────────────

describe("extension-redactor: tool:result pipeline", () => {
  it("a non-matching result passes through untouched and nobody is asked", async () => {
    const { core } = await loadRedactor();
    const { seam, asked } = fakeQuestionSeam("redact");
    const out = await run(core, "nothing to see", {
      toolCtx: makeToolContext({ seam }),
    });
    expect(out).toBe("nothing to see");
    expect(asked).toHaveLength(0);
  });

  it("asks on a match; answering redact scrubs every occurrence", async () => {
    const { core } = await loadRedactor();
    const { seam, asked } = fakeQuestionSeam("redact");
    const out = await run(core, `key: ${AWS_KEY} again: ${AWS_KEY}`, {
      toolCtx: makeToolContext({ seam }),
    });
    expect(out).toBe("key: [redacted:aws-access-key] again: [redacted:aws-access-key]");
    expect(asked).toHaveLength(1);
    // The question carries the label, a sample, the tool name, and redact as
    // its default -- the safe answer must also be the pressed-Enter answer.
    const q = asked[0]!;
    expect(q.default).toBe("redact");
    expect(q.options).toEqual(["redact", "allow once", "allow for session"]);
    expect(String(q.prompt)).toContain("aws-access-key");
    expect(String(q.prompt)).toContain(AWS_KEY);
    expect(String(q.prompt)).toContain("bash");
  });

  it("allow once passes this result and asks again on the next", async () => {
    const { core } = await loadRedactor();
    const { seam, asked } = fakeQuestionSeam("allow once");
    const first = await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }) });
    expect(first).toBe(AWS_KEY);
    const second = await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }) });
    expect(second).toBe(AWS_KEY);
    expect(asked).toHaveLength(2);
  });

  it("allow for session silences later matches until the session ends", async () => {
    const { core } = await loadRedactor();
    const { seam, asked } = fakeQuestionSeam("allow for session");
    await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }), sessionId: "sess-1" });
    await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }), sessionId: "sess-1" });
    expect(asked).toHaveLength(1);
    // Another session gets its own ask (grants are per-session).
    await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }), sessionId: "sess-2" });
    expect(asked).toHaveLength(2);
    // The dead session's grant is reclaimed.
    await core.hooks.notifyHooks(HOOKS.SESSION_END, { sessionId: "sess-2" });
    await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }), sessionId: "sess-2" });
    expect(asked).toHaveLength(3);
  });

  it("a result with no session id degrades allow-for-session to allow-once", async () => {
    const { core } = await loadRedactor();
    const { seam, asked } = fakeQuestionSeam("allow for session");
    await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }), sessionId: null });
    await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }), sessionId: null });
    expect(asked).toHaveLength(2);
  });

  it("no seam at all fails closed: redacted, nobody asked, no throw", async () => {
    const { core } = await loadRedactor();
    const out = await run(core, AWS_KEY);
    expect(out).toBe("[redacted:aws-access-key]");
  });

  it("a non-interactive seam fails closed the same way", async () => {
    const { core } = await loadRedactor();
    const { seam, asked } = fakeQuestionSeam("allow once", { interactive: false });
    const out = await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }) });
    expect(out).toBe("[redacted:aws-access-key]");
    expect(asked).toHaveLength(0);
  });

  it("a throwing seam fails closed to redact", async () => {
    const { core } = await loadRedactor();
    const { seam } = fakeQuestionSeam("", { throws: true });
    const out = await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }) });
    expect(out).toBe("[redacted:aws-access-key]");
  });

  it("an empty answer fails closed to redact", async () => {
    const { core } = await loadRedactor();
    const { seam } = fakeQuestionSeam("   ");
    const out = await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }) });
    expect(out).toBe("[redacted:aws-access-key]");
  });

  it("a pre-aborted run redacts without asking", async () => {
    const { core } = await loadRedactor();
    const { seam, asked } = fakeQuestionSeam("allow once");
    const controller = new AbortController();
    controller.abort();
    const out = await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam, abortSignal: controller.signal }) });
    expect(out).toBe("[redacted:aws-access-key]");
    expect(asked).toHaveLength(0);
  });

  it("prompt: false redacts without asking (headless posture)", async () => {
    const { core } = await loadRedactor({ prompt: false });
    const { seam, asked } = fakeQuestionSeam("allow for session");
    const out = await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }) });
    expect(out).toBe("[redacted:aws-access-key]");
    expect(asked).toHaveLength(0);
  });

  it("scrubs a ToolResult's output AND error, preserving metadata, hint, and status", async () => {
    const { core } = await loadRedactor();
    const tr = new ToolResult({
      output: `ok ${AWS_KEY}`,
      error: `failed near ${AWS_KEY}`,
      metadata: new Map([["k", "v"]]),
      hint: "retry elsewhere",
    });
    const { seam } = fakeQuestionSeam("redact");
    const out = (await run(core, tr, { toolCtx: makeToolContext({ seam }) })) as ToolResult;
    expect(out).toBeInstanceOf(ToolResult);
    expect(out.output).toBe("ok [redacted:aws-access-key]");
    expect(out.error).toBe("failed near [redacted:aws-access-key]");
    expect(out.success).toBe(false);
    expect(out.metadata?.get("k")).toBe("v");
    expect(out.hint).toBe("retry elsewhere");
  });

  it("an opaque matching result is withheld whole", async () => {
    const { core } = await loadRedactor();
    const { seam } = fakeQuestionSeam("redact");
    const out = (await run(core, { data: { key: AWS_KEY } }, { toolCtx: makeToolContext({ seam }) })) as ToolResult;
    expect(out).toBeInstanceOf(ToolResult);
    expect(out.output).toContain("[withheld]");
    expect(out.output).toContain("aws-access-key");
    expect(out.output).not.toContain(AWS_KEY);
  });

  it("a malformed pattern fails the redactor closed: results withheld, nobody asked", async () => {
    const { core } = await loadRedactor({ patterns: { broken: "[unclosed" } });
    const { seam, asked } = fakeQuestionSeam("allow once");
    const out = (await run(core, "anything at all", { toolCtx: makeToolContext({ seam }) })) as ToolResult;
    expect(out).toBeInstanceOf(ToolResult);
    expect(out.output).toContain("[withheld]");
    expect(out.output).toContain("broken");
    expect(asked).toHaveLength(0);
  });

  it("reads config at use time: a knob flip lands on the next result", async () => {
    const { core } = await loadRedactor({ patterns: {} });
    const { seam } = fakeQuestionSeam("redact");
    const clean = await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }) });
    expect(clean).toBe(AWS_KEY); // no patterns -> nothing matches
    (core.config.extensionRedactor as { patterns: Record<string, string> }).patterns = {
      "aws-access-key": "AKIA[0-9A-Z]{16}",
    };
    const scrubbed = await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }) });
    expect(scrubbed).toBe("[redacted:aws-access-key]");
  });

  it("the label set keys the grant: a wider later match asks again", async () => {
    const { core } = await loadRedactor({
      patterns: {
        "aws-access-key": "AKIA[0-9A-Z]{16}",
        "gh": "gh[pousr]_[A-Za-z0-9]{36,}",
      },
    });
    const { seam, asked } = fakeQuestionSeam("allow for session");
    await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }) }); // {aws}
    await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }) }); // memo hit
    expect(asked).toHaveLength(1);
    const both = `${AWS_KEY} gh` + "p_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    await run(core, both, { toolCtx: makeToolContext({ seam }) }); // {aws,gh} -> re-ask
    expect(asked).toHaveLength(2);
  });

  it("a non-string pattern value fails the redactor closed", async () => {
    const { core } = await loadRedactor({
      patterns: { bad: 42 as unknown as string },
    });
    const out = (await run(core, "anything")) as ToolResult;
    expect(out.output).toContain("[withheld]");
    expect(out.output).toContain("bad");
  });

  it("an async-rejecting seam fails closed to redact", async () => {
    const { core } = await loadRedactor();
    const { seam } = fakeQuestionSeam("", { rejects: true });
    const out = await run(core, AWS_KEY, { toolCtx: makeToolContext({ seam }) });
    expect(out).toBe("[redacted:aws-access-key]");
  });

  it("an abort while a prompt is open resolves toward redact", async () => {
    const { core } = await loadRedactor();
    // A prompt nobody will ever answer: only the run abort can resolve it.
    const { seam } = fakeQuestionSeam("", { never: true });
    const controller = new AbortController();
    const pending = run(core, AWS_KEY, {
      toolCtx: makeToolContext({ seam, abortSignal: controller.signal }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the handler reach the prompt
    controller.abort();
    expect(await pending).toBe("[redacted:aws-access-key]");
  });

  it("a result that cannot be scanned is withheld (unknown is not clean)", async () => {
    const { core } = await loadRedactor();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = (await run(core, circular)) as ToolResult;
    expect(out.output).toContain("[withheld]");
    expect(out.output).toContain("could not be scanned");
  });

  it("image bytes pass through with a warning while the text is still redacted", async () => {
    const { core } = await loadRedactor();
    const tr = new ToolResult({ output: AWS_KEY, images: ["<png bytes>"] });
    const out = (await run(core, tr)) as ToolResult;
    expect(out.output).toBe("[redacted:aws-access-key]");
    expect(out.images).toEqual(["<png bytes>"]);
  });

  it("a failure inside the handler withholds rather than throwing into the pipeline", async () => {
    const { core } = await loadRedactor();
    const hostileAgent = {
      get sessionId(): string {
        throw new Error("agent exploded");
      },
    };
    const payload = toolResultPayload({ result: AWS_KEY, agent: hostileAgent });
    await core.hooks.runHookPipeline<unknown, "tool:result">(HOOKS.TOOL_RESULT, payload);
    const out = payload.result as ToolResult;
    expect(out).toBeInstanceOf(ToolResult);
    expect(out.output).toContain("[withheld]");
    expect(out.output).toContain("redactor failed");
  });
});
