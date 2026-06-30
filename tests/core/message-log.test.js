import { describe, it, expect } from "bun:test";
import { MessageLog } from "../../src/core/context/message-log.js";
import { Message } from "../../src/core/context/message.js";

describe("MessageLog", () => {
  it("creates empty log", () => {
    const log = new MessageLog();
    expect(log.length).toBe(0);
    expect(log.getAll()).toEqual([]);
  });

  it("creates log with initial messages", () => {
    const m1 = new Message({ role: "user", content: "hello" });
    const m2 = new Message({ role: "assistant", content: "hi" });
    const log = new MessageLog([m1, m2]);
    expect(log.length).toBe(2);
  });

  describe("push()", () => {
    it("adds a message and returns new length", () => {
      const log = new MessageLog();
      const m = new Message({ role: "user", content: "hello" });
      const len = log.push(m);
      expect(len).toBe(1);
      expect(log.length).toBe(1);
    });

    it("throws when pushing non-Message", () => {
      const log = new MessageLog();
      expect(() => log.push({ role: "user", content: "hello" })).toThrow(
        "requires a Message instance",
      );
    });

    it("throws when pushing null", () => {
      const log = new MessageLog();
      expect(() => log.push(null)).toThrow("requires a Message instance");
    });
  });

  describe("replace()", () => {
    it("replaces all messages", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "old" }),
      ]);
      const newMsgs = [
        new Message({ role: "user", content: "new1" }),
        new Message({ role: "assistant", content: "new2" }),
      ];
      log.replace(newMsgs);
      expect(log.length).toBe(2);
      expect(log.at(0).content).toBe("new1");
    });

    it("throws when replacing with non-array", () => {
      const log = new MessageLog();
      expect(() => log.replace("not an array")).toThrow("requires an array");
    });

    it("throws when replacing with array containing non-Message", () => {
      const log = new MessageLog();
      expect(() =>
        log.replace([
          new Message({ role: "user", content: "ok" }),
          { role: "assistant", content: "bad" },
        ]),
      ).toThrow("element 1 is");
    });

    it("replaces with empty array", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "old" }),
      ]);
      log.replace([]);
      expect(log.length).toBe(0);
    });
  });

  describe("clear()", () => {
    it("removes all messages", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "hello" }),
        new Message({ role: "assistant", content: "hi" }),
      ]);
      log.clear();
      expect(log.length).toBe(0);
      expect(log.getAll()).toEqual([]);
    });
  });

  describe("at()", () => {
    it("returns message at index", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "first" }),
        new Message({ role: "assistant", content: "second" }),
      ]);
      expect(log.at(0).content).toBe("first");
      expect(log.at(1).content).toBe("second");
    });

    it("returns undefined for out-of-bounds index", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "only" }),
      ]);
      expect(log.at(5)).toBeUndefined();
    });
  });

  describe("getAll()", () => {
    it("returns a defensive copy", () => {
      const m1 = new Message({ role: "user", content: "hello" });
      const log = new MessageLog([m1]);
      const all = log.getAll();
      all.push(new Message({ role: "assistant", content: "hi" }));
      expect(log.length).toBe(1);
    });
  });

  describe("getSystem()", () => {
    it("returns only system messages", () => {
      const log = new MessageLog([
        new Message({ role: "system", content: "sys1" }),
        new Message({ role: "user", content: "user1" }),
        new Message({ role: "system", content: "sys2" }),
      ]);
      const sys = log.getSystem();
      expect(sys.length).toBe(2);
      expect(sys[0].role).toBe("system");
      expect(sys[1].role).toBe("system");
    });

    it("returns empty array when no system messages", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "hello" }),
      ]);
      expect(log.getSystem()).toEqual([]);
    });
  });

  describe("getNonSystem()", () => {
    it("returns non-system messages", () => {
      const log = new MessageLog([
        new Message({ role: "system", content: "sys" }),
        new Message({ role: "user", content: "user1" }),
        new Message({ role: "assistant", content: "assistant1" }),
      ]);
      const nonSys = log.getNonSystem();
      expect(nonSys.length).toBe(2);
      expect(nonSys[0].role).toBe("user");
    });
  });

  describe("getRecent()", () => {
    it("returns the last N messages", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "msg1" }),
        new Message({ role: "assistant", content: "msg2" }),
        new Message({ role: "user", content: "msg3" }),
      ]);
      const recent = log.getRecent(2);
      expect(recent.length).toBe(2);
      expect(recent[0].content).toBe("msg2");
      expect(recent[1].content).toBe("msg3");
    });

    it("returns all messages when N >= length", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "only" }),
      ]);
      const recent = log.getRecent(10);
      expect(recent.length).toBe(1);
    });
  });

  describe("slice()", () => {
    it("slices a portion of the message array", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "msg1" }),
        new Message({ role: "assistant", content: "msg2" }),
        new Message({ role: "user", content: "msg3" }),
      ]);
      const sliced = log.slice(1, 3);
      expect(sliced.length).toBe(2);
      expect(sliced[0].content).toBe("msg2");
    });

    it("slices with no arguments", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "msg1" }),
      ]);
      const sliced = log.slice();
      expect(sliced.length).toBe(1);
    });
  });

  describe("buildMessages()", () => {
    it("prepends system prompt when provided", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "hello" }),
      ]);
      const msgs = log.buildMessages("You are helpful.");
      expect(msgs.length).toBe(2);
      expect(msgs[0].role).toBe("system");
      expect(msgs[0].content).toBe("You are helpful.");
      expect(msgs[1].role).toBe("user");
    });

    it("returns copy without system prompt when null", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "hello" }),
      ]);
      const msgs = log.buildMessages(null);
      expect(msgs.length).toBe(1);
      expect(msgs[0].role).toBe("user");
    });
  });

  describe("toJSON()", () => {
    it("serializes messages to JSON objects", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "hello" }),
        new Message({ role: "assistant", content: "world" }),
      ]);
      const json = log.toJSON();
      expect(json.length).toBe(2);
      expect(json[0]).toEqual({ role: "user", content: "hello" });
      expect(json[1]).toEqual({ role: "assistant", content: "world" });
    });

    it("returns empty array for empty log", () => {
      const log = new MessageLog();
      expect(log.toJSON()).toEqual([]);
    });
  });

  describe("Symbol.iterator", () => {
    it("allows for-of iteration", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "first" }),
        new Message({ role: "assistant", content: "second" }),
      ]);
      const contents = [];
      for (const msg of log) {
        contents.push(msg.content);
      }
      expect(contents).toEqual(["first", "second"]);
    });

    it("allows spread operator", () => {
      const log = new MessageLog([
        new Message({ role: "user", content: "a" }),
        new Message({ role: "user", content: "b" }),
      ]);
      const arr = [...log];
      expect(arr.length).toBe(2);
    });
  });
});
