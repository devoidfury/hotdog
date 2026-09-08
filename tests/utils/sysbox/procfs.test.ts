// procfs.ts tested against the test process itself: /proc/self/mem of our
// own pid is always readable (no ptrace/Yama obstacle to self), and real
// anonymous pages give us deterministic, owned addresses -- no mocks (repo
// rule) and no sandbox spawn needed for these pure-read functions.
//
// Note: bun:ffi `ptr()` is broken in bun 1.3.14 (returns a Cell; even
// String() throws, passing one to a "ptr" arg segfaults). Everything here
// passes addresses as u64 numbers and passes typed arrays where a pointer
// is expected -- both work.

import { describe, it, expect, afterAll } from "bun:test";
import { dlopen } from "bun:ffi";
import { openSync, closeSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePosix } from "node:path";
import {
  readChildBytes,
  readChildSaFamily,
  readChildCString,
  readChildArgv,
  resolveSyscallPath,
  expandFdLink,
  AT_FDCWD,
} from "../../../src/utils/sysbox/procfs.ts";

const libc = dlopen("libc.so.6", {
  mmap: { args: ["u64", "u64", "i32", "i32", "i32", "i64"], returns: "u64" },
  munmap: { args: ["u64", "u64"], returns: "i32" },
  memcpy: { args: ["u64", "ptr", "u64"], returns: "u64" },
});
const MAP_FAILED = 0xffffffffffffffffn;
const PAGES: { addr: bigint; bytes: bigint }[] = [];

/** Map n pages, optionally fill from a byte image, return the address. */
function mapPages(n: number, image?: Uint8Array): bigint {
  const bytes = BigInt(n * 4096);
  const addr = libc.symbols.mmap(0n, bytes, 3 /* RW */, 0x22 /* PRIVATE|ANON */, -1, 0n);
  if (addr === MAP_FAILED) throw new Error("mmap failed");
  PAGES.push({ addr, bytes });
  if (image) {
    if (libc.symbols.memcpy(addr, image, BigInt(image.length)) !== addr) {
      throw new Error("memcpy into page failed");
    }
  }
  return addr;
}

afterAll(() => {
  for (const { addr, bytes } of PAGES) libc.symbols.munmap(addr, bytes);
});

// Guaranteed-unmapped address: page 0 is never readable via /proc/pid/mem.
const UNMAPPED = 0x1000n;
// A pid that cannot exist (above any pid_max).
const BOGUS_PID = 999_999_999;

describe("readChildBytes", () => {
  it("reads own memory at an owned page", () => {
    const img = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const addr = mapPages(1, img);
    const got = readChildBytes(process.pid, addr, 4);
    expect(Array.from(got ?? [])).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("null on guards, unreadable pid, and unmapped address", () => {
    expect(readChildBytes(process.pid, 0n, 4)).toBeNull();
    expect(readChildBytes(process.pid, -1n, 4)).toBeNull();
    expect(readChildBytes(process.pid, 0x8000n, 0)).toBeNull();
    expect(readChildBytes(BOGUS_PID, 0x8000n, 4)).toBeNull();
    expect(readChildBytes(process.pid, UNMAPPED, 4)).toBeNull();
  });
});

describe("readChildSaFamily", () => {
  it("reads sa_family little-endian", () => {
    const img = new Uint8Array(4);
    img[0] = 2; // AF_INET
    img[1] = 0;
    const addr = mapPages(1, img);
    expect(readChildSaFamily(process.pid, addr)).toBe(2);
  });

  it("null when unreadable", () => {
    expect(readChildSaFamily(process.pid, UNMAPPED)).toBeNull();
  });
});

describe("readChildCString", () => {
  it("reads a NUL-terminated string", () => {
    const img = new Uint8Array(64);
    img.set(new TextEncoder().encode("hello"), 8); // img[13] = 0
    const addr = mapPages(1, img);
    expect(readChildCString(process.pid, addr + 8n)).toBe("hello");
  });

  it("empty string when NUL is first", () => {
    const addr = mapPages(1);
    expect(readChildCString(process.pid, addr)).toBe("");
  });

  it("null on unreadable pid, unmapped address, guards", () => {
    expect(readChildCString(BOGUS_PID, 0x8000n)).toBeNull();
    expect(readChildCString(process.pid, UNMAPPED)).toBeNull();
    expect(readChildCString(process.pid, 0n)).toBeNull();
  });

  it("null when no NUL appears within PATH_MAX", () => {
    // Two pages of 'a': the first 4096-byte chunk collects without a NUL,
    // the loop bound (PATH_MAX) then ends the read with no terminator.
    const addr = mapPages(2);
    libc.symbols.memcpy(addr, new Uint8Array(4096).fill(0x61), 4096n);
    expect(readChildCString(process.pid, addr)).toBeNull();
  });
});

describe("readChildArgv", () => {
  it("follows the pointer table to NULL", () => {
    const img = new Uint8Array(256);
    img.set(new TextEncoder().encode("one"), 64);
    img.set(new TextEncoder().encode("two"), 128);
    const addr = mapPages(1, img);
    const table = new BigUint64Array([addr + 64n, addr + 128n, 0n]);
    libc.symbols.memcpy(addr, table, 24n);
    expect(readChildArgv(process.pid, addr)).toEqual(["one", "two"]);
  });

  it("empty on unreadable pid or unmapped table", () => {
    expect(readChildArgv(BOGUS_PID, 0x8000n)).toEqual([]);
    expect(readChildArgv(process.pid, UNMAPPED)).toEqual([]);
    expect(readChildArgv(process.pid, 0n)).toEqual([]);
  });
});

describe("resolveSyscallPath", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sbx-procfs-"));

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("absolute paths normalize without touching /proc", () => {
    expect(resolveSyscallPath(BOGUS_PID, -100n, "/etc/../x")).toBe("/x");
    expect(resolveSyscallPath(BOGUS_PID, -100n, "")).toBeNull();
    expect(resolveSyscallPath(BOGUS_PID, -100n, null)).toBeNull();
  });

  it("AT_FDCWD (both representations) resolves against the /proc cwd", () => {
    const expectRel = resolvePosix(process.cwd(), "sub/file.txt");
    expect(resolveSyscallPath(process.pid, BigInt(AT_FDCWD), "sub/file.txt")).toBe(expectRel);
    expect(resolveSyscallPath(process.pid, 0xffffffffffffff9cn, "sub/file.txt")).toBe(expectRel);
  });

  it("numeric dirfd resolves through /proc/<pid>/fd/N", () => {
    const fd = openSync(dir, "r");
    try {
      expect(resolveSyscallPath(process.pid, BigInt(fd), "inside.txt")).toBe(join(dir, "inside.txt"));
    } finally {
      closeSync(fd);
    }
  });

  it("null for a bogus dirfd and for an unreadable pid", () => {
    expect(resolveSyscallPath(process.pid, 999_999n, "x")).toBeNull();
    expect(resolveSyscallPath(BOGUS_PID, BigInt(AT_FDCWD), "x")).toBeNull();
  });
});

describe("expandFdLink", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sbx-procfs-fd-"));

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("expands /dev/fd/N to the link target", () => {
    const fd = openSync(dir, "r");
    try {
      expect(expandFdLink(process.pid, `/dev/fd/${fd}`)).toBe(dir);
      expect(expandFdLink(process.pid, `/proc/self/fd/${fd}`)).toBe(dir);
      expect(expandFdLink(process.pid, `/proc/${process.pid}/fd/${fd}`)).toBe(dir);
    } finally {
      closeSync(fd);
    }
  });

  it("keeps the original path when the fd link is unreadable (denied upstream)", () => {
    expect(expandFdLink(process.pid, "/dev/fd/987654")).toBe("/dev/fd/987654");
  });

  it("non-fd paths pass through", () => {
    expect(expandFdLink(process.pid, "/workspace/.env")).toBe("/workspace/.env");
  });
});
