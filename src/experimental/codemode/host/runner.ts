// The codemode runner -- the CHILD side of the host<->code bridge.
// Spawned by bridge.ts (fenced or degraded) as `bun <this file>`; speaks
// NDJSON frames on stdio and nothing else: the child holds no authority,
// every capability is a frame round-trip to the host.
//
// NOT a security boundary: the fence is argv, the realm is not. The
// script runs in this realm with ambient globals reachable; containment is
// the OS jail the bridge wraps us in.
//
// The script executes as the body of an async function (AsyncFunction):
// top-level `await` and `return` work. Globals handed in as parameters:
// tools, searchTools, describeTool, text, exit, store, load, console.

import { formatError } from "@core/error.ts";
import { format } from "node:util";
import {
  createFrameDecoder,
  encodeLine,
  parseHostFrame,
  type CallFrame,
  type ChildFrame,
  type DoneFrame,
  type LoadFrame,
  type MetaDescribeFrame,
  type MetaFrame,
  type MetaSearchFrame,
  type OutItem,
  type ResFrame,
  type ResPayload,
  type RunFrame,
  type StoreFrame,
  RUNNER_CAP_EXIT,
} from "./protocol.ts";
import {
  MAX_INNER_CALLS,
  OUTPUT_STREAM_CAP_BYTES,
  OUTPUT_STREAM_MAX_ITEMS,
  STORE_KEY_MAX_BYTES,
  STORE_VALUE_MAX_BYTES,
} from "../options.ts";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...init: string[]
) => (...args: unknown[]) => Promise<unknown>;

/** Thrown by exit(); unwinds the script body without failing the run. */
const EXIT_SENTINEL = Symbol("codemode-exit");

interface Pending {
  resolve: (payload: ResPayload) => void;
  reject: (err: Error) => void;
}

/** Display form of one script value for text()/console routing. */
function display(v: unknown): string {
  return typeof v === "string" ? v : format(v);
}

async function main(): Promise<void> {
  const decoder = createFrameDecoder();
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let callsUsed = 0;
  let callsCap = MAX_INNER_CALLS;
  let outBytes = 0;
  let outItems = 0;
  let closed = false;
  let runSeen = false;

  let resolveRun: (frame: RunFrame) => void = () => {};
  const runFrame = new Promise<RunFrame>((res) => {
    resolveRun = res;
  });

  const finish = (frame: DoneFrame): void => {
    if (closed) return;
    closed = true;
    process.stdout.write(encodeLine(frame));
    // Natural process exit flushes stdout; stdin must not hold the loop open.
    try {
      process.stdin.destroy();
    } catch {
      // already gone
    }
  };

  /** A host frame we cannot trust: report while the pipe still works, then
   *  let the loop drain (stdin is destroyed) and die. */
  const violate = (detail: string): void => {
    finish({ t: "done", ok: false, error: `protocol violation: ${detail}` });
  };

  const writeFrame = (frame: ChildFrame): void => {
    if (closed) return;
    process.stdout.write(encodeLine(frame));
  };

  /** Streamed past the child-side caps: the child enforces -- the host keeps
   *  all output until the script ends, so a chatty script dies from inside
   *  rather than from a host that stopped reading. The exit code tells the
   *  host this was the cap, not a stray death. */
  const capKill = (): never => {
    closed = true;
    process.exit(RUNNER_CAP_EXIT);
    throw new Error("unreachable: process.exit");
  };

  const emitOut = (item: OutItem): void => {
    if (closed) return;
    const line = encodeLine({ t: "out", item });
    outBytes += Buffer.byteLength(line);
    outItems += 1;
    process.stdout.write(line);
    if (outBytes > OUTPUT_STREAM_CAP_BYTES || outItems > OUTPUT_STREAM_MAX_ITEMS) capKill();
  };

  const sendRequest = (
    frame: CallFrame | MetaFrame | StoreFrame | LoadFrame,
  ): Promise<ResPayload> => {
    return new Promise<ResPayload>((resolve, reject) => {
      pending.set(frame.id, { resolve, reject });
      writeFrame(frame);
    });
  };

  const handleRes = (res: ResFrame): void => {
    const entry = pending.get(res.id);
    if (!entry) return; // reply for an id we never had: noise
    pending.delete(res.id);
    if (res.ok) entry.resolve(res.payload);
    else entry.reject(new Error(res.error || "tool call failed"));
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    if (closed) return;
    let lines: string[];
    try {
      lines = decoder.push(chunk);
    } catch (e) {
      violate(`frame overflow on the host->child stream: ${formatError(e)}`);
      return;
    }
    for (const line of lines) {
      const frame = parseHostFrame(line);
      if (!frame) {
        violate(`malformed frame on the host->child stream: ${line.slice(0, 120)}`);
        return;
      }
      if (frame.t === "res") handleRes(frame);
      else if (frame.t === "run" && !runSeen) {
        runSeen = true;
        resolveRun(frame);
      } else {
        violate(`unexpected host frame: ${frame.t}`);
        return;
      }
    }
  });
  process.stdin.on("error", () => {});
  process.stdout.on("error", () => {});
  process.stdin.on("end", () => {
    // Host gone mid-protocol: leave. (--die-with-parent is the real
    // guarantee; this just avoids lingering on a dead pipe.)
    if (!closed) process.exit(1);
  });

  const run = await runFrame;
  if (run.calls > 0) callsCap = run.calls;

  // The callable table: one async fn per name from the run frame, enumerable
  // without a query frame. The name list is built host-side and never
  // contains `codemode` -- the ban is structural, not a runtime check. Null-
  // prototype: a tool literally named `__proto__` (the name regex permits
  // it; MCP servers pass names through) must land as an own key, not set
  // the table's prototype and vanish from enumeration.
  const tools: Record<string, (args?: unknown) => Promise<string>> = Object.create(null);
  for (const name of run.names) {
    tools[name] = async (args?: unknown): Promise<string> => {
      callsUsed += 1;
      if (callsUsed > callsCap) {
        throw new Error(`inner call limit reached (${callsCap} per script)`);
      }
      const callFrame: CallFrame = { t: "call", id: nextId++, name, args };
      const payload = await sendRequest(callFrame);
      return payload.hint ? `${payload.output}\n${payload.hint}` : payload.output;
    };
  }

  // Discovery globals: meta frames answer with JSON -- searchTools resolves
  // to `{name, description}[]`, describeTool to a param sample or null. The
  // pointer for an unknown describeTool rides the res hint AND the
  // host-recorded digest line; the script-side value is null.
  const metaRequest = (
    base: Omit<MetaSearchFrame, "id"> | Omit<MetaDescribeFrame, "id">,
  ): Promise<ResPayload> => sendRequest({ ...base, id: nextId++ } as MetaFrame);
  const parseMetaJson = (raw: string, what: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`${what}: unparseable host response`);
    }
  };
  const searchTools = async (query: unknown, limit?: unknown): Promise<unknown> => {
    const p = await metaRequest(
      typeof limit === "number"
        ? { t: "meta", op: "searchTools", query: String(query), limit }
        : { t: "meta", op: "searchTools", query: String(query) },
    );
    return parseMetaJson(p.output, "searchTools");
  };
  const describeTool = async (name: unknown): Promise<unknown> => {
    const p = await metaRequest({ t: "meta", op: "describeTool", name: String(name) });
    return parseMetaJson(p.output, "describeTool");
  };

  // store()/load(): host-backed frames. The child pre-screens
  // JSON-serializability and the per-value size, so a script-side error
  // beats a killed child on an oversized frame; the host re-checks every
  // quota and owns the real authority -- writes commit only on script
  // success, so nothing here is durable until the run ends ok.
  const store = async (key: unknown, value: unknown): Promise<void> => {
    const k = String(key);
    const keyBytes = Buffer.byteLength(k);
    if (keyBytes > STORE_KEY_MAX_BYTES) {
      throw new Error(
        `store: key is ${keyBytes} bytes, over the ${STORE_KEY_MAX_BYTES}-byte key cap`,
      );
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch (e) {
      throw new Error(`store: value is not JSON-serializable: ${formatError(e)}`);
    }
    if (json === undefined) {
      throw new Error("store: value is required -- undefined is not a JSON value");
    }
    const valueBytes = Buffer.byteLength(json);
    const bytes = keyBytes + valueBytes;
    if (bytes > STORE_VALUE_MAX_BYTES) {
      throw new Error(
        `store: entry is ${bytes} bytes (key ${keyBytes} + value ${valueBytes}), ` +
          `over the ${STORE_VALUE_MAX_BYTES}-byte per-value cap`,
      );
    }
    const frame: StoreFrame = { t: "store", id: nextId++, key: k, value };
    await sendRequest(frame);
  };
  const load = async (key: unknown): Promise<unknown> => {
    const frame: LoadFrame = { t: "load", id: nextId++, key: String(key) };
    const payload = await sendRequest(frame);
    return payload.output ? JSON.parse(payload.output) : null;
  };

  const text = (v: unknown): void => {
    emitOut({ kind: "text", text: display(v) });
  };
  const outConsole = {
    log: (...args: unknown[]) => emitOut({ kind: "text", text: format(...args) }),
    info: (...args: unknown[]) => emitOut({ kind: "text", text: format(...args) }),
    warn: (...args: unknown[]) => emitOut({ kind: "text", text: format(...args) }),
    error: (...args: unknown[]) => emitOut({ kind: "text", text: format(...args) }),
    debug: (...args: unknown[]) => emitOut({ kind: "text", text: format(...args) }),
  };
  const exit = (): never => {
    throw EXIT_SENTINEL;
  };

  let done: DoneFrame;
  try {
    const fn = new AsyncFunction(
      "tools",
      "searchTools",
      "describeTool",
      "text",
      "exit",
      "store",
      "load",
      "console",
      run.src,
    );
    const value = await fn(tools, searchTools, describeTool, text, exit, store, load, outConsole);
    done = { t: "done", ok: true, value: value === undefined ? null : value };
  } catch (e) {
    done =
      e === EXIT_SENTINEL
        ? { t: "done", ok: true, value: null }
        : { t: "done", ok: false, error: formatError(e) };
  }
  finish(done);
}

if (import.meta.main) {
  main().catch(() => process.exit(2));
}
