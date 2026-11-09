/// <reference lib="dom" />
// Settings VIEWER: an overlay panel that renders the server's configSnapshot
// reply (see ../websocket/handlers-config.ts). The framing is deliberately
// snapshot-at-open: the server recomputes per request, but there is no live
// feed -- the panel says so.
//
// Doctrines this panel keeps:
// - Diagnostics banner FIRST: a broken config file (with the honest
//   `hotdog rescue fix` hint when fixable) and unknown/duplicate/removed key
//   findings -- key names, line numbers, did-you-mean. Values never ride the
//   findings, so there is nothing here that could echo one.
// - Secret rows (leafSecret) render "set (redacted)" or "unset" -- never a
//   length, a prefix, or a partial. The server already nulled every value;
//   the panel just refuses to render "null" as if it were the value.
// - Source badges appear only for slots the server ATTESTED (a missing slot
//   is an unattested layer, not "unset"). A row is marked when its resolved
//   value differs from the schema default.
// - Every value is a plain-text JSX child (the runtime escapes text; config
//   content never reaches the DOM as markup). Descriptions ride the native
//   title tooltip.
// - Escape closes with focus-return to the settings button (context-menu idiom: the
//   app owns the return, the panel owns the keypress). Click-outside does NOT
//   close: config values are selection targets.

import type { Ref } from "@utils/jsx";
import type {
  ConfigSnapshotResultWire,
  ConfigKeyEntryWire,
  ConfigSectionWire,
} from "@extensions/websocket/protocol.ts";

// ── Panel state (pure functions; app.tsx holds the atom) ────────────────────
// The requestId doctrine mirrors the search panel (app.tsx's searchReqId):
// every open/refresh/close bumps the sequence, so a late server reply
// carrying an older id is dropped in applySnapshotReply. Closing drops the
// snapshot too -- every open re-fetches (config may have changed on disk).

export interface SettingsPanelState {
  open: boolean;
  /** A snapshot request is in flight. */
  pending: boolean;
  snapshot: ConfigSnapshotResultWire | null;
  /** Monotonic request sequence; the CURRENT request's id rides the wire. */
  reqId: number;
}

export const initialSettingsPanelState: SettingsPanelState = {
  open: false,
  pending: false,
  snapshot: null,
  reqId: 0,
};

/** Settings button pressed: open + re-fetch (fresh id invalidates an older in-flight reply). */
export function openSettingsPanel(s: SettingsPanelState): SettingsPanelState {
  return { open: true, pending: true, snapshot: null, reqId: s.reqId + 1 };
}

/** Refresh button: same re-fetch, id bumped again. */
export function refreshSettingsPanel(s: SettingsPanelState): SettingsPanelState {
  return { ...s, pending: true, reqId: s.reqId + 1 };
}

/** Escape / ✕: close, drop the snapshot, and invalidate any in-flight reply. */
export function closeSettingsPanel(s: SettingsPanelState): SettingsPanelState {
  return { ...initialSettingsPanelState, reqId: s.reqId + 1 };
}

/** Server reply: stale ids drop here (search-panel precedent). */
export function applySnapshotReply(
  s: SettingsPanelState,
  requestId: number | undefined,
  snapshot: ConfigSnapshotResultWire,
): SettingsPanelState {
  if (requestId !== s.reqId) return s; // stale: superseded or the panel closed
  return { ...s, pending: false, snapshot };
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
 *  the value still renders (with nulls) plus an honest "fields redacted" tag. */
function valueCell(row: ConfigKeyEntryWire): { text: string; redacted: boolean; nested?: boolean } {
  if (row.leafSecret) {
    return { text: row.redacted ? "set (redacted)" : "unset", redacted: true };
  }
  const nested = row.redacted === true; // secret-shaped entries nulled inside a container value
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

function SettingsRow({ row }: { row: ConfigKeyEntryWire }) {
  const cell = valueCell(row);
  const badges = sourceBadges(row);
  const differs = differsFromDefault(row);
  return (
    <div className={`settings-row${cell.redacted ? " settings-row-redacted" : ""}`} title={row.description}>
      <span className="settings-key">{row.key}</span>
      <span className="settings-value">{cell.text}</span>
      <span className="settings-badges">
        {cell.nested ? (
          <span className="settings-badge settings-badge-diff" title="A secret-shaped entry inside this value was redacted to null server-side">
            fields redacted
          </span>
        ) : null}
        {differs ? (
          <span className="settings-badge settings-badge-diff" title="Resolved value differs from the schema default">
            ≠ default
          </span>
        ) : null}
        {badges.map((b) => (
          <span key={b.label} className="settings-badge" title={b.title}>
            {b.label}
          </span>
        ))}
      </span>
    </div>
  );
}

function SettingsSectionBody({ section }: { section: ConfigSectionWire }) {
  if (section.rows.length === 0) return null;
  return (
    <section className="settings-section">
      <h3 className="settings-section-title">{section.name}</h3>
      {section.rows.map((row) => (
        <SettingsRow key={row.key} row={row} />
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

export function SettingsViewer({ snapshot, pending, rootRef, onClose, onRefresh }: SettingsViewerProps) {
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
        // context-menu contract). Click-outside deliberately does NOT close.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="settings-view-header">
        <h2 id="settings-view-title">Settings</h2>
        <span className="settings-view-scope" title="The server recomputed this when the panel opened; there is no live feed.">
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
            <SettingsSectionBody key={section.name} section={section} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
