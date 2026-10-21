// Push-to-talk dictation for the interactive CLI.
//
// Ctrl+X toggles microphone capture (arecord -> 16 kHz mono wav in a temp
// file); the finished recording is sent to the OpenAI-compatible endpoint
// from config (`sttUrl`) and the transcript is inserted at the cursor of
// whatever line editor owns the input -- never auto-sent, the user always
// edits/submits.
//
// The state machine (recording/transcribing toggle, capture lifecycle,
// transcribe call, cancel-on-interrupt) lives in DictationCore and is input
// shape agnostic: it reports through DictationHooks. Two adapters sit on
// either side of it:
//   - DictationInterceptor (this file) is the legacy readline shape. Same
//     listener-swap trick as ./clipboard-paste.ts: installed after the paste
//     interceptor, it sits in front of that chain, swallows only the Ctrl+X
//     byte and forwards everything else untouched, and renders notices on
//     readline's output stream exactly as before.
//   - The split-renderer editor path (stage 3b) binds unhandled("ctrl-x") to
//     core.toggle() and inserts transcripts via EditorView.insertText.
// The whole thing is a no-op unless an STT target resolved (see
// resolveSttTarget); the readline adapter additionally requires a TTY input.

import readline from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { transcribeAudio } from "@utils/stt.ts";
import type { SttTarget } from "@core/config/stt.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";

export const DICTATION_KEY = "\x18"; // Ctrl+X

/** One running microphone capture. */
export interface AudioCapture {
  /** Stop the capture and resolve with the recorded wav bytes. */
  stop(): Promise<Uint8Array>;
  /** Kill the capture and discard the audio (idempotent). */
  cancel(): void;
}

export type CaptureFactory = () => AudioCapture;

/**
 * What a DictationCore reports as it works. Every method is fire-and-forget;
 * they run synchronously inside the core's lifecycle, and (mirroring the
 * original DictationInterceptor) a notice written mid-lifecycle shares the
 * try-block of the step that reports it: a throwing transcript placement is
 * reported like a transcription failure, exactly as the readline adapter did
 * before the core was extracted.
 */
export interface DictationHooks {
  /** Capture started: prompt the user how to stop it. */
  recording(): void;
  /** Audio captured, transcription request in flight. */
  transcribing(): void;
  /** Transcript ready: place it at the cursor; sending stays the user's call. */
  transcript(text: string): void;
  /** Capture or transcription failed (raw error; the adapter words it). */
  failed(err: unknown): void;
}

export interface DictationCoreOptions {
  /** Resolved STT backend (see resolveSttTarget); null disables the core entirely. */
  target?: SttTarget | null;
  /** Test seams: default to the arecord capture and transcribeAudio. */
  capture?: CaptureFactory;
  transcribe?: (audio: Uint8Array) => Promise<string>;
  /** Override the capture binary (tests); default "arecord". */
  captureCommand?: string;
  hooks: DictationHooks;
}

type State = "idle" | "recording" | "transcribing";

/**
 * Default capture: spawn `arecord -q -f S16_LE -r 16000 <tmpfile>`. SIGINT
 * makes arecord finalize the wav header; the file is read on close and
 * removed either way.
 */
export function createArecordCapture(command: string = "arecord"): CaptureFactory {
  return () => {
    const file = join(tmpdir(), `hotdog-dictation-${randomBytes(6).toString("hex")}.wav`);
    let proc: ChildProcess | null = spawn(command, ["-q", "-f", "S16_LE", "-r", "16000", file], {
      stdio: "ignore",
    });
    let spawnError: Error | null = null;
    // Settled at spawn time (close, or spawn error): a capture that dies
    // before stop() is called must not leave stop() awaiting a close event
    // that already fired (that hang printed "Transcribing…" forever).
    let settleClose: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      settleClose = resolve;
    });
    proc.on("error", (err: Error) => {
      spawnError = err;
      settleClose();
    });
    proc.on("close", () => settleClose());

    return {
      async stop(): Promise<Uint8Array> {
        if (!proc) throw new Error("dictation: capture already stopped");
        const p = proc;
        proc = null;
        p.kill("SIGINT");
        await closed;
        try {
          if (spawnError) throw spawnError;
          const bytes = readFileSync(file);
          if (bytes.length === 0) throw new Error("no audio recorded");
          return new Uint8Array(bytes);
        } finally {
          try {
            unlinkSync(file);
          } catch {
            /* file may not exist (spawn failed) */
          }
        }
      },
      cancel(): void {
        if (proc) {
          proc.kill("SIGINT");
          proc = null;
        }
        try {
          unlinkSync(file);
        } catch {
          /* nothing to clean up */
        }
      },
    };
  };
}

/**
 * The capture/transcribe state machine shared by both input shapes. Toggle
 * semantics are the historical ones: idle starts a recording, recording
 * stops and transcribes, and a press while transcribing is ignored until
 * the reply lands. cancel() drops an in-flight recording without
 * transcribing (Ctrl+C, quit).
 */
export class DictationCore {
  readonly #enabled: boolean;
  readonly #capture: CaptureFactory;
  readonly #transcribe: (audio: Uint8Array) => Promise<string>;
  readonly #hooks: DictationHooks;
  #state: State = "idle";
  #captureHandle: AudioCapture | null = null;

  constructor(opts: DictationCoreOptions) {
    const target = opts.target ?? null;
    this.#enabled = target !== null;
    this.#capture = opts.capture ?? createArecordCapture(opts.captureCommand);
    this.#transcribe =
      opts.transcribe ??
      ((audio) =>
        transcribeAudio({
          url: (target as SttTarget).url,
          model: (target as SttTarget).model,
          authHeader: (target as SttTarget).authHeader,
          audio,
          mimeType: "audio/wav",
          filename: "dictation.wav",
        }));
    this.#hooks = opts.hooks;
  }

  /** Ctrl+X arrived: start, stop, or (while transcribing) ignore. */
  toggle(): void {
    if (!this.#enabled) return;
    if (this.#state === "idle") void this.#start();
    else if (this.#state === "recording") void this.#stop();
    // "transcribing": ignore until the reply lands.
  }

  /** Drop an in-flight recording without transcribing (Ctrl+C, quit). */
  cancel(): void {
    if (this.#state === "recording" && this.#captureHandle) {
      this.#captureHandle.cancel();
      this.#captureHandle = null;
      this.#state = "idle";
    }
  }

  async #start(): Promise<void> {
    this.#state = "recording";
    try {
      this.#captureHandle = this.#capture();
    } catch (err) {
      this.#state = "idle";
      this.#hooks.failed(err);
      return;
    }
    this.#hooks.recording();
  }

  async #stop(): Promise<void> {
    const handle = this.#captureHandle;
    this.#captureHandle = null;
    if (!handle) {
      this.#state = "idle";
      return;
    }
    this.#state = "transcribing";
    this.#hooks.transcribing();
    try {
      const audio = await handle.stop();
      const text = await this.#transcribe(audio);
      this.#hooks.transcript(text);
    } catch (err) {
      this.#hooks.failed(err);
    } finally {
      this.#state = "idle";
    }
  }
}

type DataListener = (chunk: unknown) => void;

interface InputLike {
  isTTY?: boolean;
  listeners(event: string): unknown[];
  removeListener(event: string, listener: DataListener): unknown;
  on(event: string, listener: DataListener): unknown;
}

export interface DictationInterceptorOptions {
  /** Resolved STT backend (see resolveSttTarget); null disables the interceptor entirely. */
  target?: SttTarget | null;
  /** Test seams: default to the arecord capture and transcribeAudio. */
  capture?: CaptureFactory;
  transcribe?: (audio: Uint8Array) => Promise<string>;
  /** Override the capture binary (tests); default "arecord". */
  captureCommand?: string;
}

/** The readline half of the output surface the notices/status repaint use. */
type OutputLike = NodeJS.WritableStream & { isTTY?: boolean };

/**
 * Legacy readline adapter: listener-swap for the Ctrl+X byte plus the
 * historical repaint behavior (notices on rl.output, prompt(true) keeps a
 * half-typed line, the finished transcript lands via rl.write at the caret).
 */
export class DictationInterceptor {
  readonly #origData: DataListener | null;
  readonly #stdin: InputLike | null;
  readonly #core: DictationCore;
  #input: DataListener | null = null;

  constructor(rl: readline.Interface, options: DictationInterceptorOptions) {
    const target = options.target ?? null;
    const input = (rl as { input?: unknown }).input as InputLike | undefined;
    const dataListeners = (input?.listeners?.("data") ?? []) as DataListener[];
    // Whatever currently consumes raw input (readline itself, or the paste
    // interceptor installed before us) is the last data listener.
    const orig = dataListeners[dataListeners.length - 1] ?? null;
    const enabled =
      target !== null &&
      input?.isTTY === true &&
      orig !== null &&
      typeof input?.removeListener === "function" &&
      typeof input?.on === "function";

    this.#stdin = enabled ? input : null;
    this.#origData = enabled ? orig : null;

    const out = (): OutputLike | undefined =>
      (rl as { output?: OutputLike }).output;
    const writeLine = (msg: string): void => {
      const output = out();
      if (output?.isTTY !== true) return;
      output.write(msg + "\n");
    };

    this.#core = new DictationCore({
      target,
      capture: options.capture,
      transcribe: options.transcribe,
      captureCommand: options.captureCommand,
      hooks: {
        recording: (): void => {
          writeLine("\n● Recording… press Ctrl+X to stop");
          // Repaint the (still-filled) input line below the notice.
          rl.prompt(true); // keep the caret in any half-typed line
        },
        transcribing: (): void => writeLine("\nTranscribing…"),
        transcript: (text): void => {
          // Clear the transient status line, then restore prompt + buffer with
          // the transcript inserted at the cursor (never submitted).
          const output = out();
          if (output?.isTTY === true) {
            readline.cursorTo(output, 0);
            readline.clearLine(output, 0);
          }
          rl.prompt(true);
          rl.write(text);
        },
        failed: (err): void => {
          writeLine(`\nDictation failed: ${err instanceof Error ? err.message : String(err)}`);
          rl.prompt(true);
        },
      },
    });

    if (!enabled) return;

    this.#stdin!.removeListener("data", orig!);
    const onInput: DataListener = (chunk) => this.#onData(chunk);
    this.#stdin!.on("data", onInput);
    this.#input = onInput;

    // Quit/interrupt paths: never leave arecord running.
    rl.on("close", () => this.cancel());
  }

  get enabled(): boolean {
    return this.#origData !== null;
  }

  /** Drop an in-flight recording without transcribing (Ctrl+C, quit). */
  cancel(): void {
    this.#core.cancel();
  }

  dispose(): void {
    this.cancel();
    if (this.#stdin && this.#input) {
      try {
        this.#stdin.removeListener("data", this.#input);
      } catch (e) {
        logger.debug(`dictation: teardown: ${formatError(e)}`);
      }
      this.#input = null;
    }
  }

  #onData(chunk: unknown): void {
    const raw =
      typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const idx = raw.indexOf(DICTATION_KEY);
    if (idx === -1) {
      this.#origData!(chunk);
      return;
    }
    if (idx > 0) this.#origData!(raw.slice(0, idx));
    this.#core.toggle();
    const rest = raw.slice(idx + DICTATION_KEY.length);
    if (rest.length > 0) this.#onData(rest);
  }
}
