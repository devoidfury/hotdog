// The stdio JSONL machine protocol: a versioned record envelope over the
// core OutputEvent/Channel surface. Consumed by `hotdog rpc` (persistent,
// bidirectional) and by one-shot `--json-events` (single turn, events only).
//
// This is deliberately NOT the webui WebSocket protocol. That one is the
// webui's private contract (rich, unversioned, evolving with the UI); this one
// is the CI/embedding surface, so it is small, names-only on the event half,
// and additive-within-major like the rest of the published surface.
//
// Envelope: every record carries `v` (protocol version, currently 1) and a
// string `type`. Event records additionally carry a per-connection `seq`, the
// `session` they belong to, the event `name`, and its `data`. Unknown fields
// on inbound commands are ignored (forward compatibility); an unknown `cmd`
// is a rejection, not an ignore.

import {
  EVENT_NAME_MAP,
  type OutputEvent,
} from "@core/context/output.ts";
import type { QuestionDef } from "@core/context/input.ts";

export const RPC_PROTOCOL = "hotdog.rpc";
export const RPC_PROTOCOL_VERSION = 1;

/** Inbound command names. Anything else is rejected with ok:false. */
export const RPC_COMMANDS = [
  "prompt",
  "cancel",
  "interrupt",
  "status",
  "answer",
  "shutdown",
] as const;
export type RpcCommandName = (typeof RPC_COMMANDS)[number];

export interface RpcCommand {
  /** Client correlation id, echoed on the reply. Optional: fire-and-forget. */
  id: string | number | null;
  cmd: RpcCommandName;
  /** prompt/slash text */
  text?: string;
  /** cancel/interrupt target session (default: the connection's session) */
  session?: string;
  /** answer: the ask id from an `ask` record */
  askId?: string;
  /** answer: the answers object handed verbatim to the question seam */
  answers?: Record<string, unknown>;
}

export interface RpcRecord {
  v: number;
  type: string;
  [key: string]: unknown;
}

// OutputEventType number -> wire name. Derived from EVENT_NAME_MAP (the
// single source of truth) so a new core event reaches the wire the moment it
// gets a name there; nothing here needs to change.
const TYPE_TO_EVENT_NAME: Record<number, string> = {};
for (const [name, type] of Object.entries(EVENT_NAME_MAP)) {
  TYPE_TO_EVENT_NAME[type] = name;
}

/**
 * A core OutputEvent as a wire record. The numeric `type` is internal: the
 * wire carries the EVENT_NAME_MAP name and the remaining fields as `data`.
 */
export function eventRecord(
  event: OutputEvent,
  seq: number,
  sessionId?: string | null,
): RpcRecord {
  const { type: numericType, ...data } = event as unknown as Record<string, unknown>;
  const name = TYPE_TO_EVENT_NAME[numericType as number] ?? "unknown";
  return {
    v: RPC_PROTOCOL_VERSION,
    type: "event",
    seq,
    ...(sessionId ? { session: sessionId } : {}),
    event: name,
    ...(name === "unknown" ? { t: numericType } : {}),
    data,
  };
}

export function helloRecord(sessionId: string, model?: string): RpcRecord {
  return {
    v: RPC_PROTOCOL_VERSION,
    type: "hello",
    protocol: RPC_PROTOCOL,
    version: RPC_PROTOCOL_VERSION,
    session: sessionId,
    ...(model ? { model } : {}),
  };
}

export function replyRecord(
  id: string | number | null,
  ok: boolean,
  extra?: { error?: string; data?: Record<string, unknown> },
): RpcRecord {
  return { v: RPC_PROTOCOL_VERSION, type: "reply", id, ok, ...extra };
}

/** Parse failure with no correlatable id (malformed line, wrong shape). */
export function errorRecord(message: string): RpcRecord {
  return { v: RPC_PROTOCOL_VERSION, type: "error", message };
}

/**
 * A question seam ask: the authoritative answer target. The question tool
 * also emits a QUESTION event, but the `ask` record is what `answer`
 * commands must reference (user-gate prompts ride the seam without an
 * event, so asking only through events would miss half the asks).
 */
export function askRecord(
  askId: string,
  questions: QuestionDef[],
  sessionId?: string | null,
): RpcRecord {
  return {
    v: RPC_PROTOCOL_VERSION,
    type: "ask",
    ...(sessionId ? { session: sessionId } : {}),
    askId,
    data: { questions },
  };
}

/**
 * One-shot terminal record (`--json-events`): the run's verdict, replacing
 * the human "Session: <id>" trailer. Always the last record on stdout.
 */
export function resultRecord(
  sessionId: string | null,
  exitCode: number,
): RpcRecord {
  return {
    v: RPC_PROTOCOL_VERSION,
    type: "result",
    ...(sessionId ? { session: sessionId } : {}),
    ok: exitCode === 0,
    exitCode,
  };
}

export type ParseResult =
  | { ok: true; command: RpcCommand }
  /** When `id` is non-null the failure belongs to a command: answer with a
   *  reply(ok:false, id), so a pipelining client can correlate. */
  | { ok: false; error: string; id: string | number | null };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse one stdin line into a validated command, or a rejection with the
 *  echoed correlation id when one could be read. */
export function parseCommandLine(line: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: "invalid JSON", id: null };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: "record must be a JSON object", id: null };
  }

  const rawId = raw.id;
  let id: string | number | null = null;
  if (rawId !== undefined && rawId !== null) {
    if (typeof rawId !== "string" && typeof rawId !== "number") {
      return { ok: false, error: "id must be a string or number", id: null };
    }
    id = rawId;
  }

  if (typeof raw.cmd !== "string") {
    return { ok: false, error: "cmd must be a string", id };
  }
  const cmd = raw.cmd as RpcCommandName;
  if (!RPC_COMMANDS.includes(cmd)) {
    return { ok: false, error: `unknown cmd: ${raw.cmd}`, id };
  }

  if (cmd === "prompt" || cmd === "interrupt") {
    // interrupt mirrors the CLI Esc semantics: text with no session targets
    // the current one; prompt additionally requires non-empty text.
    if (cmd === "prompt" && (typeof raw.text !== "string" || raw.text.trim() === "")) {
      return { ok: false, error: "prompt requires non-empty text", id };
    }
  }
  if (raw.text !== undefined && typeof raw.text !== "string") {
    return { ok: false, error: "text must be a string", id };
  }
  if (raw.session !== undefined && typeof raw.session !== "string") {
    return { ok: false, error: "session must be a string", id };
  }
  if (cmd === "answer") {
    if (typeof raw.askId !== "string" || raw.askId === "") {
      return { ok: false, error: "answer requires askId", id };
    }
    if (!isPlainObject(raw.answers)) {
      return { ok: false, error: "answer requires an answers object", id };
    }
  }

  return {
    ok: true,
    command: {
      id,
      cmd,
      ...(typeof raw.text === "string" ? { text: raw.text } : {}),
      ...(typeof raw.session === "string" ? { session: raw.session } : {}),
      ...(typeof raw.askId === "string" ? { askId: raw.askId } : {}),
      ...(isPlainObject(raw.answers) ? { answers: raw.answers } : {}),
    },
  };
}

/**
 * One stdout writer: seq-ordered event records plus control records. stdout
 * carries these bytes and nothing else (diagnostics go to the logger).
 */
export class JsonlEventWriter {
  #seq = 0;
  #out: (line: string) => void;

  constructor(out?: (line: string) => void) {
    this.#out = out ?? ((line: string) => process.stdout.write(line));
  }

  /** Sink-compatible with CliOutputSink.emit so channels can write straight in. */
  emit(event: OutputEvent, sessionId?: string | null): void {
    this.writeRecord(eventRecord(event, ++this.#seq, sessionId));
  }

  writeRecord(record: RpcRecord): void {
    this.#out(JSON.stringify(record) + "\n");
  }

  get seq(): number {
    return this.#seq;
  }
}
