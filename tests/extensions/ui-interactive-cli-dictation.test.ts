// Tests for the CLI dictation interceptor (Ctrl+X capture -> transcribe ->
// insert at caret). Driven with a fake TTY input stream and a fake readline
// Interface, mirroring clipboard-paste.test.ts.

import { describe, it, expect, mock, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type readline from "node:readline";
import {
  DictationInterceptor,
  createArecordCapture,
  DICTATION_KEY,
  type AudioCapture,
} from "@extensions/ui-interactive-cli/dictation.ts";
import type { SttTarget } from "@core/config/stt.ts";

type MockFn = ReturnType<typeof mock>;

interface Rig {
  stdin: EventEmitter & { isTTY: boolean };
  stdout: { isTTY: boolean; write: MockFn; cursorTo: () => boolean; clearLine: () => boolean };
  rl: {
    input: EventEmitter & { isTTY: boolean };
    output: { isTTY: boolean; write: MockFn; cursorTo: () => boolean; clearLine: () => boolean };
    on: MockFn;
    prompt: MockFn;
    write: MockFn;
  };
  forwarded: unknown[];
  interceptor: DictationInterceptor;
}

function makeRig(
  options: {
    tty?: boolean;
    target?: SttTarget | null;
    capture?: () => AudioCapture;
    transcribe?: (audio: Uint8Array) => Promise<string>;
  } = {},
): Rig {
  const forwarded: unknown[] = [];
  const stdin = new EventEmitter() as Rig["stdin"];
  stdin.isTTY = options.tty !== false;
  stdin.on("data", (chunk: unknown) => forwarded.push(chunk));

  const stdout = {
    isTTY: true,
    write: mock(() => true),
    // readline.cursorTo/clearLine need these on a TTY-ish stream.
    cursorTo: () => true,
    clearLine: () => true,
  };
  const rl = {
    input: stdin,
    output: stdout,
    on: mock(() => {}),
    prompt: mock(() => {}),
    write: mock(() => {}),
  };

  const interceptor = new DictationInterceptor(rl as unknown as readline.Interface, {
    target:
      options.target === undefined
        ? { url: "http://stt.test/v1/audio/transcriptions", model: null, authHeader: null }
        : options.target,
    capture: options.capture,
    transcribe: options.transcribe,
  });
  return { stdin, stdout, rl, forwarded, interceptor };
}

function forwardedText(rig: Rig): string {
  return rig.forwarded.map((c) => (typeof c === "string" ? c : String(c))).join("");
}

function fakeCapture(): { capture: () => AudioCapture; stop: MockFn; cancel: MockFn } {
  const stop = mock(async () => new Uint8Array([1, 2, 3]));
  const cancel = mock(() => {});
  return { capture: () => ({ stop, cancel }), stop, cancel };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("DictationInterceptor", () => {
  let lastRig: Rig | null = null;
  afterEach(() => {
    lastRig?.interceptor.dispose();
    lastRig = null;
  });

  it("is disabled when no STT target resolved", () => {
    const rig = makeRig({ target: null });
    lastRig = rig;
    expect(rig.interceptor.enabled).toBe(false);
    rig.stdin.emit("data", `hi${DICTATION_KEY}`);
    // Untouched passthrough, including the Ctrl+X byte.
    expect(forwardedText(rig)).toBe(`hi${DICTATION_KEY}`);
  });

  it("is disabled when the input stream is not a TTY", () => {
    const rig = makeRig({ tty: false });
    lastRig = rig;
    expect(rig.interceptor.enabled).toBe(false);
    rig.stdin.emit("data", `a${DICTATION_KEY}b`);
    expect(forwardedText(rig)).toBe(`a${DICTATION_KEY}b`);
  });

  it("toggles capture on Ctrl+X and inserts the transcript at the caret", async () => {
    const cap = fakeCapture();
    const transcribe = mock(async (_audio: Uint8Array) => "hello dictated world");
    const rig = makeRig({ capture: cap.capture, transcribe });
    lastRig = rig;
    expect(rig.interceptor.enabled).toBe(true);

    rig.stdin.emit("data", `type${DICTATION_KEY}more${DICTATION_KEY}`);
    // The Ctrl+X byte is swallowed; surrounding text reaches readline.
    expect(forwardedText(rig)).toBe("typemore");
    expect(rig.stdout.write.mock.calls.map((c) => c[0]).join("")).toContain("Recording");
    expect(cap.stop).toHaveBeenCalledTimes(1);
    await flush();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(transcribe.mock.calls[0]![0] as Uint8Array)).toEqual(new Uint8Array([1, 2, 3]));
    // Transcript lands via rl.write (inserted, never submitted).
    expect(rig.rl.write).toHaveBeenCalledTimes(1);
    expect(rig.rl.write.mock.calls[0]![0]).toBe("hello dictated world");
    expect(rig.rl.prompt).toHaveBeenCalled();
  });

  it("ignores extra Ctrl+X while transcribing", async () => {
    let resolveTranscribe: (t: string) => void = () => {};
    const cap = fakeCapture();
    const rig = makeRig({
      capture: cap.capture,
      transcribe: () => new Promise<string>((r) => (resolveTranscribe = r)),
    });
    lastRig = rig;

    rig.stdin.emit("data", DICTATION_KEY); // start
    rig.stdin.emit("data", DICTATION_KEY); // stop -> transcribing
    rig.stdin.emit("data", DICTATION_KEY); // ignored mid-transcribe
    expect(cap.stop).toHaveBeenCalledTimes(1);
    resolveTranscribe("done");
    await flush();
  });

  it("surfaces transcription failures and returns to idle", async () => {
    const cap = fakeCapture();
    const rig = makeRig({
      capture: cap.capture,
      transcribe: async () => {
        throw new Error("STT request failed: 502 Bad Gateway");
      },
    });
    lastRig = rig;

    rig.stdin.emit("data", `${DICTATION_KEY}${DICTATION_KEY}`);
    await flush();
    const written = rig.stdout.write.mock.calls.map((c) => c[0]).join("");
    expect(written).toContain("Dictation failed: STT request failed: 502 Bad Gateway");
    expect(rig.rl.write).not.toHaveBeenCalled();

    // Idle again: a fresh toggle starts a new capture.
    rig.stdin.emit("data", DICTATION_KEY);
    expect(rig.stdout.write.mock.calls.map((c) => c[0]).join("")).toContain("Recording");
    rig.interceptor.cancel();
  });

  it("cancel drops an in-flight recording without transcribing", async () => {
    const cap = fakeCapture();
    const transcribe = mock(async () => "never");
    const rig = makeRig({ capture: cap.capture, transcribe });
    lastRig = rig;

    rig.stdin.emit("data", DICTATION_KEY);
    rig.interceptor.cancel();
    expect(cap.cancel).toHaveBeenCalledTimes(1);
    await flush();
    expect(transcribe).not.toHaveBeenCalled();
    expect(cap.stop).not.toHaveBeenCalled();
  });
});

describe("createArecordCapture", () => {
  it("records via the capture command, finalizing the wav on SIGINT", async () => {
    // Stub "arecord": ignores the format args, takes the last argv entry as
    // the output path, writes bytes and exits when SIGINT arrives.
    const dir = mkdtempSync(join(tmpdir(), "dictation-test-"));
    const stub = join(dir, "fake-arecord.sh");
    writeFileSync(
      stub,
      '#!/bin/sh\nshift 5\nout="$1"\ntrap \'printf wav-bytes > "$out"; exit 0\' INT\nwhile :; do sleep 0.05; done\n',
    );
    chmodSync(stub, 0o755);

    const capture = createArecordCapture(stub)();
    // Give the stub a moment to install its trap before signalling.
    await new Promise((r) => setTimeout(r, 100));
    const bytes = await capture.stop();
    expect(Buffer.from(bytes).toString()).toBe("wav-bytes");
  });

  it("stop rejects when the capture command is missing", async () => {
    const capture = createArecordCapture("hotdog-no-such-capture-cmd")();
    await expect(capture.stop()).rejects.toThrow();
  });

  it("cancel is safe with nothing recorded", () => {
    const capture = createArecordCapture("hotdog-no-such-capture-cmd")();
    expect(() => capture.cancel()).not.toThrow();
  });
});
