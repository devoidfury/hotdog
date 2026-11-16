// Draft persistence (ui/draft.ts) against a fake Storage -- no mock.module.
import { describe, expect, it, jest } from "bun:test";
import {
  DRAFT_STORAGE_KEY,
  DRAFT_CARET_STORAGE_KEY,
  type DraftStorage,
  loadDraft,
  loadDraftCaret,
  saveDraft,
  clearDraft,
  scheduleDraftSave,
  flushDraftSave,
  cancelDraftSave,
} from "@extensions/webui/ui/draft.ts";

class FakeStorage implements DraftStorage {
  readonly map = new Map<string, string>();
  writes = 0;

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.writes++;
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class ThrowingStorage implements DraftStorage {
  getItem(): string | null {
    throw new Error("SecurityError: storage access denied");
  }
  setItem(): void {
    throw new Error("SecurityError: storage access denied");
  }
  removeItem(): void {
    throw new Error("SecurityError: storage access denied");
  }
}

describe("save/load roundtrip", () => {
  it("persists under the house key and reads it back", () => {
    const s = new FakeStorage();
    saveDraft("half-typed thought", s);
    expect(s.map.get(DRAFT_STORAGE_KEY)).toBe("half-typed thought");
    expect(loadDraft(s)).toBe("half-typed thought");
  });

  it("load on an empty store returns null", () => {
    expect(loadDraft(new FakeStorage())).toBeNull();
  });
});

describe("save('') and clear semantics", () => {
  it("saving empty text removes the key instead of storing an empty string", () => {
    const s = new FakeStorage();
    saveDraft("draft", s);
    saveDraft("", s);
    expect(s.map.has(DRAFT_STORAGE_KEY)).toBe(false);
    expect(loadDraft(s)).toBeNull();
  });

  it("clearDraft removes the key", () => {
    const s = new FakeStorage();
    saveDraft("draft", s);
    clearDraft(s);
    expect(s.map.has(DRAFT_STORAGE_KEY)).toBe(false);
    expect(loadDraft(s)).toBeNull();
  });
});

describe("debounced scheduler", () => {
  it("coalesces rapid schedules into one save carrying the latest text", () => {
    jest.useFakeTimers();
    try {
      const s = new FakeStorage();
      scheduleDraftSave(() => "o", s);
      scheduleDraftSave(() => "on", s);
      scheduleDraftSave(() => "onion", s);
      jest.advanceTimersByTime(249);
      expect(s.writes).toBe(0);
      jest.advanceTimersByTime(1);
      expect(s.writes).toBe(1);
      expect(loadDraft(s)).toBe("onion");
    } finally {
      jest.useRealTimers();
    }
  });

  it("flush() writes immediately without waiting for the timer", () => {
    jest.useFakeTimers();
    try {
      const s = new FakeStorage();
      scheduleDraftSave(() => "typing", s);
      flushDraftSave();
      expect(s.writes).toBe(1);
      expect(loadDraft(s)).toBe("typing");
      // The already-fired save must not double-write when the timer would have elapsed.
      jest.advanceTimersByTime(1000);
      expect(s.writes).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("cancel() after schedule writes nothing (send must not resurrect a stale draft)", () => {
    jest.useFakeTimers();
    try {
      const s = new FakeStorage();
      scheduleDraftSave(() => "sent message", s);
      cancelDraftSave();
      jest.advanceTimersByTime(1000);
      expect(s.writes).toBe(0);
      // A later unload flush also finds nothing pending.
      flushDraftSave();
      expect(s.writes).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("storage failures never propagate", () => {
  const s = new ThrowingStorage();

  it("loadDraft swallows getItem throwing", () => {
    expect(loadDraft(s)).toBeNull();
  });

  it("saveDraft and clearDraft swallow setItem/removeItem throwing", () => {
    expect(() => saveDraft("text", s)).not.toThrow();
    expect(() => saveDraft("", s)).not.toThrow();
    expect(() => clearDraft(s)).not.toThrow();
  });

  it("scheduled and flushed saves swallow throwing storage", () => {
    jest.useFakeTimers();
    try {
      scheduleDraftSave(() => "text", s);
      jest.advanceTimersByTime(250);
      flushDraftSave();
      scheduleDraftSave(() => "text", s);
      expect(() => flushDraftSave()).not.toThrow();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── Caret + focus record (saved alongside the text) ────
// Sibling key beside the draft: the text wire format stays raw, the caret
// rides its own strict-decoded record. Written ONLY through the debounced
// save path (the composer's own seam) -- the same coalesced snapshot, so
// text and caret can never disagree.

describe("caret record: debounced roundtrip", () => {
  it("the debounced save writes text + caret + marker together", () => {
    jest.useFakeTimers();
    try {
      const s = new FakeStorage();
      scheduleDraftSave(() => "half typed", s, () => ({ start: 4, end: 9, focused: true }));
      jest.advanceTimersByTime(250);
      expect(s.map.get(DRAFT_STORAGE_KEY)).toBe("half typed");
      expect(loadDraftCaret(s)).toEqual({ start: 4, end: 9, focused: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it("coalesced schedules carry the LATEST text and the LATEST caret", () => {
    jest.useFakeTimers();
    try {
      const s = new FakeStorage();
      let text = "o";
      let caret = { start: 1, end: 1, focused: false };
      scheduleDraftSave(() => text, s, () => caret);
      text = "on";
      caret = { start: 2, end: 2, focused: true };
      scheduleDraftSave(() => text, s, () => caret);
      jest.advanceTimersByTime(250);
      expect(loadDraft(s)).toBe("on");
      expect(loadDraftCaret(s)).toEqual({ start: 2, end: 2, focused: true });
      expect(s.writes).toBe(2); // one text key + one caret key, one coalesced write
    } finally {
      jest.useRealTimers();
    }
  });

  it("the unload flush carries the caret too (fire-time read, latest posture)", () => {
    jest.useFakeTimers();
    try {
      const s = new FakeStorage();
      let focused = true;
      scheduleDraftSave(() => "typo fixed", s, () => ({ start: 3, end: 3, focused }));
      focused = false; // the user clicked away before the page died
      flushDraftSave();
      expect(loadDraft(s)).toBe("typo fixed");
      expect(loadDraftCaret(s)).toEqual({ start: 3, end: 3, focused: false });
    } finally {
      jest.useRealTimers();
    }
  });

  it("empty text takes the caret record with the draft", () => {
    jest.useFakeTimers();
    try {
      const s = new FakeStorage();
      scheduleDraftSave(() => "typed", s, () => ({ start: 2, end: 2, focused: true }));
      jest.advanceTimersByTime(250);
      expect(loadDraftCaret(s)).not.toBeNull();
      scheduleDraftSave(() => "", s, () => ({ start: 2, end: 2, focused: true }));
      jest.advanceTimersByTime(250);
      expect(s.map.has(DRAFT_STORAGE_KEY)).toBe(false);
      expect(s.map.has(DRAFT_CARET_STORAGE_KEY)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a caller without a caret getter leaves the caret record alone", () => {
    jest.useFakeTimers();
    try {
      const s = new FakeStorage();
      scheduleDraftSave(() => "typed", s, () => ({ start: 2, end: 2, focused: true }));
      jest.advanceTimersByTime(250);
      scheduleDraftSave(() => "retyped", s); // no getter: text-only write
      jest.advanceTimersByTime(250);
      expect(loadDraft(s)).toBe("retyped");
      expect(loadDraftCaret(s)).toEqual({ start: 2, end: 2, focused: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it("cancelDraftSave drops the caret write with the text write", () => {
    jest.useFakeTimers();
    try {
      const s = new FakeStorage();
      scheduleDraftSave(() => "sent", s, () => ({ start: 1, end: 1, focused: true }));
      cancelDraftSave();
      jest.advanceTimersByTime(1000);
      flushDraftSave();
      expect(s.writes).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("caret record: strict decode + clear + throwing storage", () => {
  it("loadDraftCaret: missing key means no restore", () => {
    expect(loadDraftCaret(new FakeStorage())).toBeNull();
  });

  it("garbage records decode to null (a wrong caret is worse than none)", () => {
    const junk = ["not json", "42", '"a string"', "null", "[1,2]", "{}", '{"s":1}', '{"s":1,"e":0}', '{"s":-1,"e":2}', '{"s":1.5,"e":2}', '{"s":"1","e":"2"}'];
    for (const raw of junk) {
      const s = new FakeStorage();
      s.map.set(DRAFT_CARET_STORAGE_KEY, raw);
      expect(loadDraftCaret(s)).toBeNull();
    }
  });

  it("focused is strictly the 1 marker: absent/0/garbage reads false", () => {
    for (const f of [undefined, 0, true, "1", 2]) {
      const s = new FakeStorage();
      s.map.set(DRAFT_CARET_STORAGE_KEY, JSON.stringify({ s: 1, e: 2, ...(f === undefined ? {} : { f }) }));
      expect(loadDraftCaret(s)).toEqual({ start: 1, end: 2, focused: f === 1 });
    }
  });

  it("clearDraft removes BOTH keys", () => {
    const s = new FakeStorage();
    saveDraft("text", s);
    s.map.set(DRAFT_CARET_STORAGE_KEY, JSON.stringify({ s: 1, e: 1, f: 1 }));
    clearDraft(s);
    expect(s.map.has(DRAFT_STORAGE_KEY)).toBe(false);
    expect(s.map.has(DRAFT_CARET_STORAGE_KEY)).toBe(false);
  });

  it("a throwing storage swallows every caret path (private-mode Safari)", () => {
    jest.useFakeTimers();
    try {
      const s = new ThrowingStorage();
      expect(loadDraftCaret(s)).toBeNull();
      scheduleDraftSave(() => "text", s, () => ({ start: 1, end: 1, focused: true }));
      expect(() => jest.advanceTimersByTime(250)).not.toThrow();
      scheduleDraftSave(() => "text", s, () => ({ start: 1, end: 1, focused: true }));
      expect(() => flushDraftSave()).not.toThrow();
    } finally {
      jest.useRealTimers();
    }
  });
});
