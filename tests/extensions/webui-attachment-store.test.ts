// Tests for webui/ui/attachment-store.ts. Storage is injected, so these run
// anywhere; the app-level lifecycle (hydrate on composer mount, persist on
// mutation) lives in tests/dom-helper/app.test.tsx.

import { describe, it, expect } from "bun:test";
import {
  ATTACHMENTS_STORAGE_KEY,
  loadAttachments,
  saveAttachments,
  type PendingAttachment,
} from "@extensions/webui/ui/attachment-store.ts";

function fakeStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const att = (over: Partial<PendingAttachment> = {}): PendingAttachment => ({
  id: "att-1",
  name: "a.txt",
  mimeType: "text/plain",
  size: 3,
  data: "QUJD",
  ...over,
});

describe("saveAttachments", () => {
  it("round-trips the payload without the per-boot id", () => {
    const s = fakeStore();
    saveAttachments([att()], s);
    const raw = JSON.parse(s.map.get(ATTACHMENTS_STORAGE_KEY)!);
    expect(raw).toEqual([{ name: "a.txt", mimeType: "text/plain", size: 3, data: "QUJD" }]);
    expect(loadAttachments(s)).toEqual([{ name: "a.txt", mimeType: "text/plain", size: 3, data: "QUJD" }]);
  });

  it("an empty set removes the key", () => {
    const s = fakeStore({ [ATTACHMENTS_STORAGE_KEY]: "[]" });
    saveAttachments([], s);
    expect(s.map.has(ATTACHMENTS_STORAGE_KEY)).toBe(false);
  });

  it("a throwing storage (quota / private mode) is swallowed, not propagated", () => {
    const s = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: () => {},
    };
    expect(() => saveAttachments([att()], s)).not.toThrow();
  });
});

describe("loadAttachments", () => {
  it("missing key and unparseable JSON load as empty", () => {
    expect(loadAttachments(fakeStore())).toEqual([]);
    expect(loadAttachments(fakeStore({ [ATTACHMENTS_STORAGE_KEY]: "{oops" }))).toEqual([]);
    expect(loadAttachments(fakeStore({ [ATTACHMENTS_STORAGE_KEY]: '{"a":1}' }))).toEqual([]);
  });

  it("drops malformed entries but keeps valid ones", () => {
    const s = fakeStore({
      [ATTACHMENTS_STORAGE_KEY]: JSON.stringify([
        att(),
        { name: "", mimeType: "x", size: 1, data: "AA==" },
        { name: "b", mimeType: "x", size: Number.NaN, data: "AA==" },
        { name: "b", mimeType: "x", size: 1, data: "" },
        null,
        "string",
      ]),
    });
    expect(loadAttachments(s)).toHaveLength(1);
    expect(loadAttachments(s)[0]!.name).toBe("a.txt");
  });
});
