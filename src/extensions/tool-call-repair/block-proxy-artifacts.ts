// Hard fence for hallucinated file-proxy artifact URLs in tool-call arguments.
//
// Core logic ported from an opencode plugin by wtogami: https://github.com/wtogami/qwen-block-proxy-artifacts
// distributed under MIT License, Copyright (c) 2026 by the block-proxy-artifacts contributors.
//
// Why: Qwen3.8-Flash-Next family builds fabricate signed Aliyun OSS "file proxy" links from pretraining data --
// nobody configured that host -- and feed them to fetch/curl/MCP tools. The real infrastructure answers 403,
// every retry leaks a trace identifier to a third party, and each attempt costs ~5 s and ~200 permanent context tokens.
// The fence makes the failure loud, terminal, and self-correcting: the call dies in <10 ms and with guidance to not to retry.
//
// Why these rules: the observed dials hit the relay bucket label `routify-file-proxy-sg` in Aliyun OSS's two documented
// endpoint formats (public `<bucket>.oss-<region>...` and dual-stack `<bucket>.<region>.oss...`), re-synthesizing the
// trace / request / date segments each time. Upstream's weights-level row ablation (SURGERY.md) proved this is a TEMPLATE FAMILY,
// not one memorized host: zeroing the table rows carrying the canonical template produced dials at never-before-observed labels and endpoint forms,
// including proxy-less labels, `oss-accelerate`-style endpoints, and an aliyuncs `io` TLD variant. So rule 2 must NOT require a "proxy" segment and
// must admit both TLDs; rule 1 still pins the exact incident host for provenance.
//
// Retired rules: a generic aliyuncs path rule (would block legitimate relay operators' own objects, which can validly return 200)
// and a bare relay-host-token rule (over-fires on relay-ops code and incident writeups, and blocks self-documentation).
//
// Self-compatibility: the regex sources below are written with character classes (`[.]`, `[-]`) so this file's own
// literal text never matches the blocklist -- otherwise an edit/grep tool call carrying this file's contents
// would trip the fence. A test enforces the property for this file and its test file.

export interface BlockedHit {
  pattern: RegExp;
  why: string;
}

export const BLOCKED: BlockedHit[] = [
  {
    pattern: /routify[-]file[-]proxy[-]sg[.]oss-ap-southeast-1[.]aliyuncs[.]com/i,
    why: "observed incident host (dead relay bucket)",
  },
  {
    pattern: /routify[\w.-]{0,12}file[\w.-]{0,56}aliyuncs[.](com|io)/i,
    why: "relay bucket label (any routify-file-* form) on an Aliyun OSS endpoint, com or io TLD",
  },
];

/** The blocked shape found in the serialized tool arguments, or null. */
export function findBlocked(input: string): BlockedHit | null {
  for (const b of BLOCKED) if (b.pattern.test(input)) return b;
  return null;
}

const FULL_GUIDANCE =
  `This URL is a dead upload-proxy artifact from a third-party relay middlebox, not a real ` +
  `content source: it cannot be fetched and retrying leaks trace identifiers. ` +
  `Do NOT retry it. Go back to the original publisher URL and fetch that instead.`;

// Repeat occurrences in the same session get a one-liner: the full guidance is
// what drove good self-corrections in the field, but re-injecting ~200 tokens
// per recurrence pollutes the context the fence exists to protect.
const TERSE_GUIDANCE =
  `Dead upload-proxy artifact from a third-party relay middlebox. Do NOT retry it. ` +
  `Fetch the original publisher URL directly.`;

// Server-process-scale cap; clearing wholesale is fine at this size.
export const WARNED_CAP = 500;

/**
 * Error message for a blocked call shape (recording the session as warned),
 * or null to allow it. `warned` maps sessionId -> guided, owned by the
 * caller (one map per loaded extension instance, as upstream).
 */
export function verdict(input: string, warned: Map<string, boolean>, session: string): string | null {
  const hit = findBlocked(input);
  if (!hit) return null;
  const first = !warned.has(session);
  if (warned.size > WARNED_CAP) warned.clear();
  warned.set(session, true);
  return `Blocked by block-proxy-artifacts policy (${hit.why}). ` + (first ? FULL_GUIDANCE : TERSE_GUIDANCE);
}
