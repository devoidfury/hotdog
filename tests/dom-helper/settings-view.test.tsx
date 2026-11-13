/// <reference lib="dom" />
// DOM tests for the settings viewer panel (settings-view.tsx) on the
// dom-helper: the Zed-style two-pane body (rail: search + categories with
// counts; pane: grouped rows), the CLIENT-SIDE CATEGORY SWEEP (every row of
// the fixture lands in exactly one category; unknown file-only keys land in
// "Other"), ZED rows (derived bold label, schema description or the raw
// keyPath in monospace -- never invented prose, keyPath in the title, source
// chips survive), search (keyPath AND description, case/kebab-insensitive,
// flattens with category chips), diagnostics banner wording (the `hotdog
// rescue fix` hint, did-you-mean), Escape close + the pure panel-state
// doctrine (fresh id per open/refresh, stale replies dropped). The
// settings-button -> chat-header wiring and the live WS round trip are covered in
// app.test.tsx.

import { describe, it, expect, afterEach } from "bun:test";
import {
  SettingsViewer,
  openSettingsPanel,
  refreshSettingsPanel,
  closeSettingsPanel,
  applySnapshotReply,
  initialSettingsPanelState,
  displayConfigValue,
  categoryGroups,
  categoryOf,
  rowMatchesQuery,
  fieldUnitCount,
  fieldUnitKeys,
  friendlyLabel,
  setSettingsQuery,
  setSettingsCategory,
  GENERAL_CATEGORY,
  OTHER_CATEGORY,
} from "@extensions/webui/ui/settings-view.tsx";
import type { ConfigKeyEditWire, ConfigKeyEntryWire, ConfigSnapshotResultWire } from "@extensions/websocket/protocol.ts";
import type { SettingsQueuedSave } from "@extensions/webui/ui/settings-view.tsx";
import { mount, type DomNode, type Mounted } from "@utils/jsx";

const noop = (): void => {};

// A fixture shaped like a REAL snapshot: core scalars (General), namespace
// rows (webui / loopDetect / bashTool / providers), env + cli entries, a
// secret, a json container, an env-only redaction, file-only UNKNOWN keys
// (dotted + undotted) for the "Other" sweep, and refusal rows (no edit).
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
        { key: "systemPromptTemplate", description: "Big prose", default: null, file: "Once upon a time...[truncated]", resolved: "Once upon a time...[truncated]", edit: { type: "string", seedless: true } },
        { key: "modelGroups", description: "Model groups", file: { fast: ["m1"] }, edit: { type: "json" } },
      ],
    },
    {
      name: "webui",
      rows: [
        { key: "webui.port", description: "WebUI server port", default: 3000, file: 4321, cli: { flag: "--port", value: 4321 }, resolved: 4321, edit: { type: "number" } },
        {
          key: "webui.apiKey",
          description: "API key for login authentication.",
          default: null,
          env: { set: false, source: "HOTDOG_WEBUI_API_KEY" },
          resolved: null,
          leafSecret: true,
        },
        { key: "webui.host", description: "WebUI server host", default: "127.0.0.1", resolved: "127.0.0.1" },
      ],
    },
    {
      name: "loop-detect",
      rows: [
        { key: "loopDetect.enabled", description: "Watch tool calls for loop patterns", default: true, resolved: true, edit: { type: "boolean" } },
        { key: "loopDetect.repeatThreshold", description: "Identical repeats before the first nudge", default: 3, resolved: 3, edit: { type: "number", minimum: 2 } },
      ],
    },
    {
      name: "bash-tool",
      rows: [
        { key: "bashTool.env", description: "Extra environment variables", resolved: { GITHUB_TOKEN: null, PATH: "/usr/bin" }, redacted: true },
        { key: "bashTool.timeout", description: "Shell command timeout (seconds)", default: 120, resolved: 120, edit: { type: "number", minimum: 1 } },
      ],
    },
    {
      // A chrome'd array-of-primitives (the server's list doctrine): the
      // HEADER row carries arrayChrome + NO edit (its bulk write refuses);
      // the elements ride as their own stamped rows. The category view must
      // render this as ONE list block (header + 2 element rows + add), never
      // as a flattened value dump.
      name: "workspace",
      rows: [
        { key: "workspace.deny", description: "Denied path globs", arrayChrome: true, file: ["dist", "build"] },
        { key: "workspace.deny[0]", file: "dist", edit: { type: "string" } },
        { key: "workspace.deny[1]", file: "build", edit: { type: "string" } },
      ],
    },
    {
      name: "providers",
      rows: [
        { key: "providers[0].url", description: "Provider base URL", file: "http://127.0.0.1:8000/v1", edit: { type: "string" } },
        { key: "providers.slow.models", description: "Models served by this provider", resolved: ["a", "b"] },
      ],
    },
    {
      // File-only leftovers: the diagnostics' unknown-key story, as rows.
      name: "themee",
      rows: [{ key: "themee", file: "solarized" }],
    },
    {
      name: "myTools",
      rows: [
        { key: "myTools.legacy", description: "Old toggle nobody reads", file: true },
        { key: "myTools", file: { nested: 1 } },
      ],
    },
  ],
};

// ── Harness ─────────────────────────────────────────────────────────────────

let current: Mounted | null = null;

/** Editor-context defaults: the panel renders inert (no container expanded,
 *  no save in flight, no banner) unless a test opts into the editor props. */
function renderPanel(
  snapshot: ConfigSnapshotResultWire | null,
  opts: {
    pending?: boolean;
    onClose?: () => void;
    onRefresh?: () => void;
    editing?: string | null;
    pendingSave?: { key: string; reqId: number; shown: string } | null;
    queuedSaves?: SettingsQueuedSave[];
    editError?: { key: string; message: string } | null;
    needsRestart?: boolean;
    editedKeys?: string[];
    query?: string;
    category?: string | null;
    onQuery?: (q: string) => void;
    onCategory?: (c: string | null) => void;
    onEdit?: (key: string) => void;
    onCancelEdit?: () => void;
    onSaveEdit?: (key: string, raw: string, edit: ConfigKeyEditWire) => void;
    onListAddStart?: (key: string) => void;
    onListAddCommit?: (key: string, raw: string, edit?: ConfigKeyEditWire) => void;
    onListAddCancel?: () => void;
    onListRemove?: (elementKey: string) => void;
    addingList?: string | null;
    confirmRemoveKey?: string | null;
    listError?: { key: string; message: string } | null;
    listBusy?: boolean;
    focusProviderName?: string | null;
    onProviderRemoveArm?: (cardKey: string, index: number, name: string) => void;
    onProviderRemoveConfirm?: (index: number, name: string) => void;
    onProviderRemoveCancel?: () => void;
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
      pendingSave={opts.pendingSave ?? null}
      queuedSaves={opts.queuedSaves ?? []}
      editError={opts.editError ?? null}
      needsRestart={opts.needsRestart ?? false}
      editedKeys={opts.editedKeys ?? []}
      query={opts.query ?? ""}
      category={opts.category ?? null}
      onQuery={opts.onQuery ?? noop}
      onCategory={opts.onCategory ?? noop}
      onEdit={opts.onEdit ?? noop}
      onCancelEdit={opts.onCancelEdit ?? noop}
      onSaveEdit={opts.onSaveEdit ?? noop}
      addingList={opts.addingList ?? null}
      confirmRemoveKey={opts.confirmRemoveKey ?? null}
      listError={opts.listError ?? null}
      listBusy={opts.listBusy ?? false}
      focusProviderName={opts.focusProviderName ?? null}
      onListAddStart={opts.onListAddStart ?? noop}
      onListAddCommit={opts.onListAddCommit ?? noop}
      onListAddCancel={opts.onListAddCancel ?? noop}
      onListRemove={opts.onListRemove ?? noop}
      onProviderRemoveArm={opts.onProviderRemoveArm ?? noop}
      onProviderRemoveConfirm={opts.onProviderRemoveConfirm ?? noop}
      onProviderRemoveCancel={opts.onProviderRemoveCancel ?? noop}
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
  rows(root).find((r) => r.getAttribute("data-key") === key)!;
const rowText = (el: HTMLElement): string => el.textContent;
const badgesOf = (el: HTMLElement): string[] =>
  Array.from(el.querySelectorAll(".settings-badge"))
    .map((b) => (b as unknown as HTMLElement).textContent)
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

  it("the stale 'snapshot-at-open' chip is gone from the rendered DOM (live-at-open)", () => {
    const root = renderPanel(CANNED);
    // The chip and its text are removed entirely: the panel re-reads on every
    // open, so it must not advertise staleness.
    expect(root.querySelector(".settings-view-scope")).toBeNull();
    expect(root.textContent).not.toContain("snapshot-at-open");
    expect(root.textContent.toLowerCase()).not.toContain("no live feed");
    expect(root.textContent.toLowerCase()).not.toContain("live config");
  });

  it("pending with no snapshot yet: honest loading line, no table", () => {
    const root = renderPanel(null, { pending: true });
    expect(root.querySelector(".settings-pending")!.textContent).toContain("snapshot");
    expect(root.querySelector(".settings-view-body")).toBeNull();
  });

  it("two-pane body: rail (search + categories with counts) beside the grouped pane", () => {
    const root = renderPanel(CANNED);
    const rail = root.querySelector(".settings-rail")!;
    expect(rail.querySelector(".settings-search")).toBeTruthy();
    const cats = Array.from(rail.querySelectorAll(".settings-cat")) as unknown as HTMLElement[];
    const titles = cats.map((c) => c.querySelector(".settings-cat-title")!.textContent);
    // General first, curated namespaces in map order, Other last; only PRESENT groups.
    expect(titles).toEqual(["All settings", "General", "WebUI", "Providers", "Loop Detect", "Bash Tool", "Workspace", OTHER_CATEGORY]);
    // Counts ride -- in FIELD UNITS (owner ruling 2026-11-11): `providers[0].url`
    // counts as its provider (Providers = 2: that card + the dotted models
    // array), the `myTools` object rolls up into its shipped child (Other = 2),
    // and the chrome'd `workspace.deny` array is ONE field no matter how many
    // element rows ship (Workspace = 1).
    const counts = cats.map((c) => c.querySelector(".settings-cat-count")!.textContent);
    expect(counts).toEqual(["17", "5", "3", "2", "2", "2", "1", "2"]);
    expect(root.querySelector(".settings-content")).toBeTruthy();
    expect(root.querySelector(".settings-dir")!.textContent).toContain("/home/u/.config/hotdog");
  });

  it("categories render in display order and EVERY row lands in exactly one", () => {
    const root = renderPanel(CANNED);
    const titles = Array.from(root.querySelectorAll(".settings-section-title")).map((t) => t.textContent);
    expect(titles).toEqual(["General", "WebUI", "Providers", "Loop Detect", "Bash Tool", "Workspace", OTHER_CATEGORY]);
    // The sweep: EVERY snapshot row renders exactly once, chrome included.
    // Chrome rows render as list-block headers (their own data-key nodes),
    // not as .settings-row; the sweep counts all RENDER nodes so a chrome can
    // never hide a dump AND can never double-paint (header + row).
    const allKeys = CANNED.sections.flatMap((s) => s.rows.map((r) => r.key));
    const domKeys = (Array.from(root.querySelectorAll(".settings-row, .settings-list-block, .settings-list-chrome-heading, .settings-providers-heading, .settings-provider-card")) as unknown as HTMLElement[]).map(
      (el) => el.getAttribute("data-key"),
    );
    // Each SNAPSHOT key appears exactly once among the render nodes (extra
    // structural data-keys the snapshot never shipped -- the providers
    // heading/card built from field rows -- are not snapshot rows and stay).
    const renderKeys = domKeys.filter((k): k is string => k !== null && allKeys.includes(k));
    expect(renderKeys.length).toBe(allKeys.length);
    for (const k of allKeys) expect(renderKeys.filter((d) => d === k)).toHaveLength(1);
    // The chrome'd array renders as a list-block header (never a flat row).
    expect(rows(root).some((r) => r.getAttribute("data-key") === "workspace.deny")).toBe(false);
    expect(domKeys.filter((d) => d === "workspace.deny")).toHaveLength(1);
    // "Other" catches the file-only unknowns.
    const other = Array.from(root.querySelectorAll(".settings-section")) as unknown as HTMLElement[];
    const otherSection = other.find((s) => s.querySelector(".settings-section-title")!.textContent === OTHER_CATEGORY)!;
    expect(Array.from(otherSection.querySelectorAll(".settings-row")).map((r) => (r as unknown as HTMLElement).getAttribute("data-key")))
      .toEqual(["themee", "myTools.legacy", "myTools"]);
  });

  it("the chrome row renders as a list-block header, not a dumpable row", () => {
    const root = renderPanel(CANNED);
    // A chrome'd array field renders its header block (data-key rides the
    // block) and its elements below -- the chrome itself never becomes a
    // .settings-row with a value cell (that is the exact dump posture).
    const block = listBlock(root, "workspace.deny");
    expect(block).toBeTruthy();
    expect(block.querySelector(".settings-list-count")!.textContent).toBe("2 elements");
    expect(block.querySelector(".settings-value")).toBeNull();
    expect(rows(root).some((r) => r.getAttribute("data-key") === "workspace.deny")).toBe(false);
    expect(root.textContent).not.toContain("dist, build");
    // The element rows live inside the block, order kept.
    expect(blockRows(block).map((r) => r.getAttribute("data-key"))).toEqual(["workspace.deny[0]", "workspace.deny[1]"]);
  });

  it("rows: derived bold label + description line (raw keyPath mono when none)", () => {
    const root = renderPanel(CANNED);
    const port = rowForKey(root, "webui.port");
    expect(port.querySelector(".settings-row-label")!.textContent).toBe("Port");
    expect(port.querySelector(".settings-row-desc")!.textContent).toBe("WebUI server port");
    // No schema description -> the raw keyPath in monospace, never invented prose.
    const themee = rowForKey(root, "themee");
    const desc = themee.querySelector(".settings-row-desc")!;
    expect(desc.textContent).toBe("themee");
    expect(desc.className).toContain("settings-row-key");
    // The full keyPath rides the title attribute (tooltip truth).
    expect(port.getAttribute("title")).toBe("webui.port");
    expect(rowForKey(root, "loopDetect.repeatThreshold").getAttribute("title")).toBe("loopDetect.repeatThreshold");
  });

  it("resolved value + attested-slot badges only (chips survive as row meta)", () => {
    const root = renderPanel(CANNED);
    const port = rowForKey(root, "webui.port");
    // A stamped number row shows its value THROUGH the control (seed 4321).
    const input = port.querySelector(".settings-edit-input") as unknown as HTMLElement;
    expect(input.getAttribute("value")).toBe("4321");
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
    const envBadge = Array.from(row.querySelectorAll(".settings-badge")).find((b) => (b as unknown as HTMLElement).textContent === "env")!;
    expect((envBadge as unknown as HTMLElement).getAttribute("title")).toBe("Environment variable: HOTDOG_LOGIN_TOKEN");
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
    const root = renderPanel(CANNED);
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
      files: [{ path: "/x/defaults.json", inUse: true, status: "ok" }],
      findings: [],
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

// ── Category mapping (pure) ─────────────────────────────────────────────────

describe("settings categories", () => {
  it("categoryOf: core scalars -> General, namespaces -> map, unknowns -> Other", () => {
    const row = (key: string): ConfigKeyEntryWire => ({ key });
    expect(categoryOf("core", row("theme"))).toBe(GENERAL_CATEGORY);
    expect(categoryOf("core", row("apiKey"))).toBe(GENERAL_CATEGORY);
    expect(categoryOf("webui", row("webui.port"))).toBe("WebUI");
    expect(categoryOf("websocket", row("websocket.idleTimeoutSecs"))).toBe("WebSocket");
    expect(categoryOf("core", row("compaction.enabled"))).toBe("Compaction");
    expect(categoryOf("core-tools", row("coreTools.readToolLimit"))).toBe("Core Tools");
    expect(categoryOf("loop-detect", row("loopDetect.enabled"))).toBe("Loop Detect");
    expect(categoryOf("workflows", row("workflows.enabled"))).toBe("Workflows");
    expect(categoryOf("prompts", row("prompts.displayPrompt"))).toBe("Prompts");
    expect(categoryOf("bash-tool", row("bashTool.env"))).toBe("Bash Tool");
    // INDEXED provider paths belong to Providers, not to a per-index bucket.
    expect(categoryOf("providers", row("providers[0].url"))).toBe("Providers");
    expect(categoryOf("providers", row("providers.slow.apiKey"))).toBe("Providers");
    // File-only unknowns (the diagnostics class) land in Other -- dotted and bare.
    expect(categoryOf("themee", row("themee"))).toBe(OTHER_CATEGORY);
    expect(categoryOf("myTools", row("myTools.legacy"))).toBe(OTHER_CATEGORY);
    // Unknown members INSIDE a known namespace follow the namespace (the
    // findings banner is what names them unknown).
    expect(categoryOf("core", row("coreTools.bogus"))).toBe("Core Tools");
  });

  it("categoryGroups covers every row exactly once and orders General..Other", () => {
    const groups = categoryGroups(CANNED);
    const titles = groups.map((g) => g.title);
    expect(titles[0]).toBe(GENERAL_CATEGORY);
    expect(titles[titles.length - 1]).toBe(OTHER_CATEGORY);
    const covered = groups.flatMap((g) => g.rows.map((r) => r.key));
    const all = CANNED.sections.flatMap((s) => s.rows.map((r) => r.key));
    expect(covered.sort()).toEqual([...all].sort());
    expect(new Set(covered).size).toBe(covered.length); // exactly one category each
  });

  it("friendlyLabel derives from the key and invents nothing", () => {
    expect(friendlyLabel("webui.port")).toBe("Port");
    expect(friendlyLabel("maxIterations")).toBe("Max Iterations");
    expect(friendlyLabel("loopDetect.repeatThreshold")).toBe("Repeat Threshold");
    expect(friendlyLabel("apiKey")).toBe("API Key"); // acronyms stay upper
    expect(friendlyLabel("sttUrl")).toBe("STT URL");
    expect(friendlyLabel("providers[0]")).toBe("Providers");
    expect(friendlyLabel("some-kebab-key")).toBe("Some Kebab Key");
    expect(friendlyLabel("theme")).toBe("Theme");
  });

  it("rowMatchesQuery: keyPath AND description, case/kebab-insensitive", () => {
    const row: ConfigKeyEntryWire = { key: "loopDetect.repeatThreshold", description: "Identical repeats before the first nudge" };
    expect(rowMatchesQuery(row, "loopdetect")).toBe(true);
    expect(rowMatchesQuery(row, "loop-detect")).toBe(true); // kebab-insensitive
    expect(rowMatchesQuery(row, "LOOP_DETECT.repeat")).toBe(true);
    expect(rowMatchesQuery(row, "nudge")).toBe(true); // description text
    expect(rowMatchesQuery(row, "first nudge")).toBe(true);
    expect(rowMatchesQuery(row, "zzz")).toBe(false);
    expect(rowMatchesQuery(row, "")).toBe(true);
  });
});

// ── Field-unit counting doctrine (owner ruling 2026-11-11) ──────────────────
// The rail counts FIELDS AS A USER PERCEIVES THEM. Each case below pins ONE
// rule independently; the rail (both modes) renders exactly these numbers,
// and "All settings" is the SUM of unit counts, never a raw row count.
//   1. leaf (scalar/bool/enum/writeOnly secret/non-array json container): 1
//   2. array-valued field: 1, never per element; per-index rows roll up
//   3. object element of an array (a card): 1; everything under it: 0 extra
//   4. array container whose element rows ship (a section heading): 0
//   5. plain object container shipping child rows: 0, children roll up
//   6. shape comes from the SHIPPED value (unknown file-only keys included)

const urow = (key: string, rest: Partial<ConfigKeyEntryWire> = {}): ConfigKeyEntryWire => ({ key, ...rest });

describe("field-unit counting doctrine", () => {
  const cases: Array<{ name: string; rows: ConfigKeyEntryWire[]; want: number }> = [
    {
      name: "a top-level array with 4 items is ONE field (rule 2)",
      rows: [urow("tags", { file: ["a", "b", "c", "d"], edit: { type: "json" } })],
      want: 1,
    },
    {
      name: "per-index rows of a scalar array never add (rule 2, future shape)",
      rows: [
        urow("tags", { file: ["a", "b", "c", "d"] }),
        urow("tags[0]", { file: "a" }),
        urow("tags[1]", { file: "b" }),
        urow("tags[2]", { file: "c" }),
        urow("tags[3]", { file: "d" }),
      ],
      want: 1,
    },
    {
      name: "an array of two objects with three fields each is TWO (rule 3)",
      rows: [
        urow("mcpServers", { file: [{ name: "s0" }, { name: "s1" }] }),
        urow("mcpServers[0]", { file: { name: "s0" } }),
        urow("mcpServers[0].url", { file: "http://s0" }),
        urow("mcpServers[0].enabled", { resolved: true }),
        urow("mcpServers[0].headers", { file: { h: "v" } }),
        urow("mcpServers[1]", { file: { name: "s1" } }),
        urow("mcpServers[1].url", { file: "http://s1" }),
        urow("mcpServers[1].enabled", { resolved: false }),
        urow("mcpServers[1].headers", { file: {} }),
      ],
      want: 2,
    },
    {
      name: "a plain object with three leaf children is THREE (rule 5)",
      rows: [
        urow("compaction", { resolved: { mode: "auto" } }),
        urow("compaction.mode", { resolved: "auto" }),
        urow("compaction.threshold", { resolved: 4 }),
        urow("compaction.enabled", { resolved: true }),
      ],
      want: 3,
    },
    { name: "a lone scalar is ONE (rule 1)", rows: [urow("theme", { resolved: "dark" })], want: 1 },
    {
      name: "a writeOnly secret is ONE (rule 1)",
      rows: [urow("webui.apiKey", { leafSecret: true, edit: { type: "string", writeOnly: true } })],
      want: 1,
    },
    {
      // Rule 1's json half: a container with NO shipped children is the field
      // itself (this is the existing schema-namespace behavior, unpregressed).
      name: "a json container shipping no children is ONE (rule 1)",
      rows: [urow("modelGroups", { file: { fast: ["m1"] }, edit: { type: "json" } })],
      want: 1,
    },
    {
      // The server's arrayChrome doctrine (2026-11-11): the chrome row IS the
      // field (rule 4 makes it the heading), and per-index rows roll into it
      // (rule 2) -- the chrome + N elements = ONE unit, never N+1.
      name: "a chrome'd array with 3 element rows is ONE (rules 2+4)",
      rows: [
        urow("workspace.deny", { arrayChrome: true, file: ["a", "b", "c"] }),
        urow("workspace.deny[0]", { file: "a" }),
        urow("workspace.deny[1]", { file: "b" }),
        urow("workspace.deny[2]", { file: "c" }),
      ],
      want: 1,
    },
    {
      name: "an EMPTY chrome array is ONE (header only, append creates it)",
      rows: [urow("workspace.deny", { arrayChrome: true, file: [] })],
      want: 1,
    },
    {
      // A schema-declared list the file omits ships chrome with no slots set
      // (no file, no elements): still ONE countable field.
      name: "an absent-file schema-list chrome is ONE (chrome alone)",
      rows: [urow("workspace.allow", { arrayChrome: true, default: [] })],
      want: 1,
    },
    {
      // Rule 3 with chrome inside the card: the chrome'd models list and its
      // elements contribute 0 extra to the provider's unit.
      name: "chrome'd models inside a provider card count 0 extra (rule 3)",
      rows: [
        urow("providers[0]", { file: { name: "p" } }),
        urow("providers[0].models", { arrayChrome: true, file: ["m1", "m2"] }),
        urow("providers[0].models[0]", { file: "m1" }),
        urow("providers[0].models[1]", { file: "m2" }),
      ],
      want: 1,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(fieldUnitCount(c.rows)).toBe(c.want);
    });
  }

  it("a nested array inside an object element contributes 0 extra (rule 3)", () => {
    expect(
      fieldUnitCount([
        urow("providers[1]", { file: { name: "p" } }),
        urow("providers[1].url", { file: "http://p" }),
        urow("providers[1].models", { file: ["m1", "m2"] }),
        urow("providers[1].models[0]", { file: "m1" }),
      ]),
    ).toBe(1);
  });

  it("search subsets resolve units against the full group", () => {
    const group = [
      urow("providers", { file: [{ name: "a" }, { name: "b" }] }),
      urow("providers[0]", { file: { name: "a" } }),
      urow("providers[0].url", { file: "http://a" }),
      urow("providers[1]", { file: { name: "b" } }),
      urow("providers[1].url", { file: "http://b" }),
    ];
    // The whole group: two cards, the heading is chrome.
    expect(fieldUnitKeys(group, group)).toEqual(["providers[0]", "providers[1]"]);
    // A query matching ONLY providers[1].url counts Providers as 1 (the card).
    expect(fieldUnitCount([group[4]!], group)).toBe(1);
    // The heading row alone is pure chrome: zero units (no phantom entry).
    expect(fieldUnitCount([group[0]!], group)).toBe(0);
    // Two per-index matches of workspace.paths count the array ONCE.
    const paths = [
      urow("workspace.paths", { file: ["/a", "/b"] }),
      urow("workspace.paths[0]", { file: "/a" }),
      urow("workspace.paths[1]", { file: "/b" }),
    ];
    expect(fieldUnitCount([paths[1]!, paths[2]!], paths)).toBe(1);
    expect(fieldUnitCount(paths)).toBe(1);
    // The chrome seam in SEARCH mode (SAME function, context = the full
    // group): chrome + elements = one unit; a heading-only match claims
    // nothing (the elements own the seam); an element-only match claims the
    // ONE field; an empty chrome (no elements to match) counts through the
    // same seam as its own unit.
    const deny = [
      urow("workspace.deny", { arrayChrome: true, file: ["a", "b"] }),
      urow("workspace.deny[0]", { file: "a" }),
      urow("workspace.deny[1]", { file: "b" }),
    ];
    expect(fieldUnitKeys(deny, deny)).toEqual(["workspace.deny"]);
    expect(fieldUnitCount([deny[0]!], deny)).toBe(0);
    expect(fieldUnitCount([deny[0]!, deny[1]!], deny)).toBe(1);
    expect(fieldUnitCount([deny[1]!], deny)).toBe(1);
    const emptyChrome = [urow("workspace.tags", { arrayChrome: true, file: [] })];
    expect(fieldUnitCount([emptyChrome[0]!], emptyChrome)).toBe(1);
  });

  // A rendered panel over a fixture that exercises the rules together.
  const UNITS_SNAP: ConfigSnapshotResultWire = {
    type: "configSnapshotResult",
    ts: 1700000000000,
    configDir: "/home/u/.config/hotdog",
    files: [{ path: "/home/u/.config/hotdog/defaults.json", inUse: true, status: "ok" }],
    findings: [],
    sections: [
      { name: "core", rows: [urow("theme", { description: "Theme", resolved: "dark" })] },
      {
        name: "workspace",
        rows: [
          urow("workspace.paths", { description: "Workspace roots", file: ["/home/a", "/home/b"] }),
          urow("workspace.paths[0]", { description: "root zero", file: "/home/a" }),
          urow("workspace.paths[1]", { description: "root one", file: "/home/b" }),
        ],
      },
      {
        name: "mcp-servers",
        rows: [
          urow("mcpServers", { description: "MCP servers", file: [{ name: "s0" }, { name: "s1" }] }),
          urow("mcpServers[0]", { description: "Server entry", file: { name: "s0" } }),
          urow("mcpServers[0].url", { description: "Server base URL", file: "http://s0" }),
          urow("mcpServers[1]", { description: "Server entry", file: { name: "s1" } }),
          urow("mcpServers[1].url", { description: "Server base URL", file: "http://s1" }),
        ],
      },
    ],
  };

  it("idle and search count through the SAME function; All settings is the unit sum", () => {
    // IDLE: 1 scalar + 1 array field (3 rows) + 2 cards (5 rows) = 4 units.
    const idle = renderPanel(UNITS_SNAP);
    expect(railPairs(idle)).toEqual([
      ["All settings", "4"],
      ["General", "1"],
      ["Workspace", "1"],
      ["MCP Servers", "2"],
    ]);
    // A query matching EVERY row reproduces the idle rail exactly.
    const all = renderPanel(UNITS_SNAP, { query: "e" });
    expect(railPairs(all)).toEqual(railPairs(idle));
    // Two element matches of workspace.paths count Workspace once.
    const roots = renderPanel(UNITS_SNAP, { query: "root" });
    expect(railPairs(roots)).toEqual([["All settings", "1"], ["Workspace", "1"]]);
    // A match on mcpServers[1].url counts that ONE server.
    const url = renderPanel(UNITS_SNAP, { query: "base url" });
    expect(railPairs(url)).toEqual([["All settings", "2"], ["MCP Servers", "2"]]);
    // Both modes equal the pure seam per group.
    for (const g of categoryGroups(UNITS_SNAP)) {
      const rail = (railPairs(idle) as Array<[string, string]>).find(([t]) => t === g.title);
      expect(rail?.[1]).toBe(String(fieldUnitCount(g.rows)));
    }
  });
});

// ── Search + category filter (rail interactions) ────────────────────────────

describe("settings search + category rail", () => {
  it("typing in the search box reports the query (input event)", () => {
    const seen: string[] = [];
    const root = renderPanel(CANNED, { onQuery: (q) => seen.push(q) });
    const search = root.querySelector(".settings-search") as unknown as HTMLElement & { value: string };
    search.value = "port";
    search.dispatchEvent({ type: "input" } as unknown as Event);
    expect(seen).toEqual(["port"]);
  });

  it("a query flattens to the matching rows, each carrying its category chip", () => {
    const root = renderPanel(CANNED, { query: "loop-detect" });
    const rowsShown = rows(root);
    expect(rowsShown.map((r) => r.getAttribute("data-key")).sort()).toEqual(["loopDetect.enabled", "loopDetect.repeatThreshold"]);
    // Every flattened row carries the category label.
    for (const r of rowsShown) {
      expect(r.querySelector(".settings-cat-chip")!.textContent).toBe("Loop Detect");
    }
  });

  it("a description-only match still surfaces the row", () => {
    const root = renderPanel(CANNED, { query: "nudge" });
    expect(rows(root).map((r) => r.getAttribute("data-key"))).toEqual(["loopDetect.repeatThreshold"]);
  });

  it("no matches: one honest line, no rows", () => {
    const root = renderPanel(CANNED, { query: "zzzz-no-such-setting" });
    expect(rows(root)).toHaveLength(0);
    expect(root.querySelector(".settings-empty")!.textContent).toContain("No settings match");
  });

  it("a category click filters the pane; All settings clears it", () => {
    const seen: (string | null)[] = [];
    const root = renderPanel(CANNED, { category: "WebUI", onCategory: (c) => seen.push(c) });
    const titles = Array.from(root.querySelectorAll(".settings-section-title")).map((t) => t.textContent);
    expect(titles).toEqual(["WebUI"]);
    expect(rows(root).length).toBe(3);
    const cats = Array.from(root.querySelectorAll(".settings-cat")) as unknown as HTMLElement[];
    const webuiBtn = cats.find((c) => c.querySelector(".settings-cat-title")!.textContent === "WebUI")!;
    expect(webuiBtn.getAttribute("aria-current")).toBe("true");
    webuiBtn.click();
    expect(seen).toEqual(["WebUI"]); // re-click keeps it selected (the panel owns the toggle)
    const allBtn = cats.find((c) => c.querySelector(".settings-cat-title")!.textContent === "All settings")!;
    allBtn.click();
    expect(seen).toEqual(["WebUI", null]);
  });
});

// ── Search-active rail + clear button (owner 2026-11-11) ────────────────────
// While a search is active the rail is SEARCH-TRUTH: only the categories
// holding at least one matched FIELD UNIT, each with its unit count, "All
// settings" the total units. The unit rule is IDENTICAL to the idle rail
// (fieldUnitCount): a match on `providers[1].url` counts the provider once,
// the top `providers` heading is chrome and never counts -- a chrome-only
// match adds no rail entry and no number. With an empty box the rail is the
// snapshot-truth category list at unit counts (pinned above; this sweep
// re-asserts the restore path).
// The x button: a real <button> that exists ONLY while the box holds text;
// clicking it clears the query and keeps focus in the search field.

const RAIL_MIX: ConfigSnapshotResultWire = {
  type: "configSnapshotResult",
  ts: 1700000000000,
  configDir: "/home/u/.config/hotdog",
  files: [{ path: "/home/u/.config/hotdog/defaults.json", inUse: true, status: "ok" }],
  findings: [],
  sections: [
    {
      name: "core",
      rows: [
        { key: "theme", description: "Theme", default: "dark", resolved: "dark" },
        { key: "maxIterations", description: "Max iterations", default: 25, resolved: 25 },
      ],
    },
    {
      name: "webui",
      rows: [
        { key: "webui.port", description: "WebUI server port", default: 3000, resolved: 3000, edit: { type: "number" } },
        { key: "webui.host", description: "WebUI server host", default: "127.0.0.1", resolved: "127.0.0.1" },
      ],
    },
    {
      name: "loop-detect",
      rows: [
        { key: "loopDetect.enabled", description: "Watch tool calls for loop patterns", default: true, resolved: true, edit: { type: "boolean" } },
        { key: "loopDetect.repeatThreshold", description: "Identical repeats before the first nudge", default: 3, resolved: 3, edit: { type: "number" } },
      ],
    },
    {
      name: "bash-tool",
      rows: [
        { key: "bashTool.env", description: "Extra environment variables", resolved: { PATH: "/usr/bin" } },
        { key: "bashTool.timeout", description: "Shell command timeout (seconds)", default: 120, resolved: 120, edit: { type: "number" } },
      ],
    },
    {
      name: "providers",
      rows: [
        { key: "providers", description: "Model providers", file: [{ name: "p1" }] },
        { key: "providers[0]", description: "Provider entry", file: { name: "p1" } },
        { key: "providers[0].url", description: "Provider base URL", file: "http://a/v1", edit: { type: "string" } },
      ],
    },
  ],
};

/** The rail as [title, count] pairs. */
const railPairs = (root: HTMLElement): string[][] =>
  (Array.from(root.querySelectorAll(".settings-cat")) as unknown as HTMLElement[]).map(
    (c) => [c.querySelector(".settings-cat-title")!.textContent, c.querySelector(".settings-cat-count")!.textContent],
  );

describe("settings rail search-filter + clear button", () => {
  it("x is absent while the box is empty and a real labelled button once text is held", () => {
    const idle = renderPanel(RAIL_MIX);
    expect(idle.querySelector(".settings-search-clear")).toBeNull();
    expect((idle.querySelector(".settings-search") as unknown as HTMLElement).className).not.toContain("settings-search-filled");
    const root = renderPanel(RAIL_MIX, { query: "tool" });
    const x = root.querySelector(".settings-search-clear") as unknown as HTMLElement;
    expect(x).toBeTruthy();
    expect(x.tagName).toBe("BUTTON"); // keyboard-reachable, not a pseudo-element
    expect(x.getAttribute("aria-label")).toBe("Clear search");
    // The reserved gutter rides the filled state only.
    expect((root.querySelector(".settings-search") as unknown as HTMLElement).className).toContain("settings-search-filled");
  });

  it("clicking x clears the query and keeps focus in the search field", () => {
    const seen: string[] = [];
    const root = renderPanel(RAIL_MIX, { query: "tool", onQuery: (q) => seen.push(q) });
    const box = root.querySelector(".settings-search") as unknown as HTMLElement & { value: string };
    box.focus();
    (root.querySelector(".settings-search-clear") as unknown as HTMLElement).click();
    expect(seen).toEqual([""]); // the query goes back through the owner
    expect(box.value).toBe(""); // the live field is wiped (attributes never rewrite a dirty input)
    expect(document.activeElement as unknown as HTMLElement).toBe(box); // the caret's home is kept
  });

  it("with a search active the rail shows ONLY matching categories with match counts", () => {
    // "tool": both bashTool rows (keyPath) + loopDetect.enabled (description
    // "Watch tool calls..."). General, WebUI and Providers hold NO match.
    const root = renderPanel(RAIL_MIX, { query: "tool" });
    expect(railPairs(root)).toEqual([
      ["All settings", "3"], // == the total matched units, nothing else
      ["Loop Detect", "1"],
      ["Bash Tool", "2"],
    ]);
    // The pane agrees: exactly those three rows, once each, with chips.
    expect(rows(root).map((r) => r.getAttribute("data-key"))).toEqual([
      "loopDetect.enabled",
      "bashTool.env",
      "bashTool.timeout",
    ]);
    expect(rows(root).map((r) => r.querySelector(".settings-cat-chip")!.textContent)).toEqual([
      "Loop Detect",
      "Bash Tool",
      "Bash Tool",
    ]);
  });

  it("clicking a filtered rail category narrows the pane to that category's matches", () => {
    const seen: (string | null)[] = [];
    const root = renderPanel(RAIL_MIX, { query: "tool", onCategory: (c) => seen.push(c) });
    const bashBtn = (Array.from(root.querySelectorAll(".settings-cat")) as unknown as HTMLElement[]).find(
      (c) => c.querySelector(".settings-cat-title")!.textContent === "Bash Tool",
    )!;
    bashBtn.click();
    expect(seen).toEqual(["Bash Tool"]);
    // With the selection applied: the pane is ONLY Bash Tool's matches...
    const narrowed = renderPanel(RAIL_MIX, { query: "tool", category: "Bash Tool" });
    expect(rows(narrowed).map((r) => r.getAttribute("data-key"))).toEqual(["bashTool.env", "bashTool.timeout"]);
    // ...while the rail still lists every MATCHING category (the selection
    // never amputates the rail) and carries the current marker.
    expect(railPairs(narrowed)).toEqual([["All settings", "3"], ["Loop Detect", "1"], ["Bash Tool", "2"]]);
    const cats = Array.from(narrowed.querySelectorAll(".settings-cat")) as unknown as HTMLElement[];
    expect(cats.map((c) => c.getAttribute("aria-current"))).toEqual(["false", "false", "true"]);
  });

  it("a stale selection with no matches is neutralized for the search, not dropped", () => {
    // Category WebUI selected, then "tool" typed: WebUI has no match (it is
    // off the rail). The pane shows ALL matches and All settings is current.
    const root = renderPanel(RAIL_MIX, { query: "tool", category: "WebUI" });
    expect(rows(root).map((r) => r.getAttribute("data-key"))).toEqual([
      "loopDetect.enabled",
      "bashTool.env",
      "bashTool.timeout",
    ]);
    const cats = Array.from(root.querySelectorAll(".settings-cat")) as unknown as HTMLElement[];
    expect(cats[0]!.getAttribute("aria-current")).toBe("true");
  });

  it("clearing the search restores the FULL snapshot-truth rail AND the surviving selection", () => {
    // The state kept category "Bash Tool" through the search; with the box
    // empty the rail is every present category at snapshot UNIT counts
    // again (the providers card is one field, the heading chrome is none).
    const root = renderPanel(RAIL_MIX, { query: "", category: "Bash Tool" });
    expect(railPairs(root)).toEqual([
      ["All settings", "9"],
      ["General", "2"],
      ["WebUI", "2"],
      ["Providers", "1"],
      ["Loop Detect", "2"],
      ["Bash Tool", "2"],
    ]);
    const cats = Array.from(root.querySelectorAll(".settings-cat")) as unknown as HTMLElement[];
    expect(cats.map((c) => c.getAttribute("aria-current"))).toEqual([
      "false",
      "false",
      "false",
      "false",
      "false",
      "true",
    ]);
    // The pane shows the WHOLE Bash Tool group (not just the search matches).
    expect(rows(root).map((r) => r.getAttribute("data-key"))).toEqual(["bashTool.env", "bashTool.timeout"]);
    expect(rows(root)[0]!.querySelector(".settings-cat-chip")).toBeNull(); // grouped view, no chips
  });

  it("heading chrome never counts; a matched CARD counts as its one unit", () => {
    // "model providers" matches ONLY the top `providers` heading row (rule 4:
    // the section heading is chrome, not a field): the category stays off the
    // rail entirely -- no phantom count for a heading.
    const phantom = renderPanel(RAIL_MIX, { query: "model providers" });
    expect(railPairs(phantom)).toEqual([["All settings", "0"]]);
    expect(rows(phantom)).toHaveLength(0);
    // "entry" matches ONLY the providers[0] ELEMENT header: the card is one
    // field (rule 3), so the rail says 1 even though the pane paints it as a
    // card header rather than a flat .settings-row.
    const card = renderPanel(RAIL_MIX, { query: "entry" });
    expect(railPairs(card)).toEqual([["All settings", "1"], ["Providers", "1"]]);
    expect(rows(card)).toHaveLength(0);
    // "provider": all three providers rows match, but heading + card + field
    // all resolve to the ONE provider unit (fieldUnitKeys dedupes).
    const root = renderPanel(RAIL_MIX, { query: "provider" });
    expect(railPairs(root)).toEqual([["All settings", "1"], ["Providers", "1"]]);
    expect(rows(root).map((r) => r.getAttribute("data-key"))).toEqual(["providers[0].url"]);
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
    // The notice sits at the TOP of the right pane (redesign C6).
    const content = root.querySelector(".settings-content")!;
    expect(content.firstChild).toBe(banner);
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

  it("Escape with text in the search box clears the search FIRST and does NOT close", () => {
    let closes = 0;
    const seen: string[] = [];
    const root = renderPanel(CANNED, { query: "port", onClose: () => closes++, onQuery: (q) => seen.push(q) });
    keyOn(root, "Escape");
    expect(seen).toEqual([""]);
    expect(closes).toBe(0);
    // ...and it is caught even when the press rides the search input itself
    // (bubbling to the dialog's staged ladder).
    let closes2 = 0;
    const seen2: string[] = [];
    const root2 = renderPanel(CANNED, { query: "nudge", onClose: () => closes2++, onQuery: (q) => seen2.push(q) });
    const box = root2.querySelector(".settings-search") as unknown as HTMLElement & { value: string };
    box.value = "nudge";
    box.dispatchEvent({ type: "keydown", key: "Escape" } as unknown as Event);
    expect(seen2).toEqual([""]);
    expect(box.value).toBe(""); // the dirty live value comes down with the query
    expect(closes2).toBe(0);
    // Whitespace counts as text: the box clears, the dialog stays.
    let closes3 = 0;
    const seen3: string[] = [];
    const root3 = renderPanel(CANNED, { query: "  ", onClose: () => closes3++, onQuery: (q) => seen3.push(q) });
    keyOn(root3, "Escape");
    expect(seen3).toEqual([""]);
    expect(closes3).toBe(0);
  });

  it("the staged order survives: an expanded JSON container collapses before the search clears", () => {
    let closes = 0;
    const seen: string[] = [];
    let cancels = 0;
    const root = renderPanel(CANNED, {
      query: "model",
      editing: "modelGroups",
      onClose: () => closes++,
      onQuery: (q) => seen.push(q),
      onCancelEdit: () => cancels++,
    });
    keyOn(root, "Escape");
    expect(cancels).toBe(1); // the reveal collapses first
    expect(seen).toEqual([]); // the search is NOT touched yet
    expect(closes).toBe(0);
  });

  it("the ✕ button closes and Refresh re-issues", () => {
    let closes = 0;
    let refreshes = 0;
    const root = renderPanel(CANNED, { onClose: () => closes++, onRefresh: () => refreshes++ });
    (root.querySelector(".settings-close") as unknown as HTMLElement).click();
    expect(closes).toBe(1);
    // Refresh is the glyph-button standard (no text node): aria-label
    // carries it.
    const refresh = (Array.from(root.querySelectorAll(".file-reload-btn")) as unknown as HTMLElement[]).find(
      (b) => b.getAttribute("aria-label") === "Refresh",
    )!;
    expect(refresh.querySelector("svg.file-reload-glyph[aria-hidden='true']")).toBeTruthy();
    refresh.click();
    expect(refreshes).toBe(1);
  });

  it("refresh is disabled while pending (no double request)", () => {
    const root = renderPanel(CANNED, { pending: true });
    const refresh = (Array.from(root.querySelectorAll(".file-reload-btn")) as unknown as HTMLElement[]).find(
      (b) => b.getAttribute("aria-label") === "Refresh",
    )!;
    expect(refresh.hasAttribute("disabled")).toBe(true);
  });
});

// ── Provider cards (owner 2026-11-11: the card-shaped snapshot) ─────────────
// The server ships the providers rows for a card layout (the `providers`
// heading chrome, one `providers[i]` chrome header per element, the element's
// field rows, and stamped create-on-write rows for known children the file
// omits). The client renders ONE CARD PER PROVIDER: no whole-array dump, no
// per-element JSON container row, an unknown extra key still visible inside
// its card, an absent known field reading "(unset)" with a control ONLY where
// the server stamped one, apiKey keeping the writeOnly REPLACE idiom -- and
// zero secret bytes anywhere in the panel DOM. (Secret-shaped children inside
// a container value are nulled SERVER-side; the panel's own rule is that a
// leafSecret row never prints slot bytes, pinned below with a sentinel.)

const SECRET_SENTINEL = "SENTINEL-SECRET-9137-NOT-FOR-THE-DOM";

const PROVIDERS_CANNED: ConfigSnapshotResultWire = {
  type: "configSnapshotResult",
  ts: 1700000000000,
  configDir: "/home/u/.config/hotdog",
  files: [{ path: "/home/u/.config/hotdog/defaults.json", inUse: true, status: "ok" }],
  findings: [],
  sections: [
    {
      name: "providers",
      rows: [
        { key: "providers", description: "Model providers", file: [{ name: "p1" }, { name: "p2" }] },
        { key: "providers[0]", description: "Provider entry", file: { name: "p1", url: "http://a/v1" } },
        { key: "providers[0].url", description: "Provider base URL", file: "http://a/v1", edit: { type: "string" } },
        // redacted:true is the honest shipped shape; `resolved` here is a
        // deliberately hostile extras-bytes case for the sweep (a buggy frame
        // must STILL never paint them through the leafSecret display rule).
        { key: "providers[0].apiKey", description: "Provider API key.", leafSecret: true, file: null, redacted: true, resolved: SECRET_SENTINEL, edit: { type: "string", writeOnly: true } },
        { key: "providers[0].nickname", description: "A key the schema does not know", file: "kept-verbatim" },
        { key: "providers[1]", description: "Provider entry", file: { name: "p2" } },
        // Known-but-absent child WITH the server's create-on-write stamp.
        { key: "providers[1].contextLength", description: "Context window", edit: { type: "integer" } },
        // The absent SECRET child: the stamped create row keeps the writeOnly
        // REPLACE idiom (the display side is the honest "unset").
        { key: "providers[1].apiKey", description: "Provider API key.", leafSecret: true, edit: { type: "string", writeOnly: true } },
        // Absent and UNstamped: reads "(unset)" and stays inert.
        { key: "providers[1].legend", description: "Nothing attests this" },
      ],
    },
  ],
};

const providerCard = (root: HTMLElement, key: string): HTMLElement =>
  (Array.from(root.querySelectorAll(".settings-provider-card")) as unknown as HTMLElement[]).find(
    (c) => c.getAttribute("data-key") === key,
  )!;

/** A card-scoped row lookup (attribute selectors cannot quote a "]" here). */
const rowIn = (scope: HTMLElement, key: string): HTMLElement | undefined =>
  (Array.from(scope.querySelectorAll(".settings-row")) as unknown as HTMLElement[]).find(
    (r) => r.getAttribute("data-key") === key,
  );

describe("provider cards", () => {
  it("one card per provider; the chrome never renders as a dump row or a JSON container", () => {
    const root = renderPanel(PROVIDERS_CANNED);
    const cards = (Array.from(root.querySelectorAll(".settings-provider-card")) as unknown as HTMLElement[]);
    expect(cards.map((c) => c.getAttribute("data-key"))).toEqual(["providers[0]", "providers[1]"]);
    // Card header: bold name + the mono providers[i] path (the chrome row IS
    // the header; it never paints as a flat .settings-row).
    expect(cards[0]!.querySelector(".settings-provider-name")!.textContent).toBe("p1");
    expect(cards[0]!.querySelector(".settings-provider-path")!.textContent).toBe("providers[0]");
    expect(rows(root).map((r) => r.getAttribute("data-key"))).toEqual([
      "providers[0].url",
      "providers[0].apiKey",
      "providers[0].nickname",
      "providers[1].contextLength",
      "providers[1].apiKey",
      "providers[1].legend",
    ]);
    // The top chrome is the section heading, not an array dump; the element
    // chrome has no whole-element JSON editor (the card + list ops own it).
    expect(root.querySelector(".settings-providers-heading")!.getAttribute("data-key")).toBe("providers");
    expect(root.textContent).not.toContain("name: p1, name: p2");
    const jsonBtns = (Array.from(root.querySelectorAll(".settings-btn")) as unknown as HTMLElement[]).filter(
      (b) => b.textContent === "Edit JSON",
    );
    expect(jsonBtns).toHaveLength(0);
    // The add affordance rides the category (the list ops own the array).
    const addBtn = (Array.from(root.querySelectorAll(".settings-btn")) as unknown as HTMLElement[]).find(
      (b) => b.textContent === "+ Add provider",
    );
    expect(addBtn).toBeTruthy();
  });

  it("an unknown extra key stays visible inside its provider's card", () => {
    const root = renderPanel(PROVIDERS_CANNED);
    const card0 = providerCard(root, "providers[0]");
    // (The dom-helper cannot quote a `]` inside an attribute selector, so
    // scoping walks the card's own rows.)
    expect(rowIn(card0, "providers[0].nickname")).toBeTruthy();
    expect(card0.textContent).toContain("kept-verbatim");
    // It belongs to THIS card only (never hoisted, never dropped).
    expect(rowIn(providerCard(root, "providers[1]"), "providers[0].nickname")).toBeUndefined();
  });

  it("an absent known field reads (unset) and carries a control ONLY where the server stamped one", () => {
    const root = renderPanel(PROVIDERS_CANNED);
    const card1 = providerCard(root, "providers[1]");
    // Absent + UNstamped: the display reads "(unset)" and NOTHING offers to
    // edit it (the honest hint is all the server can promise).
    const unstamped = rowForKey(root, "providers[1].legend");
    expect(unstamped.querySelector(".settings-value")!.textContent).toBe("(unset)");
    expect(unstamped.querySelector("input, textarea, button")).toBeNull();
    expect(unstamped.querySelector(".settings-file-hint")!.textContent).toContain("edit in file");
    // Absent + stamped create-on-write: a LIVE control exists, seeded EMPTY
    // (the faithful create seed attests nothing is set; editable scalar rows
    // never print a value cell).
    const stamped = rowForKey(root, "providers[1].contextLength");
    const box = stamped.querySelector(".settings-edit-input") as unknown as { value: string } | null;
    expect(box).toBeTruthy();
    expect(box!.value).toBe("");
    expect(stamped.querySelector(".settings-file-hint")).toBeNull();
    // The stamped SECRET create row keeps the REPLACE idiom: the display side
    // reads "unset" (never bytes), the box is empty, Set is offered.
    const secret = rowForKey(root, "providers[1].apiKey");
    expect(secret.querySelector(".settings-value")!.textContent).toBe("unset");
    expect((secret.querySelector(".settings-edit-secret") as unknown as HTMLElement).getAttribute("value")).toBe("");
    // All three ride inside their card.
    for (const key of ["providers[1].contextLength", "providers[1].apiKey", "providers[1].legend"]) {
      expect(rowIn(card1, key)).toBeTruthy();
    }
  });

  it("apiKey renders the write-only REPLACE box, never its bytes", () => {
    const root = renderPanel(PROVIDERS_CANNED);
    const card0 = providerCard(root, "providers[0]");
    const apiKey = rowIn(card0, "providers[0].apiKey")!;
    const box = apiKey.querySelector(".settings-edit-secret") as unknown as { value: string } | null;
    expect(box).toBeTruthy();
    expect((box as unknown as HTMLElement).getAttribute("type")).toBe("password");
    // Never prefilled -- not with the old value (unknown here), not with "".
    expect((box as unknown as HTMLElement).getAttribute("value")).toBe("");
    expect(box!.value).toBe("");
    const setBtn = (Array.from(apiKey.querySelectorAll(".settings-btn")) as unknown as HTMLElement[]).find(
      (b) => b.textContent === "Set",
    );
    expect(setBtn).toBeTruthy();
    // The file slot display is the redaction truth, not the sentinel bytes.
    expect(apiKey.querySelector(".settings-value")!.textContent).toBe("set (redacted)");
  });

  it("the sentinel sweep: zero secret bytes anywhere in the panel DOM", () => {
    const root = renderPanel(PROVIDERS_CANNED);
    // The sentinel-carrying row DID render (the sweep tests a live panel).
    expect(root.textContent).toContain("Provider API key.");
    const leaks: string[] = [];
    for (const el of Array.from(root.querySelectorAll("*")) as unknown as HTMLElement[]) {
      for (const attr of ["value", "placeholder", "title", "aria-label"]) {
        const v = el.getAttribute(attr);
        if (v !== null && v.includes(SECRET_SENTINEL)) leaks.push(`${attr} on ${el.getAttribute("class") ?? el.tagName}`);
      }
      const prop = (el as unknown as { value?: string }).value;
      if (typeof prop === "string" && prop.includes(SECRET_SENTINEL)) leaks.push(`.value on ${el.getAttribute("class")}`);
    }
    expect(leaks).toEqual([]);
    expect(root.textContent).not.toContain(SECRET_SENTINEL);
  });

  // Audit finding 1 (2026-11-11): the FLAT search list obeys the same doctrine
  // as the category view -- provider chrome rows never paint as flattened
  // containers, and every matched row still accounts.
  const PROV3: ConfigSnapshotResultWire = {
    type: "configSnapshotResult",
    ts: 1700000000000,
    configDir: "/home/u/.config/hotdog",
    files: [{ path: "/home/u/.config/hotdog/defaults.json", inUse: true, status: "ok" }],
    findings: [],
    sections: [
      {
        name: "providers",
        rows: [
          { key: "providers", description: "Model providers", file: [{ name: "p1" }, { name: "p2" }, { name: "p3" }] },
          { key: "providers[0]", description: "Provider entry", file: { name: "p1", url: "http://127.0.0.1:8000/v1" } },
          { key: "providers[0].url", description: "Provider base URL", file: "http://127.0.0.1:8000/v1", edit: { type: "string" } },
          { key: "providers[1]", description: "Provider entry", file: { name: "p2", url: "http://127.0.0.1:8100/v1" } },
          { key: "providers[1].url", description: "Provider base URL", file: "http://127.0.0.1:8100/v1", edit: { type: "string" } },
          { key: "providers[2]", description: "Provider entry", file: { name: "p3", url: "http://127.0.0.1:8200/v1" } },
          { key: "providers[2].url", description: "Provider base URL", file: "http://127.0.0.1:8200/v1", edit: { type: "string" } },
        ],
      },
    ],
  };

  it("search \"provider\": chrome paints HEADING form, never a flattened-container dump; leaves stay reachable", () => {
    const root = renderPanel(PROV3, { query: "provider" });
    const text = root.textContent;
    // The probe-captured dump shapes are gone (the top row flattened its array;
    // each element chrome flattened its object).
    expect(text).not.toContain("name: p1, name: p2, name: p3");
    expect(text).not.toContain("name: p1, url:");
    expect(text).not.toContain("name: p2, url:");
    expect(text).not.toContain("name: p3, url:");
    // The matched chrome still ACCOUNTS: the section heading + a one-line card
    // header per element (bold name + the mono providers[i] path).
    expect(root.querySelector(".settings-providers-heading")!.getAttribute("data-key")).toBe("providers");
    const heads = Array.from(root.querySelectorAll(".settings-provider-card-header")) as unknown as HTMLElement[];
    expect(heads.map((h) => h.getAttribute("data-key"))).toEqual(["providers[0]", "providers[1]", "providers[2]"]);
    expect(heads.map((h) => h.querySelector(".settings-provider-name")!.textContent)).toEqual(["p1", "p2", "p3"]);
    // Leaf rows render flat (reachable, live controls) beside the headings.
    expect(rows(root).map((r) => r.getAttribute("data-key"))).toEqual([
      "providers[0].url",
      "providers[1].url",
      "providers[2].url",
    ]);
    const leaf = rowForKey(root, "providers[1].url").querySelector(".settings-edit-input") as unknown as HTMLElement | null;
    expect((leaf as unknown as HTMLElement).getAttribute("value")).toBe("http://127.0.0.1:8100/v1");
    // The rail is SEARCH-TRUTH in FIELD UNITS (owner ruling 2026-11-11): the
    // seven matched rows resolve to the THREE provider cards -- the heading is
    // chrome (0) and each url row rolls into its card. Idle mode agrees: same
    // function, same three units (was: snapshot-truth "7" in both modes).
    const railCats = Array.from(root.querySelectorAll(".settings-cat")) as unknown as HTMLElement[];
    expect(railCats.map((c) => c.querySelector(".settings-cat-title")!.textContent)).toEqual(["All settings", "Providers"]);
    expect(railCats.map((c) => c.querySelector(".settings-cat-count")!.textContent)).toEqual(["3", "3"]);
    // Idle agrees with search through the same seam: the whole group counts 3.
    const idle = renderPanel(PROV3);
    const idleCats = Array.from(idle.querySelectorAll(".settings-cat")) as unknown as HTMLElement[];
    expect(idleCats.map((c) => c.querySelector(".settings-cat-count")!.textContent)).toEqual(["3", "3"]);
    expect(fieldUnitCount(PROV3.sections[0]!.rows)).toBe(3);
  });

  // Audit finding 5 (2026-11-11): a fallback-shape section (dotted
  // providers.<name>.<field> rows -- the file's `providers` value is no
  // parseable array) hides the Add affordance and says why in one honest
  // line; the panel never offers what the server must refuse.
  const PROV_FALLBACK: ConfigSnapshotResultWire = {
    type: "configSnapshotResult",
    ts: 1700000000000,
    configDir: "/home/u/.config/hotdog",
    files: [{ path: "/home/u/.config/hotdog/defaults.json", inUse: true, status: "ok" }],
    findings: [],
    sections: [
      {
        name: "providers",
        rows: [
          { key: "providers.slow.url", description: "Provider base URL", file: "http://slow/v1" },
          { key: "providers.slow.apiKey", description: "Provider API key.", leafSecret: true, file: null, redacted: true },
          { key: "providers.quick.url", description: "Provider base URL", file: "http://quick/v1" },
        ],
      },
    ],
  };

  it("a fallback-shape section renders NO Add control, only the honest one-line reason", () => {
    const root = renderPanel(PROV_FALLBACK);
    const cards = Array.from(root.querySelectorAll(".settings-provider-card")) as unknown as HTMLElement[];
    expect(cards.map((c) => c.getAttribute("data-name"))).toEqual(["slow", "quick"]);
    const btns = Array.from(root.querySelectorAll(".settings-btn")) as unknown as HTMLElement[];
    expect(btns.find((b) => b.textContent === "+ Add provider")).toBeUndefined();
    expect(root.querySelector(".settings-provider-add")).toBeNull();
    const none = root.querySelector(".settings-provider-add-none") as unknown as HTMLElement;
    expect(none.textContent).toContain("parseable providers array");
    expect(none.textContent).toContain("edit in file: /home/u/.config/hotdog/defaults.json");
  });
});

// ── Panel state doctrine (pure): fresh id per request, stale dropped ────────

// ── Array-of-primitives list blocks (the chrome doctrine, generalized) ───────
// The arrayChrome row renders as ONE list block: a compact header (label +
// description + attested layer badges + an element-count summary derived from
// the shipped element rows, NEVER a flattened value dump) over its element
// rows (existing control machinery, untouched), each with a one-click x, and
// exactly ONE + add affordance living ON the header (the chrome row ships
// ahead of its elements, so truncation can never strand the add). Empty chrome
// = header + add, zero phantom rows. writeOnly elements keep the REPLACE
// idiom with zero bytes anywhere. Search mode: chrome in HEADING form,
// elements individually editable WITH their x (the + stays in the category
// view -- documented decision).

const LIST_SECRET = "SENTINEL-LIST-4471-NEVER-IN-THE-DOM";

const LISTS_SNAP: ConfigSnapshotResultWire = {
  type: "configSnapshotResult",
  ts: 1700000000000,
  configDir: "/home/u/.config/hotdog",
  files: [{ path: "/home/u/.config/hotdog/defaults.json", inUse: true, status: "ok" }],
  findings: [],
  sections: [
    {
      name: "workspace",
      rows: [
        { key: "workspace.deny", description: "Denied path globs", arrayChrome: true, file: ["dist", "build"] },
        { key: "workspace.deny[0]", file: "dist", edit: { type: "string" } },
        { key: "workspace.deny[1]", file: "build", edit: { type: "string" } },
        { key: "workspace.ports", description: "Allowed ports", arrayChrome: true, file: [8080] },
        { key: "workspace.ports[0]", file: 8080, edit: { type: "integer", minimum: 1, maximum: 65535 } },
        { key: "workspace.modes", description: "Active modes", arrayChrome: true, file: ["fast"] },
        { key: "workspace.modes[0]", file: "fast", edit: { type: "string", enum: ["fast", "balanced", "thorough"] } },
        { key: "workspace.flags", description: "Feature booleans", arrayChrome: true, file: [true] },
        { key: "workspace.flags[0]", file: true, edit: { type: "boolean" } },
        { key: "workspace.tokens", description: "Rotate these tokens", arrayChrome: true, leafSecret: true, file: null, redacted: true },
        { key: "workspace.tokens[0]", leafSecret: true, file: null, redacted: true, resolved: LIST_SECRET, edit: { type: "string", writeOnly: true } },
        { key: "workspace.tags", description: "Nothing appended yet", arrayChrome: true, file: [] },
      ],
    },
  ],
};

const listBlock = (root: HTMLElement, key: string): HTMLElement =>
  (Array.from(root.querySelectorAll(".settings-list-block")) as unknown as HTMLElement[]).find(
    (b) => b.getAttribute("data-key") === key,
  )!;
const blockRows = (block: HTMLElement): HTMLElement[] =>
  Array.from(block.querySelectorAll(".settings-row")) as unknown as HTMLElement[];
const addBtnIn = (scope: HTMLElement): HTMLElement | undefined =>
  (Array.from(scope.querySelectorAll(".settings-list-add-btn")) as unknown as HTMLElement[])[0];
const removeBtnsIn = (scope: HTMLElement): HTMLElement[] =>
  Array.from(scope.querySelectorAll(".settings-list-remove")) as unknown as HTMLElement[];

describe("array list blocks (chrome doctrine, generalized)", () => {
  it("chrome header: label + description + count + badges, NEVER the value dump", () => {
    const root = renderPanel(LISTS_SNAP);
    const block = listBlock(root, "workspace.deny");
    const header = block.querySelector(".settings-list-header")!;
    expect(header.querySelector(".settings-row-label")!.textContent).toBe("Deny");
    expect(header.querySelector(".settings-row-desc")!.textContent).toBe("Denied path globs");
    // Element-count summary derived from the SHIPPED element rows.
    expect(header.querySelector(".settings-list-count")!.textContent).toBe("2 elements");
    // The attested layer badge rides (file is set); no value cell anywhere.
    expect(badgesOf(header as unknown as HTMLElement)).toEqual(["2 elements", "file"]);
    expect(header.querySelector(".settings-value")).toBeNull();
    // THE dump the owner rejected is absent from the whole panel.
    expect(root.textContent).not.toContain("dist, build");
    // One element row per index, shipped order, plus exactly ONE + on the block.
    expect(blockRows(block).map((r) => r.getAttribute("data-key"))).toEqual(["workspace.deny[0]", "workspace.deny[1]"]);
    expect((Array.from(block.querySelectorAll(".settings-list-add-btn")) as unknown as HTMLElement[])).toHaveLength(1);
    // The chrome row is NOT a flat .settings-row (header form only).
    expect(rows(root).some((r) => r.getAttribute("data-key") === "workspace.deny")).toBe(false);
  });

  it("element rows: existing control machinery + trailing one-click x", () => {
    const removed: string[] = [];
    const root = renderPanel(LISTS_SNAP, { onListRemove: (k) => removed.push(k) });
    const el0 = rowForKey(root, "workspace.deny[0]");
    // Seeds ride the RAW bytes through the untouched control machinery (the
    // dom-helper never reflects the value attribute into .value at mount --
    // the attribute is the seam here, exactly like the existing pins).
    expect((el0.querySelector(".settings-edit-input") as unknown as HTMLElement).getAttribute("value")).toBe("dist");
    const x = removeBtnsIn(el0)[0]!;
    expect(x.getAttribute("aria-label")).toBe("Remove workspace.deny[0]");
    // ONE click, no confirm: the frame decision rides immediately.
    x.click();
    expect(removed).toEqual(["workspace.deny[0]"]);
    expect(root.textContent).not.toContain("Confirm");
    // Every element row carries its own x (both deny rows).
    expect(removeBtnsIn(rowForKey(root, "workspace.deny[1]"))).toHaveLength(1);
    // The integer element got the stepper, the boolean the toggle, the enum
    // the dropdown -- unchanged SettingsControl, no re-routing.
    expect(rowForKey(root, "workspace.ports[0]").querySelector(".settings-stepper")).toBeTruthy();
    expect(rowForKey(root, "workspace.flags[0]").querySelector(".settings-toggle")).toBeTruthy();
    expect(rowForKey(root, "workspace.modes[0]").querySelector(".settings-select-input")).toBeTruthy();
  });

  it("empty chrome array: header + add only, zero element rows", () => {
    const root = renderPanel(LISTS_SNAP);
    const block = listBlock(root, "workspace.tags");
    expect(block.querySelector(".settings-list-count")!.textContent).toBe("0 elements");
    expect(blockRows(block)).toHaveLength(0);
    expect(addBtnIn(block)).toBeTruthy();
  });

  it("writeOnly elements: REPLACE box with ZERO bytes in the DOM, x still there", () => {
    const root = renderPanel(LISTS_SNAP);
    const block = listBlock(root, "workspace.tokens");
    const el = blockRows(block)[0]!;
    const box = el.querySelector(".settings-edit-secret") as unknown as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.getAttribute("type")).toBe("password");
    expect(box.getAttribute("value")).toBe("");
    // No element byte anywhere in the panel (the hostile resolved slot included).
    expect(root.textContent).not.toContain(LIST_SECRET);
    for (const node of Array.from(root.querySelectorAll("*")) as unknown as HTMLElement[]) {
      for (const attr of ["value", "placeholder", "title", "aria-label"]) {
        const v = node.getAttribute(attr);
        expect(v === null || !v.includes(LIST_SECRET)).toBe(true);
      }
    }
    // The count rides; the header never dumps. And x still removes a secret
    // element (the frame carries only the keyPath).
    expect(block.querySelector(".settings-list-count")!.textContent).toBe("1 element");
    expect(removeBtnsIn(el)).toHaveLength(1);
  });

  it("+ opens a TYPED inline field per element stamp (text/number/enum/bool/secret)", () => {
    const root = renderPanel(LISTS_SNAP, { addingList: "workspace.deny" });
    const deny = listBlock(root, "workspace.deny");
    const input = deny.querySelector(".settings-list-add-input") as unknown as HTMLElement;
    expect(input).toBeTruthy();
    expect(input.getAttribute("type")).toBe("text");
    expect((Array.from(deny.querySelectorAll(".settings-list-add-go")) as unknown as HTMLElement[])).toHaveLength(1);

    const num = renderPanel(LISTS_SNAP, { addingList: "workspace.ports" });
    expect((listBlock(num, "workspace.ports").querySelector(".settings-list-add-input") as unknown as HTMLElement).getAttribute("type")).toBe("number");

    const en = renderPanel(LISTS_SNAP, { addingList: "workspace.modes" });
    const sel = en.querySelectorAll("select.settings-list-add-input")[0] as unknown as HTMLElement;
    const opts = Array.from(sel.querySelectorAll("option")).map((o) => (o as unknown as HTMLElement).textContent);
    expect(opts).toEqual(["fast", "balanced", "thorough"]); // EXACTLY the enum set

    const bool = renderPanel(LISTS_SNAP, { addingList: "workspace.flags" });
    const bsel = bool.querySelectorAll("select.settings-list-add-input")[0] as unknown as HTMLElement;
    expect(Array.from(bsel.querySelectorAll("option")).map((o) => (o as unknown as HTMLElement).textContent)).toEqual(["true", "false"]);

    const secret = renderPanel(LISTS_SNAP, { addingList: "workspace.tokens" });
    expect((listBlock(secret, "workspace.tokens").querySelector(".settings-list-add-input") as unknown as HTMLElement).getAttribute("type")).toBe("password");
  });

  it("+ commit reports the raw text WITH the element stamp; Cancel is pure", () => {
    const commits: Array<[string, string, ConfigKeyEditWire | undefined]> = [];
    let cancels = 0;
    const root = renderPanel(LISTS_SNAP, {
      addingList: "workspace.deny",
      onListAddCommit: (k, raw, edit) => commits.push([k, raw, edit]),
      onListAddCancel: () => cancels++,
    });
    const block = listBlock(root, "workspace.deny");
    const input = block.querySelector(".settings-list-add-input") as unknown as HTMLElement & { value: string };
    input.value = "node_modules";
    (Array.from(block.querySelectorAll(".settings-list-add-go")) as unknown as HTMLElement[])[0]!.click();
    expect(commits).toEqual([["workspace.deny", "node_modules", { type: "string" }]]);
    // The element stamp rides (the FIRST shipped element row's edit) -- the
    // app parses the typed value with it.
    (Array.from(block.querySelectorAll(".settings-btn")).find((b) => (b as unknown as HTMLElement).textContent === "Cancel") as unknown as HTMLElement).click();
    expect(cancels).toBe(1);
  });

  it("busy (one list op in flight) disables every x and + in every block", () => {
    const root = renderPanel(LISTS_SNAP, { listBusy: true });
    for (const x of removeBtnsIn(root)) expect(x.hasAttribute("disabled")).toBe(true);
    const adds = Array.from(root.querySelectorAll(".settings-list-add-btn")) as unknown as HTMLElement[];
    expect(adds.length).toBeGreaterThan(0);
    for (const a of adds) expect(a.hasAttribute("disabled")).toBe(true);
  });

  it("a refusal renders VERBATIM under the owning block only", () => {
    const root = renderPanel(LISTS_SNAP, { listError: { key: "workspace.deny", message: '"workspace.deny" holds string elements -- appending a number would mix types' } });
    expect(listBlock(root, "workspace.deny").querySelector(".settings-list-error")!.textContent).toContain("would mix types");
    expect(listBlock(root, "workspace.ports").querySelector(".settings-list-error")).toBeNull();
  });

  it("Escape with an open add field cancels FIRST (zero wire, dialog stays)", () => {
    let closes = 0;
    let cancels = 0;
    const root = renderPanel(LISTS_SNAP, { addingList: "workspace.deny", onClose: () => closes++, onListAddCancel: () => cancels++ });
    (root as unknown as HTMLElement).dispatchEvent({ type: "keydown", key: "Escape", currentTarget: root } as unknown as Event);
    expect(cancels).toBe(1);
    expect(closes).toBe(0);
  });

  it("click-away cancels an open add; a click inside the affordance does not", () => {
    let cancels = 0;
    const root = renderPanel(LISTS_SNAP, { addingList: "workspace.deny", onListAddCancel: () => cancels++ });
    const inside = listBlock(root, "workspace.deny").querySelector(".settings-list-add-row")!;
    root.dispatchEvent({ type: "mousedown", target: inside } as unknown as Event);
    expect(cancels).toBe(0);
    root.dispatchEvent({ type: "mousedown", target: root.querySelector(".settings-search") } as unknown as Event);
    expect(cancels).toBe(1);
  });

  it("search: chrome renders HEADING form (never a dump), elements stay editable WITH x", () => {
    const root = renderPanel(LISTS_SNAP, { query: "deny" });
    // The chrome matched (key AND description) -> heading form: label + path.
    const head = root.querySelector(".settings-list-chrome-heading") as unknown as HTMLElement;
    expect(head).toBeTruthy();
    expect(head.getAttribute("data-key")).toBe("workspace.deny");
    expect(head.textContent).toContain("workspace.deny");
    // No flattened dump anywhere in the search pane.
    expect(root.textContent).not.toContain("dist, build");
    // Element rows are matched searchable units: each keeps its control + x.
    const hit = rows(root).map((r) => r.getAttribute("data-key"));
    expect(hit).toContain("workspace.deny[0]");
    expect(hit).toContain("workspace.deny[1]");
    for (const k of ["workspace.deny[0]", "workspace.deny[1]"]) {
      expect(removeBtnsIn(rowForKey(root, k))).toHaveLength(1);
    }
    // A description-only match surfaces the HEADING alone (no dump, no rows).
    const g = renderPanel(LISTS_SNAP, { query: "globs" });
    expect((g.querySelector(".settings-list-chrome-heading") as unknown as HTMLElement).getAttribute("data-key")).toBe("workspace.deny");
    expect(rows(g).filter((r) => (r.getAttribute("data-key") ?? "").startsWith("workspace.deny["))).toHaveLength(0);
    // The rail agrees with the chrome doctrine: a heading-ONLY match claims
    // zero units, so the search rail carries no Workspace entry (the same
    // "chrome never counts" rule pinned for the providers heading).
    const railCats = Array.from(g.querySelectorAll(".settings-cat")) as unknown as HTMLElement[];
    expect(railCats.map((c) => c.querySelector(".settings-cat-title")!.textContent)).toEqual(["All settings"]);
    expect(railCats.map((c) => c.querySelector(".settings-cat-count")!.textContent)).toEqual(["0"]);
  });

  it("a 450-element truncated snapshot renders promptly with the header + add intact", () => {
    const rows450: ConfigKeyEntryWire[] = [
      { key: "workspace.deny", description: "Denied path globs", arrayChrome: true, file: Array.from({ length: 450 }, (_, i) => `p${i}`) },
      ...Array.from({ length: 450 }, (_, i) => ({
        key: `workspace.deny[${i}]`,
        file: `p${i}`,
        edit: { type: "string" as const },
      })),
    ];
    const root = renderPanel({ ...LISTS_SNAP, truncated: true, sections: [{ name: "workspace", rows: rows450 }] });
    // Completes (no hang) -- the header is present, the + survives the cut,
    // and the honest truncation notice attests it.
    const block = listBlock(root, "workspace.deny");
    expect(block).toBeTruthy();
    expect(blockRows(block)).toHaveLength(450);
    expect(addBtnIn(block)).toBeTruthy();
    expect(root.textContent).toContain("List truncated");
  });
});

// ── Provider-card list blocks (chrome inside the card) ───────────────────────
// Inside a provider card, a chrome'd field (providers[0].models and its
// element rows, landing in the card fields via splitProviderRows) uses the
// SAME list block component: models never renders as a dump row. The card's
// two-step Remove and the section's "+ Add provider" keep their doctrine.

describe("provider card list blocks", () => {
  const PROV_MODELS: ConfigSnapshotResultWire = {
    type: "configSnapshotResult",
    ts: 1700000000000,
    configDir: "/home/u/.config/hotdog",
    files: [{ path: "/home/u/.config/hotdog/defaults.json", inUse: true, status: "ok" }],
    findings: [],
    sections: [
      {
        name: "providers",
        rows: [
          { key: "providers", description: "Model providers", file: [{ name: "p1" }] },
          { key: "providers[0]", description: "Provider entry", file: { name: "p1", url: "http://a/v1" } },
          { key: "providers[0].url", description: "Provider base URL", file: "http://a/v1", edit: { type: "string" } },
          { key: "providers[0].models", description: "Models served by this provider", arrayChrome: true, file: ["m1", "m2"] },
          { key: "providers[0].models[0]", file: "m1", edit: { type: "string" } },
          { key: "providers[0].models[1]", file: "m2", edit: { type: "string" } },
        ],
      },
    ],
  };

  it("models renders as a list block inside the card: per-model x + ONE +", () => {
    const root = renderPanel(PROV_MODELS);
    const card = providerCard(root, "providers[0]");
    // Same component as everywhere: chrome header (no dump), element rows, add.
    const block = listBlock(card, "providers[0].models");
    expect(block).toBeTruthy();
    expect(card.textContent).not.toContain("m1, m2");
    expect(blockRows(block).map((r) => r.getAttribute("data-key"))).toEqual(["providers[0].models[0]", "providers[0].models[1]"]);
    expect(removeBtnsIn(block)).toHaveLength(2); // one x per model
    expect((Array.from(block.querySelectorAll(".settings-list-add-btn")) as unknown as HTMLElement[])).toHaveLength(1);
    // The card's own two-step Remove + the section's "+ Add provider" are the
    // PROVIDER list's affordances -- unchanged doctrine, separate from models.
    expect(card.querySelector(".settings-provider-remove")).toBeTruthy();
    const addProvider = (Array.from(root.querySelectorAll(".settings-btn")) as unknown as HTMLElement[]).find(
      (b) => b.textContent === "+ Add provider",
    );
    expect(addProvider).toBeTruthy();
    // url stays a plain field row (not swallowed into a list).
    expect(rowIn(card, "providers[0].url")).toBeTruthy();
    // The sweep keeps faith: every shipped row renders exactly once (chrome
    // via the block header, models elements via their rows).
    const allKeys = PROV_MODELS.sections[0]!.rows.map((r) => r.key);
    const domKeys = (Array.from(root.querySelectorAll(".settings-row, .settings-list-block, .settings-providers-heading, .settings-provider-card")) as unknown as HTMLElement[])
      .map((el) => el.getAttribute("data-key"))
      .filter((k): k is string => k !== null && allKeys.includes(k));
    for (const k of allKeys) expect(domKeys.filter((d) => d === k)).toHaveLength(1);
  });
});

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
      queuedSaves: [],
      editError: null,
      saveReqId: 0,
      needsRestart: false,
      editedKeys: [],
      query: "",
      category: null,
      addingList: null,
      confirmRemoveKey: null,
      listError: null,
      pendingList: null,
      queuedList: [],
      listReqId: 0,
      focusProviderName: null,
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

  it("rail filter ops are pure visits: query + category live on the panel state", () => {
    let s = openSettingsPanel(initialSettingsPanelState);
    s = setSettingsQuery(s, "loop");
    expect(s.query).toBe("loop");
    s = setSettingsCategory(s, "WebUI");
    expect(s.category).toBe("WebUI");
    // A snapshot refresh keeps the filter (the visit owns it)...
    const refreshed = refreshSettingsPanel(s);
    expect(refreshed.query).toBe("loop");
    // ...a close drops it (a new visit starts clean).
    const closed = closeSettingsPanel(refreshed);
    expect(closed.query).toBe("");
    expect(closed.category).toBeNull();
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
