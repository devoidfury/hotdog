/// <reference lib="dom" />
// DOM tests for the settings viewer panel (settings-view.tsx) on the
// dom-helper: canned-snapshot rendering (sections / source badges /
// differs-from-default / redacted wording), diagnostics banner wording
// (the `hotdog rescue fix` hint, did-you-mean), Escape close + the pure
// panel-state doctrine (fresh id per open/refresh, stale replies dropped).
// The settings-button -> chat-header wiring and the live WS round trip are covered in
// app.test.tsx (the app-wiring single-booter).

import { describe, it, expect, afterEach } from "bun:test";
import {
  SettingsViewer,
  openSettingsPanel,
  refreshSettingsPanel,
  closeSettingsPanel,
  applySnapshotReply,
  initialSettingsPanelState,
  displayConfigValue,
} from "@extensions/webui/ui/settings-view.tsx";
import type { ConfigKeyEditWire, ConfigSnapshotResultWire } from "@extensions/websocket/protocol.ts";
import { mount, type DomNode, type Mounted } from "@utils/jsx";

const noop = (): void => {};

const CANNED: ConfigSnapshotResultWire = {
  type: "configSnapshotResult",
  ts: 1700000000000,
  configDir: "/home/u/.config/hotdog",
  files: [
    {
      path: "/home/u/.config/hotdog/defaults.json",
      inUse: true,
      status: "broken",
      parseError: 'Unexpected token "/" ... is not valid JSON',
      jsoncIssues: [{ kind: "comment", lines: [2] }, { kind: "trailing-comma", lines: [7, 8] }],
      fixable: true,
    },
  ],
  findings: [
    { type: "unknown-key", key: "themee", line: 5, didYouMean: ["theme"] },
    { type: "duplicate-key", key: "theme", line: 9, firstLine: 4 },
    { type: "removed-key", key: "maxToolOutputLines", line: 11, message: '"maxToolOutputLines" is no longer read; replaced by "maxToolResultChars"' },
  ],
  sections: [
    {
      name: "core",
      rows: [
        { key: "theme", description: "Theme", default: "dark", file: "light", resolved: "light" },
        {
          key: "apiKey",
          description: "API key for the AI endpoint.",
          default: null,
          env: { set: true, source: "HOTDOG_API_KEY" },
          resolved: null,
          leafSecret: true,
          redacted: true,
        },
        { key: "maxIterations", description: "Max iterations", default: 25, resolved: 25 },
      ],
    },
    {
      name: "webui",
      rows: [
        { key: "webui.port", description: "WebUI server port", default: 3000, file: 4321, cli: { flag: "--port", value: 4321 }, resolved: 4321 },
        {
          key: "webui.apiKey",
          description: "API key for login authentication.",
          default: null,
          env: { set: false, source: "HOTDOG_WEBUI_API_KEY" },
          resolved: null,
          leafSecret: true,
        },
      ],
    },
  ],
};

// ── Harness ─────────────────────────────────────────────────────────────────

let current: Mounted | null = null;

/** Editor-context defaults: the panel renders inert (no row in edit mode, no
 *  save in flight, no banner) unless a test opts into the editor props. */
function renderPanel(
  snapshot: ConfigSnapshotResultWire | null,
  opts: {
    pending?: boolean;
    onClose?: () => void;
    onRefresh?: () => void;
    editing?: string | null;
    saving?: boolean;
    editError?: { key: string; message: string } | null;
    needsRestart?: boolean;
    editedKeys?: string[];
    onEdit?: (key: string) => void;
    onCancelEdit?: () => void;
    onSaveEdit?: (key: string, raw: string, edit: ConfigKeyEditWire) => void;
  } = {},
): HTMLElement {
  const host = document.createElement("div");
  current = mount(
    <SettingsViewer
      snapshot={snapshot}
      pending={opts.pending ?? false}
      rootRef={() => {}}
      onClose={opts.onClose ?? noop}
      onRefresh={opts.onRefresh ?? noop}
      editing={opts.editing ?? null}
      saving={opts.saving ?? false}
      editError={opts.editError ?? null}
      needsRestart={opts.needsRestart ?? false}
      editedKeys={opts.editedKeys ?? []}
      onEdit={opts.onEdit ?? noop}
      onCancelEdit={opts.onCancelEdit ?? noop}
      onSaveEdit={opts.onSaveEdit ?? noop}
    />,
    host as unknown as DomNode,
  );
  return host.querySelector(".settings-view") as unknown as HTMLElement;
}

afterEach(() => {
  current?.unmount();
  current = null;
});

const rows = (root: HTMLElement) => Array.from(root.querySelectorAll(".settings-row")) as unknown as HTMLElement[];
const rowForKey = (root: HTMLElement, key: string): HTMLElement =>
  rows(root).find((r) => r.querySelector(".settings-key")!.textContent === key)!;
const rowText = (el: HTMLElement): string => el.textContent;
const badgesOf = (el: HTMLElement): string[] =>
  Array.from(el.querySelectorAll(".settings-badge"))
    .map((b) => b.textContent)
    .filter((t) => t !== "≠ default"); // the diff marker is asserted separately

// ── Panel structure ─────────────────────────────────────────────────────────

describe("settings viewer panel", () => {
  it("dialog semantics: role=dialog labelled by the title", () => {
    const root = renderPanel(CANNED);
    expect(root.getAttribute("role")).toBe("dialog");
    expect(root.getAttribute("aria-modal")).toBe("true");
    expect(root.getAttribute("aria-labelledby")).toBe("settings-view-title");
    expect(root.getAttribute("tabindex")).toBe("-1");
    expect(root.querySelector("#settings-view-title")!.textContent).toBe("Settings");
  });

  it("the snapshot-at-open framing is stated, never a live claim", () => {
    const root = renderPanel(CANNED);
    const scope = root.querySelector(".settings-view-scope")!;
    expect(scope.textContent).toBe("snapshot-at-open");
    expect(scope.getAttribute("title")).toContain("no live feed");
    expect(root.textContent.toLowerCase()).not.toContain("live config");
  });

  it("pending with no snapshot yet: honest loading line, no table", () => {
    const root = renderPanel(null, { pending: true });
    expect(root.querySelector(".settings-pending")!.textContent).toContain("snapshot");
    expect(root.querySelector(".settings-view-body")).toBeNull();
  });

  it("sections render in payload order, config dir rides once", () => {
    const root = renderPanel(CANNED);
    const titles = Array.from(root.querySelectorAll(".settings-section-title")).map((t) => t.textContent);
    expect(titles).toEqual(["core", "webui"]);
    expect(root.querySelector(".settings-dir")!.textContent).toContain("/home/u/.config/hotdog");
  });

  it("rows: key + resolved value + attested-slot badges only", () => {
    const root = renderPanel(CANNED);
    const port = rowForKey(root, "webui.port");
    expect(rowText(port)).toContain("4321");
    // Override-source badges only (owner 2026-11-09: no "default" badge);
    // env was not attested (no env slot).
    expect(badgesOf(port)).toEqual(["cli", "file"]);
    // differs from default => the ≠ marker.
    expect(port.querySelector(".settings-badge-diff")!.textContent).toBe("≠ default");

    const iters = rowForKey(root, "maxIterations");
    expect(rowText(iters)).toContain("25");
    // Nothing overrides and default == resolved => the row carries NO badge.
    expect(iters.querySelector(".settings-badge-diff")).toBeNull();
    expect(badgesOf(iters)).toEqual([]);

    const theme = rowForKey(root, "theme");
    expect(badgesOf(theme)).toEqual(["file"]);
    expect(theme.querySelector(".settings-badge-diff")!.textContent).toBe("≠ default");
  });

  it("schema description rides the native title", () => {
    const root = renderPanel(CANNED);
    expect(rowForKey(root, "theme").getAttribute("title")).toBe("Theme");
    expect(rowForKey(root, "webui.port").getAttribute("title")).toBe("WebUI server port");
  });

  it("redacted rows say set (redacted) / unset -- never a length or partial", () => {
    const root = renderPanel(CANNED);
    const apiKey = rowForKey(root, "apiKey");
    expect(rowText(apiKey)).toContain("set (redacted)");
    // No digit could be a leaked hint at the key's shape.
    expect(rowText(apiKey).replace(/\d/g, "") === rowText(apiKey)).toBe(true);

    const webuiKey = rowForKey(root, "webui.apiKey");
    expect(rowText(webuiKey)).toContain("unset");
    expect(rowText(webuiKey)).not.toContain("redacted");
  });

  it("a slot-redacted env value (null) renders (redacted), never the word null", () => {
    const root = renderPanel({
      ...CANNED,
      files: [{ path: "/x/defaults.json", inUse: true, status: "ok" }],
      findings: [],
      sections: [
        {
          name: "webui",
          rows: [
            {
              key: "webui.loginCache",
              description: "Login cache namespace",
              env: { set: true, source: "HOTDOG_LOGIN_TOKEN", value: null },
              redacted: true,
            },
          ],
        },
      ],
    });
    const row = rowForKey(root, "webui.loginCache");
    expect(rowText(row)).toContain("(redacted)");
    expect(rowText(row)).not.toContain("null");
    // The nested-redaction tag rides (the row-level flag is set), then the
    // env badge names the slot's source in its title.
    expect(badgesOf(row)).toEqual(["fields redacted", "env"]);
    const envBadge = Array.from(row.querySelectorAll(".settings-badge")).find((b) => b.textContent === "env")!;
    expect(envBadge.getAttribute("title")).toBe("Environment variable: HOTDOG_LOGIN_TOKEN");
  });

  it("a profiles row from a pre-shaping server still renders stubs, not walls", () => {
    // The wire-side body stub is a SERVER change; a daemon older than it
    // ships the full profile bodies. The client must render the row as
    // structure + length stubs regardless (owner 2026-11-09, the wall-of-
    // text report came from exactly such a stale daemon).
    const body = "# Your job: code quality auditor. ".repeat(30); // ~1020 chars
    const root = renderPanel({
      ...CANNED,
      files: [{ path: "/x/defaults.json", inUse: true, status: "ok" }],
      findings: [],
      sections: [
        {
          name: "core",
          rows: [
            {
              key: "profiles",
              description: "Inline profile overrides",
              resolved: { auditor: { body, model: "m1" } },
            },
          ],
        },
      ],
    });
    const text = rowText(rowForKey(root, "profiles"));
    expect(text).not.toContain("code quality auditor");
    expect(text).toContain("[1020-char text omitted]");
    expect(text).toContain("model: m1"); // short scalars still ride
  });

  it("container rows with nested redaction render the value + an honest 'fields redacted' tag", () => {
    const root = renderPanel({
      ...CANNED,
      files: [{ path: "/x/defaults.json", inUse: true, status: "ok" }],
      findings: [],
      sections: [
        {
          name: "bashTool",
          rows: [
            {
              key: "bashTool.env",
              description: "Extra environment variables",
              resolved: { GITHUB_TOKEN: null, PATH: "/usr/bin" },
              redacted: true,
            },
          ],
        },
      ],
    });
    const row = rowForKey(root, "bashTool.env");
    expect(rowText(row)).toContain("GITHUB_TOKEN: null");
    expect(rowText(row)).toContain("/usr/bin");
    expect(rowText(row)).toContain("fields redacted");
    // It is NOT a leaf-secret row: no "set (redacted)" phrasing.
    expect(rowText(row)).not.toContain("(redacted)");
  });

  it("every value is plain text (no markup), descriptions too", () => {
    const root = renderPanel({
      ...CANNED,
      sections: [
        {
          name: "core",
          rows: [
            { key: "prompt", description: '<img src=x onerror="boom">', resolved: '<script>alert(1)</script>' },
          ],
        },
      ],
    });
    const row = rowForKey(root, "prompt");
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector("script")).toBeNull();
    // The text is rendered verbatim (the JSX runtime escapes; the parsed DOM
    // carries it as text, not as an element).
    expect(row.textContent).toContain("<script>alert(1)</script>");
  });
});

// ── Diagnostics banner ──────────────────────────────────────────────────────

describe("settings viewer diagnostics banner", () => {
  it("broken file: status, parse message, JSONC kinds with lines, fix hint", () => {
    const root = renderPanel(CANNED);
    const banner = root.querySelector(".settings-diagnostics")!;
    expect(banner.textContent).toContain("Broken config file");
    expect(banner.textContent).toContain("/home/u/.config/hotdog/defaults.json");
    expect(banner.textContent).toContain("is not valid JSON");
    expect(banner.textContent).toContain("comment at line 2");
    expect(banner.textContent).toContain("trailing-comma at lines 7, 8");
    expect(banner.textContent).toContain("hotdog rescue fix");
  });

  it("not fixable: says edit, never offers rescue fix", () => {
    const root = renderPanel({
      ...CANNED,
      files: [{ ...CANNED.files[0]!, fixable: false }],
      findings: [],
    });
    const banner = root.querySelector(".settings-diagnostics")!;
    expect(banner.textContent).toContain("Not auto-fixable");
    expect(banner.textContent).not.toContain("hotdog rescue fix");
  });

  it("findings: unknown + did-you-mean, duplicate pointing at both lines, removed tombstone -- no values", () => {
    const root = renderPanel(CANNED);
    const banner = root.querySelector(".settings-diagnostics")!;
    expect(banner.textContent).toContain("Unknown key");
    expect(banner.textContent).toContain("themee");
    expect(banner.textContent).toContain('did you mean "theme"?');
    expect(banner.textContent).toContain("duplicates line 4");
    expect(banner.textContent).toContain("later value silently wins");
    expect(banner.textContent).toContain("maxToolOutputLines");
    expect(banner.textContent).toContain("maxToolResultChars");
    // The banner NEVER renders values: the wire has none, and nothing here
    // echoes one (the canned fixture has no value fields to render anyway).
    expect(banner.querySelectorAll(".settings-diag .settings-value")).toHaveLength(0);
  });

  it("clean file and no findings: no banner at all", () => {
    const root = renderPanel({ ...CANNED, files: [{ path: "/x/defaults.json", inUse: true, status: "ok" }], findings: [] });
    expect(root.querySelector(".settings-diagnostics")).toBeNull();
  });
});

// ── Escape / close / refresh ────────────────────────────────────────────────

describe("settings viewer interactions", () => {
  const keyOn = (el: Element, k: string): boolean =>
    (el as unknown as HTMLElement).dispatchEvent({ type: "keydown", key: k, currentTarget: el } as unknown as Event);

  it("Escape closes (prevented) via onClose", () => {
    let closes = 0;
    const root = renderPanel(CANNED, { onClose: () => closes++ });
    expect(keyOn(root, "Escape")).toBe(false);
    expect(closes).toBe(1);
    // Other keys are the browser's.
    expect(keyOn(root, "x")).toBe(true);
    expect(closes).toBe(1);
  });

  it("the ✕ button closes and Refresh re-issues", () => {
    let closes = 0;
    let refreshes = 0;
    const root = renderPanel(CANNED, { onClose: () => closes++, onRefresh: () => refreshes++ });
    (root.querySelector(".settings-close") as unknown as HTMLElement).click();
    expect(closes).toBe(1);
    const refresh = (Array.from(root.querySelectorAll(".settings-btn")) as unknown as HTMLElement[]).find(
      (b) => b.textContent === "Refresh",
    )!;
    refresh.click();
    expect(refreshes).toBe(1);
  });

  it("refresh is disabled while pending (no double request)", () => {
    const root = renderPanel(CANNED, { pending: true });
    const refresh = (Array.from(root.querySelectorAll(".settings-btn")) as unknown as HTMLElement[]).find(
      (b) => b.textContent === "Refresh",
    )!;
    expect(refresh.hasAttribute("disabled")).toBe(true);
  });
});

// ── Panel state doctrine (pure): fresh id per request, stale dropped ────────

describe("settings panel state", () => {
  it("open re-fetches: pending, no stale snapshot, fresh id", () => {
    const opened = openSettingsPanel(initialSettingsPanelState);
    expect(opened).toEqual({
      open: true,
      pending: true,
      snapshot: null,
      reqId: 1,
      editing: null,
      pendingSave: null,
      editError: null,
      saveReqId: 0,
      needsRestart: false,
      editedKeys: [],
    });
    // Re-open after a close bumps again (every open re-fetches).
    const reopened = openSettingsPanel(closeSettingsPanel(opened));
    expect(reopened.reqId).toBe(3);
    expect(reopened.pending).toBe(true);
  });

  it("refresh bumps the id (the in-flight reply becomes stale)", () => {
    const opened = openSettingsPanel(initialSettingsPanelState);
    const refreshed = refreshSettingsPanel(opened);
    expect(refreshed.reqId).toBe(opened.reqId + 1);
    expect(refreshed.pending).toBe(true);
  });

  it("close drops the snapshot AND invalidates any in-flight reply", () => {
    const opened = openSettingsPanel(initialSettingsPanelState);
    const withSnap = applySnapshotReply(opened, opened.reqId, CANNED);
    expect(withSnap.snapshot).toBe(CANNED);
    expect(withSnap.pending).toBe(false);
    const closed = closeSettingsPanel(withSnap);
    expect(closed.open).toBe(false);
    expect(closed.snapshot).toBeNull();
    // A reply for the id that was in flight when the panel closed is dropped.
    expect(applySnapshotReply(closed, opened.reqId, CANNED).snapshot).toBeNull();
  });

  it("stale requestId drops: older id, newer id, and undefined all lose", () => {
    const opened = openSettingsPanel(initialSettingsPanelState);
    const refreshed = refreshSettingsPanel(opened); // reqId 2 now current
    expect(applySnapshotReply(refreshed, opened.reqId, CANNED)).toBe(refreshed); // older: unchanged state
    expect(applySnapshotReply(refreshed, undefined, CANNED)).toBe(refreshed);
    expect(applySnapshotReply(refreshed, refreshed.reqId, CANNED).snapshot).toBe(CANNED);
  });
});

// ── Value display (pure) ────────────────────────────────────────────────────

describe("displayConfigValue", () => {
  it("scalars verbatim, containers flattened, empty string marked", () => {
    expect(displayConfigValue("light")).toBe("light");
    expect(displayConfigValue(3000)).toBe("3000");
    expect(displayConfigValue(false)).toBe("false");
    expect(displayConfigValue(null)).toBe("null");
    expect(displayConfigValue(["a", "b"])).toBe("a, b");
    expect(displayConfigValue({ a: 1, b: null })).toBe("a: 1, b: null");
    expect(displayConfigValue("")).toBe("(empty string)");
  });
});
