// Malformed tool-call grammar recovery for local backends.
//
// Local stacks often use chat templates that emit Hermes-format tool calls, but often come out screwed up:
// it arrives as plain text -- in content or reasoning -- with finish_reason "stop" and no
// tool_calls, and the turn ends with the call stranded in the transcript.
//
// This module attempts to parse those leaked calls. It fails closed -- anything ambiguous is left alone:
//
// - The call block must run to the END of the text. Prose after the last block means the model is showing markup, not calling a tool.
// - Trailing whitespace, stray commas, and stray code fences are tolerated.
// - A missing block close (truncated output) still repairs: the block runs to EOF either way, so the trailing-content rule holds.
// - Real text before the call is kept as the visible message body; a leaked think-block tail glued to the front is stripped.
//
// NOTE ON LITERALS: the special tokens parsed here are assembled from bare names at use time via tok()/reTok().
// A literal token anywhere in this file (or in any tool call that writes it) can re-trigger the very
// backend bug we are routing around -- the serving stack re-parses our own output. Keep every token constructed.

import { ToolCall } from "@core/context/message.ts";

// ── Token assembly ───────────────────────────────────────────────────────────

const LT = "<";
const GT = ">";

/** Regex source for one special token. Matches BOTH the Hermes pipe-delimited
 style and the bare XML style (antml / chatml-embedded), pipes optional. Built
 here rather than literal so this file never contains a token the backend would eat. */
function reTok(name: string): string {
  return LT + "\\|?" + name + "\\|?";
}

/** Regex source matching any of the given tag-name variants. */
function altTok(...names: string[]): string {
  return "(?:" + names.map(reTok).join("|") + ")";
}

// Tag synonyms seen in the wild: Hermes words, the antml/Claude variants. Underscore, hyphen, and plural spellings all show up
const CALL_ALT = altTok("tool_call", "tool-call", "toolcall", "tool_calls");
const CALL_CLOSE_ALT = altTok("/tool_call", "/tool_calls", "/tool-call");
const FUNC_ALT = altTok("function", "func");
const PARAM_ALT = altTok("parameter", "param");
const THINK_ALT = altTok("think");

const CALL_OPEN_RE = new RegExp(CALL_ALT + GT);
const CALL_CLOSE_RE = new RegExp(CALL_CLOSE_ALT + GT);
// NAME -- the "=" is mandatory in Hermes grammar; tolerate its
// omission (the model dropping it is a frequent miss). The optional pipe
// before GT admits the XML-style close after a bare-name tag head; the
// name may also ride inside the head (antml style), hence the second alt.
// Function/param open. Two name slots:
//  - legacy/Hermes: header token (pipes), then optional "=" and the name, then ">"
//  - inside-header (antml/chatml XML, and Hermes where the name rides inside the bars):
//    the name attaches to the header with "=", the tag then closes (stray bar tolerated)
// reTok's optional bars admit the bare XML style and any half-dropped bar.
const NAME_SRC = "([A-Za-z0-9_.:-]+)";
const OPEN_TAIL = "(?:" + GT + "\\s*=?\\s*" + NAME_SRC + "|\\s*=\\s*" + NAME_SRC + "\\s*\\|?)";
const FUNC_OPEN_RE = new RegExp(FUNC_ALT + OPEN_TAIL + GT);
const FUNC_CLOSE_RE = new RegExp(altTok("/function", "/func") + GT);
const PARAM_OPEN_RE = new RegExp(PARAM_ALT + OPEN_TAIL + GT);
const PARAM_CLOSE_RE = new RegExp(altTok("/parameter", "/param") + GT);

export interface ParsedCall {
  call: ToolCall;
  /** End offset of the consumed block (incl. any trailing wrapper close). */
  end: number;
}

export interface RepairResult {
  calls: ToolCall[];
  /** Visible message body after stripping the call block (trimmed). */
  text: string;
  /** False when nothing was parsed or the fail-closed rules vetoed it. */
  repaired: boolean;
}

// Trailing junk allowed after/between blocks: whitespace, stray commas,
// stray code fences.
const JUNK_ONLY = /^[\s,`]*$/;

function newCallId(): string {
  return "call_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

/** Strip a leaked think-block tail glued to the front of content. */
function stripThinkTail(text: string): string {
  return text.replace(new RegExp("^" + THINK_ALT + GT + "\\s*"), "");
}

// Hermes values are raw text; tool schemas want numbers/booleans where the
// model plainly meant them. Coerce only those -- parsing objects/quoted
// strings would eat text a tool expects verbatim.
// The round-trip check (String(Number(raw)) === raw) keeps id-like values
// intact: leading-zero strings ("0123"), out-of-safe-integer ids, "-0", and
// trailing-zero decimals ("1.50") stay strings rather than silently change.
function coerceScalar(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw) && String(Number(raw)) === raw) {
    return Number(raw);
  }
  return raw;
}

/** Parse one parameter (name already matched); null if unterminated. */
function parseParam(
  text: string,
  open: RegExpExecArray,
  from: number,
): { name: string; value: unknown; end: number } | null {
  const valueStart = from + open.index + open[0].length;
  const rest = text.slice(valueStart);
  const close = PARAM_CLOSE_RE.exec(rest);
  if (close === null) return null;
  // Hermes wraps values with a leading and trailing newline; strip exactly
  // those (internal whitespace is data).
  const raw = rest.slice(0, close.index).replace(/^\n/, "").replace(/\n$/, "");
  const name = open[1] ?? open[2];
  if (!name) return null;
  return { name, value: coerceScalar(raw), end: valueStart + close.index + close[0].length };
}

/** Parse parameters up to the function close (or EOF when truncated). */
function parseParams(text: string, from: number): { args: Record<string, unknown>; end: number } | null {
  const args: Record<string, unknown> = {};
  let pos = from;
  for (;;) {
    const rest = text.slice(pos);
    const funcClose = FUNC_CLOSE_RE.exec(rest);
    PARAM_OPEN_RE.lastIndex = 0;
    const paramOpen = PARAM_OPEN_RE.exec(rest);
    if (paramOpen && (!funcClose || paramOpen.index < funcClose.index)) {
      // Only whitespace/junk may sit before the next open. A token in the gap unexpected -- fail closed.
      if (!JUNK_ONLY.test(rest.slice(0, paramOpen.index))) return null;
      // Junk between parameters is tolerated (stray fences/commas/newlines).
      const p = parseParam(text, paramOpen, pos);
      if (p === null) return null; // unterminated parameter -- fail closed
      args[p.name] = p.value;
      pos = p.end;
      continue;
    }
    if (funcClose) {
      const gap = rest.slice(0, funcClose.index);
      if (!JUNK_ONLY.test(gap)) return null; // unexpected shape inside block
      return { args, end: pos + funcClose.index + funcClose[0].length };
    }
    // No func close ahead: repairable only when what follows is junk or the wrapper close (truncated block);
    // anything else is unexpected and fails closed. The outer loop consumes the close.
    const nt = nextToken(text, pos);
    if (nt === null) {
      if (JUNK_ONLY.test(rest)) return { args, end: text.length };
      return null;
    }
    if (nt.kind === "close") return { args, end: pos };
    return null; // an open token inside a func block is an unexpected shape
  }
}

/** Parse one  ... block starting at `from`. */
function parseOneCall(text: string, from: number): ParsedCall | null {
  const rest = text.slice(from);
  const fmap = FUNC_OPEN_RE.exec(rest);
  const funcName = fmap ? (fmap[1] ?? fmap[2]) : undefined;
  // Only accept a function open at the block head (after whitespace/junk).
  if (!fmap || !funcName || !JUNK_ONLY.test(rest.slice(0, fmap.index))) return null;
  const parsed = parseParams(text, from + fmap.index + fmap[0].length);
  if (!parsed) return null;
  return {
    call: {
      id: newCallId(),
      type: "function",
      function: { name: funcName as string, arguments: JSON.stringify(parsed.args) },
    },
    end: parsed.end,
  };
}

/** Next non-junk token at/after `pos`: "close", "open", or null (EOF/junk). */
function nextToken(text: string, pos: number): { kind: "close" | "open"; end: number } | null {
  const rest = text.slice(pos);
  const close = CALL_CLOSE_RE.exec(rest);
  const open = CALL_OPEN_RE.exec(rest);
  if (close && (!open || close.index <= open.index)) {
    if (JUNK_ONLY.test(rest.slice(0, close.index))) {
      return { kind: "close", end: pos + close.index + close[0].length };
    }
    return null;
  }
  if (open) {
    if (JUNK_ONLY.test(rest.slice(0, open.index))) {
      return { kind: "open", end: pos + open.index + open[0].length };
    }
    return null;
  }
  return null;
}

/**
 * Repair a leaked tool-call block at the tail of `text`. Returns
 * repaired: false when nothing parses or the fail-closed rules veto it
 * (prose after the last block, unterminated parameter, junk inside a
 * block). Text before the block is kept as the visible body.
 */
export function repairCallsInText(text: string): RepairResult {
  const failed: RepairResult = { calls: [], text, repaired: false };
  const open = CALL_OPEN_RE.exec(text);
  if (!open) return failed;

  const before = text.slice(0, open.index);
  const calls: ToolCall[] = [];
  let pos = open.index + open[0].length;

  for (;;) {
    const parsed = parseOneCall(text, pos);
    if (!parsed) return failed;
    calls.push(parsed.call);
    pos = parsed.end;

    // Separator loop: junk, wrapper close, wrapper open, or done.
    let done = false;
    while (!done) {
      const rest = text.slice(pos);
      if (JUNK_ONLY.test(rest)) return finish(before, calls);
      const nt = nextToken(text, pos);
      if (nt === null) return failed; // trailing prose -- fail closed
      if (nt.kind === "close") {
        pos = nt.end;
        continue;
      }
      // Wrapper open: another function block must follow.
      pos = nt.end;
      break;
    }
  }

  function finish(body: string, cs: ToolCall[]): RepairResult {
    return { calls: cs, text: stripThinkTail(body).trim(), repaired: true };
  }
}
