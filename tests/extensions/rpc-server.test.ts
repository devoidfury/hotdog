// Tests for src/extensions/ui-rpc/rpc-server.ts — command dispatch, event
// record emission, and the question seam (ask/answer round-trip, honest
// unanswered stamps on cancel and connection close).

import { describe, it, expect, mock } from "bun:test";
import { RpcQuestionSeam, RpcServer } from "@extensions/ui-rpc/rpc-server.ts";
import type { ChannelSessionManager } from "@core/channel.ts";
import { OUTPUT_EVENT, type OutputEvent } from "@core/context/output.ts";
import { unansweredReason } from "@core/context/input.ts";

function createMockSessionManager(overrides: Partial<ChannelSessionManager> = {}) {
  const handlers = new Map<string, (event: OutputEvent) => void>();
  const manager: ChannelSessionManager = {
    enqueue: mock(() => {}),
    cancel: mock(() => {}),
    interrupt: mock(() => {}),
    executeCommand: mock(async () => undefined),
    onSessionEvents: mock((sessionId, handler) => {
      handlers.set(sessionId, handler);
      return () => handlers.delete(sessionId);
    }),
    sessionIds: mock(() => ["s1"]),
    getSessionInfo: mock((id) => ({ id, model: "test-model" })),
    ...overrides,
  };
  return { manager, handlers };
}

function createServer(overrides: Partial<ChannelSessionManager> = {}) {
  const { manager, handlers } = createMockSessionManager(overrides);
  const lines: string[] = [];
  const server = new RpcServer({
    sessionManager: manager,
    sessionId: "s1",
    writeLine: (line) => lines.push(line),
  });
  const records = () => lines.map((l) => JSON.parse(l));
  return { server, manager, handlers, lines, records };
}

async function* reader(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

describe("RpcServer dispatch", () => {
  it("writes a hello record naming session and model", () => {
    const { server, records } = createServer();
    server.hello("test-model");
    const hello = records()[0];
    expect(hello.type).toBe("hello");
    expect(hello.session).toBe("s1");
    expect(hello.model).toBe("test-model");
  });

  it("routes a prompt through steering enqueue and acks with the id", async () => {
    const { server, manager, records } = createServer();
    await server.handleLine('{"id":"c1","cmd":"prompt","text":"do it"}');
    expect(manager.enqueue).toHaveBeenCalledWith("s1", "do it", { steering: true });
    expect(records()[0]).toEqual({ v: 1, type: "reply", id: "c1", ok: true });
  });

  it("runs slash-prefixed prompt text as a command, not a turn", async () => {
    const { server, manager, records } = createServer();
    await server.handleLine('{"id":2,"cmd":"prompt","text":"/compact"}');
    expect(manager.executeCommand).toHaveBeenCalledWith("s1", "compact");
    expect(manager.enqueue).not.toHaveBeenCalled();
    expect(records()[0].ok).toBe(true);
  });

  it("routes cancel and interrupt to the session manager", async () => {
    const { server, manager } = createServer();
    await server.handleLine('{"cmd":"cancel"}');
    await server.handleLine('{"cmd":"interrupt","session":"other"}');
    expect(manager.cancel).toHaveBeenCalledWith("s1");
    expect(manager.interrupt).toHaveBeenCalledWith("other");
  });

  it("answers status with sessions, current, and pending asks", async () => {
    const { server, records } = createServer();
    await server.handleLine('{"id":9,"cmd":"status"}');
    const reply = records()[0];
    expect(reply.id).toBe(9);
    expect(reply.data.current).toBe("s1");
    expect(reply.data.sessions).toEqual([{ id: "s1", model: "test-model" }]);
    expect(reply.data.pendingAsks).toEqual([]);
  });

  it("writes parse failures as replies when an id is readable, errors otherwise", async () => {
    const { server, records } = createServer();
    await server.handleLine("{broken");
    await server.handleLine('{"id":4,"cmd":"nope"}');
    const [err, reply] = records();
    expect(err.type).toBe("error");
    expect(reply).toMatchObject({ type: "reply", id: 4, ok: false });
  });

  it("shutdown acks before closing and ends the run loop", async () => {
    const { server, records } = createServer();
    // A reader that would block forever after the shutdown: run() must end
    // on the command, not wait for a line.
    await server.run(reader(['{"id":1,"cmd":"shutdown"}']));
    expect(records()[0]).toEqual({ v: 1, type: "reply", id: 1, ok: true });
    expect(server.isClosed).toBe(true);
  });

  it("stdin EOF ends the run loop and closes the connection", async () => {
    const { server } = createServer();
    await server.run(reader([]));
    expect(server.isClosed).toBe(true);
  });
});

describe("RpcServer event emission", () => {
  it("tags session events with the subscribing session and a monotonic seq", () => {
    const { handlers, records } = createServer();
    const emit = handlers.get("s1")!;
    emit({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "a" } as OutputEvent);
    emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "b" } as OutputEvent);
    const [first, second] = records();
    expect(first).toEqual({
      v: 1,
      type: "event",
      seq: 1,
      session: "s1",
      event: "assistant_message",
      data: { content: "a" },
    });
    expect(second.seq).toBe(2);
    expect(second.event).toBe("streaming_chunk");
  });

  it("stops emitting after close (detached subscription)", async () => {
    const { server, handlers, records } = createServer();
    await server.run(reader([]));
    handlers.get("s1")?.({ type: OUTPUT_EVENT.SYSTEM_MESSAGE, content: "late" } as OutputEvent);
    expect(records()).toHaveLength(0);
  });
});

describe("RpcQuestionSeam", () => {
  it("ask records surface on the wire and answer commands resolve them", async () => {
    const { server, records } = createServer();
    const asks = server.seam.collectAnswers([{ key: "color", prompt: "Which?" }]);
    const ask = records()[0];
    expect(ask.type).toBe("ask");
    expect(ask.session).toBe("s1");
    expect(ask.data.questions[0].key).toBe("color");

    await server.handleLine(`{"id":"x","cmd":"answer","askId":"${ask.askId}","answers":{"color":"blue"}}`);
    expect(await asks).toEqual({ color: "blue" });
    expect(records().at(-1)).toMatchObject({ type: "reply", id: "x", ok: true });
  });

  it("answers to an unknown askId are rejected", async () => {
    const { server, records } = createServer();
    await server.handleLine('{"id":"x","cmd":"answer","askId":"nope","answers":{}}');
    expect(records()[0]).toMatchObject({ type: "reply", id: "x", ok: false });
  });

  it("run cancellation releases the hold with an honest unanswered stamp, never defaults", async () => {
    const controller = new AbortController();
    const seam = new RpcQuestionSeam(() => {});
    const pending = seam.collectAnswers([{ key: "k", prompt: "p?", default: "d" }], controller.signal);
    controller.abort();
    const answers = await pending;
    expect(unansweredReason(answers)).toBe("run cancelled");
    expect(answers.k).toBeUndefined();
  });

  it("a pre-aborted signal resolves immediately without an ask", async () => {
    const controller = new AbortController();
    controller.abort();
    const seam = new RpcQuestionSeam(() => {
      throw new Error("must not emit an ask for an aborted run");
    });
    const answers = await seam.collectAnswers([{ key: "k", prompt: "p?" }], controller.signal);
    expect(unansweredReason(answers)).toBe("run cancelled");
  });

  it("connection close settles held asks as unanswered", async () => {
    const { server } = createServer();
    const pending = server.seam.collectAnswers([{ key: "k", prompt: "p?" }]);
    expect(server.seam.pendingAskIds()).toEqual(["a1"]);
    await server.run(reader([]));
    const answers = await pending;
    expect(unansweredReason(answers)).toBe("connection closed");
  });
});
