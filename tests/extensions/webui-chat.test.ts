// Tests for webui/ui/chat.ts session plumbing. Only the container-facing
// paths are exercised here (createChat accepts the message-list element as
// an opaque handle), which keeps this runnable under Bun without a DOM.
// The rest of chat.ts is browser-only by project convention.

import { describe, it, expect, afterEach } from "bun:test";
import { createChat, type ChatController } from "@extensions/webui/ui/chat.ts";

function makeContainer(): { events: string[]; removed: string[]; innerHTML: string } & Record<string, unknown> {
  const events: string[] = [];
  const removed: string[] = [];
  return {
    events,
    removed,
    innerHTML: "",
    addEventListener: (type: string) => {
      events.push(type);
    },
    removeEventListener: (type: string) => {
      removed.push(type);
    },
  };
}

describe("createChat.setSession", () => {
  let chat: ChatController | null = null;

  afterEach(() => {
    chat?.disconnect();
    chat = null;
  });

  it("reuses the message list manager across session switches", () => {
    const container = makeContainer();
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => container as unknown as HTMLElement,
    });
    chat.setSession("session-a");
    chat.setSession("session-b");
    // A fresh manager per switch would re-attach the scroll listener each time;
    // the container must see it attached exactly once. (Counted, not compared
    // as a full array, so unrelated listeners do not break this.)
    expect(container.events.filter((e) => e === "scroll")).toHaveLength(1);
    expect(chat.sessionIdAtom()).toBe("session-b");
  });

  it("does not create a message list or set the session when the container is unmounted", () => {
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => null,
    });
    chat.setSession("session-a");
    expect(chat.sessionIdAtom()).toBeNull();
    expect(chat.messageListAtom()).toBeNull();
  });

  it("destroy detaches the scroll listener from the container", () => {
    const container = makeContainer();
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => container as unknown as HTMLElement,
    });
    chat.setSession("session-a");
    // handleAuthFailure drops the chat but the container outlives it; the
    // owner must be able to detach the manager's listener before that.
    chat.messageListAtom()?.destroy();
    expect(container.removed).toEqual(["scroll"]);
  });
});
