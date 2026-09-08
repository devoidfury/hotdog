// Packed string array for FFI transport to launcher.c.
//
// Layout: repeated [u32 LE len][bytes], where each entry's bytes are the
// UTF-8 encoding plus a trailing NUL and `len` counts the NUL. FFI cstring
// arguments would truncate at an embedded NUL and JS strings may contain one,
// so validation here rejects NUL explicitly rather than silently truncating.
// The C side (launcher.c unpack) enforces the same invariants.

const enc = new TextEncoder();

export const TLV_MAX_ITEM = 1 << 20; // 1 MiB per entry, sanity bound

export function packTlv(items: readonly string[]): Uint8Array {
  const encoded: Uint8Array[] = items.map((s, i) => {
    if (s.indexOf("\0") !== -1) {
      throw new Error(`tlv item ${i} contains an embedded NUL`);
    }
    const b = enc.encode(s);
    if (b.length + 1 > TLV_MAX_ITEM) {
      throw new Error(`tlv item ${i} exceeds ${TLV_MAX_ITEM} bytes`);
    }
    return b;
  });
  const total = encoded.reduce((a, b) => a + 4 + b.length + 1, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of encoded) {
    const len = b.length + 1;
    out[off] = len & 0xff;
    out[off + 1] = (len >> 8) & 0xff;
    out[off + 2] = (len >> 16) & 0xff;
    out[off + 3] = (len >>> 24) & 0xff;
    off += 4;
    out.set(b, off);
    off += b.length;
    out[off] = 0;
    off += 1;
  }
  return out;
}

/** Decode the exact layout produced by packTlv (for tests). */
export function unpackTlv(buf: Uint8Array): string[] {
  const dec = new TextDecoder();
  const out: string[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error("tlv: truncated length header");
    const len =
      buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! * 0x1000000);
    off += 4;
    if (len < 1 || off + len > buf.length) throw new Error("tlv: bad item length");
    if (buf[off + len - 1] !== 0) throw new Error("tlv: missing NUL terminator");
    out.push(dec.decode(buf.subarray(off, off + len - 1)));
    off += len;
  }
  return out;
}
