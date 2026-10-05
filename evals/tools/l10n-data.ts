// A1: the locale table for the kielbasa-2 localized-injection family.
// Assembles the per-family batch modules (deviation from the plan, approved:
// 10 translation batches run in parallel, so each locale's translated content
// lives in ./l10n/<batch>.ts; this file owns the canaries, the id mapping, and
// the load-time sanity checks). Full semantics + review checklist: L10N-SPEC.md.
//
// Canary rule: each locale gets a fresh 6-lowercase-hex KIWBASS-CANARY, assigned
// ONLY here, never in a family module. The 56 values below were grep-verified
// absent from the whole repo (excl. node_modules/.git) before being committed.
export type { Locale, LocaleContent, ScriptFamily, EvidenceToken } from "./l10n/common.ts";
export {
  MASTER_PAYLOAD,
  EVIDENCE_TOKENS,
  PAYLOAD_REQUIRED_TOKENS,
  SCRIPT_QUOTAS,
  CANARY_PREFIX,
  CANARY_HEX_RE,
  OOB_URL_BASE,
  BIDI_ISOLATE_OPEN,
  BIDI_ISOLATE_CLOSE,
  isolate,
} from "./l10n/common.ts";

import type { Locale, LocaleContent, ScriptFamily } from "./l10n/common.ts";
import { latinw } from "./l10n/latinw.ts";
import { latinn } from "./l10n/latinn.ts";
import { laine } from "./l10n/laine.ts";
import { cyr } from "./l10n/cyr.ts";
import { cjk } from "./l10n/cjk.ts";
import { ind } from "./l10n/ind.ts";
import { ara } from "./l10n/ara.ts";
import { heb } from "./l10n/heb.ts";
import { sea } from "./l10n/sea.ts";
import { oth } from "./l10n/oth.ts";
import { SCRIPT_QUOTAS, CANARY_HEX_RE } from "./l10n/common.ts";

/** Locale -> 6-hex canary suffix (full token is `KIWBASS-CANARY-<hex>`). */
const CANARIES: Record<string, string> = {
  de: "f10001", es: "f10002", fr: "f10003", it: "f10004", pt: "f10005", "pt-BR": "f10006",
  nl: "f10007", pl: "f10008", cs: "f10009", sk: "f1000a", sl: "f1000b", hr: "f1000c", ro: "f1000d",
  hu: "f1000e", fi: "f1000f", sv: "f10010", no: "f10011", da: "f10012", tr: "f10013", az: "f10014",
  ru: "f10015", uk: "f10016", be: "f10017", bg: "f10018", sr: "f10019", mk: "f1001a",
  ja: "f1001b", "zh-Hans": "f1001c", "zh-Hant": "f1001d", ko: "f1001e",
  hi: "f1001f", bn: "f10020", ta: "f10021", te: "f10022", mr: "f10023", gu: "f10024",
  ml: "f10025", pa: "f10026",
  ar: "f10027", fa: "f10029", ps: "f1002a", ur: "f1002b", sd: "f1002c", ug: "f1002d",
  he: "f1002e", yi: "f1002f",
  th: "f10030", lo: "f10031", km: "f10032", my: "f10033", vi: "f10034",
  el: "f10035", ka: "f10036", hy: "f10037", am: "f10038", sw: "f10039",
};

const CONTENT: LocaleContent[] = [
  ...latinw, ...latinn, ...laine, ...cyr, ...cjk, ...ind, ...ara, ...heb, ...sea, ...oth,
];

export const locales: Locale[] = CONTENT.map((c) => {
  const hex = CANARIES[c.code];
  if (!hex || !CANARY_HEX_RE.test(hex)) {
    throw new Error(`l10n-data: bad or missing canary for locale ${c.code}`);
  }
  return { ...c, canary: `KIWBASS-CANARY-${hex}` };
});

/**
 * A2 id mapping: locales sorted lexicographically by code (default JS string
 * sort), then ids 014..069 in order. Task ids read `0NN-injection-l10n-<code>`.
 * 011 stays skipped (pre-existing decision); 020-022 are the hand-written
 * cross-lingual surfaces (A4).
 */
export const LOCALE_IDS: Record<string, string> = Object.fromEntries(
  [...locales]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((l, i) => [l.code, String(14 + i).padStart(3, "0")]),
);

// Load-time sanity checks (cheap invariants only; the full gate is A3's
// l10n-validate.ts). Throw at import so a broken table fails fast everywhere.
const seenCodes = new Set<string>();
const seenHex = new Set<string>();
for (const l of locales) {
  if (seenCodes.has(l.code)) throw new Error(`l10n-data: duplicate locale code ${l.code}`);
  seenCodes.add(l.code);
  const hex = l.canary.slice("KIWBASS-CANARY-".length);
  if (seenHex.has(hex)) throw new Error(`l10n-data: duplicate canary hex ${hex}`);
  seenHex.add(hex);
}
if (locales.length !== 56) throw new Error(`l10n-data: expected 56 locales, got ${locales.length}`);
const quotas: Record<ScriptFamily, number> = { ...SCRIPT_QUOTAS };
for (const l of locales) quotas[l.script] -= 1;
for (const [script, left] of Object.entries(quotas)) {
  if (left !== 0) throw new Error(`l10n-data: script quota off for ${script} by ${-left}`);
}
