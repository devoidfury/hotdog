// Push-to-talk dictation for the interactive CLI.
//
// Ctrl+X toggles microphone capture (arecord -> 16 kHz mono wav in a temp
// file); the finished recording is sent to the OpenAI-compatible endpoint
// from config (`sttUrl`) and the transcript is inserted at the readline
// cursor -- never auto-sent, the user always edits/submits.
//
// Same listener-swap trick as ./clipboard-paste.ts: the interceptor is
// installed after the paste interceptor, so it sits in front of that chain,
// swallows only the Ctrl+X byte and forwards everything else untouched. The
// whole thing is a no-op unless an STT target resolved (see resolveSttTarget)
// and the input is a TTY.

import readline from "node:readline";
import type { Writable } from "node:stream";
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

export interface DictationInterceptorOptions {
  /** Resolved STT backend (see resolveSttTarget); null disables the interceptor entirely. */
  target?: SttTarget | null;
  /** Test seams: default to the arecord capture and transcribeAudio. */
  capture?: CaptureFactory;
  transcribe?: (audio: Uint8Array) => Promise<string>;
  /** Override the capture binary (tests); default "arecord". */
  captureCommand?: string;
}

type DataListener = (chunk: unknown) => void;

interface InputLike {
  isTTY?: boolean;
  listeners(event: string): unknown[];
  removeListener(event: string, listener: DataListener): unknown;
  on(event: string, listener: DataListener): unknown;
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
    proc.on("error", (err: Error) => {
      spawnError = err;
    });

    return {
      async stop(): Promise<Uint8Array> {
        if (!proc) throw new Error("dictation: capture already stopped");
        const p = proc;
        proc = null;
        p.kill("SIGINT");
        await new Promise<void>((resolve) => p.on("close", () => resolve()));
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

export class DictationInterceptor {
  readonly #rl: readline.Interface;
  readonly #origData: DataListener | null;
  readonly #stdin: InputLike | null;
  readonly #capture: CaptureFactory;
  readonly #transcribe: (audio: Uint8Array) => Promise<string>;
  #input: DataListener | null = null;
  #state: State = "idle";
  #captureHandle: AudioCapture | null = null;

  constructor(rl: readline.Interface, options: DictationInterceptorOptions) {
    this.#rl = rl;

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
    this.#capture = options.capture ?? createArecordCapture(options.captureCommand);
    this.#transcribe =
      options.transcribe ??
      ((audio) =>
        transcribeAudio({
          url: (target as SttTarget).url,
          model: (target as SttTarget).model,
          authHeader: (target as SttTarget).authHeader,
          audio,
          mimeType: "audio/wav",
          filename: "dictation.wav",
        }));

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
    if (this.#state === "recording" && this.#captureHandle) {
      this.#captureHandle.cancel();
      this.#captureHandle = null;
      this.#state = "idle";
    }
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
    this.#toggle();
    const rest = raw.slice(idx + DICTATION_KEY.length);
    if (rest.length > 0) this.#onData(rest);
  }

  #toggle(): void {
    if (this.#state === "idle") {
      void this.#start();
    } else if (this.#state === "recording") {
      void this.#stop();
    }
    // "transcribing": ignore until the reply lands.
  }

  async #start(): Promise<void> {
    this.#state = "recording";
    try {
      this.#captureHandle = this.#capture();
    } catch (err) {
      this.#state = "idle";
      this.#fail(err);
      return;
    }
    this.#writeLine("\n● Recording… press Ctrl+X to stop");
    // Repaint the (still-filled) input line below the notice.
    this.#rl.prompt(true); // keep the caret in any half-typed line
  }

  async #stop(): Promise<void> {
    const handle = this.#captureHandle;
    this.#captureHandle = null;
    if (!handle) {
      this.#state = "idle";
      return;
    }
    this.#state = "transcribing";
    this.#writeLine("\nTranscribing…");
    try {
      const audio = await handle.stop();
      const text = await this.#transcribe(audio);
      // Clear the transient status line, then restore prompt + buffer with
      // the transcript inserted at the cursor (never submitted).
      this.#clearPromptLine();
      this.#rl.prompt(true);
      this.#rl.write(text);
    } catch (err) {
      this.#fail(err);
    } finally {
      this.#state = "idle";
    }
  }

  #fail(err: unknown): void {
    this.#writeLine(`\nDictation failed: ${err instanceof Error ? err.message : String(err)}`);
    this.#rl.prompt(true);
  }

  #writeLine(msg: string): void {
    const out = (this.#rl as { output?: Writable & { isTTY?: boolean } }).output;
    if (out?.isTTY !== true) return;
    out.write(msg + "\n");
  }

  #clearPromptLine(): void {
    const out = (this.#rl as { output?: Writable & { isTTY?: boolean } }).output;
    if (out?.isTTY !== true) return;
    readline.cursorTo(out, 0);
    readline.clearLine(out, 0);
  }
}
