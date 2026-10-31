// Draft persistence (ui/draft.ts) against a fake Storage -- no mock.module.
import { describe, expect, it, jest } from "bun:test";
import {
  DRAFT_STORAGE_KEY,
  type DraftStorage,
  loadDraft,
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
