/// <reference lib="dom" />
// Settings VIEWER + EDITOR: an overlay panel that renders the server's
// configSnapshot reply (see ../websocket/handlers-config.ts) in a Zed-style
// two-pane body. The framing is live-at-open: the panel requests a FRESH
// snapshot on EVERY open (no cached snapshot is ever shown), and the server
// recomputes per request; there is still no push feed, so staleness only ends
// at the next open/Refresh, never mid-visit. Editing rides
// the same frame: EVERY row the server stamped `edit` carries its IMMEDIATE
// control (owner ruling C6, 2026-11-09: no Edit click for scalars -- the
// toggle flips, the stepper steps, the input blurs, the save goes out); the
// honest hint survives ONLY on the two refusal classes -- rows whose shipped
// payload is a redacted/stubbed summary, and paths the surgical locator
// cannot address. Saves go out as setConfigKey (fresh requestId per save,
// stale replies dropped, one save in flight with a last-write-wins queue per
// path), and success is honest -- the value is persisted to the file, the
// running server needs a restart to apply it. The restart marker is DRIVEN
// by the reply's needsRestart field (Phase 9 will make it per-key; today the
// server answers every success with needsRestart:true).
//
// Layout (redesign C6): a LEFT RAIL (search input on top, then the category
// list with FIELD-UNIT counts -- settings as a user perceives them, arrays
// one field and array-object cards one apiece, see the field-unit doctrine
// at fieldUnitKeyOf -- config dir at the bottom) and a RIGHT PANE (scroll-
// able grouped settings). Categories are computed CLIENT-SIDE from the row's
// top-level keyPath namespace -- core scalars land in General, every real
// namespace (webui, websocket, compaction, coreTools, loopDetect, workflows,
// prompts, providers, bashTool, the extension namespaces, ...) gets a
// friendly title, and anything the map does not know lands in Other. EVERY
// row of the snapshot lands in exactly one category (pinned by test). A
// search query (keyPath AND schema description, case/kebab-insensitive)
// flattens to a filtered list carrying category chips, AND filters the rail:
// while a search is active the rail shows ONLY the categories holding at
// least one matched field UNIT, each with its unit count ("All settings" the
// total units) -- the SAME unit rule as the idle rail, so a match on
// `providers[1].url` counts the provider once and a container-heading match
// counts zero. With an empty box the rail is the snapshot-truth category
// list, counted in the same units.
//
// Doctrines this panel keeps:
// - Diagnostics banner FIRST in the right pane: a broken config file (with
//   the honest `hotdog rescue fix` hint when fixable) and unknown/duplicate/
//   removed key findings -- key names, line numbers, did-you-mean. Values
//   never ride the findings, so there is nothing here that could echo one.
// - Secret rows (leafSecret) render "set (redacted)" or "unset" -- never a
//   length, a prefix, or a partial. The server already nulled every value;
//   the panel just refuses to render "null" as if it were the value. An
//   UNSTAMPED secret row (an old server, or a class-B refusal) stays fully
//   inert. A WRITEONLY stamp is the one exception: the REPLACE box (password
//   input + explicit Set button) starts empty, refuses an empty Set with
//   "no new value entered" WITHOUT touching the wire, and never shows any
//   value -- before or after the save ("set (redacted)" remains the display).
//   The new bytes never ride the optimistic queue display either.
// - Source badges appear only for slots the server ATTESTED (a missing slot
//   is an unattested layer, not "unset"). A row is marked when its resolved
//   value differs from the schema default.
// - Every value is a plain-text JSX child (the runtime escapes text; config
//   content never reaches the DOM as markup). The friendly row label is
//   DERIVED from the key (camelCase/kebab -> Title Case, acronyms kept);
//   the description line is the schema description, or the raw keyPath in
//   monospace when there is none -- the panel NEVER invents prose. The full
//   keyPath rides the row's title attribute. Server error text renders
//   VERBATIM -- this layer adds no prose of its own to a refusal.
// - IMMEDIATE-SAVE honesty: an unchanged field blurring is ZERO wire traffic;
//   a seedless (lossy-ship) string saves only when non-empty; while a save
//   is in flight a further change on the SAME path updates the queued value
//   instead of firing a parallel second save; an error reply reverts the
//   control to the last server-known value and renders the server text
//   verbatim under the row.
// - Escape closes with focus-return to the settings button (context-menu idiom: the
//   app owns the return, the panel owns the keypress). Escape retreats in
//   stages: an armed provider Remove dismisses first, then an open Add field,
//   then an expanded JSON container collapses, then a non-empty search box
//   clears -- only with nothing pending does the dialog close. Click-outside
//   does NOT close: config values are selection targets.

import type { Ref } from "@utils/jsx";
import type {
  ConfigEditPayload,
  ConfigSnapshotResultWire,
  ConfigKeyEntryWire,
  ConfigKeyEditWire,
  SetConfigKeyResultWire,
  ConfigListOp,
  EditConfigListResultWire,
} from "@extensions/websocket/protocol.ts";

// ── Panel state (pure functions; app.tsx holds the atom) ────────────────────
// The requestId doctrine mirrors the search panel (app.tsx's searchReqId):
// every open/refresh/close bumps the sequence, so a late server reply
// carrying an older id is dropped in applySnapshotReply. Closing drops the
// snapshot too -- every open re-fetches (config may have changed on disk).
// WRITES ride their own sequence (saveReqId): refreshing the snapshot never
// invalidates an in-flight save, and a save never invalidates snapshot
// replies. Only ok saves touch needsRestart / editedKeys / the row's file
// slot; refusals keep the verbatim error on the row. Writes SERIALIZE through
// one in-flight slot + a last-write-wins queue (one entry per path), so a
// rapid flip/stepper on the same row never fires parallel saves and never
// loses the newest value.

export type EditScalar = string | number | boolean;

/** A write waiting behind the in-flight save (one entry per path; a newer
 *  request for a queued path REPLACES the entry). `shown` is the optimistic
 *  display text for the row control -- empty for a writeOnly secret replace
 *  and for a json container (their bytes never ride panel state). */
export interface SettingsQueuedSave {
  key: string;
  payload: ConfigEditPayload;
  shown: string;
}

export interface SettingsPanelState {
  open: boolean;
  /** A snapshot request is in flight. */
  pending: boolean;
  snapshot: ConfigSnapshotResultWire | null;
  /** Monotonic snapshot request sequence; the CURRENT request's id rides the wire. */
  reqId: number;
  /** The JSON container row whose textarea is expanded (one at a time), or null. */
  editing: string | null;
  /** A save is in flight, correlated by its own id (`shown` drives the row's
   *  optimistic control value until the reply settles it). */
  pendingSave: { key: string; reqId: number; shown: string } | null;
  /** Writes waiting behind the in-flight save (last-write-wins per path). */
  queuedSaves: SettingsQueuedSave[];
  /** Last save rejection (rendered verbatim under that row). */
  editError: { key: string; message: string } | null;
  /** Monotonic write request sequence (separate from reqId -- see above). */
  saveReqId: number;
  /** A save has persisted WITH needsRestart during this panel visit: the
   *  restart banner stays up across further edits and snapshot refreshes
   *  (closed on close). Driven by the REPLY's needsRestart field, never
   *  hardcoded. */
  needsRestart: boolean;
  /** Keys whose ok reply carried needsRestart ("restart pending" badge +
   *  file-slot display). */
  editedKeys: string[];
  /** Rail search query (matches keyPath AND description, case/kebab-insensitive). */
  query: string;
  /** The selected rail category (title), or null = all. While searching it
   *  narrows the matches (a selection with no matches is neutralized, kept). */
  category: string | null;
  // ── Provider-LIST editing (owner 2026-11-11: one card per provider + add/remove) ──
  // A list op edits the providers ARRAY itself (append/remove) through the
  // additive editConfigList pair. It shares the one-op-in-flight doctrine: a
  // second op on the path while one is in flight queues last-write-wins.
  /** The inline "+ Add provider" name field is open. */
  addingProvider: boolean;
  /** The providers[i] card whose two-step Remove confirm is armed (its key),
   *  or null. Escape / clicking away cancels it with ZERO wire traffic. */
  confirmRemoveKey: string | null;
  /** The last list-op rejection, rendered VERBATIM under the add affordance
   *  (a duplicate name, a referenced provider, a write failure) OR the local
   *  honest "name is empty" refusal (no wire traffic went out for that one). */
  providerListError: string | null;
  /** A list op in flight, correlated by its own id sequence (listReqId). */
  pendingList: { reqId: number; op: ConfigListOp; keyPath: string; name?: string } | null;
  /** List ops waiting behind the in-flight one (last-write-wins per path). */
  queuedList: Array<{ op: ConfigListOp; keyPath: string; name?: string; index?: number }>;
  /** Monotonic list-op request sequence (separate from reqId AND saveReqId). */
  listReqId: number;
  /** After a successful append, the new provider's name: the app focuses that
   *  card once the refreshed snapshot lands (bring the new card into view). */
  focusProviderName: string | null;
}

export const initialSettingsPanelState: SettingsPanelState = {
  open: false,
  pending: false,
  snapshot: null,
  reqId: 0,
  editing: null,
  pendingSave: null,
  queuedSaves: [],
  editError: null,
  saveReqId: 0,
  needsRestart: false,
  editedKeys: [],
  query: "",
  category: null,
  addingProvider: false,
  confirmRemoveKey: null,
  providerListError: null,
  pendingList: null,
  queuedList: [],
  listReqId: 0,
  focusProviderName: null,
};

/** Settings button pressed: open + re-fetch (fresh id invalidates an older in-flight reply).
 *  The editor context belongs to the visit: a new open starts clean (the
 *  restart truth of the previous visit is not re-attestable against a fresh
 *  snapshot anyway), and so do the rail filter and any queued writes. */
export function openSettingsPanel(s: SettingsPanelState): SettingsPanelState {
  return {
    ...initialSettingsPanelState,
    open: true,
    pending: true,
    reqId: s.reqId + 1,
    saveReqId: s.saveReqId,
  };
}

/** Refresh button: same re-fetch, id bumped again (editor + filter state survive). */
export function refreshSettingsPanel(s: SettingsPanelState): SettingsPanelState {
  return { ...s, pending: true, reqId: s.reqId + 1 };
}

/** Escape / ✕: close, drop the snapshot, and invalidate any in-flight reply. */
export function closeSettingsPanel(s: SettingsPanelState): SettingsPanelState {
  return { ...initialSettingsPanelState, reqId: s.reqId + 1, saveReqId: s.saveReqId };
}

/** Server snapshot reply: stale ids drop here (search-panel precedent). */
export function applySnapshotReply(
  s: SettingsPanelState,
  requestId: number | undefined,
  snapshot: ConfigSnapshotResultWire,
): SettingsPanelState {
  if (requestId !== s.reqId) return s; // stale: superseded or the panel closed
  return { ...s, pending: false, snapshot };
}

/** The JSON textarea opened on a container row (a previous rejection on
 *  another row is dismissed with the switch). Scalar rows have no edit mode:
 *  their controls save immediately. */
export function startSettingsEdit(s: SettingsPanelState, keyPath: string): SettingsPanelState {
  return { ...s, editing: keyPath, editError: null };
}

/** Cancel (button, or Escape while a container is expanded): collapse it,
 *  drop the error. The error is dropped even when nothing is open -- it
 *  renders on its row independently, so a cancel must not leave it behind. */
export function cancelSettingsEdit(s: SettingsPanelState): SettingsPanelState {
  if (s.editing === null && s.editError === null) return s;
  return { ...s, editing: null, editError: null };
}

/** Rail search box (the panel filters live; Escape clears a non-empty box
 *  BEFORE it closes -- see the dialog's staged Escape ladder). */
export function setSettingsQuery(s: SettingsPanelState, query: string): SettingsPanelState {
  return { ...s, query };
}

/** Rail category click (null = All settings). Survives a search: while the
 *  box holds a query it narrows the flattened matches (a selection with no
 *  matches is neutralized for the duration of the search, never dropped). */
export function setSettingsCategory(s: SettingsPanelState, category: string | null): SettingsPanelState {
  return { ...s, category };
}

/** Client-side parse of a control's raw text against the server-stamped
 *  kind (the BOUNDS are not re-checked here -- they are the server's job;
 *  this only keeps obvious garbage off the wire). Scalars ride the `value`
 *  channel; JSON containers and writeOnly secret replaces ride `valueText`. */
export function parseEditValue(
  edit: ConfigKeyEditWire,
  raw: string,
): { ok: true; payload: ConfigEditPayload } | { ok: false; error: string } {
  if (edit.writeOnly === true) {
    // The REPLACE box: an empty save is the classic "I did not type anything"
    // mistake, and it would clear a live credential. Refuse it client-side
    // AND server-side; the old value is never known here anyway.
    if (raw === "") return { ok: false, error: "no new value entered" };
    return { ok: true, payload: { valueText: raw } };
  }
  if (edit.type === "json") {
    const trimmed = raw.trim();
    if (trimmed === "") return { ok: false, error: "a value is required" };
    try {
      JSON.parse(trimmed);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `invalid JSON -- ${reason}` };
    }
    return { ok: true, payload: { valueText: raw } };
  }
  if (edit.type === "boolean") {
    if (raw === "true") return { ok: true, payload: { value: true } };
    if (raw === "false") return { ok: true, payload: { value: false } };
    return { ok: false, error: "choose true or false" };
  }
  if (edit.type === "string") return { ok: true, payload: { value: raw } };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, error: "a value is required" };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false, error: `"${trimmed}" is not a number` };
  if (edit.type === "integer" && !Number.isInteger(n)) return { ok: false, error: "a whole number is required" };
  return { ok: true, payload: { value: n } };
}

/** The optimistic control text for an accepted save: scalars show their
 *  value; writeOnly replaces and json containers show NOTHING (their bytes
 *  never ride panel display -- the box keeps hiding, the textarea keeps the
 *  user's own text). */
export function pendingDisplay(edit: ConfigKeyEditWire, payload: ConfigEditPayload): string {
  if (edit.writeOnly === true || edit.type === "json") return "";
  return "value" in payload ? String(payload.value) : "";
}

/** A save the parse rejected: the row keeps its control with the hint. */
export function rejectSettingsSave(s: SettingsPanelState, key: string, message: string): SettingsPanelState {
  return { ...s, editError: { key, message } };
}

/** Send or queue a parsed save. Writes SERIALIZE through one in-flight slot:
 *  the slot is free -> fresh write id, it goes out (send is returned for the
 *  app to put on the wire). The slot is busy -> the value is queued for its
 *  path, REPLACING any earlier queued value for that path (a second flip on
 *  a pending row updates the queue instead of firing a parallel second save). */
export function requestSettingsSave(
  s: SettingsPanelState,
  key: string,
  payload: ConfigEditPayload,
  shown: string,
): { state: SettingsPanelState; send: { reqId: number; key: string; payload: ConfigEditPayload } | null } {
  if (s.pendingSave !== null) {
    const rest = s.queuedSaves.filter((q) => q.key !== key);
    return { state: { ...s, queuedSaves: [...rest, { key, payload, shown }] }, send: null };
  }
  const reqId = s.saveReqId + 1;
  return {
    state: { ...s, saveReqId: reqId, pendingSave: { key, reqId, shown }, editError: null },
    send: { reqId, key, payload },
  };
}

/** After the in-flight slot settles, send the oldest queued write (if any).
 *  A queued write for a path whose save just FAILED still goes out: it is
 *  the user's newest intent for that path. */
export function flushSettingsSave(s: SettingsPanelState): {
  state: SettingsPanelState;
  send: { reqId: number; key: string; payload: ConfigEditPayload } | null;
} {
  if (s.pendingSave !== null || s.queuedSaves.length === 0) return { state: s, send: null };
  const [next, ...rest] = s.queuedSaves as [SettingsQueuedSave, ...SettingsQueuedSave[]];
  const reqId = s.saveReqId + 1;
  return {
    state: {
      ...s,
      saveReqId: reqId,
      pendingSave: { key: next.key, reqId, shown: next.shown },
      queuedSaves: rest,
      editError: s.editError && s.editError.key === next.key ? null : s.editError,
    },
    send: { reqId, key: next.key, payload: next.payload },
  };
}

/** Update one row's FILE slot from a persisted echo (the resolved slot keeps
 *  attesting the running server's pre-restart value -- that is the honest
 *  split the "restart pending" badge explains). The three success shapes:
 *  scalar -> the value; container -> the echoed JSON text re-parsed; writeOnly
 *  secret -> file:null + redacted:true (the ONLY honest post-save ship: the
 *  value definitely IS set now, its bytes must never ride anything). */
function patchRowFileSlot(
  snapshot: ConfigSnapshotResultWire | null,
  key: string,
  result: SetConfigKeyResultWire,
): ConfigSnapshotResultWire | null {
  if (!snapshot) return snapshot;
  let patch: Partial<ConfigKeyEntryWire>;
  if (result.redacted === true) {
    patch = { file: null, redacted: true };
  } else if (result.valueText !== undefined) {
    try {
      patch = { file: JSON.parse(result.valueText) as unknown };
    } catch {
      return snapshot; // an unparsable echo patches nothing (the server gate should prevent this)
    }
  } else if (result.value !== undefined && result.value !== null) {
    patch = { file: result.value };
  } else {
    return snapshot;
  }
  return {
    ...snapshot,
    sections: snapshot.sections.map((sec) => ({
      ...sec,
      rows: sec.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    })),
  };
}

/** Write reply: stale ids drop here (same doctrine, own sequence). ok: the
 *  row updates from the server's echo, and the restart marker follows the
 *  reply's needsRestart FIELD (a save whose reply does not claim one raises
 *  neither the banner nor the badge); refusal: verbatim under the row. The
 *  queued writer drains via flushSettingsSave (the app calls it here). */
export function applySetConfigReply(
  s: SettingsPanelState,
  requestId: number | undefined,
  result: SetConfigKeyResultWire,
): SettingsPanelState {
  if (!s.pendingSave || requestId !== s.pendingSave.reqId) return s; // stale: superseded or the panel closed
  const key = s.pendingSave.key;
  if (result.ok) {
    const needsRestart = result.needsRestart === true;
    return {
      ...s,
      pendingSave: null,
      editing: null,
      editError: null,
      needsRestart: s.needsRestart || needsRestart,
      editedKeys: !needsRestart || s.editedKeys.includes(key) ? s.editedKeys : [...s.editedKeys, key],
      snapshot: patchRowFileSlot(s.snapshot, key, result),
    };
  }
  return { ...s, pendingSave: null, editError: { key, message: result.error ?? "save failed" } };
}

// ── Provider-LIST ops (add / remove a whole provider, owner 2026-11-11) ──────
// These edit the providers ARRAY through the additive editConfigList pair; the
// server writes the file with the SAME verified transaction setConfigKey uses.
// The client doctrine mirrors the value editor: ONE op in flight, a second on
// the same path queues last-write-wins, stale replies drop by id. Success
// refreshes the snapshot (the file is the source of truth); the running server
// keeps its startup providers until restart, so needsRestart rides the reply.

/** Open the inline "+ Add provider" name field (a prior list refusal clears). */
export function startProviderAdd(s: SettingsPanelState): SettingsPanelState {
  return { ...s, addingProvider: true, confirmRemoveKey: null, providerListError: null };
}

/** Close the add field (Cancel / Escape / click-away). Zero wire traffic. */
export function cancelProviderAdd(s: SettingsPanelState): SettingsPanelState {
  if (!s.addingProvider && s.providerListError === null) return s;
  return { ...s, addingProvider: false, providerListError: null };
}

/** Arm the two-step Remove on a card (Remove clicked, awaiting Confirm). Zero
 *  wire traffic -- the op goes out only on confirm. */
export function armProviderRemove(s: SettingsPanelState, cardKey: string): SettingsPanelState {
  return { ...s, confirmRemoveKey: cardKey, addingProvider: false, providerListError: null };
}

/** Dismiss the armed Remove (Cancel / Escape / click-away). Zero wire traffic. */
export function cancelProviderRemove(s: SettingsPanelState): SettingsPanelState {
  return { ...s, confirmRemoveKey: null };
}

/** Request an append or a remove. An APPEND name is validated HERE, client-
 *  side: an empty or whitespace-only name is refused locally with honest text
 *  and ZERO wire traffic (the field stays open for a fix). Otherwise the op
 *  goes out if nothing is in flight, else queues last-write-wins on its path
 *  (`keyPath`: "providers" for append, "providers[i]" for remove). */
export function requestProviderListOp(
  s: SettingsPanelState,
  op: ConfigListOp,
  keyPath: string,
  opts: { name?: string; index?: number } = {},
): { state: SettingsPanelState; send: { reqId: number; op: ConfigListOp; keyPath: string; name?: string; index?: number } | null } {
  if (op === "append") {
    const name = (opts.name ?? "").trim();
    if (name === "") {
      return { state: { ...s, providerListError: "Provider names can't be empty -- type a name first." }, send: null };
    }
    return enqueueListOp(s, { op, keyPath, name });
  }
  return enqueueListOp(s, { op, keyPath, index: opts.index });
}

/** One-op-in-flight for the list path: free -> a fresh listReqId goes out;
 *  busy -> the entry REPLACES any queued entry for the same keyPath. */
function enqueueListOp(
  s: SettingsPanelState,
  entry: { op: ConfigListOp; keyPath: string; name?: string; index?: number },
): { state: SettingsPanelState; send: { reqId: number; op: ConfigListOp; keyPath: string; name?: string; index?: number } | null } {
  if (s.pendingList !== null) {
    const rest = s.queuedList.filter((q) => q.keyPath !== entry.keyPath);
    return { state: { ...s, queuedList: [...rest, entry], addingProvider: false, confirmRemoveKey: null }, send: null };
  }
  const reqId = s.listReqId + 1;
  return {
    state: {
      ...s,
      listReqId: reqId,
      pendingList: { reqId, op: entry.op, keyPath: entry.keyPath, ...(entry.name !== undefined ? { name: entry.name } : {}) },
      addingProvider: false,
      confirmRemoveKey: null,
      providerListError: null,
    },
    send: { reqId, ...entry },
  };
}

/** Drain the next queued list op once the in-flight one settles (the app sends
 *  it and, on success, refreshes again). */
export function flushProviderList(s: SettingsPanelState): {
  state: SettingsPanelState;
  send: { reqId: number; op: ConfigListOp; keyPath: string; name?: string; index?: number } | null;
} {
  if (s.pendingList !== null || s.queuedList.length === 0) return { state: s, send: null };
  const [next, ...rest] = s.queuedList as [SettingsPanelState["queuedList"][number], ...SettingsPanelState["queuedList"]];
  const reqId = s.listReqId + 1;
  return {
    state: {
      ...s,
      listReqId: reqId,
      pendingList: { reqId, op: next.op, keyPath: next.keyPath, ...(next.name !== undefined ? { name: next.name } : {}) },
      queuedList: rest,
    },
    send: { reqId, op: next.op, keyPath: next.keyPath, ...(next.name !== undefined ? { name: next.name } : {}), ...(next.index !== undefined ? { index: next.index } : {}) },
  };
}

/** editConfigList reply: stale ids drop here. ok -> clear the in-flight op, the
 *  add field and the armed confirm, fold needsRestart from the REPLY FIELD, and
 *  (for an append) mark the new provider for focus after the refresh. refusal
 *  -> the server text verbatim under the add affordance (the card / confirm is
 *  cleared so the row is re-editable; the name field re-opens so the user can
 *  fix a duplicate). Then the app drains any queued op and refreshes on ok. */
export function applyListOpReply(
  s: SettingsPanelState,
  requestId: number | undefined,
  result: EditConfigListResultWire,
): SettingsPanelState {
  if (!s.pendingList || requestId !== s.pendingList.reqId) return s; // stale: superseded or the panel closed
  const op = s.pendingList.op;
  if (result.ok) {
    return {
      ...s,
      pendingList: null,
      providerListError: null,
      addingProvider: false,
      confirmRemoveKey: null,
      needsRestart: s.needsRestart || result.needsRestart === true,
      focusProviderName: op === "append" ? s.pendingList.name ?? null : s.focusProviderName,
    };
  }
  return {
    ...s,
    pendingList: null,
    providerListError: result.error ?? "provider change failed",
    // Re-open the add field on a REFUSED append so the typed name survives to fix
    // a duplicate; a refused remove just disarms (the card stays as it is).
    addingProvider: op === "append" ? true : s.addingProvider,
    confirmRemoveKey: null,
  };
}

/** Consume a pending "focus this new card" request once the app has focused it. */
export function clearProviderFocus(s: SettingsPanelState): SettingsPanelState {
  return s.focusProviderName === null ? s : { ...s, focusProviderName: null };
}

// ── Categories (client-side grouping of the snapshot rows) ──────────────────
// The grouping is PURE DISPLAY: it never rewrites a row and never drops one.
// The key is the row's top-level keyPath namespace (first segment, array
// indices stripped); the server's own section names are used for exactly one
// thing -- routing the bare core scalars (section "core", no dot) to
// General. A file-only unknown whose namespace the map does not know falls
// into Other. The map below lists the REAL namespaces of the running schema
// (the top-level CONFIG_SCHEMA containers + every bundled extension's
// extension.json configSchema keys + the providers passthrough).

export const GENERAL_CATEGORY = "General";
export const OTHER_CATEGORY = "Other";

export const CATEGORY_TITLES: Record<string, string> = {
  // The everyday surface first (rail order = declaration order below).
  webui: "WebUI",
  websocket: "WebSocket",
  providers: "Providers",
  // Extension namespaces people tune (extension.json configSchema keys).
  coreTools: "Core Tools",
  compaction: "Compaction",
  loopDetect: "Loop Detect",
  workflows: "Workflows",
  prompts: "Prompts",
  bashTool: "Bash Tool",
  // Core containers (top-level CONFIG_SCHEMA objects).
  workspace: "Workspace",
  profiles: "Profiles",
  modelGroups: "Model Groups",
  modelPricing: "Model Pricing",
  toolExec: "Tool Exec",
  execFence: "Exec Fence",
  envScrubbing: "Env Scrubbing",
  uploadLimits: "Upload Limits",
  // The long tail.
  agentsMd: "Agents File",
  environment: "Environment",
  fetchTool: "Fetch Tool",
  fileAttachment: "File Attachment",
  handoffTool: "Handoff Tool",
  loop: "Loop",
  mcpClient: "MCP Client",
  mcpServers: "MCP Servers",
  modelSwitch: "Model Switch",
  profileSwitch: "Profile Switch",
  questionTool: "Question Tool",
  sessionLog: "Session Log",
  skills: "Skills",
  stringLength: "String Length",
  subagents: "Subagents",
  toolCallRepair: "Tool Call Repair",
  uiInfoCli: "UI Info CLI",
  uiInteractiveCli: "UI Interactive CLI",
  uiOneShot: "UI One-Shot",
  uiSessionReviewCli: "UI Session Review CLI",
  userGate: "User Gate",
  webSearch: "Web Search",
};

/** First keyPath segment with array indices stripped ("providers[0].url" ->
 *  "providers", "webui.port" -> "webui", "theme" -> "theme"). */
export function keyNamespace(keyPath: string): string {
  const head = keyPath.split(".")[0] ?? keyPath;
  return head.replace(/\[\d*\]/g, "");
}

/** The category ONE row belongs to. Core scalars (section "core", an undotted
 *  key) live in General; everything else follows the namespace map, and the
 *  map's absence means Other (file-only unknowns). */
export function categoryOf(sectionName: string, row: ConfigKeyEntryWire): string {
  if (sectionName === "core" && !row.key.includes(".") && !row.key.includes("[")) return GENERAL_CATEGORY;
  return CATEGORY_TITLES[keyNamespace(row.key)] ?? OTHER_CATEGORY;
}

export interface SettingsGroup {
  title: string;
  rows: ConfigKeyEntryWire[];
}

/** Group every snapshot row into exactly one category. Display order:
 *  General, then the curated map order, then Other (only present groups). */
export function categoryGroups(snapshot: ConfigSnapshotResultWire): SettingsGroup[] {
  const byCat = new Map<string, ConfigKeyEntryWire[]>();
  for (const section of snapshot.sections) {
    for (const row of section.rows) {
      const title = categoryOf(section.name, row);
      const bucket = byCat.get(title);
      if (bucket) bucket.push(row);
      else byCat.set(title, [row]);
    }
  }
  const groups: SettingsGroup[] = [];
  for (const title of [GENERAL_CATEGORY, ...Object.values(CATEGORY_TITLES), OTHER_CATEGORY]) {
    const rows = byCat.get(title);
    if (rows && rows.length > 0) groups.push({ title, rows });
  }
  return groups;
}

/** Case- and kebab-insensitive normalization ("loop-detect" ~ "loopDetect"). */
function normSearch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A row matches the query on its keyPath OR its schema description. */
export function rowMatchesQuery(row: ConfigKeyEntryWire, query: string): boolean {
  const q = normSearch(query);
  if (q === "") return true;
  if (normSearch(row.key).includes(q)) return true;
  return row.description !== undefined && normSearch(row.description).includes(q);
}

// ── Field-unit counts (owner ruling 2026-11-11) ─────────────────────────────
// The rail answers "how many SETTINGS live here" the way a user perceives
// them, not how many snapshot rows the server happened to ship. A row
// contributes ONE countable FIELD UNIT or ZERO; the count is the number of
// DISTINCT unit keys, and the same function serves BOTH rail modes (idle =
// every group row, search = the matched rows with the full group as context).
// The rules (shape-driven, no per-namespace special cases):
//   1. A LEAF (scalar / boolean / enum / writeOnly secret / a json container
//      whose shipped value is not an array and that ships no child rows): 1.
//   2. An ARRAY-valued field is ONE unit, never per element. Per-index rows
//      of it roll up into the array's own unit (so two matches inside
//      `workspace.paths` count workspace as 1).
//   3. An OBJECT ELEMENT of an array (`providers[0]`) is ONE unit -- the
//      card. Everything under it (`providers[0].url`, `.apiKey`, `.models`
//      and its items) rolls into the card, contributing 0 extra. This falls
//      out of "element of an array", so ANY array of objects gets it free.
//   4. Structural chrome -- an ARRAY container whose element rows ship
//      (the `providers` section heading): 0; the cards carry the count.
//   5. A plain OBJECT container row that ships its children as rows: 0, the
//      children roll up (`compaction` counts its leaves, not the container).
//   6. Shape comes from the SHIPPED value (file ?? resolved ?? default), so
//      unknown file-only keys follow the same rules without a schema.
// "All settings" is the sum of the per-group unit counts, never a raw row
// count. With two providers configured the Providers rail reads 2.
const ELEMENT_HEAD = /^(.*)\[\d+\]$/; // "providers[0]" -- an element row
const ELEMENT_DESC = /^(.*\[\d+\])\./; // "providers[0].url" -- under an element

/** The value the row's shape is read from (write-only/secret rows ship no
 *  bytes and stay leaves; an unset row with no value is a leaf too). */
function rowShippedValue(row: ConfigKeyEntryWire): unknown {
  return row.file !== undefined ? row.file : row.resolved !== undefined ? row.resolved : row.default;
}

/** The field-unit KEY a row belongs to, or null when the row is pure chrome
 *  (a container whose children ship as rows -- the children carry the unit).
 *  `group` is the category's full row list; the shipped-children checks read
 *  it, so a SEARCH subset still resolves units against snapshot truth. */
export function fieldUnitKeyOf(row: ConfigKeyEntryWire, group: ConfigKeyEntryWire[]): string | null {
  const desc = ELEMENT_DESC.exec(row.key);
  if (desc) return desc[1]!; // everything under a card belongs to that card (rule 3)
  const head = ELEMENT_HEAD.exec(row.key);
  if (head) {
    // An OBJECT element is the card itself (rule 3); anything else at an
    // index is a per-index row of the array field (rule 2).
    const v = rowShippedValue(row);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? row.key : head[1]!;
  }
  const v = rowShippedValue(row);
  if (Array.isArray(v)) {
    // The array field is one unit -- unless its ELEMENTS ship as rows, in
    // which case this row is the heading chrome and the cards count (rule 4).
    return group.some((r) => r !== row && r.key.startsWith(`${row.key}[`)) ? null : row.key;
  }
  if (v !== null && typeof v === "object") {
    // A plain object container that ships its children rolls up (rule 5).
    return group.some((r) => r !== row && r.key.startsWith(`${row.key}.`)) ? null : row.key;
  }
  return row.key; // a leaf (rule 1)
}

/** The DISTINCT field-unit keys the rows claim, first-seen order. `context`
 *  is the category's full row list (defaults to `rows`); search mode passes
 *  the matched subset with the whole group as context, so a match on
 *  `providers[1].url` still claims the ONE provider's unit. */
export function fieldUnitKeys(rows: ConfigKeyEntryWire[], context: ConfigKeyEntryWire[] = rows): string[] {
  const seen = new Set<string>();
  const units: string[] = [];
  for (const row of rows) {
    const unit = fieldUnitKeyOf(row, context);
    if (unit === null || seen.has(unit)) continue;
    seen.add(unit);
    units.push(unit);
  }
  return units;
}

/** The rail number for a row list: how many fields a user counts (see the
 *  doctrine above). Idle mode calls it with the group rows; search mode with
 *  the matches + the group as context -- SAME function, SAME units. */
export function fieldUnitCount(rows: ConfigKeyEntryWire[], context: ConfigKeyEntryWire[] = rows): number {
  return fieldUnitKeys(rows, context).length;
}

const LABEL_ACRONYMS = new Set([
  "ai", "api", "cli", "css", "html", "id", "json", "llm", "mcp", "sql",
  "sse", "stt", "ttl", "ui", "uri", "url", "yaml",
]);

/** The bold row label: the key's LAST segment (array indices dropped) split
 *  on camelCase / kebab / snake, Title-Cased, known acronyms uppered. Purely
 *  derived -- invents nothing beyond the key itself. */
export function friendlyLabel(keyPath: string): string {
  const dot = keyPath.lastIndexOf(".");
  const leaf = (dot >= 0 ? keyPath.slice(dot + 1) : keyPath).replace(/\[\d*\]/g, " ");
  const words = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .filter(Boolean);
  return words
    .map((w) => (LABEL_ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// ── Value + badge rendering (viewer semantics, unchanged doctrines) ─────────

/** Render one wire value as plain display text. Strings pass through as-is
 *  (server-side truncation markers included); containers JSON-pretty on one
 *  line; null means the slot said "explicitly null" (not "unset" -- an unset
 *  slot rides absent). Inside a container, long strings are BODY text
 *  (profile prompts, pasted docs) and render as a length stub, never a wall
 *  (owner 2026-11-09) -- the same shaping the server applies, so the panel
 *  stays honest even against a daemon older than the wire-side change. */
export function displayConfigValue(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (value === "") return "(empty string)";
    if (depth >= 1 && value.length > 80) return `[${value.length}-char text omitted]`;
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((v) => displayConfigValue(v, depth + 1)).join(", ");
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${displayConfigValue(v, depth + 1)}`)
      .join(", ");
  }
  return String(value);
}

/** The row's value display. The server's redacted flag is the whole story on
 *  a leaf-secret row: redacted:true means some layer holds a real value there
 *  ("set (redacted)"), absence means nothing is set ("unset") -- the panel
 *  never re-derives set-ness from the nulled slot values. On container rows a
 *  redacted flag means secret-shaped entries were nulled INSIDE the value;
 *  the value still renders (with nulls) plus an honest "fields redacted" tag.
 *  A row saved with needsRestart this visit shows the PERSISTED file value
 *  (that is now the truth on disk) with "restart pending" -- the running
 *  server still holds the older resolved value until it restarts. */
function valueCell(row: ConfigKeyEntryWire, editedPending = false): { text: string; redacted: boolean; nested?: boolean; pending?: boolean } {
  if (row.leafSecret) {
    return { text: row.redacted ? "set (redacted)" : "unset", redacted: true };
  }
  const nested = row.redacted === true; // secret-shaped entries nulled inside a container value
  if (editedPending && row.file !== undefined) {
    return { text: displayConfigValue(row.file), redacted: false, pending: true, ...(nested ? { nested } : {}) };
  }
  if (row.resolved !== undefined) return { text: displayConfigValue(row.resolved), redacted: false, ...(nested ? { nested } : {}) };
  if (row.file !== undefined) return { text: displayConfigValue(row.file), redacted: false, ...(nested ? { nested } : {}) };
  // Env values are strings by construction; a null here is a server-side
  // redaction (secret-shaped var name), so render it as such, never "null".
  if (row.env?.set) return { text: displayConfigValue(row.env.value ?? "(redacted)"), redacted: false, ...(nested ? { nested } : {}) };
  if (row.default !== undefined) return { text: displayConfigValue(row.default), redacted: false, ...(nested ? { nested } : {}) };
  return { text: "(unset)", redacted: false };
}

/** Source badges: only for slots the server attested. "resolved" is not a
 *  source (it is what the sources produced); the marker answers "differs
 *  from default" instead. */
function sourceBadges(row: ConfigKeyEntryWire): Array<{ label: string; title: string }> {
  const badges: Array<{ label: string; title: string }> = [];
  if (row.cli !== undefined) {
    badges.push({ label: "cli", title: `CLI flag: ${row.cli.flag}` });
  }
  if (row.env?.set) {
    badges.push({
      label: "env",
      title: row.env.source ? `Environment variable: ${row.env.source}` : "Set from the environment",
    });
  }
  if (row.file !== undefined) badges.push({ label: "file", title: "Set in the config file" });
  // No "default" badge (owner 2026-11-09): nearly every row has a schema
  // default, so it attested nothing. Badges are OVERRIDE sources only; the
  // "differs from default" marker carries the one default fact worth space.
  return badges;
}

function differsFromDefault(row: ConfigKeyEntryWire): boolean {
  if (row.redacted || row.default === undefined || row.resolved === undefined) return false;
  try {
    return JSON.stringify(row.resolved) !== JSON.stringify(row.default);
  } catch {
    return false;
  }
}

// ── Row rendering (immediate-save controls) ─────────────────────────────────

/** Everything a row needs from the panel's editor context (props are threaded
 *  one level through the row to keep rows render-pure). */
interface RowUI {
  /** The in-use config file path (snapshot.files' inUse entry) for the
   *  edit-in-file hint on rows the server does not offer to edit. */
  filePath: string;
  /** The JSON container row whose textarea is expanded. */
  editing: string | null;
  /** Paths with a save in flight or queued -> optimistic control text
   *  (latest intent wins: the queued value when one is queued). */
  desired: Map<string, string>;
  /** The path whose save is in flight right now (its queue entry, if any, is
   *  still the newest intent). */
  pendingKey: string | null;
  editError: { key: string; message: string } | null;
  needsRestart: boolean;
  editedKeys: string[];
  /** Expand a JSON container row's textarea. */
  onEdit: (keyPath: string) => void;
  onCancel: () => void;
  /** Raw control text + the server-stamped edit descriptor (the app parses
   *  with parseEditValue and sends/queues on parse success). */
  onSave: (keyPath: string, raw: string, edit: ConfigKeyEditWire) => void;
}

/** Seed the scalar control from the layer the edit targets: the file slot
 *  when set (that is what the edit will rewrite), else resolved, else the
 *  schema default. Purely a starting value -- the server persists what the
 *  save sends. A SEEDLESS stamp means the row's shipped form is a summary
 *  (truncated / URL-scrubbed): the box starts EMPTY and the user types a
 *  full replacement -- editing a stub would write the stub.
 *
 *  ROUND-TRIP FAITHFUL (owner 2026-11-11: the "(empty string)" leak). This is
 *  the ONE seed formatter for every scalar control (text, stepper value, enum
 *  select); it must NEVER route through displayConfigValue, whose placeholders
 *  are honest in the VALUE CELL but were being seeded into the field and
 *  re-written to disk on blur (a string whose real value is "" seeded the box
 *  with "(empty string)"). So: string -> raw text; boolean -> "true"/"false";
 *  number -> String(); undefined or null -> "" (a null scalar slot has nothing
 *  to carry -- it seeds empty and a real value can be typed; the write path
 *  never round-trips a null literal, so seeding "" is the honest posture). The
 *  JSON textarea seeds from jsonSeedText (JSON.stringify), already faithful. */
function editSeedText(row: ConfigKeyEntryWire): string {
  if (row.edit?.seedless === true) return "";
  const v = row.file !== undefined ? row.file : row.resolved !== undefined ? row.resolved : row.default;
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v; // RAW bytes -- never the display formatter
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return String(v); // a non-scalar in a scalar-stamped row cannot ship; be literal
}
/** Test seam: the round-trip-faithful seed formatters (see editSeedText). */
export { editSeedText, jsonSeedText };

/** Seed the JSON textarea from the row's SHIPPED value (file ?? resolved ??
 *  default), pretty-printed. Honest by construction: a JSON stamp only exists
 *  where the server shipped the payload byte-faithfully, so what you edit is
 *  what is on disk. */
function jsonSeedText(row: ConfigKeyEntryWire): string {
  const v = row.file !== undefined ? row.file : row.resolved !== undefined ? row.resolved : row.default;
  if (v === undefined) return "";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Read the sibling field's raw text from a Save/Enter/blur event. */
function readEditorText(e: Event): string {
  const src = ((e as { currentTarget?: unknown }).currentTarget ?? (e as { target?: unknown }).target) as
    | (HTMLElement & { parentNode?: unknown })
    | null;
  const holder = (src?.parentElement ?? src?.parentNode) as HTMLElement | null | undefined;
  const field = holder?.querySelector(".settings-edit-input") as unknown as { value: string } | null;
  return field?.value ?? "";
}

/** The immediate-save rule for text/stepper controls. While a save rides the
 *  path, a new value ALWAYS goes out (the app updates the queue -- even a
 *  value equal to the original seed: that is the user's undo); repeating the
 *  pending intent is a no-op. With nothing riding: an UNCHANGED seed saves
 *  nothing (zero wire traffic on a plain blur) and a SEEDLESS box saves only
 *  non-empty text (an empty replace would wipe the value; the placeholder
 *  says so). */
function saveTextIfNeeded(ui: RowUI, row: ConfigKeyEntryWire, raw: string): void {
  const edit = row.edit!;
  const desired = ui.desired.get(row.key);
  if (desired !== undefined) {
    if (desired !== raw) ui.onSave(row.key, raw, edit);
    return;
  }
  if (edit.seedless === true) {
    if (raw !== "") ui.onSave(row.key, raw, edit);
    return;
  }
  if (raw !== editSeedText(row)) ui.onSave(row.key, raw, edit);
}

function SettingsControl({ row, ui }: { row: ConfigKeyEntryWire; ui: RowUI }) {
  const edit = row.edit!;
  const seed = editSeedText(row);
  const shown = ui.desired.get(row.key) ?? seed;

  if (edit.writeOnly === true) {
    // REPLACE box: never prefilled (the old value never left the server),
    // type password (even the NEW bytes do not linger on screen), cleared on
    // Set. An empty Set is refused by the parse with the honest hint and
    // NEVER reaches the wire. Enter = Set.
    const setNow = (e: Event): void => {
      const src = ((e as { currentTarget?: unknown }).currentTarget ?? (e as { target?: unknown }).target) as
        | HTMLElement
        | null;
      const holder = src?.parentElement as HTMLElement | null;
      const field = holder?.querySelector(".settings-edit-input") as unknown as { value: string } | null;
      const raw = field?.value ?? "";
      if (field) field.value = ""; // the typed bytes leave the screen the moment Set fires
      ui.onSave(row.key, raw, edit);
    };
    return (
      <span className="settings-edit settings-edit-secret-wrap">
        <input
          className="settings-edit-input settings-edit-secret"
          type="password"
          value=""
          placeholder="set a new value (never shown)"
          autocomplete="new-password"
          aria-label={`New value for ${row.key} (secret: current value is not shown)`}
          onKeydown={(e: KeyboardEvent) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              setNow(e);
            }
          }}
        />
        <button type="button" className="settings-btn settings-save" onClick={(e: MouseEvent) => setNow(e)}>
          Set
        </button>
      </span>
    );
  }

  if (edit.type === "json") {
    // Containers are the ONE edit mode that stays explicit: the row reveals
    // a monospace textarea (Enter inserts a newline -- saving is the button;
    // Escape collapses).
    if (ui.editing !== row.key) {
      return (
        <button
          type="button"
          className="settings-btn settings-json-open"
          title={`Edit the whole ${row.key} container as JSON`}
          onClick={() => ui.onEdit(row.key)}
        >
          Edit JSON
        </button>
      );
    }
    return (
      <span className="settings-edit settings-edit-json-wrap">
        <textarea
          className="settings-edit-input settings-edit-json"
          rows={6}
          spellcheck="false"
          aria-label={`New JSON value for ${row.key}`}
          onKeydown={(e: KeyboardEvent) => {
            // Enter belongs to the JSON (multi-line work); Escape collapses.
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              ui.onCancel();
            }
          }}
        >
          {jsonSeedText(row)}
        </textarea>
        <button
          type="button"
          className="settings-btn settings-save"
          onClick={(e: MouseEvent) => ui.onSave(row.key, readEditorText(e), edit)}
        >
          {ui.pendingKey === row.key || ui.desired.has(row.key) ? "Saving..." : "Save"}
        </button>
        <button type="button" className="settings-btn settings-cancel" onClick={() => ui.onCancel()}>
          Cancel
        </button>
      </span>
    );
  }

  if (edit.type === "boolean") {
    // The toggle IS the save: flipping it fires. aria-checked follows the
    // optimistic value while pending and REVERTS when an error reply drops
    // the pending state (the row then re-seeds from the server-known value).
    const checked = shown !== "false";
    return (
      <button
        type="button"
        role="switch"
        className="settings-toggle"
        aria-checked={checked ? "true" : "false"}
        aria-label={`Toggle ${row.key}`}
        onClick={() => ui.onSave(row.key, checked ? "false" : "true", edit)}
      >
        <span className="settings-toggle-knob" />
      </button>
    );
  }

  const isNumber = edit.type === "number" || edit.type === "integer";

  if (!isNumber && Array.isArray(edit.enum) && edit.enum.length > 0) {
    // Schema enum: a dropdown of the server's set, saving on change. When the
    // current value is NOT in the set (a hand-authored config the schema has
    // since narrowed), a leading "(current)" option carries it verbatim --
    // never silently replaced -- and the first legal value is the placeholder
    // selection. Re-picking the shown value is a no-op (saveTextIfNeeded).
    const inSet = edit.enum.includes(shown);
    return (
      <span className="settings-edit settings-select">
        <select
          key={`${row.key}:${shown}`}
          className="settings-edit-input settings-select-input"
          aria-label={`Value for ${row.key}`}
          onChange={(e: Event) => {
            const src = ((e as { currentTarget?: unknown }).currentTarget ?? (e as { target?: unknown }).target) as
              | { value: string }
              | null;
            saveTextIfNeeded(ui, row, src?.value ?? "");
          }}
        >
          {/* Selection rides the OPTION's selected attribute: the real DOM
              never reflects a value attribute onto a <select>. */}
          {!inSet && <option value={shown} selected={true}>{shown} (current)</option>}
          {edit.enum.map((v) => (
            <option key={v} value={v} selected={v === shown}>{v}</option>
          ))}
        </select>
      </span>
    );
  }

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      saveTextIfNeeded(ui, row, readEditorText(e));
    }
  };
  const onBlur = (e: Event): void => {
    saveTextIfNeeded(ui, row, readEditorText(e));
  };

  if (isNumber) {
    // Every number row is a minus/plus stepper with the value between --
    // one control language for numbers, so bounded and unbounded rows read
    // identically (the browser's native spin buttons are suppressed in
    // CSS). Declared bounds CLAMP the steps and ride as input hints;
    // undeclared rows step freely. The value itself stays editable
    // (blur/Enter save like any input); the server revalidates every save.
    const stepBy = (e: MouseEvent, dir: number): void => {
      const btn = ((e as { currentTarget?: unknown }).currentTarget ?? (e as { target?: unknown }).target) as HTMLElement | null;
      const holder = btn?.parentElement as HTMLElement | null;
      const input = holder?.querySelector(".settings-edit-input") as unknown as { value: string } | null;
      const typedText = input?.value ?? shown;
      // An empty field is NOT zero (Number("") === 0 would step from a lie):
      // fall back to the panel's shown value, then the lower bound.
      const typed = typedText.trim() === "" ? NaN : Number(typedText);
      const from = Number.isFinite(typed) ? typed : Number(shown);
      const base = Number.isFinite(from) ? from : (edit.minimum ?? 0);
      const next = Math.min(edit.maximum ?? Infinity, Math.max(edit.minimum ?? -Infinity, base + dir));
      if (next === base) return; // already at the bound: nothing changes, nothing goes out
      if (input) input.value = String(next);
      saveTextIfNeeded(ui, row, String(next));
    };
    return (
      <span className="settings-edit settings-stepper">
        <button type="button" className="settings-step" aria-label={`Decrease ${row.key}`} onClick={(e: MouseEvent) => stepBy(e, -1)}>
          −
        </button>
        {/* The key rides the shown value: a revert (error reply dropping the
            pending state) remounts the field with the server-known text --
            the runtime patches attributes, and a DIRTY input would otherwise
            keep the refused bytes on screen forever. */}
        <input
          key={`${row.key}:${shown}`}
          className="settings-edit-input settings-step-value"
          type="number"
          value={shown}
          min={edit.minimum}
          max={edit.maximum}
          step={edit.type === "integer" ? "1" : undefined}
          aria-label={`Value for ${row.key}`}
          onKeydown={onKeydown}
          onBlur={onBlur}
        />
        <button type="button" className="settings-step" aria-label={`Increase ${row.key}`} onClick={(e: MouseEvent) => stepBy(e, 1)}>
          +
        </button>
      </span>
    );
  }

  // Long or multi-line strings (the prompts, e.g. the baton notice) become a
  // textarea so they are actually editable (owner 2026-11-11). Threshold: the
  // raw SEED holds a newline or runs past 80 chars. Saving stays on BLUR with
  // the RAW bytes (Enter inserts a newline and never saves; Escape blurs rather
  // than closing the dialog, so a stray Escape cannot destroy an in-progress
  // edit -- and because blur saves, no dirty textarea survives a close). Short
  // single-line strings keep the plain input below; the wire channel is
  // unchanged (a string rides `value`).
  if (seed.includes("\n") || seed.length > 80) {
    const textRows = Math.min(12, Math.max(2, seed.split("\n").length));
    return (
      <span className="settings-edit">
        <textarea
          key={`${row.key}:${shown}`}
          className="settings-edit-input settings-edit-longtext"
          rows={textRows}
          spellcheck="false"
          aria-label={`Value for ${row.key}`}
          onKeydown={(e: KeyboardEvent) => {
            if (e.key === "Escape") {
              // Retreat WITHIN the row: blur (which saves) instead of closing
              // the dialog. stopPropagation keeps the dialog's Escape handler
              // from firing while the textarea holds the edit.
              e.preventDefault();
              e.stopPropagation();
              ((e.currentTarget ?? e.target) as HTMLElement | null)?.blur?.();
            }
            // Enter and every other key fall through to the textarea's own
            // newline behavior -- nothing saves on Enter here.
          }}
          onBlur={onBlur}
        >
          {shown}
        </textarea>
      </span>
    );
  }

  // String -> text input (seeded, or the honest EMPTY seedless box); saves
  // on blur/Enter, never on unchanged. (Every number row took the stepper
  // branch above, so this tail is short single-line strings.)
  return (
    <span className="settings-edit">
      <input
        key={`${row.key}:${shown}`}
        className="settings-edit-input"
        type="text"
        value={shown}
        placeholder={
          edit.seedless === true
            ? "current value is too long or hidden to display -- type a full replacement"
            : undefined
        }
        aria-label={`Value for ${row.key}`}
        onKeydown={onKeydown}
        onBlur={onBlur}
      />
    </span>
  );
}

function SettingsRow({ row, ui, catLabel = null }: { row: ConfigKeyEntryWire; ui: RowUI; catLabel?: string | null }) {
  // A writeOnly stamp is the ONE secret row that edits (the REPLACE box shows
  // no value); every other secret row stays inert. canEdit is the server's
  // stamp's wire twin -- the client-side checks are belts so a hostile or
  // ancient reply cannot unlock a redacted row.
  const writeOnly = row.edit?.writeOnly === true;
  const canEdit = row.edit !== undefined && (!row.leafSecret || writeOnly);
  const editedPending = ui.editedKeys.includes(row.key);
  const cell = valueCell(row, editedPending);
  const badges = sourceBadges(row);
  const differs = differsFromDefault(row);
  const busy = ui.pendingKey === row.key || ui.desired.has(row.key);
  const error = ui.editError && ui.editError.key === row.key ? ui.editError.message : null;
  return (
    <div
      className={`settings-row${cell.redacted ? " settings-row-redacted" : ""}${busy ? " settings-row-pending" : ""}`}
      data-key={row.key}
      title={row.key}
    >
      <div className="settings-row-main">
        <span className="settings-row-label">{friendlyLabel(row.key)}</span>
        {row.description !== undefined && row.description !== "" ? (
          <span className="settings-row-desc">{row.description}</span>
        ) : (
          // No schema description: the raw keyPath in monospace. The panel
          // never invents prose.
          <span className="settings-row-desc settings-row-key">{row.key}</span>
        )}
        <span className="settings-row-meta">
          {catLabel !== null ? (
            <span className="settings-badge settings-cat-chip" title="Category">
              {catLabel}
            </span>
          ) : null}
          {cell.nested ? (
            <span className="settings-badge settings-badge-diff" title="A secret-shaped entry inside this value was redacted to null server-side">
              fields redacted
            </span>
          ) : null}
          {differs && !cell.pending ? (
            <span className="settings-badge settings-badge-diff" title="Resolved value differs from the schema default">
              ≠ default
            </span>
          ) : null}
          {badges.map((b) => (
            <span key={b.label} className="settings-badge" title={b.title}>
              {b.label}
            </span>
          ))}
          {editedPending && ui.needsRestart ? (
            <span className="settings-badge settings-badge-diff" title="Persisted to the config file; applied when the server restarts">
              restart pending
            </span>
          ) : null}
          {busy ? (
            <span className="settings-badge settings-badge-pending" title="A save for this row is in flight; the row settles from the server's reply">
              saving
            </span>
          ) : null}
        </span>
      </div>
      <div className="settings-row-control">
        {!canEdit ? (
          <>
            <span
              className="settings-value"
              title={cell.pending ? "Saved to the config file; the running server keeps its startup value until restart" : undefined}
            >
              {cell.text}
            </span>
            {/* The honest refusals wear this hint (everything else carries a
                stamp): the server could not promise an edit here -- the
                shipped payload redacts/stubs something inside, the locator
                cannot address the path (duplicate key, broken file, un-
                spellable key), or a null carries no write shape. That
                includes UNSTAMPED secret rows (a duplicated apiKey, the
                provider-fallback slot): the file stays the interface there
                too -- an honest hint costs nothing. */}
            <span className="settings-file-hint" title={`edit in file: ${ui.filePath} (hotdog rescue validates it)`}>
              edit in file
            </span>
          </>
        ) : writeOnly ? (
          <>
            {/* The redaction stays the DISPLAY; the REPLACE box beside it
                never shows anything. */}
            <span className="settings-value">{cell.text}</span>
            <SettingsControl row={row} ui={ui} />
          </>
        ) : row.edit?.type === "json" && ui.editing !== row.key ? (
          <>
            {/* Collapsed containers still SHOW their value; the textarea is
                the reveal. */}
            <span
              className="settings-value"
              title={cell.pending ? "Saved to the config file; the running server keeps its startup value until restart" : undefined}
            >
              {cell.text}
            </span>
            <SettingsControl row={row} ui={ui} />
          </>
        ) : (
          <SettingsControl row={row} ui={ui} />
        )}
      </div>
      {error !== null ? (
        // Verbatim server text (or the local parse hint) -- no rewording.
        <div className="settings-edit-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

// ── Provider cards (owner 2026-11-11: one card per provider) ─────────────────
// The Providers category is NOT a flat row list: the snapshot ships the rows
// for a card layout (a `providers` section heading row, a `providers[i]` header
// chrome row per element, its field rows, and create-on-write rows for known
// children the file omits). The client renders those as ONE CARD PER PROVIDER:
//   - the `providers` row lands as the section heading (its chrome -- never a
//     whole-array dump);
//   - each `providers[i]` row is the card header (provider name bold + the mono
//     providers[i] path) with a two-step Remove;
//   - the element's field rows render inside the card body via the existing
//     control machinery (apiKey keeps the writeOnly REPLACE idiom);
//   - an unknown extra key in the element is a field row too (still renders,
//     never dropped); a known-but-absent child reads "(unset)" and gets a live
//     control because the server ships a create-on-write stamp for it.
// The unparseable-file FALLBACK ships dotted `providers.<name>.<field>` rows
// (name-keyed, read-only): they group into the same card shape by name, with
// no remove and no Add affordance (the list ops need a parseable array; the
// server refuses them and the file stays the interface -- the card hides
// "+ Add provider" with that one-line reason, owner 2026-11-11 audit finding
// 5, so the comment and the UI tell the same story).

const PROVIDERS_NAMESPACE = "providers";

/** True when `node` or an ancestor carries the affordance marker, so a
 *  "click-away" that lands inside the Add field or the two-step Remove does NOT
 *  cancel it. (Manual walk -- the shared dom helper has no closest().) */
function insideProviderAffordance(node: unknown): boolean {
  let cur = node as { getAttribute?: (n: string) => string | null; parentNode?: unknown } | null | undefined;
  const seen = new Set<unknown>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const cls = cur.getAttribute?.("class") ?? "";
    if (cls.includes("settings-provider-affordance")) return true;
    cur = cur.parentNode as typeof cur;
  }
  return false;
}

interface ProviderCardData {
  /** The element chrome row key ("providers[0]"). */
  key: string;
  /** The array index, or null for a fallback (name-keyed) card. */
  index: number | null;
  /** The provider name (header label), or the chrome key when unnameable. */
  name: string;
  /** The card header chrome row (present for element cards). */
  header?: ConfigKeyEntryWire;
  /** The element's field rows (present + known-but-absent create rows). */
  fields: ConfigKeyEntryWire[];
}

interface ProviderSplit {
  /** The top `providers` row (the section heading's chrome), if shipped. */
  top?: ConfigKeyEntryWire;
  /** Element cards, in array-index order. */
  cards: ProviderCardData[];
  /** Fallback name-keyed groups (unparseable-array shape), in first-seen order. */
  fallbacks: Array<{ name: string; rows: ConfigKeyEntryWire[] }>;
  /** Providers rows the split could not place (a malformed index, a bare
   *  "providers.x" with no field) -- still rendered once, flat, so NOTHING is
   *  ever dropped. */
  leftovers: ConfigKeyEntryWire[];
}

/** Read a provider element's name off its header row (the element object's
 *  `name` member) or its `providers[i].name` field row; never invented. */
function providerNameOf(header: ConfigKeyEntryWire | undefined, fields: ConfigKeyEntryWire[]): string {
  const file = header?.file;
  if (file && typeof file === "object" && !Array.isArray(file)) {
    const n = (file as Record<string, unknown>).name;
    if (typeof n === "string" && n !== "") return n;
  }
  const nameRow = fields.find((r) => /\.name$/.test(r.key));
  const v = nameRow?.file ?? nameRow?.resolved;
  if (typeof v === "string" && v !== "") return v;
  return header?.key ?? "";
}

/** The provider-LIST chrome rows (the `providers` section heading + the per-
 *  element `providers[i]` card headers). Their container value must NEVER be
 *  painted as a flat dump -- same doctrine in the search list as in the
 *  category view (audit finding 1, 2026-11-11): heading form only. */
function isProviderChromeKey(key: string): boolean {
  return key === PROVIDERS_NAMESPACE || /^providers\[\d+\]$/.test(key);
}

/** Partition a providers-category row list into the card shape. Every shipped
 *  row lands in exactly one place: top heading, one card's header, one card's
 *  fields, or a fallback group. */
export function splitProviderRows(rows: ConfigKeyEntryWire[]): ProviderSplit {
  const top = rows.find((r) => r.key === PROVIDERS_NAMESPACE);
  const byIndex = new Map<number, { header?: ConfigKeyEntryWire; fields: ConfigKeyEntryWire[] }>();
  const fallback = new Map<string, ConfigKeyEntryWire[]>();
  const leftovers: ConfigKeyEntryWire[] = [];
  for (const row of rows) {
    if (row.key === PROVIDERS_NAMESPACE) continue; // the top chrome (the heading)
    const elem = /^providers\[(\d+)\]/.exec(row.key);
    if (elem) {
      const idx = Number(elem[1]);
      const slot = byIndex.get(idx) ?? { fields: [] };
      if (row.key === `providers[${idx}]`) slot.header = row;
      else slot.fields.push(row); // providers[idx].something (field/create rows)
      byIndex.set(idx, slot);
      continue;
    }
    const dotted = /^providers\.([^.]+)\./.exec(row.key);
    if (dotted) {
      const name = dotted[1]!;
      const bucket = fallback.get(name) ?? [];
      bucket.push(row);
      fallback.set(name, bucket);
      continue;
    }
    leftovers.push(row);
  }
  const cards: ProviderCardData[] = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, slot]) => ({
      key: `providers[${index}]`,
      index,
      name: providerNameOf(slot.header, slot.fields),
      header: slot.header,
      fields: slot.fields,
    }));
  return {
    ...(top ? { top } : {}),
    cards,
    fallbacks: [...fallback.entries()].map(([name, groupRows]) => ({ name, rows: groupRows })),
    leftovers,
  };
}

interface ProviderCardProps {
  card: ProviderCardData;
  ui: RowUI;
  confirmRemoveKey: string | null;
  listBusy: boolean;
  focusName: string | null;
  onArm: (cardKey: string, index: number, name: string) => void;
  onConfirm: (index: number, name: string) => void;
  onCancel: () => void;
}

/** One provider card: header (name + mono path + two-step Remove) + field rows. */
function ProviderCard({ card, ui, confirmRemoveKey, listBusy, focusName, onArm, onConfirm, onCancel }: ProviderCardProps) {
  const confirm = confirmRemoveKey === card.key;
  const removable = card.index !== null; // fallback cards have no array index to remove
  const busy = listBusy;
  return (
    <div
      className={`settings-provider-card${confirm ? " settings-provider-card-confirm" : ""}`}
      data-key={card.key}
      data-name={card.name}
      data-focus={focusName !== null && card.name === focusName ? "true" : undefined}
    >
      <div className="settings-provider-card-header settings-provider-affordance">
        <span className="settings-provider-name">{card.name}</span>
        <span className="settings-provider-path">{card.key}</span>
        {removable ? (
          confirm ? (
            <span className="settings-provider-remove-confirm">
              <button
                type="button"
                className="settings-btn settings-provider-remove-yes"
                disabled={busy}
                onClick={() => onConfirm(card.index as number, card.name)}
              >
                Confirm remove "{card.name}"
              </button>
              <button type="button" className="settings-btn" onClick={onCancel}>
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="settings-btn settings-provider-remove"
              disabled={busy}
              onClick={() => onArm(card.key, card.index as number, card.name)}
            >
              Remove
            </button>
          )
        ) : null}
      </div>
      <div className="settings-provider-card-body">
        {card.fields.map((row) => (
          <SettingsRow key={row.key} row={row} ui={ui} />
        ))}
      </div>
    </div>
  );
}

/** Fallback (unparseable-array) provider block: name header + read-only field
 *  rows. No add/remove (the file is unaddressable; the server refuses list ops). */
function ProviderFallbackCard({ name, rows, ui }: { name: string; rows: ConfigKeyEntryWire[]; ui: RowUI }) {
  return (
    <div className="settings-provider-card settings-provider-card-readonly" data-name={name}>
      <div className="settings-provider-card-header">
        <span className="settings-provider-name">{name}</span>
        <span className="settings-provider-path">providers.{name}</span>
      </div>
      <div className="settings-provider-card-body">
        {rows.map((row) => (
          <SettingsRow key={row.key} row={row} ui={ui} />
        ))}
      </div>
    </div>
  );
}

interface ProviderAddProps {
  adding: boolean;
  busy: boolean;
  error: string | null;
  onAdd: () => void;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/** The "+ Add provider" affordance: a button that opens an inline name field;
 *  Enter or Add commits; Cancel/Escape dismisses; the refusal renders verbatim
 *  below (including the LOCAL empty-name refusal -- that never touched the wire). */
function ProviderAddControl({ adding, busy, error, onAdd, onCommit, onCancel }: ProviderAddProps) {
  const commit = (e: Event): void => {
    const src = ((e as { currentTarget?: unknown }).currentTarget ?? (e as { target?: unknown }).target) as
      | (HTMLElement & { parentNode?: unknown })
      | null;
    const holder = (src?.parentElement ?? src?.parentNode) as HTMLElement | null | undefined;
    const field = holder?.querySelector(".settings-provider-add-input") as unknown as { value: string } | null;
    onCommit(field?.value ?? "");
  };
  return (
    <div className="settings-provider-add settings-provider-affordance">
      {adding ? (
        <span className="settings-provider-add-row">
          <input
            className="settings-provider-add-input"
            type="text"
            placeholder="new provider name"
            aria-label="New provider name"
            onKeydown={(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                commit(e);
              }
            }}
          />
          <button type="button" className="settings-btn settings-provider-add-go" disabled={busy} onClick={(e: MouseEvent) => commit(e)}>
            Add
          </button>
          <button type="button" className="settings-btn" onClick={onCancel}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button" className="settings-btn settings-provider-add-btn" disabled={busy} onClick={onAdd}>
          + Add provider
        </button>
      )}
      {error !== null ? (
        <div className="settings-edit-error settings-provider-list-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** The whole Providers category: one section heading (the top `providers` row's
 *  chrome -- carrying its data-key so the shipped row renders exactly once), one
 *  card per provider, the read-only fallback blocks, any un-placed rows flat, and
 *  the add affordance. No whole-array dump and no per-element JSON container row
 *  renders while the leaf rows render. */
interface ProviderSectionProps {
  rows: ConfigKeyEntryWire[];
  ui: RowUI;
  confirmRemoveKey: string | null;
  listBusy: boolean;
  focusProviderName: string | null;
  addingProvider: boolean;
  providerListError: string | null;
  onAdd: () => void;
  onCommitAdd: (name: string) => void;
  onCancelAdd: () => void;
  onArm: (cardKey: string, index: number, name: string) => void;
  onConfirm: (index: number, name: string) => void;
  onCancelRemove: () => void;
}

function ProviderSection(p: ProviderSectionProps) {
  const split = splitProviderRows(p.rows);
  return (
    <>
      <h3 className="settings-section-title settings-providers-heading" data-key={PROVIDERS_NAMESPACE}>
        {CATEGORY_TITLES[PROVIDERS_NAMESPACE] ?? "Providers"}
      </h3>
      {split.cards.map((card) => (
        <ProviderCard
          key={card.key}
          card={card}
          ui={p.ui}
          confirmRemoveKey={p.confirmRemoveKey}
          listBusy={p.listBusy}
          focusName={p.focusProviderName}
          onArm={p.onArm}
          onConfirm={p.onConfirm}
          onCancel={p.onCancelRemove}
        />
      ))}
      {split.fallbacks.map((f) => (
        <ProviderFallbackCard key={`provider-fb-${f.name}`} name={f.name} rows={f.rows} ui={p.ui} />
      ))}
      {split.leftovers.map((row) => (
        <SettingsRow key={row.key} row={row} ui={p.ui} />
      ))}
      {split.cards.length === 0 && split.fallbacks.length > 0 ? (
        // Fallback-shape section (dotted providers.<name>.<field> rows): the file's
        // `providers` value is no parseable array, so the list ops cannot run and
        // the server refuses them. The comment above and the panel now tell the
        // same story (audit finding 5): no Add affordance, one honest line.
        <div className="settings-provider-add-none" data-key={PROVIDERS_NAMESPACE}>
          Add / remove need a parseable providers array -- {`edit in file: ${p.ui.filePath} (hotdog rescue validates it)`}
        </div>
      ) : (
        <ProviderAddControl
          adding={p.addingProvider}
          busy={p.listBusy}
          error={p.providerListError}
          onAdd={p.onAdd}
          onCommit={p.onCommitAdd}
          onCancel={p.onCancelAdd}
        />
      )}
    </>
  );
}

/** Diagnostics banner: files that are broken/missing, then key-level
 *  findings (unknown / duplicate / removed). Renders key names and line
 *  numbers only -- the wire carries nothing else. Restyled (redesign C6) as
 *  the amber notice at the TOP of the right pane; behavior unchanged. */
export function DiagnosticsBanner({ snapshot }: { snapshot: ConfigSnapshotResultWire }) {
  const badFiles = snapshot.files.filter((f) => f.status !== "ok");
  const hasFindings = snapshot.findings.length > 0 || badFiles.length > 0;
  if (!hasFindings && !snapshot.truncated) return null;
  return (
    <div className="settings-diagnostics" role="status">
      {badFiles.map((f) => (
        <div key={f.path} className="settings-diag settings-diag-file">
          <span className="settings-diag-key">{f.status === "broken" ? "Broken config file" : "Config file missing"}</span>
          <span className="settings-diag-path">{f.path}</span>
          {f.parseError ? <span className="settings-diag-detail">{f.parseError}</span> : null}
          {(f.jsoncIssues ?? []).map((iss) => (
            <span key={iss.kind} className="settings-diag-detail">
              {iss.kind} at line{iss.lines.length > 1 ? "s" : ""} {iss.lines.join(", ")}
            </span>
          ))}
          {f.status === "broken" ? (
            <span className="settings-diag-hint">
              {f.fixable
                ? "Fixable: run `hotdog rescue fix` (a .bak backup is kept)"
                : "Not auto-fixable: edit the file at the marked position"}
            </span>
          ) : null}
        </div>
      ))}
      {snapshot.findings.map((fd, i) => (
        <div key={`${fd.type}-${fd.key}-${fd.line}-${i}`} className="settings-diag">
          {fd.type === "unknown-key" ? (
            <>
              <span className="settings-diag-key">Unknown key</span>
              <span className="settings-diag-name">{fd.key}</span>
              <span className="settings-diag-detail">line {fd.line} - hotdog ignores it</span>
              {fd.didYouMean && fd.didYouMean.length > 0 ? (
                <span className="settings-diag-suggest">did you mean {fd.didYouMean.map((s) => `"${s}"`).join(", ")}?</span>
              ) : null}
            </>
          ) : fd.type === "duplicate-key" ? (
            <>
              <span className="settings-diag-key">Duplicate key</span>
              <span className="settings-diag-name">{fd.key}</span>
              <span className="settings-diag-detail">
                line {fd.line} duplicates line {fd.firstLine} - the later value silently wins
              </span>
            </>
          ) : (
            <>
              <span className="settings-diag-key">Removed key</span>
              <span className="settings-diag-name">{fd.key}</span>
              <span className="settings-diag-detail">line {fd.line} - {fd.message}</span>
            </>
          )}
        </div>
      ))}
      {snapshot.truncated ? (
        <div className="settings-diag settings-diag-detail">List truncated -- see `hotdog rescue --json` for the full report.</div>
      ) : null}
    </div>
  );
}

export interface SettingsViewerProps {
  /** null until the first reply lands (or while re-fetching on open). */
  snapshot: ConfigSnapshotResultWire | null;
  /** A request is in flight (the open/refresh re-fetch). */
  pending: boolean;
  /** Stable ref identity so the app can move focus in on open. */
  rootRef: Ref;
  onClose: () => void;
  /** Re-issue with a fresh requestId (stale replies drop by id in the app). */
  onRefresh: () => void;
  // ── Editor context (all from SettingsPanelState; see the pure fns above) ──
  /** The JSON container row whose textarea is expanded. */
  editing: string | null;
  /** The write in flight (its `shown` text drives the row's optimistic control). */
  pendingSave: { key: string; reqId: number; shown: string } | null;
  /** Writes queued behind it (last-write-wins per path). */
  queuedSaves: SettingsQueuedSave[];
  /** The last write rejection, rendered VERBATIM under that row. */
  editError: { key: string; message: string } | null;
  /** A save persisted WITH needsRestart during this visit: the banner stays up. */
  needsRestart: boolean;
  /** Keys whose ok reply carried needsRestart ("restart pending" badge). */
  editedKeys: string[];
  /** Rail search query + selected category (null = all; while searching the
   *  category narrows the matched rows, see SettingsPanelState.category). */
  query: string;
  category: string | null;
  onQuery: (query: string) => void;
  onCategory: (category: string | null) => void;
  onEdit: (keyPath: string) => void;
  onCancelEdit: () => void;
  /** Raw control text + the server-stamped edit descriptor (the app parses
   *  with parseEditValue and sends/queues on parse success). */
  onSaveEdit: (keyPath: string, raw: string, edit: ConfigKeyEditWire) => void;
  // ── Provider-card context (owner 2026-11-11) ──
  /** The inline "+ Add provider" field is open. */
  addingProvider: boolean;
  /** The providers[i] card whose two-step Remove confirm is armed, or null. */
  confirmRemoveKey: string | null;
  /** Last list-op refusal, verbatim under the add affordance (or the local
   *  empty-name refusal). */
  providerListError: string | null;
  /** A provider list op (append/remove) is in flight -> the add/remove affordances
   *  are disabled (one op in flight). */
  listBusy: boolean;
  /** A just-added provider's name to bring into view/focus (the app focuses the
   *  matching card once the refreshed snapshot lands). */
  focusProviderName: string | null;
  onProviderAdd: () => void;
  onProviderAddCommit: (name: string) => void;
  onProviderAddCancel: () => void;
  onProviderRemoveArm: (cardKey: string, index: number, name: string) => void;
  onProviderRemoveConfirm: (index: number, name: string) => void;
  onProviderRemoveCancel: () => void;
}

export function SettingsViewer({
  snapshot,
  pending,
  rootRef,
  onClose,
  onRefresh,
  editing,
  pendingSave,
  queuedSaves,
  editError,
  needsRestart,
  editedKeys,
  query,
  category,
  onQuery,
  onCategory,
  onEdit,
  onCancelEdit,
  onSaveEdit,
  addingProvider,
  confirmRemoveKey,
  providerListError,
  listBusy,
  focusProviderName,
  onProviderAdd,
  onProviderAddCommit,
  onProviderAddCancel,
  onProviderRemoveArm,
  onProviderRemoveConfirm,
  onProviderRemoveCancel,
}: SettingsViewerProps) {
  // The in-use file (the one the server would write): the hint text for
  // non-editable rows names exactly that path.
  const filePath = snapshot?.files.find((f) => f.inUse)?.path ?? snapshot?.files[0]?.path ?? "";
  // Optimistic display: the queued entry (newest intent) wins over the
  // in-flight one; paths with no save riding read the server-known value.
  const desired = new Map<string, string>();
  if (pendingSave) desired.set(pendingSave.key, pendingSave.shown);
  for (const q of queuedSaves) desired.set(q.key, q.shown);
  const ui: RowUI = {
    filePath,
    editing,
    desired,
    pendingKey: pendingSave?.key ?? null,
    editError,
    needsRestart,
    editedKeys,
    onEdit,
    onCancel: onCancelEdit,
    onSave: onSaveEdit,
  };
  const groups = snapshot ? categoryGroups(snapshot) : [];
  const searching = query.trim() !== "";
  // Search-mode grouping. The rail counts FIELD UNITS (owner ruling
  // 2026-11-11): the matched rows resolve to their units against the FULL
  // group as context, so a match on `providers[1].url` claims the ONE
  // provider, two matches inside `workspace.paths` claim the array once,
  // and pure chrome matches (the `providers` heading) claim nothing.
  const matches = snapshot
    ? groups
        .map((g) => {
          const rows = g.rows.filter((r) => rowMatchesQuery(r, query));
          return { title: g.title, rows, units: fieldUnitKeys(rows, g.rows).length };
        })
        .filter((g) => g.rows.length > 0)
    : [];
  // The rail: search-active it is search-truth (matching categories only,
  // unit counts, "All settings" the total units); idle it is snapshot-truth
  // -- but BOTH modes count through the SAME fieldUnitCount seam.
  const rail = searching
    ? matches.filter((m) => m.units > 0).map((m) => ({ title: m.title, count: m.units }))
    : groups.map((g) => ({ title: g.title, count: fieldUnitCount(g.rows) }));
  const railTotal = searching
    ? matches.reduce((n, m) => n + m.units, 0)
    : groups.reduce((n, g) => n + fieldUnitCount(g.rows), 0);
  // The selection means what the rail shows. A category chosen before the
  // query that holds no matches is NEUTRALIZED for the duration of the search
  // (state survives -- clearing the box restores the narrowed view); during a
  // search a clicked category narrows the pane to that category's matches.
  const activeCategory =
    searching && category !== null && !rail.some((e) => e.title === category) ? null : category;
  const shownGroups =
    activeCategory === null
      ? searching ? matches : groups
      : (searching ? matches : groups).filter((g) => g.title === activeCategory);
  return (
    <div
      id="settings-view"
      className="settings-view"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-view-title"
      tabindex={-1}
      ref={rootRef}
      onKeydown={(e: KeyboardEvent) => {
        // Escape retreats in stages, never jumping out of the dialog when
        // there is something less drastic to cancel: an armed provider Remove
        // dismisses first, then an open Add field, then an expanded JSON
        // container, then a non-empty search box (clearing the query, the
        // same "collapse before you close" doctrine as the JSON reveal); only
        // with nothing pending does it close the dialog (the app hands focus
        // back to the settings button). Cancellation here is pure client
        // state -- ZERO wire traffic. Click-outside still does NOT close
        // (values get selected); it DOES cancel a pending provider op.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (confirmRemoveKey !== null) onProviderRemoveCancel();
          else if (addingProvider) onProviderAddCancel();
          else if (editing !== null) onCancelEdit();
          else if (query !== "") {
            onQuery("");
            // The controlled value ATTRIBUTE never rewrites a dirty input
            // (the stepper's lesson), and preventDefault suppressed the
            // browser's native search-clear -- take the field's live value
            // down with the query, by hand.
            const src = ((e as { currentTarget?: unknown }).currentTarget ?? (e as { target?: unknown }).target) as
              | HTMLElement
              | null;
            const box =
              src?.classList?.contains("settings-search") === true
                ? src
                : ((src?.querySelector?.(".settings-search") as HTMLElement | null) ?? null);
            if (box) (box as unknown as { value: string }).value = "";
          } else onClose();
        }
      }}
      onMousedown={(e: MouseEvent) => {
        // "Click away" cancels a pending provider add/remove (the two-step
        // Remove and the inline Add field) with zero wire traffic -- but only a
        // click OUTSIDE the affordance itself, so pressing Add/Cancel/Remove
        // still reaches its handler. (Manual ancestor walk: the shared dom
        // helper has no closest().)
        if (confirmRemoveKey === null && !addingProvider) return;
        if (insideProviderAffordance((e as unknown as { target?: unknown }).target)) return;
        if (confirmRemoveKey !== null) onProviderRemoveCancel();
        if (addingProvider) onProviderAddCancel();
      }}
    >
      <div className="settings-view-header">
        <h2 id="settings-view-title">Settings</h2>
        <button
          type="button"
          className="settings-btn"
          title="Re-read the config from disk and recompute the snapshot"
          disabled={pending}
          onClick={onRefresh}
        >
          Refresh
        </button>
        <button type="button" className="settings-btn settings-close" title="Close (Esc)" onClick={onClose}>
          ✕
        </button>
      </div>
      {needsRestart ? (
        // Persistent (this panel visit): survives row edits and snapshot
        // refreshes. The server never claims live effect -- config resolves
        // at startup, and this banner is where that honesty lives. It rides
        // the success REPLY's needsRestart field, never a hardcoded claim.
        <div className="settings-restart" role="status">
          Restart required to apply: saved values are written to the config file; the running server keeps its startup values until it restarts.
        </div>
      ) : null}
      {pending && !snapshot ? (
        <div className="settings-pending">Reading config snapshot...</div>
      ) : null}
      {snapshot ? (
        <div className="settings-view-body">
          <nav className="settings-rail" aria-label="Settings categories">
            <div className="settings-search-wrap">
              <input
                className={`settings-search${query !== "" ? " settings-search-filled" : ""}`}
                type="search"
                placeholder="Search settings"
                aria-label="Search settings"
                value={query}
                onInput={(e: Event) => {
                  const t = ((e as { currentTarget?: unknown }).currentTarget ?? (e as { target?: unknown }).target) as
                    | { value?: string }
                    | null;
                  onQuery(t?.value ?? "");
                }}
              />
              {query !== "" ? (
                // A real button (keyboard-reachable), rendered ONLY while the
                // box holds text -- the empty box has no reserved gutter.
                // Clearing keeps the caret's home: focus goes back to the
                // search field (in the real DOM the mousedown lands on the
                // button first, so this return is load-bearing).
                <button
                  type="button"
                  className="settings-search-clear"
                  aria-label="Clear search"
                  title="Clear search (Esc)"
                  onClick={(e: MouseEvent) => {
                    onQuery("");
                    const src = ((e as { currentTarget?: unknown }).currentTarget ?? (e as { target?: unknown }).target) as
                      | HTMLElement
                      | null;
                    const box = (src?.parentElement as HTMLElement | null)?.querySelector(
                      ".settings-search",
                    ) as unknown as { focus?: () => void; value?: string } | null;
                    if (box) box.value = ""; // the attribute patch never rewrites a dirty input
                    box?.focus?.();
                  }}
                >
                  ✕
                </button>
              ) : null}
            </div>
            <div className="settings-cats">
              <button
                type="button"
                className="settings-cat"
                aria-current={activeCategory === null ? "true" : "false"}
                onClick={() => onCategory(null)}
              >
                <span className="settings-cat-title">All settings</span>
                <span className="settings-cat-count">{railTotal}</span>
              </button>
              {rail.map((e) => (
                <button
                  type="button"
                  key={e.title}
                  className="settings-cat"
                  aria-current={activeCategory === e.title ? "true" : "false"}
                  onClick={() => onCategory(e.title)}
                >
                  <span className="settings-cat-title">{e.title}</span>
                  <span className="settings-cat-count">{e.count}</span>
                </button>
              ))}
            </div>
            <div className="settings-dir" title="The config directory the running server resolved">
              config dir: {snapshot.configDir}
            </div>
          </nav>
          <div className="settings-content">
            <DiagnosticsBanner snapshot={snapshot} />
            {shownGroups.length === 0 ? (
              <div className="settings-empty">No settings match your search.</div>
            ) : searching ? (
              shownGroups.map((g) => (
                <section className="settings-section" key={g.title}>
                  {g.rows.map((row) =>
                    isProviderChromeKey(row.key) ? (
                      // The search list obeys the category view's doctrine (audit
                      // finding 1): chrome rows render in HEADING form, never as a
                      // flattened-container dump. Nothing is dropped -- the matched
                      // chrome still surfaces as its heading. The RAIL counts the
                      // units: the top `providers` heading is pure chrome (0), the
                      // element card header IS the provider's unit (doctrine rule 3),
                      // so the number agrees with the field the user sees.
                      row.key === PROVIDERS_NAMESPACE ? (
                        <h3
                          key={row.key}
                          className="settings-section-title settings-providers-heading"
                          data-key={PROVIDERS_NAMESPACE}
                        >
                          {CATEGORY_TITLES[PROVIDERS_NAMESPACE] ?? "Providers"}
                        </h3>
                      ) : (
                        <div key={row.key} className="settings-provider-card-header" data-key={row.key} data-name={providerNameOf(row, [])}>
                          <span className="settings-provider-name">{providerNameOf(row, [])}</span>
                          <span className="settings-provider-path">{row.key}</span>
                        </div>
                      )
                    ) : (
                      <SettingsRow key={row.key} row={row} ui={ui} catLabel={g.title} />
                    ),
                  )}
                </section>
              ))
            ) : (
              shownGroups.map((g) =>
                g.title === CATEGORY_TITLES[PROVIDERS_NAMESPACE] ? (
                  <section className="settings-section" key={g.title}>
                    <ProviderSection
                      rows={g.rows}
                      ui={ui}
                      confirmRemoveKey={confirmRemoveKey}
                      listBusy={listBusy}
                      focusProviderName={focusProviderName}
                      addingProvider={addingProvider}
                      providerListError={providerListError}
                      onAdd={onProviderAdd}
                      onCommitAdd={onProviderAddCommit}
                      onCancelAdd={onProviderAddCancel}
                      onArm={onProviderRemoveArm}
                      onConfirm={onProviderRemoveConfirm}
                      onCancelRemove={onProviderRemoveCancel}
                    />
                  </section>
                ) : (
                  <section className="settings-section" key={g.title}>
                    <h3 className="settings-section-title">{g.title}</h3>
                    {g.rows.map((row) => (
                      <SettingsRow key={row.key} row={row} ui={ui} />
                    ))}
                  </section>
                ),
              )
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
