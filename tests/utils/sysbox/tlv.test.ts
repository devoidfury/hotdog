import { describe, it, expect } from "bun:test";
import { packTlv, unpackTlv } from "../../../src/utils/sysbox/tlv.ts";

describe("packTlv / unpackTlv", () => {
  it("round-trips empty and simple items", () => {
    expect(unpackTlv(packTlv([]))).toEqual([]);
    expect(unpackTlv(packTlv(["a", "b", "hello world"]))).toEqual(["a", "b", "hello world"]);
  });

  it("round-trips empty strings and unicode (CJK/emoji)", () => {
    const items = ["", "ключ", "日本語のコマンド", "emoji 🌭 done"];
    expect(unpackTlv(packTlv(items))).toEqual(items);
  });

  it("length header counts bytes including the NUL terminator", () => {
    const buf = packTlv(["abc"]);
    expect(buf.length).toBe(4 + 4); // u32 len(4) + "abc\0"
    expect(buf[0]).toBe(4);
  });

  it("rejects embedded NUL instead of silently truncating", () => {
    expect(() => packTlv(["ok"])).not.toThrow();
    expect(() => packTlv(["bad\0value"])).toThrow(/NUL/);
  });

  it("unpack rejects malformed layouts", () => {
    expect(() => unpackTlv(new Uint8Array([1, 2]))).toThrow(/truncated/);
    // len runs past the buffer
    expect(() => unpackTlv(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0]))).toThrow(/bad item length/);
    // missing NUL terminator
    expect(() => unpackTlv(new Uint8Array([3, 0, 0, 0, 0x61, 0x62, 0x63]))).toThrow(/NUL/);
  });
});
