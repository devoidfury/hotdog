// Fuzz suite for the fetch tool's SSRF guard and content-type boundary.
//
// Load-bearing invariant: no encoding trick makes a private/loopback/reserved
// address pass the guard. The intended policy is restated below as an oracle,
// independently of isPrivateAddress; every generated address is checked in
// both directions (private MUST be flagged; genuinely public must not be
// over-blocked). The oracle also runs on the URL-normalized hostname, exactly
// the string parseArgs/fetchWithSafeRedirects hand to assertPublicHost.
//
// Where the source and its own docs disagree, the case gets verdict "gap":
// never asserted in either direction, only tallied (see run notes).
//
// No network requests anywhere: assertPublicHost is only fed inputs where
// isIP() !== 0, which short-circuit before any DNS lookup.

import { describe, it, expect } from "bun:test";
import { isIP } from "node:net";
import {
  isPrivateAddress,
  assertPublicHost,
  imageMimeFor,
  withDefaultAccept,
} from "@extensions/fetch-tool/index.ts";
import { makeRng, type Rng } from "../fuzz/prng.ts";

// ── Transcribed policy oracle ───────────────────────────────────────

type Verdict = "private" | "public" | "gap";

// Refused v4 ranges (from the tool description + in-source comments; the
// oracle is written as CIDR intent, not as the implementation's if-chain).
const V4_REFUSED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // unspecified / "this network"
  ["10.0.0.0", 8], // RFC1918
  ["127.0.0.0", 8], // loopback
  ["100.64.0.0", 10], // CGNAT
  ["172.16.0.0", 12], // RFC1918
  ["169.254.0.0", 16], // link-local (cloud metadata)
  ["192.0.0.0", 24], // IETF Protocol Assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 anycast relay (RFC 7526 deprecated prefix)
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast (SSDP/mDNS LAN targets)
  ["240.0.0.0", 4], // reserved + broadcast
];

function toU32(p: readonly number[]): number {
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

function inCidr(n: number, base: string, bits: number): boolean {
  const b = toU32(base.split(".").map(Number));
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) === (b & mask);
}

// Canonical dotted-quad only: leading-zero octets are ambiguous (octal in
// inet_aton, domain-safe in WHATWG) and count as "not a clean public IP".
function parseStrictV4(s: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  const parts: number[] = [];
  for (const piece of s.split(".")) {
    if (piece.length > 1 && piece[0] === "0") return null;
    const n = Number(piece);
    if (n > 255) return null;
    parts.push(n);
  }
  return parts;
}

function v4Verdict(n: number): Verdict {
  for (const [base, bits] of V4_REFUSED) if (inCidr(n, base, bits)) return "private";
  return "public";
}

interface ParsedV6 {
  groups: number[]; // exactly 8, 16-bit each
  dotted: boolean; // text carried an embedded dotted IPv4 quad
}

function parseV6(s: string): ParsedV6 | null {
  const pct = s.indexOf("%");
  // A trailing delimiter with an empty zone ("...::%") is rejected by the
  // parsers, so the oracle fails closed on it too; delimiter-only zones
  // are otherwise inert.
  if (pct >= 0 && pct === s.length - 1) return null;
  const bare = pct >= 0 ? s.slice(0, pct) : s;
  if (!bare.includes(":")) return null;
  const group = (t: string): number | null =>
    /^[0-9a-fA-F]{1,4}$/.test(t) ? parseInt(t, 16) : null;

  // Right-hand side: hex groups, optionally ending in a dotted quad.
  const splitTail = (t: string): { groups: number[]; dotted: boolean } | null => {
    if (t === "") return { groups: [], dotted: false };
    const li = t.lastIndexOf(":");
    const last = li < 0 ? t : t.slice(li + 1);
    const headPart = li < 0 ? "" : t.slice(0, li);
    let groups: number[];
    let dotted = false;
    if (last.includes(".")) {
      const v4 = parseStrictV4(last);
      if (!v4) return null;
      groups = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
      dotted = true;
    } else {
      const g = group(last);
      if (g === null) return null;
      groups = [g];
    }
    if (headPart !== "") {
      const gs: number[] = [];
      for (const p of headPart.split(":")) {
        const g = group(p);
        if (g === null) return null;
        gs.push(g);
      }
      groups = [...gs, ...groups];
    }
    return { groups, dotted };
  };

  const dc = bare.indexOf("::");
  if (dc >= 0 && bare.indexOf("::", dc + 1) >= 0) return null;
  if (dc >= 0) {
    const headText = bare.slice(0, dc);
    if (headText.includes(".")) return null; // BSD leading embedded v4: invalid
    const head: number[] = [];
    if (headText !== "") {
      for (const p of headText.split(":")) {
        const g = group(p);
        if (g === null) return null;
        head.push(g);
      }
    }
    const tail = splitTail(bare.slice(dc + 2));
    if (!tail) return null;
    if (head.length + tail.groups.length > 7) return null; // "::" must elide >= 1 group
    const zeros = Array.from({ length: 8 - head.length - tail.groups.length }, () => 0);
    return { groups: [...head, ...zeros, ...tail.groups], dotted: tail.dotted };
  }
  const t = splitTail(bare);
  if (!t || t.groups.length !== 8) return null;
  return t;
}

function v6Verdict(g: readonly number[], dotted: boolean): Verdict {
  const zero = (i: number) => g[i] === 0;
  if (g.every((x) => x === 0)) return "private"; // :: unspecified
  if (zero(0) && zero(1) && zero(2) && zero(3) && zero(4) && zero(5) && zero(6) && g[7] === 1) {
    return "private"; // ::1 loopback
  }
  if (zero(0) && zero(1) && zero(2) && zero(3) && zero(4) && (g[5] === 0xffff || g[5] === 0)) {
    // IPv4-mapped ::ffff:x.y and deprecated IPv4-compatible ::x.y carry a v4
    // address in the low 32 bits; it runs the v4 policy.
    const v = v4Verdict((((g[6]! << 16) | g[7]!) >>> 0));
    if (v === "private") return "private";
    // Dotted-embedded text always fails closed in the classifier (expandIpv6
    // rejects the dotted piece before the embedded check), so a "public"
    // reading here is a doc-vs-code gap; see run notes.
    return dotted ? "gap" : v;
  }
  if (
    zero(0) && zero(1) && zero(2) && zero(3) && g[4] === 0xffff && g[5] === 0
  ) {
    return "private"; // ::ffff:0:0/96 translator-local, unroutable, refused whole
  }
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "private"; // documentation
  if (g[0] === 0x2002) return "private"; // 6to4, whole prefix
  if (g[0] === 0x0064 && g[1] === 0xff9b) {
    // Comment claims 64:ff9b::/96 NAT64; the code checks two groups (/32).
    // Only the /96 is asserted; the /32 remainder is a doc/code gap.
    return (g[2]! | g[3]! | g[4]! | g[5]!) === 0 ? "private" : "gap";
  }
  if (g[0] === 0x2001 && g[1] === 0x0000) return "private"; // Teredo, whole /32
  if ((g[0]! & 0xff00) === 0xff00) return "private"; // multicast
  if ((g[0]! & 0xffc0) === 0xfe80) return "private"; // link-local
  if ((g[0]! & 0xfe00) === 0xfc00) return "private"; // unique-local
  // Dotted-embedded forms never read as public out of the classifier (it
  // fails closed before any policy check), so any public-looking verdict on
  // such text is the known fail-closed gap.
  return dotted ? "gap" : "public";
}

// Oracle: what the guard is supposed to say about raw address text.
function oracleAddress(s: string): Verdict {
  const v4 = parseStrictV4(s);
  if (v4) return v4Verdict(toU32(v4));
  const v6 = parseV6(s);
  if (!v6) return "private"; // fail closed: "not a clean public IP counts as private"
  return v6Verdict(v6.groups, v6.dotted);
}

// ── Corpus: address pools and encoding renderers ────────────────────

const V4_PRIVATE: number[][] = [
  [0, 0, 0, 0], [0, 255, 255, 255], [10, 0, 0, 0], [10, 255, 255, 255],
  [100, 64, 0, 0], [100, 127, 255, 255], [127, 0, 0, 1], [127, 255, 255, 255],
  [169, 254, 169, 254], [172, 16, 0, 0], [172, 31, 255, 255], [192, 0, 0, 1],
  [192, 0, 2, 1], [192, 88, 99, 1], [192, 168, 1, 1], [198, 18, 0, 1],
  [198, 19, 255, 255], [198, 51, 100, 1], [203, 0, 113, 1], [240, 0, 0, 0],
  [255, 255, 255, 255],
];
const V4_PUBLIC: number[][] = [
  [1, 1, 1, 1], [8, 8, 8, 8], [9, 9, 9, 9], [1, 0, 0, 1], [93, 184, 216, 34],
  [104, 16, 0, 1], [140, 82, 114, 4], [100, 63, 255, 255], [100, 128, 0, 1],
  [172, 15, 255, 255], [172, 32, 0, 1], [192, 0, 1, 1], [192, 0, 3, 1],
  [192, 88, 98, 255], [198, 17, 255, 255], [198, 20, 0, 1], [203, 0, 114, 1],
  [223, 255, 255, 255],
];
const V4_MULTICAST_REFUSED: number[][] = [
  [224, 0, 0, 1], [239, 255, 255, 250], [224, 0, 0, 251], [231, 69, 176, 1],
];

const V6_PRIVATE: number[][] = [
  [0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 1],
  [0xfe80, 0, 0, 0, 0, 0, 0, 1], [0xfe80, 0x1234, 0, 0, 0, 0, 0, 0xabcd],
  [0xfebf, 0xffff, 0, 0, 0, 0, 0, 1], // top of fe80::/10
  [0xfc00, 0, 0, 0, 0, 0, 0, 1], [0xfd12, 0x3456, 0, 0, 0, 0, 0, 1],
  [0xfdff, 0, 0, 0, 0, 0, 0, 1], // top of fc00::/7
  [0xff02, 0, 0, 0, 0, 0, 0, 1], [0xff0e, 0, 0, 0, 0, 0, 0, 1],
  [0xffff, 0, 0, 0, 0, 0, 0, 2], // top of ff00::/8
  [0x2001, 0x0db8, 0, 0, 0, 0, 0, 1],
  [0x2002, 0x7f00, 0x0001, 0, 0, 0, 0, 0], // 6to4 embedding 127.0.0.1
  [0x2002, 0x0a00, 0x0001, 0, 0, 0, 0, 0],
  [0x0064, 0xff9b, 0, 0, 0, 0, 0x0808, 0x0808], // NAT64 /96
  [0x2001, 0, 0x4500, 0, 0, 0, 0x7f00, 1], // Teredo /32
  [0x2001, 0, 0, 0, 0, 0, 0x7f00, 1],
  [0, 0, 0, 0, 0xffff, 0, 0x7f00, 1], // ::ffff:0:0/96 embedding loopback
  [0, 0, 0, 0, 0xffff, 0, 0x0808, 0x0808], // same /96 with public v4: prefix refused
  [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1], // mapped loopback
  [0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001],
  [0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe],
  [0, 0, 0, 0, 0, 0xffff, 0, 0], // mapped 0.0.0.0
  [0, 0, 0, 0, 0, 0xffff, 0xffff, 0xffff],
  [0, 0, 0, 0, 0, 0, 0x7f00, 1], // IPv4-compatible loopback (fix regression)
  [0, 0, 0, 0, 0, 0, 0x0a00, 0x0001],
  [0, 0, 0, 0, 0, 0, 0xffff, 1], // 255.255.0.1
  [0, 0, 0, 0, 0, 0, 2, 0], // ::2 == 0.0.2.0
];
const V6_PUBLIC: number[][] = [
  [0x2606, 0x4700, 0x4700, 0, 0, 0, 0x1111, 0x1111],
  [0x2001, 0x4860, 0x4860, 0, 0, 0, 0x8888, 0x8888],
  [0x2001, 0x0db9, 0, 0, 0, 0, 0, 1],
  [0x0064, 0xff9c, 0, 0, 0, 0, 0, 1],
  [0x2620, 0xfee7, 0, 0, 0, 0, 0xdead, 0xbeef],
  [0, 0, 0, 0, 0, 0, 0x0808, 0x0808], // IPv4-compatible 8.8.8.8 stays public
  [0, 0, 0, 0, 0xffff, 0, 0x0808, 0x0808],
  [0xfe7f, 0xffff, 0, 0, 0, 0, 0, 1], // just below fe80::/10
];
const V6_GAP: number[][] = [
  [0x0064, 0xff9b, 0x0002, 0, 0, 0, 0, 1], // 64:ff9b::/32 outside the claimed /96
];

const hx = (n: number, w: number) => n.toString(16).padStart(w, "0");

// Every v4 textual rendering the attack surface covers.
function v4Renders(p: readonly number[]): string[] {
  const [a, b, c, d] = p as [number, number, number, number];
  const dotted = `${a}.${b}.${c}.${d}`;
  const packed = a * 0x1000000 + b * 0x10000 + c * 0x100 + d;
  const g6 = (a << 8) | b;
  const g7 = (c << 8) | d;
  return [
    dotted,
    `${a}.${b}.${c * 0x100 + d}`, // abbreviated 3-part
    `${a}.${b * 0x10000 + c * 0x100 + d}`, // abbreviated 2-part (127.1 style)
    String(packed), // decimal-packed
    "0" + packed.toString(8), // octal-packed (017700000001 style)
    "0x" + packed.toString(16), // hex-packed
    `0${a.toString(8)}.0${b.toString(8)}.0${c.toString(8)}.0${d.toString(8)}`, // octet octal
    `0x${hx(a, 1)}.0x${hx(b, 1)}.0x${hx(c, 1)}.0x${hx(d, 1)}`, // octet hex
    `00${a}.0${b}.${c}.${d}`, // leading-zero octet ambiguity
    dotted + ".", // trailing dot
    ` ${dotted}`, `${dotted}\t`, `\r\n${dotted}\n`, // whitespace wraps
    `::ffff:${hx(g6, 1)}:${hx(g7, 1)}`, // v6-mapped numeric
    `::FFFF:${hx(g6, 4).toUpperCase()}:${hx(g7, 4).toUpperCase()}`, // mapped, padded upper
    `::ffff:${dotted}`, // v6-mapped dotted
    `::${hx(g6, 1)}:${hx(g7, 1)}`, // IPv4-compatible numeric
    `::${dotted}`, // IPv4-compatible dotted (legacy)
    `0:0:0:0:0:ffff:${hx(g6, 4)}:${hx(g7, 4)}`, // full uncompressed mapped
    `0:0:0:0:0:0:${hx(g6, 4)}:${hx(g7, 4)}`, // full uncompressed compatible
  ];
}

function compressV6(g: readonly number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && g[i] === 0) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart > bestLen) {
        bestStart = runStart;
        bestLen = i - runStart;
      }
      runStart = -1;
    }
  }
  if (bestLen < 1) return g.map((x) => hx(x, 1)).join(":");
  const head = g.slice(0, bestStart).map((x) => hx(x, 1)).join(":");
  const tail = g.slice(bestStart + bestLen).map((x) => hx(x, 1)).join(":");
  return `${head}::${tail}`;
}

function v6Renders(g: readonly number[]): string[] {
  const full = g.map((x) => hx(x, 1)).join(":");
  const fullPadded = g.map((x) => hx(x, 4)).join(":");
  const comp = compressV6(g);
  return [
    full,
    fullPadded,
    comp,
    comp.toUpperCase(),
    fullPadded.toUpperCase(),
    comp + "%eth0",
    comp + "%1",
    comp + "%WLAN0",
  ];
}

const JUNK = [
  "", " ", "\t\n", "::::", ":::::", "1.2.3.256", "1.2.3.4.5", ".1.2.3.4",
  "999.999.999.999", "-1.0.0.1", "1.2.3.4:80", "user@127.0.0.1", "[::1]",
  "[127.0.0.1]", "http://127.0.0.1", "127.0.0.1/x", "ｆｅ８０::", "１２７.0.0.1",
  "١٢٧.٠.٠.١", "127\u200b.0.0.1", "1..2", "0x7f", "2130706433.", "07f.0.0.1",
  "0x0a.0.0.1", "::ffff:", "::ffff:0x7f.0.0.1", "1:2:3:4:5:6:7:8:9",
  "12345:::1", "fe80::1%eth0%foo", "1.2.3.4%eth0", "%eth0", "::%eth0",
  "0:0:0:0:ffff:0:7f00:1", "0:0:0::ffff:7f00:1", "a".repeat(10000),
  "1.2.3.4" + "x".repeat(10000), "\u0000127.0.0.1", "127.0.0.1\u0000",
];

// ── Shared checker ──────────────────────────────────────────────────

interface Tally {
  checked: number;
  gaps: string[];
  failures: string[];
}

function checkAddress(tally: Tally, text: string, tag: string): void {
  tally.checked++;
  let got: boolean;
  try {
    got = isPrivateAddress(text);
  } catch (e) {
    tally.failures.push(`${tag} THREW on ${JSON.stringify(text)}: ${e}`);
    return;
  }
  const want = oracleAddress(text);
  if (want === "gap") {
    if (tally.gaps.length < 200) tally.gaps.push(text);
    return;
  }
  if (got !== (want === "private")) {
    tally.failures.push(
      `${tag} ${JSON.stringify(text)}: isPrivateAddress=${got}, oracle=${want}`,
    );
  }
}

// Host extraction exactly as parseArgs / fetchWithSafeRedirects do it.
function seamHost(text: string): string | null {
  let u: URL;
  try {
    u = new URL(`http://${text}/`);
  } catch {
    return null;
  }
  return u.hostname.replace(/^\[|\]$/g, "");
}

function* allAddressTexts(): Generator<{ text: string; tag: string }> {
  for (const p of V4_PRIVATE) for (const t of v4Renders(p)) yield { text: t, tag: "v4-private" };
  for (const p of V4_PUBLIC) for (const t of v4Renders(p)) yield { text: t, tag: "v4-public" };
  for (const p of V4_MULTICAST_REFUSED) for (const t of v4Renders(p)) yield { text: t, tag: "v4-mcast" };
  for (const g of V6_PRIVATE) for (const t of v6Renders(g)) yield { text: t, tag: "v6-private" };
  for (const g of V6_PUBLIC) for (const t of v6Renders(g)) yield { text: t, tag: "v6-public" };
  for (const g of V6_GAP) for (const t of v6Renders(g)) yield { text: t, tag: "v6-gap" };
  for (const j of JUNK) yield { text: j, tag: "junk" };
}

// ── Direct classifier fuzz ──────────────────────────────────────────

describe("fetch-ssrf isPrivateAddress fuzz", () => {
  const tally: Tally = { checked: 0, gaps: [], failures: [] };

  it("curated pool x encoding grid agrees with the policy oracle", () => {
    for (const { text, tag } of allAddressTexts()) checkAddress(tally, text, tag);
  });

  it("seeded random addresses in every rendering agree with the oracle", () => {
    const rng = makeRng(0x53535231); // "SSR1"
    for (let i = 0; i < 220; i++) {
      if (rng.bool(0.55)) {
        checkAll(tally, v4Renders(Array.from(rng.bytes(4))), "rand-v4");
      } else {
        const g0 = rng.pick([
          0, 0x2001, 0x2002, 0x0064, 0xfe80, 0xfd00, 0xfebf, 0x00fc, 0xff00,
          0x2606, rng.next() & 0xffff,
        ]);
        const rest = [g0];
        for (let k = 1; k < 8; k++) {
          rest.push(rng.pick([0, 1, 0xffff, 0x7f00, 0x0808, rng.next() & 0xffff]));
        }
        checkAll(tally, v6Renders(rest), "rand-v6");
      }
    }
  });

  it("mutated encodings (case, zones, truncation, injected chars) agree with the oracle", () => {
    const rng = makeRng(0x53535232); // "SSR2"
    const sources = [...allAddressTexts()];
    const muts: Array<(r: Rng, s: string) => string> = [
      (r, s) => s + r.pick([".", ":", "%eth0", " ", "\t", "x", "/"]),
      (r, s) => r.pick([" ", "\t", "\n", "\u200b", "0", ":"]) + s,
      (_r, s) => s.replace(".", "::"),
      (_r, s) => s.replace(".", "%2e"),
      (_r, s) => s.replace(":", "%3a"),
      (_r, s) => "[" + s + "]",
      (_r, s) => s.toUpperCase(),
      (_r, s) => s.replace(/^:/, "0000:"),
      (_r, s) => s.replace(/^0+/, "0"),
      (_r, s) => s.slice(1),
      (_r, s) => s.slice(0, s.length - 1),
    ];
    for (let i = 0; i < 500; i++) {
      let s = rng.pick(sources).text;
      const n = 1 + rng.int(3);
      for (let k = 0; k < n; k++) s = rng.pick(muts)(rng, s);
      checkAddress(tally, s, "mutant");
    }
  });

  it("agreement tallies hold with zero failures", () => {
    // Corpus must actually exercise the remaining gap families
    // (dotted-embedded public, NAT64 /32-minus-/96, JS-trim mime nit).
    // Multicast v4 left the gap list 2026-10-25 when the guard learned 224/4.
    expect(tally.gaps.length).toBeGreaterThan(10);
    expect(tally.failures).toEqual([]);
  });
});

describe("fetch-ssrf tightening (owner ruling 2026-10-25)", () => {
  // 224.0.0.0/4 was the batch-2 fuzz run's W1 flag: intended policy refused
  // multicast, the guard only checked ff00::/8. Now refused both sides.
  // ::ffff:0:0/96 (RFC 6052 translator-local) serializes past the mapped
  // unwrap as ::ffff:0:x:y; unroutable prefix, refused whole.
  const REFUSED = [
    "224.0.0.1", "231.69.176.1", "239.255.255.250", "239.0.0.1",
    "::ffff:0:7f00:1", "::ffff:0:127.0.0.1", "0:0:0:0:ffff:0:7f00:1",
    "::ffff:0:808:808",
  ];
  for (const text of REFUSED) {
    it(`refuses ${text}`, () => {
      expect(isPrivateAddress(text)).toBe(true);
    });
  }
});

function checkAll(tally: Tally, texts: string[], tag: string): void {
  for (const t of texts) checkAddress(tally, t, tag);
}

// ── URL seam: what the guard actually receives after URL parsing ────

describe("fetch-ssrf URL hostname seam", () => {
  const tally: Tally = { checked: 0, gaps: [], failures: [] };
  let parseFails = 0;

  it("URL-normalized hostnames of the whole corpus agree with the oracle", () => {
    for (const { text, tag } of allAddressTexts()) {
      const host = seamHost(text);
      if (host === null) {
        parseFails++;
        continue;
      }
      checkAddress(tally, host, `url(${tag})`);
    }
    const rng = makeRng(0x55524c31); // "URL1"
    for (let i = 0; i < 150; i++) {
      const p = Array.from(rng.bytes(4));
      for (const t of v4Renders(p)) {
        const host = seamHost(t);
        if (host === null) {
          parseFails++;
          continue;
        }
        checkAddress(tally, host, "url(rand-v4)");
      }
    }
    console.log(
      `[fetch-ssrf-fuzz] seam checked=${tally.checked}, unparsable=${parseFails}, gaps=${tally.gaps.length}`,
    ); // informational; console is silenced by the tests/setup.ts preload
    expect(tally.failures).toEqual([]);
  });

  it("packed/octal/hex/abbreviated encodings of private v4 are normalized and flagged", () => {
    for (const t of [
      "2130706433", "017700000001", "0x7f000001", "127.1", "127.0.1",
      "0x7f.1", "127.0.0.01", "0x7f000000001", "127。0.0.1", "%31%32%37.0.0.1",
      "167772161", "0xA9FEA9FE", "10.1", "0251.254.0.1", "3232235521",
    ]) {
      const host = seamHost(t);
      if (host === null) continue; // unparsable = refused by parseArgs
      expect(isPrivateAddress(host)).toBe(true);
    }
  });

  it("public hosts survive the URL seam unflagged", () => {
    for (const t of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "example.com",
      "[64:ff9c::1]", "[2001:4860:4860::8888]"]) {
      const host = seamHost(t);
      if (host === null) continue;
      if (oracleAddress(host) === "private" || oracleAddress(host) === "gap") continue;
      expect(isPrivateAddress(host)).toBe(false);
    }
  });
});

// ── assertPublicHost literal seam (isIP short-circuits, never DNS) ──

describe("fetch-ssrf assertPublicHost literal seam", () => {
  it("IP literals get exactly the oracle verdict from the gate", async () => {
    const failures: string[] = [];
    const candidates: string[] = [];
    for (const { text } of allAddressTexts()) candidates.push(text);
    for (const text of candidates) {
      if (isIP(text) === 0) continue; // non-literals would hit DNS; out of scope
      const want = oracleAddress(text);
      if (want === "gap") continue;
      const err = await assertPublicHost(text);
      const gotPrivate = err !== null;
      if (gotPrivate !== (want === "private")) {
        failures.push(`${JSON.stringify(text)}: gate=${gotPrivate ? "blocked" : "allowed"}, oracle=${want}`);
      }
      if (gotPrivate) expect(err).toContain("private or reserved");
    }
    expect(failures).toEqual([]);
  });
});

// ── IPv4-compatible ::/96 regression (fuzz-exposed product fix) ─────
// Before the fix, isPrivateAddress("::7f00:1") === false, and Bun's URL
// parser rewrites http://[::127.0.0.1]/ to exactly that hostname, so the
// numeric IPv4-compatible form of loopback slipped past the guard.

describe("fetch-ssrf IPv4-compatible ::/96 regression", () => {
  it("numeric IPv4-compatible forms of private v4 are refused", () => {
    for (const ip of ["::7f00:1", "::0a00:0001", "::a9fea9fe", "::2", "::ffff:1",
      "::6440:0", "::ffff:ffff", "::7f00:0001", "::FE80:1".toLowerCase()]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it("URL-normalized [::127.0.0.1] is flagged at the host seam", () => {
    const host = new URL("http://[::127.0.0.1]/").hostname.replace(/^\[|\]$/g, "");
    expect(host).toBe("::7f00:1");
    expect(isPrivateAddress(host)).toBe(true);
  });

  it("IPv4-compatible forms of public v4 stay public (no over-block)", () => {
    expect(isPrivateAddress("::808:808")).toBe(false);
    expect(isPrivateAddress("::102:34")).toBe(false);
  });
});

// ── Content-type boundary ───────────────────────────────────────────

const RASTER_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

// Oracle: the claimed type is the text before the FIRST ";" (parameter
// quoting never changes the base type), trimmed to RFC 9110 OWS (SP/HTAB
// only), case-folded, and must be one of the four script-less rasters.
// If only JS-trim (VT, FF, NBSP, ZWSP, ...) would land it in the allowlist,
// that is the over-permissive-trim nit from the run notes: verdict "gap".
function oracleMime(s: string): string | null | "gap" {
  const semi = s.indexOf(";");
  const raw = semi >= 0 ? s.slice(0, semi) : s;
  const rfc = raw.replace(/^[\t ]+|[\t ]+$/g, "").toLowerCase();
  if (RASTER_MIME.has(rfc)) return rfc;
  const js = raw.trim().toLowerCase();
  if (RASTER_MIME.has(js)) return "gap";
  return null;
}

function checkMime(tally: Tally, ct: string): void {
  tally.checked++;
  let got: string | null;
  try {
    got = imageMimeFor(ct);
  } catch (e) {
    tally.failures.push(`imageMimeFor THREW on ${JSON.stringify(ct.slice(0, 80))}: ${e}`);
    return;
  }
  if (got !== null && !RASTER_MIME.has(got)) {
    tally.failures.push(`classified non-raster ${JSON.stringify(got)} for ${JSON.stringify(ct.slice(0, 80))}`);
    return;
  }
  const want = oracleMime(ct);
  if (want === "gap") {
    if (tally.gaps.length < 200) tally.gaps.push(ct.slice(0, 80));
    return;
  }
  if (got !== want) {
    tally.failures.push(`mime ${JSON.stringify(ct.slice(0, 80))}: got=${JSON.stringify(got)}, oracle=${JSON.stringify(want)}`);
  }
}

const CT_BASES = [
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml",
  "image/avif", "image/heic", "image/bmp", "image/tiff", "text/html",
  "application/json", "application/octet-stream", "multipart/form-data",
  "image/pngx", "ximage/png", "image//png", "IMAGE/PNG", "Image/Gif",
  "image\/PNG", "image/png ", " image/png", "javascript", "text/javascript",
];
const CT_PARAMS = [
  "", ";", ";charset=utf-8", "; charset=UTF-8", ";;", ";charset=",
  ';charset="utf-8"', ';charset=";image/svg+xml"', ';charset=";image/png"',
  ";a=1;b=2;a=3", ';boundary="image/png"', ";q=0.9;charset",
  ";=?utf-8?Q?=", ";charset=binary;charset=iso-8859-1", ';p="\\""', ";x=y",
];
const CT_ODD = [
  'image/png"', '"image/png"', "'image/png'", "\x00image/png", "image/pn\x00g",
  "\u00a0image/gif", "\u200bimage/png", "\x0bimage/png", "\fimage/webp",
  "image/gif\u00a0", "image/png\u2028", "image /png", " image/png ; a=b",
  "image/png\r\n", "\ud800image/png", ";image/png", ",image/png",
  "image/png,image/jpeg", "image/svg+xml;;image/png",
];

describe("fetch-ssrf content-type fuzz", () => {
  const tally: Tally = { checked: 0, gaps: [], failures: [] };

  it("base x parameter-soup grid agrees with the mime oracle", () => {
    for (const b of CT_BASES) {
      for (const p of CT_PARAMS) checkMime(tally, b + p);
      for (const o of CT_ODD) checkMime(tally, o + b.slice(0, 4));
    }
    for (const o of CT_ODD) checkMime(tally, o);
  });

  it("10KB content-types never throw and never over-classify", () => {
    checkMime(tally, "image/png;" + "x=".repeat(5000));
    checkMime(tally, "image/svg+xml;charset=\"" + ";".repeat(4990) + "\"");
    checkMime(tally, 'image/gif;p="' + ";image/png;".repeat(500) + '"');
    checkMime(tally, "a".repeat(10000));
    checkMime(tally, "\x00".repeat(9000) + "image/png");
  });

  it("seeded random content-type junk agrees with the mime oracle", () => {
    const rng = makeRng(0x4d494d45); // "MIME"
    const soup = [";", ",", '"', "=", " ", "\t", "\x00", "a", "/", "image", "png",
      "\u00a0", "\u200b", "charset", "utf-8", "\\", "'", "\n"];
    for (let i = 0; i < 500; i++) {
      const parts: string[] = [];
      const n = 1 + rng.int(8);
      for (let k = 0; k < n; k++) {
        const roll = rng.float();
        if (roll < 0.4) parts.push(rng.pick(CT_BASES));
        else if (roll < 0.7) parts.push(rng.pick(CT_PARAMS));
        else parts.push(rng.pick(soup));
      }
      checkMime(tally, parts.join(rng.pick(["", " ", ";", ""])).slice(0, 300));
    }
    expect(tally.failures).toEqual([]);
  });
});

// ── withDefaultAccept ───────────────────────────────────────────────

describe("fetch-ssrf withDefaultAccept", () => {
  it("caller Accept always wins; default is added exactly once otherwise", () => {
    const rng = makeRng(0x41434331); // "ACC1"
    const keyPool = ["Accept", "accept", "ACCEPT", "aCcEpT", "Content-Type", "X-A", ""];
    for (let i = 0; i < 200; i++) {
      const headers: Record<string, string> = {};
      const n = rng.int(3);
      for (let k = 0; k < n; k++) headers[rng.pick(keyPool)] = rng.pick(["v", "*/*", "text/plain"]);
      const showOriginal = rng.bool();
      const hadAccept = Object.keys(headers).some((k) => k.toLowerCase() === "accept");
      const snapshot = { ...headers };
      let out: Record<string, string>;
      try {
        out = withDefaultAccept(headers, showOriginal);
      } catch (e) {
        expect(`threw: ${e}`).toBe("never throws");
        return;
      }
      const outAcceptKeys = Object.keys(out).filter((k) => k.toLowerCase() === "accept");
      if (hadAccept) {
        // Caller wins: no default Accept sneaks in alongside the caller's.
        expect(outAcceptKeys.sort()).toEqual(
          Object.keys(snapshot).filter((k) => k.toLowerCase() === "accept").sort(),
        );
        for (const key of Object.keys(snapshot)) {
          if (key.toLowerCase() === "accept") expect(out[key]).toBe(snapshot[key]);
        }
      } else {
        expect(outAcceptKeys).toEqual(["Accept"]);
        expect(out.Accept!.startsWith(showOriginal ? "text/html" : "text/markdown")).toBe(true);
        for (const key of Object.keys(snapshot)) expect(out[key]).toBe(snapshot[key]);
      }
    }
  });
});
