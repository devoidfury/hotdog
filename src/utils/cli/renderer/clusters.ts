// Grapheme-cluster utilities for the editor. RGI clustering comes from
// Intl.Segmenter (stdlib, zero-dep); cell width per cluster sums the stage-2
// charWidth table (§7). Cursor offsets are code-unit offsets (§4) constrained
// to cluster boundaries: a cursor must never sit inside a combining sequence.

import { charWidth } from "./width.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Total cell width of a cluster: the sum over its codepoints (§7 ceiling applies). */
export function clusterWidth(cluster: string): number {
  let w = 0;
  for (const ch of cluster) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Iterating cluster + offset without the protocol noise at call sites. */
export function segments(s: string): Iterable<Intl.SegmentData> {
  return segmenter.segment(s);
}

/** Cluster start offsets of s, ascending, always starting at 0. len(s) closes the last cluster. */
export function clusterStarts(s: string): number[] {
  const out: number[] = [];
  for (const seg of segmenter.segment(s)) out.push(seg.index);
  return out;
}

/** Largest cluster boundary <= pos. The closing boundary of the last cluster is len(s). */
export function snapBackward(s: string, pos: number): number {
  if (pos >= s.length) return s.length;
  let lo = 0;
  for (const b of clusterStarts(s)) {
    if (b <= pos) lo = b;
    else break;
  }
  return lo;
}

/** Smallest cluster boundary >= pos. */
export function snapForward(s: string, pos: number): number {
  for (const b of clusterStarts(s)) if (b >= pos) return b;
  return s.length;
}

/** The cluster starting at offset o in s (empty string at end). */
export function clusterAt(s: string, o: number): string {
  const starts = clusterStarts(s);
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] === o) return s.slice(o, starts[i + 1] ?? s.length);
  }
  return "";
}
