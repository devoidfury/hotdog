/// <reference lib="dom" />
// Settings VIEWER + EDITOR: an overlay panel that renders the server's
// configSnapshot reply (see ../websocket/handlers-config.ts). The framing is
// deliberately snapshot-at-open: the server recomputes per request, but
// there is no live feed -- the panel says so. Editing rides the same frame:
// EVERY row the server stamped `edit` offers an affordance (owner ruling
// 2026-11-09: ALL the settings; the hint survives ONLY on the two honest
// refusal classes -- rows whose shipped payload is a redacted/stubbed
// summary, and paths the surgical locator cannot address), saves go out as
// setConfigKey (fresh requestId per save, stale replies dropped), and success
// is honest -- the value is persisted to the file, the running server needs
// a restart to apply it (persistent banner; the server never claims live
// effect).
//
// Doctrines this panel keeps:
// - Diagnostics banner FIRST: a broken config file (with the honest
//   `hotdog rescue fix` hint when fixable) and unknown/duplicate/removed key
//   findings -- key names, line numbers, did-you-mean. Values never ride the
//   findings, so there is nothing here that could echo one.
// - Secret rows (leafSecret) render "set (redacted)" or "unset" -- never a
//   length, a prefix, or a partial. The server already nulled every value;
//   the panel just refuses to render "null" as if it were the value. An
//   UNSTAMPED secret row (an old server, or a class-B refusal) stays fully
//   inert. A WRITEONLY stamp is the one exception: the REPLACE box (password
//   input) starts empty, refuses an empty save, and never shows any value --
//   before or after the save ("set (redacted)" remains the display).
// - Source badges appear only for slots the server ATTESTED (a missing slot
//   is an unattested layer, not "unset"). A row is marked when its resolved
//   value differs from the schema default.
// - Every value is a plain-text JSX child (the runtime escapes text; config
//   content never reaches the DOM as markup). Descriptions ride the native
//   title tooltip. Server error text renders VERBATIM -- this layer adds no
//   prose of its own to a refusal.
// - Escape closes with focus-return to the settings button (context-menu idiom: the
//   app owns the return, the panel owns the keypress). While a row is in
//   edit mode Escape cancels the edit instead. Click-outside does NOT
//   close: config values are selection targets.

import type { Ref } from "@utils/jsx";
import type {
  ConfigEditPayload,
  ConfigSnapshotResultWire,
  ConfigKeyEntryWire,
  ConfigKeyEditWire,
  ConfigSectionWire,
  SetConfigKeyResultWire,
} from "@extensions/websocket/protocol.ts";

// ── Panel state (pure functions; app.tsx holds the atom) ────────────────────
// The requestId doctrine mirrors the search panel (app.tsx's searchReqId):
// every open/refresh/close bumps the sequence, so a late server reply
// carrying an older id is dropped in applySnapshotReply. Closing drops the
// snapshot too -- every open re-fetches (config may have changed on disk).
// WRITES ride their own sequence (saveReqId): refreshing the snapshot never
// invalidates an in-flight save, and a save never invalidates snapshot
// replies. Only ok saves touch needsRestart / editedKeys / the row's file
// slot; refusals keep the row in edit mode with the server's text verbatim.

export type EditScalar = string | number | boolean;

export interface SettingsPanelState {
  open: boolean;
  /** A snapshot request is in flight. */
  pending: boolean;
  snapshot: ConfigSnapshotResultWire | null;
  /** Monotonic snapshot request sequence; the CURRENT request's id rides the wire. */
  reqId: number;
  /** The keyPath with an open inline editor (one row at a time), or null. */
  editing: string | null;
  /** A save is in flight, correlated by its own id. */
  pendingSave: { key: string; reqId: number } | null;
  /** Last save rejection (rendered verbatim on that row; the row stays editable). */
  editError: { key: string; message: string } | null;
  /** Monotonic write request sequence (separate from reqId -- see above). */
  saveReqId: number;
  /** A save has persisted during this panel visit: the restart banner stays
   *  up across further edits and snapshot refreshes (closed on close). */
  needsRestart: boolean;
  /** Keys whose file slot was updated from a server echo ("restart pending" badge). */
  editedKeys: string[];
}

export const initialSettingsPanelState: SettingsPanelState = {
  open: false,
  pending: false,
  snapshot: null,
  reqId: 0,
  editing: null,
  pendingSave: null,
  editError: null,
  saveReqId: 0,
  needsRestart: false,
  editedKeys: [],
};

/** Settings button pressed: open + re-fetch (fresh id invalidates an older in-flight reply).
 *  The editor context belongs to the visit: a new open starts clean (the
 *  restart truth of the previous visit is not re-attestable against a fresh
 *  snapshot anyway). */
export function openSettingsPanel(s: SettingsPanelState): SettingsPanelState {
  return {
    ...initialSettingsPanelState,
    open: true,
    pending: true,
    reqId: s.reqId + 1,
    saveReqId: s.saveReqId,
  };
}

/** Refresh button: same re-fetch, id bumped again (editor state survives). */
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

/** Edit pressed on a whitelisted row: open its inline editor (a previous
 *  rejection on another row is dismissed with the switch). */
export function startSettingsEdit(s: SettingsPanelState, keyPath: string): SettingsPanelState {
  return { ...s, editing: keyPath, editError: null };
}

/** Cancel (button, or Escape while editing): leave edit mode, drop the error.
 *  The error is dropped even when no row is open -- it renders on its row
 *  independently of edit mode, so a cancel must not leave it behind. */
export function cancelSettingsEdit(s: SettingsPanelState): SettingsPanelState {
  if (s.editing === null && s.editError === null) return s;
  return { ...s, editing: null, editError: null };
}

/** Client-side parse of the row editor's raw text against the server-stamped
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

/** A save the parse rejected: the row stays in edit mode with the hint. */
export function rejectSettingsSave(s: SettingsPanelState, key: string, message: string): SettingsPanelState {
  return { ...s, editError: { key, message } };
}

/** A save goes out: fresh write id, previous rejection cleared. The row
 *  remains in edit mode until the reply settles it. */
export function beginSettingsSave(s: SettingsPanelState, key: string): SettingsPanelState {
  const reqId = s.saveReqId + 1;
  return { ...s, saveReqId: reqId, pendingSave: { key, reqId }, editError: null };
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
 *  row updates from the server's echo and the restart banner goes up for
 *  good (this visit). refusal: verbatim, row stays in edit mode. */
export function applySetConfigReply(
  s: SettingsPanelState,
  requestId: number | undefined,
  result: SetConfigKeyResultWire,
): SettingsPanelState {
  if (!s.pendingSave || requestId !== s.pendingSave.reqId) return s; // stale: superseded or the panel closed
  const key = s.pendingSave.key;
  if (result.ok) {
    return {
      ...s,
      pendingSave: null,
      editing: null,
      editError: null,
      needsRestart: true,
      editedKeys: s.editedKeys.includes(key) ? s.editedKeys : [...s.editedKeys, key],
      snapshot: patchRowFileSlot(s.snapshot, key, result),
    };
  }
  return { ...s, pendingSave: null, editError: { key, message: result.error ?? "save failed" } };
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
  /** The keyPath whose inline editor is open (one row at a time). */
  editing: string | null;
  /** A setConfigKey reply is awaited (Save disabled while true). */
  saving: boolean;
  /** The last write rejection, rendered VERBATIM on that row. */
  editError: { key: string; message: string } | null;
  /** A save persisted during this visit: the restart banner stays up. */
  needsRestart: boolean;
  /** Keys updated from a server echo this visit ("restart pending" badge). */
  editedKeys: string[];
  onEdit: (keyPath: string) => void;
  onCancelEdit: () => void;
  /** Raw editor text + the server-stamped edit descriptor (the app parses
   *  with parseEditValue and sends on parse success). */
  onSaveEdit: (keyPath: string, raw: string, edit: ConfigKeyEditWire) => void;
}

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

/** The row's value column. The server's redacted flag is the whole story on a
 *  leaf-secret row: redacted:true means some layer holds a real value there
 *  ("set (redacted)"), absence means nothing is set ("unset") -- the panel
 *  never re-derives set-ness from the nulled slot values. On container rows a
 *  redacted flag means secret-shaped entries were nulled INSIDE the value;
 *  the value still renders (with nulls) plus an honest "fields redacted" tag.
 *  A row saved this visit shows the PERSISTED file value (that is now the
 *  truth on disk) with "restart pending" -- the running server still holds
 *  the older resolved value until it restarts. */
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

// ── Row rendering (viewer + editor affordances) ─────────────────────────────

/** Everything a row needs from the panel's editor context (props are threaded
 *  one level through the section body to keep rows render-pure). */
interface RowUI {
  /** The in-use config file path (snapshot.files' inUse entry) for the
   *  edit-in-file hint on rows the server does not offer to edit. */
  filePath: string;
  editing: string | null;
  saving: boolean;
  editError: { key: string; message: string } | null;
  editedKeys: string[];
  onEdit: (keyPath: string) => void;
  onCancel: () => void;
  onSave: (keyPath: string, raw: string, edit: ConfigKeyEditWire) => void;
}

/** Seed the scalar editor from the layer the edit targets: the file slot when
 *  set (that is what the edit will rewrite), else resolved, else the schema
 *  default. Purely a starting value -- the server persists what Save sends.
 *  A SEEDLESS stamp means the row's shipped form is a summary (truncated /
 *  URL-scrubbed): the box starts EMPTY and the user types a full replacement
 *  -- editing a stub would write the stub. */
function editSeedText(row: ConfigKeyEntryWire): string {
  if (row.edit?.seedless === true) return "";
  const v = row.file !== undefined ? row.file : row.resolved !== undefined ? row.resolved : row.default;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === undefined) return "";
  return displayConfigValue(v);
}

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

/** Read the sibling field's raw text from a Save/Enter event. */
function readEditorText(e: Event): string {
  const src = ((e as { currentTarget?: unknown }).currentTarget ?? (e as { target?: unknown }).target) as
    | (HTMLElement & { parentNode?: unknown })
    | null;
  const holder = (src?.parentElement ?? src?.parentNode) as HTMLElement | null | undefined;
  const field = holder?.querySelector(".settings-edit-input") as unknown as { value: string } | null;
  return field?.value ?? "";
}

/** The honest-type inline input: number (or text) input, a two-option select
 *  for booleans, a monospace JSON textarea for containers, or a never-
 *  prefilled password box for a writeOnly secret replace. Bounds ride from
 *  the server's stamp (cosmetic hints; the server revalidates every save
 *  against the same schema/shape). */
function SettingsEditControl({ row, ui }: { row: ConfigKeyEntryWire; ui: RowUI }) {
  const edit = row.edit!;
  const seed = editSeedText(row);
  // Enter saves, Escape cancels -- on EVERY single-line control (a boolean
  // row must not demand the Save click its number/text twin does not).
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      ui.onSave(row.key, readEditorText(e), edit);
    } else if (e.key === "Escape") {
      // Cancel the EDIT, not the dialog (the dialog-level handler would close
      // the panel; the edit owns Escape while open).
      e.preventDefault();
      e.stopPropagation();
      ui.onCancel();
    }
  };
  // The JSON textarea: Enter inserts a newline (a JSON edit is multi-line
  // work -- saving is an explicit act), Escape still cancels the edit.
  const onTextareaKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      ui.onCancel();
    }
  };
  if (edit.writeOnly === true) {
    // REPLACE box: never prefilled (the old value never left the server),
    // type password (even the NEW bytes do not linger on screen), empty save
    // refused by the parse (client) and again by the server.
    return (
      <span className="settings-edit">
        <input
          className="settings-edit-input settings-edit-secret"
          type="password"
          value=""
          placeholder="set a new value (never shown)"
          autocomplete="new-password"
          aria-label={`New value for ${row.key} (secret: current value is not shown)`}
          onKeydown={onKeydown}
        />
        <button
          type="button"
          className="settings-btn settings-save"
          disabled={ui.saving}
          onClick={(e: MouseEvent) => ui.onSave(row.key, readEditorText(e), edit)}
        >
          {ui.saving ? "Saving..." : "Save"}
        </button>
        <button type="button" className="settings-btn settings-cancel" disabled={ui.saving} onClick={() => ui.onCancel()}>
          Cancel
        </button>
      </span>
    );
  }
  if (edit.type === "json") {
    return (
      <span className="settings-edit settings-edit-json-wrap">
        <textarea
          className="settings-edit-input settings-edit-json"
          rows={6}
          spellcheck="false"
          aria-label={`New JSON value for ${row.key}`}
          onKeydown={onTextareaKeydown}
        >
          {jsonSeedText(row)}
        </textarea>
        <button
          type="button"
          className="settings-btn settings-save"
          disabled={ui.saving}
          onClick={(e: MouseEvent) => ui.onSave(row.key, readEditorText(e), edit)}
        >
          {ui.saving ? "Saving..." : "Save"}
        </button>
        <button type="button" className="settings-btn settings-cancel" disabled={ui.saving} onClick={() => ui.onCancel()}>
          Cancel
        </button>
      </span>
    );
  }
  return (
    <span className="settings-edit">
      {edit.type === "boolean" ? (
        <select className="settings-edit-input" aria-label={`New value for ${row.key}`} onKeydown={onKeydown}>
          <option value="true" selected={seed !== "false"}>
            true
          </option>
          <option value="false" selected={seed === "false"}>
            false
          </option>
        </select>
      ) : (
        <input
          className="settings-edit-input"
          type={edit.type === "string" ? "text" : "number"}
          value={seed}
          placeholder={
            edit.seedless === true
              ? "current value is too long or hidden to display -- type a full replacement"
              : undefined
          }
          min={edit.minimum}
          max={edit.maximum}
          step={edit.type === "integer" ? "1" : undefined}
          aria-label={`New value for ${row.key}`}
          onKeydown={onKeydown}
        />
      )}
      <button
        type="button"
        className="settings-btn settings-save"
        disabled={ui.saving}
        onClick={(e: MouseEvent) => ui.onSave(row.key, readEditorText(e), edit)}
      >
        {ui.saving ? "Saving..." : "Save"}
      </button>
      <button type="button" className="settings-btn settings-cancel" disabled={ui.saving} onClick={() => ui.onCancel()}>
        Cancel
      </button>
    </span>
  );
}

function SettingsRow({ row, ui }: { row: ConfigKeyEntryWire; ui: RowUI }) {
  // A writeOnly stamp is the ONE secret row that edits (the REPLACE box shows
  // no value); every other secret row stays inert. canEdit is the server's
  // stamp's wire twin -- the client-side checks are belts so a hostile or
  // ancient reply cannot unlock a redacted row.
  const writeOnly = row.edit?.writeOnly === true;
  const editing = ui.editing === row.key && row.edit !== undefined && (!row.leafSecret || writeOnly);
  const editedPending = ui.editedKeys.includes(row.key);
  const cell = valueCell(row, editedPending);
  const badges = sourceBadges(row);
  const differs = differsFromDefault(row);
  const canEdit = row.edit !== undefined && (!row.leafSecret || writeOnly);
  return (
    <div className={`settings-row${cell.redacted ? " settings-row-redacted" : ""}`} title={row.description}>
      <span className="settings-key">{row.key}</span>
      {editing ? (
        <SettingsEditControl row={row} ui={ui} />
      ) : (
        <span
          className="settings-value"
          title={cell.pending ? "Saved to the config file; the running server keeps its startup value until restart" : undefined}
        >
          {cell.text}
        </span>
      )}
      <span className="settings-badges">
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
        {editedPending && row.edit !== undefined ? (
          <span className="settings-badge settings-badge-diff" title="Persisted to the config file; applied when the server restarts">
            restart pending
          </span>
        ) : null}
        {ui.editError && ui.editError.key === row.key ? (
          // Verbatim server text (or the local parse hint) -- no rewording.
          <span className="settings-edit-error" role="alert">
            {ui.editError.message}
          </span>
        ) : null}
        {editing ? null : canEdit ? (
          <button
            type="button"
            className="settings-edit-btn"
            disabled={ui.saving}
            title={`Edit ${row.key} in the config file (applies on restart)`}
            onClick={() => ui.onEdit(row.key)}
          >
            Edit
          </button>
        ) : (
          // The honest refusals wear this hint (everything else carries a
          // stamp): the server could not promise an edit here -- the shipped
          // payload redacts/stubs something inside, the locator cannot
          // address the path (duplicate key, broken file, un-spellable key),
          // or a null carries no write shape. That includes UNSTAMPED secret
          // rows (a duplicated apiKey, the provider-fallback slot): the file
          // stays the interface there too -- an honest hint costs nothing.
          <span className="settings-file-hint" title={`edit in file: ${ui.filePath} (hotdog rescue validates it)`}>
            edit in file
          </span>
        )}
      </span>
    </div>
  );
}

function SettingsSectionBody({ section, ui }: { section: ConfigSectionWire; ui: RowUI }) {
  if (section.rows.length === 0) return null;
  return (
    <section className="settings-section">
      <h3 className="settings-section-title">{section.name}</h3>
      {section.rows.map((row) => (
        <SettingsRow key={row.key} row={row} ui={ui} />
      ))}
    </section>
  );
}

/** Diagnostics banner: files that are broken/missing, then key-level
 *  findings (unknown / duplicate / removed). Renders key names and line
 *  numbers only -- the wire carries nothing else. */
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

export function SettingsViewer({
  snapshot,
  pending,
  rootRef,
  onClose,
  onRefresh,
  editing,
  saving,
  editError,
  needsRestart,
  editedKeys,
  onEdit,
  onCancelEdit,
  onSaveEdit,
}: SettingsViewerProps) {
  // The in-use file (the one the server would write): the hint text for
  // non-editable rows names exactly that path.
  const filePath = snapshot?.files.find((f) => f.inUse)?.path ?? snapshot?.files[0]?.path ?? "";
  const ui: RowUI = { filePath, editing, saving, editError, editedKeys, onEdit, onCancel: onCancelEdit, onSave: onSaveEdit };
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
        // Escape closes here; the app hands focus back to the settings button (the
        // context-menu contract). While a row editor is open, Escape cancels
        // the EDIT instead (progressive retreat, not a jump out of the dialog).
        // Click-outside deliberately does NOT close.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (editing !== null) onCancelEdit();
          else onClose();
        }
      }}
    >
      <div className="settings-view-header">
        <h2 id="settings-view-title">Settings</h2>
        <span
          className="settings-view-scope"
          title="The server recomputed this when the panel opened; there is no live feed. You are editing against a snapshot -- the server revalidates every save against the schema before writing."
        >
          snapshot-at-open
        </span>
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
        // at startup, and this banner is where that honesty lives.
        <div className="settings-restart" role="status">
          Restart required to apply: saved values are written to the config file; the running server keeps its startup values until it restarts.
        </div>
      ) : null}
      {pending && !snapshot ? (
        <div className="settings-pending">Reading config snapshot...</div>
      ) : null}
      {snapshot ? (
        <div className="settings-view-body">
          <DiagnosticsBanner snapshot={snapshot} />
          <div className="settings-dir" title="The config directory the running server resolved">
            config dir: {snapshot.configDir}
          </div>
          {snapshot.sections.map((section) => (
            <SettingsSectionBody key={section.name} section={section} ui={ui} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
