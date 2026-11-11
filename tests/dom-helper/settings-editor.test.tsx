/// <reference lib="dom" />
// DOM tests for the settings EDITOR layer of settings-view.tsx on the
// dom-helper (redesign C6: IMMEDIATE-SAVE controls, no Edit click). One
// control test per stamp kind asserting the right widget AND the payload
// shape it asks the app to send: boolean -> toggle switch (role=switch,
// aria-checked) firing on flip; number -> minus/plus stepper on EVERY
// number row (declared bounds clamp, undeclared step freely) with the
// value editable between, saving on blur/Enter; seeded string -> inline input saving on
// blur/Enter with NO wire traffic when unchanged; seedless string -> EMPTY
// box that saves only when non-empty; writeOnly secret -> password REPLACE
// box + explicit Set (empty refused locally "no new value entered"); json
// container -> row-revealed monospace textarea with Save/Cancel (Enter does
// NOT save). Refusal rows (no row.edit) render NO control and keep the
// honest "edit in file: ..." text. Rejections render VERBATIM and the
// control reverts to the last server-known value; the restart marker is
// driven by the success reply's needsRestart field. The pending queue rule
// (a second change on a path whose save is in flight updates the queued
// value instead of a parallel second save) is pinned alongside the pure
// write-state doctrine. The live WS round trip is covered in app.test.tsx.

import { describe, it, expect, afterEach } from "bun:test";
import {
  SettingsViewer,
  initialSettingsPanelState,
  openSettingsPanel,
  refreshSettingsPanel,
  startSettingsEdit,
  cancelSettingsEdit,
  parseEditValue,
  editSeedText,
  jsonSeedText,
  rejectSettingsSave,
  requestSettingsSave,
  flushSettingsSave,
  pendingDisplay,
  applySetConfigReply,
  applySnapshotReply,
  type SettingsPanelState,
  type SettingsQueuedSave,
} from "@extensions/webui/ui/settings-view.tsx";
import type { ConfigKeyEditWire, ConfigSnapshotResultWire } from "@extensions/websocket/protocol.ts";
import { mount, type DomNode, type Mounted } from "@utils/jsx";

const noop = (): void => {};

const EDIT_PORT: ConfigKeyEditWire = { type: "number" };
const EDIT_BOOL: ConfigKeyEditWire = { type: "boolean" };
const EDIT_FENCE: ConfigKeyEditWire = { type: "string", enum: ["off", "probe"] };

const CANNED: ConfigSnapshotResultWire = {
  type: "configSnapshotResult",
  ts: 1700000000000,
  configDir: "/home/u/.config/hotdog",
  files: [
    { path: "/home/u/.config/hotdog/defaults.json", inUse: true, status: "ok" },
    { path: "/etc/hotdog/defaults.json", inUse: false, status: "missing" },
  ],
  findings: [],
  sections: [
    {
      name: "core",
      rows: [
        { key: "maxToolResultChars", description: "Cap", default: null, edit: { type: "number", maximum: 2000000 } },
        { key: "maxIterations", description: "Max iterations", default: 25, resolved: 25 },
        { key: "execFence", description: "Fence for pooled executors", default: "probe", file: "probe", resolved: "probe", edit: EDIT_FENCE },
        { key: "systemPromptTemplate", description: "Big prose (the shipped form is a truncation)", default: null, file: "Once upon a time...[truncated]", resolved: "Once upon a time...[truncated]", edit: { type: "string", seedless: true } },
        {
          key: "apiKey",
          description: "API key.",
          default: null,
          env: { set: true, source: "HOTDOG_API_KEY" },
          resolved: null,
          leafSecret: true,
          redacted: true,
        },
      ],
    },
    {
      name: "webui",
      rows: [
        { key: "webui.port", description: "WebUI server port", default: 3000, file: 4321, resolved: 4321, edit: EDIT_PORT },
        { key: "webui.host", description: "WebUI server host", default: "127.0.0.1", resolved: "127.0.0.1" },
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
    {
      name: "prompts",
      rows: [{ key: "prompts.displayPrompt", description: "Show the prompt", default: true, resolved: true, edit: EDIT_BOOL }],
    },
    {
      name: "workspace",
      rows: [
        { key: "workspace.paths", description: "Workspace roots", file: ["/home/u/proj"], edit: { type: "json" } },
        {
          key: "webSearch.braveApiKey",
          description: "Brave Search API key.",
          leafSecret: true,
          file: null,
          redacted: true,
          edit: { type: "string", writeOnly: true },
        },
      ],
    },
    {
      name: "loop-detect",
      rows: [
        { key: "loopDetect.enabled", description: "Watch tool calls for loop patterns", default: true, resolved: true, edit: EDIT_BOOL },
        { key: "loopDetect.repeatThreshold", description: "Identical repeats before the first nudge", default: 3, resolved: 3, edit: { type: "integer", minimum: 2, maximum: 12 } },
      ],
    },
  ],
};

// ── Harness ─────────────────────────────────────────────────────────────────

let current: Mounted | null = null;

function renderPanel(
  snapshot: ConfigSnapshotResultWire | null,
  opts: {
    editing?: string | null;
    pendingSave?: { key: string; reqId: number; shown: string } | null;
    queuedSaves?: SettingsQueuedSave[];
    editError?: { key: string; message: string } | null;
    needsRestart?: boolean;
    editedKeys?: string[];
    onEdit?: (key: string) => void;
    onCancelEdit?: () => void;
    onSaveEdit?: (key: string, raw: string, edit: ConfigKeyEditWire) => void;
    onClose?: () => void;
    addingProvider?: boolean;
    confirmRemoveKey?: string | null;
    providerListError?: string | null;
    listBusy?: boolean;
    onProviderAdd?: () => void;
    onProviderAddCommit?: (name: string) => void;
    onProviderAddCancel?: () => void;
    onProviderRemoveArm?: (cardKey: string, index: number, name: string) => void;
    onProviderRemoveConfirm?: (index: number, name: string) => void;
    onProviderRemoveCancel?: () => void;
  } = {},
): HTMLElement {
  const host = document.createElement("div");
  current = mount(
    <SettingsViewer
      snapshot={snapshot}
      pending={false}
      rootRef={() => {}}
      onClose={opts.onClose ?? noop}
      onRefresh={noop}
      editing={opts.editing ?? null}
      pendingSave={opts.pendingSave ?? null}
      queuedSaves={opts.queuedSaves ?? []}
      editError={opts.editError ?? null}
      needsRestart={opts.needsRestart ?? false}
      editedKeys={opts.editedKeys ?? []}
      query=""
      category={null}
      onQuery={noop}
      onCategory={noop}
      onEdit={opts.onEdit ?? noop}
      onCancelEdit={opts.onCancelEdit ?? noop}
      onSaveEdit={opts.onSaveEdit ?? noop}
      addingProvider={opts.addingProvider ?? false}
      confirmRemoveKey={opts.confirmRemoveKey ?? null}
      providerListError={opts.providerListError ?? null}
      listBusy={opts.listBusy ?? false}
      focusProviderName={null}
      onProviderAdd={opts.onProviderAdd ?? noop}
      onProviderAddCommit={opts.onProviderAddCommit ?? noop}
      onProviderAddCancel={opts.onProviderAddCancel ?? noop}
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
const valueText = (row: HTMLElement): string => (row.querySelector(".settings-value") as unknown as HTMLElement)?.textContent ?? "";

const buttonLabeled = (scope: HTMLElement, label: string): HTMLElement | undefined =>
  (Array.from(scope.querySelectorAll("button")) as unknown as HTMLElement[]).find((b) => b.textContent === label);
const buttonByAria = (scope: HTMLElement, ariaLabel: string): HTMLElement | undefined =>
  (Array.from(scope.querySelectorAll("button")) as unknown as HTMLElement[]).find((b) => b.getAttribute("aria-label") === ariaLabel);
const dispatch = (el: HTMLElement, ev: Record<string, unknown>): void => {
  el.dispatchEvent(ev as unknown as Event);
};

// ── The affordance split: stamped / inert / redacted ─────────────────────────

describe("settings editor affordances", () => {
  it("stamped rows carry their IMMEDIATE control (no Edit click): toggle, stepper, input, textarea opener, Set box", () => {
    const root = renderPanel(CANNED);
    // boolean -> toggle switch
    expect(rowForKey(root, "prompts.displayPrompt").querySelector('[role="switch"]')).toBeTruthy();
    // bounded number -> stepper (minus + plus around the value)
    const step = rowForKey(root, "loopDetect.repeatThreshold");
    expect(buttonByAria(step, "Decrease loopDetect.repeatThreshold")).toBeTruthy();
    expect(buttonByAria(step, "Increase loopDetect.repeatThreshold")).toBeTruthy();
    // unbounded number -> the SAME stepper shape, just clamp-free
    const port = rowForKey(root, "webui.port");
    expect(port.querySelector('input[type="number"]')).toBeTruthy();
    expect(buttonByAria(port, "Decrease webui.port")).toBeTruthy();
    expect(buttonByAria(port, "Increase webui.port")).toBeTruthy();
    // schema enum -> a dropdown of the stamped set, no free-text input
    const fence = rowForKey(root, "execFence");
    expect(fence.querySelector("select")).toBeTruthy();
    expect(fence.querySelector("input")).toBeNull();
    const fopts = fence.querySelectorAll("option");
    expect(Array.from(fopts).map((o) => o.getAttribute("value"))).toEqual(["off", "probe"]);
    expect(fopts[1]?.hasAttribute("selected")).toBe(true); // the seed "probe" rides selected
    expect(fopts[0]?.hasAttribute("selected")).toBe(false);
    // json container -> the row reveals the textarea on demand
    expect(buttonLabeled(rowForKey(root, "workspace.paths"), "Edit JSON")).toBeTruthy();
    // writeOnly secret -> REPLACE box + explicit Set
    const secret = rowForKey(root, "webSearch.braveApiKey");
    expect(secret.querySelector('input[type="password"]')).toBeTruthy();
    expect(buttonLabeled(secret, "Set")).toBeTruthy();
  });

  it("UNSTAMPED rows render NO control and keep the honest edit-in-file hint with the IN-USE config path", () => {
    const root = renderPanel(CANNED);
    for (const key of ["maxIterations", "webui.host", "apiKey", "webui.apiKey"]) {
      const row = rowForKey(root, key);
      // No control of any stamp kind reaches an unstamped row (belts against
      // a hostile or ancient reply unlocking a redacted row).
      expect(row.querySelector("input")).toBeNull();
      expect(row.querySelector("textarea")).toBeNull();
      expect(row.querySelector('[role="switch"]')).toBeNull();
      expect(row.querySelectorAll("button")).toHaveLength(0);
      const hint = row.querySelector(".settings-file-hint") as unknown as HTMLElement;
      expect(hint).toBeTruthy();
      expect(hint.textContent).toContain("edit in file");
      expect(hint.getAttribute("title")).toContain("/home/u/.config/hotdog/defaults.json"); // the inUse entry, not the /etc candidate
      expect(hint.getAttribute("title")).toContain("hotdog rescue validates it");
    }
  });
});

// ── The immediate-save controls (one per stamp kind) ────────────────────────

describe("settings immediate-save controls", () => {
  it("boolean row: a toggle switch (role=switch, aria-checked) that fires a save on flip", () => {
    const saves: Array<{ key: string; raw: string; edit: ConfigKeyEditWire }> = [];
    const root = renderPanel(CANNED, { onSaveEdit: (key, raw, edit) => saves.push({ key, raw, edit }) });
    const toggle = rowForKey(root, "prompts.displayPrompt").querySelector('[role="switch"]') as unknown as HTMLElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true"); // resolved/default = true
    toggle.click();
    expect(saves).toEqual([{ key: "prompts.displayPrompt", raw: "false", edit: EDIT_BOOL }]);
    // The optimistic flip renders: the panel shows the DESIRED value while
    // the save is in flight (the reply settles or reverts it).
    const root2 = renderPanel(CANNED, { pendingSave: { key: "prompts.displayPrompt", reqId: 1, shown: "false" } });
    expect(rowForKey(root2, "prompts.displayPrompt").querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("false");
    // A SECOND flip while pending asks the app to save again -- the queue
    // rule (no parallel second save) is the app/state half, pinned below.
    const seen2: string[] = [];
    const root3 = renderPanel(CANNED, {
      pendingSave: { key: "prompts.displayPrompt", reqId: 1, shown: "false" },
      onSaveEdit: (key) => seen2.push(key),
    });
    (rowForKey(root3, "prompts.displayPrompt").querySelector('[role="switch"]') as unknown as HTMLElement).click();
    expect(seen2).toEqual(["prompts.displayPrompt"]); // and the parse maps it to a BOOLEAN payload
    expect(parseEditValue(EDIT_BOOL, "false")).toEqual({ ok: true, payload: { value: false } });
  });

  it("bounded number: a minus/plus stepper clamped at the bounds, value editable between", () => {
    const saves: Array<{ key: string; raw: string; edit: ConfigKeyEditWire }> = [];
    const root = renderPanel(CANNED, { onSaveEdit: (key, raw, edit) => saves.push({ key, raw, edit }) });
    const row = rowForKey(root, "loopDetect.repeatThreshold");
    const value = row.querySelector(".settings-step-value") as unknown as HTMLElement & { value: string };
    expect(value.getAttribute("value")).toBe("3");
    expect(value.getAttribute("min")).toBe("2");
    expect(value.getAttribute("max")).toBe("12");
    // plus steps from the shown value and fires immediately
    buttonByAria(row, "Increase loopDetect.repeatThreshold")!.click();
    expect(saves.pop()).toEqual({
      key: "loopDetect.repeatThreshold",
      raw: "4",
      edit: { type: "integer", minimum: 2, maximum: 12 },
    });
    // Stepping straight back to the SERVER-KNOWN value with nothing in
    // flight is back to where we started: no save.
    buttonByAria(row, "Decrease loopDetect.repeatThreshold")!.click();
    expect(saves).toHaveLength(0);
    // With the +4 save IN FLIGHT, stepping back is a queue update (the
    // undo must still go out): the control shows the optimistic 4 and the
    // minus asks to save 3.
    const pendingRoot = renderPanel(CANNED, {
      pendingSave: { key: "loopDetect.repeatThreshold", reqId: 1, shown: "4" },
      onSaveEdit: (key, raw) => saves.push({ key, raw, edit: { type: "integer", minimum: 2, maximum: 12 } }),
    });
    const pendingRow = rowForKey(pendingRoot, "loopDetect.repeatThreshold");
    expect((pendingRow.querySelector(".settings-step-value") as unknown as HTMLElement).getAttribute("value")).toBe("4");
    buttonByAria(pendingRow, "Decrease loopDetect.repeatThreshold")!.click();
    expect(saves.pop()).toEqual({ key: "loopDetect.repeatThreshold", raw: "3", edit: { type: "integer", minimum: 2, maximum: 12 } });
    // CLAMPS: 2 is the floor -- minus at the bound changes nothing, so
    // nothing goes to the wire (no pending state: the static path).
    const floor: ConfigSnapshotResultWire = {
      ...CANNED,
      sections: CANNED.sections.map((x) => ({
        ...x,
        rows: x.rows.map((r) => (r.key === "loopDetect.repeatThreshold" ? { ...r, file: 2, resolved: 2 } : r)),
      })),
    };
    const floorRoot = renderPanel(floor, { onSaveEdit: (key, raw, edit) => saves.push({ key, raw, edit }) });
    const floorRow = rowForKey(floorRoot, "loopDetect.repeatThreshold");
    buttonByAria(floorRow, "Decrease loopDetect.repeatThreshold")!.click();
    expect(saves).toHaveLength(0);
    buttonByAria(floorRow, "Increase loopDetect.repeatThreshold")!.click();
    expect(saves.pop()!.raw).toBe("3");
    // The value itself stays editable (blur saves like any input; the
    // dom-helper does not reflect the seed into .value, so seed it by hand).
    const editable = floorRow.querySelector(".settings-step-value") as unknown as HTMLElement & { value: string };
    editable.value = "7";
    dispatch(editable, { type: "blur" });
    expect(saves.pop()!.raw).toBe("7");
  });

  it("unbounded number: the same stepper, no clamp; blur/Enter save, NOTHING on unchanged", () => {
    const saves: Array<{ key: string; raw: string; edit: ConfigKeyEditWire }> = [];
    const root = renderPanel(CANNED, { onSaveEdit: (key, raw, edit) => saves.push({ key, raw, edit }) });
    const row = rowForKey(root, "webui.port");
    const input = row.querySelector(".settings-edit-input") as unknown as HTMLElement & { value: string };
    expect(input.getAttribute("type")).toBe("number");
    expect(input.getAttribute("value")).toBe("4321"); // the file slot seeds it
    // An unchanged blur is zero wire traffic. (The dom-helper does not
    // reflect the value ATTRIBUTE into the live .value the way a browser
    // does at mount, so seed the field by hand to model the honest blur.)
    input.value = "4321";
    dispatch(input, { type: "blur" });
    expect(saves).toHaveLength(0);
    // A typed blur fires; Enter fires the same way.
    input.value = "4399";
    dispatch(input, { type: "blur" });
    expect(saves.pop()).toEqual({ key: "webui.port", raw: "4399", edit: EDIT_PORT });
    input.value = "4400";
    dispatch(input, { type: "keydown", key: "Enter" });
    expect(saves.pop()!.raw).toBe("4400");
    // The ± buttons exist HERE too (one stepper language for all numbers)
    // and step WITHOUT any clamp: 4400 -> 4401 -> 4400, each saving live.
    const plus = buttonByAria(row, "Increase webui.port");
    const minus = buttonByAria(row, "Decrease webui.port");
    expect(plus).toBeTruthy();
    expect(minus).toBeTruthy();
    plus!.click();
    expect(saves.pop()).toEqual({ key: "webui.port", raw: "4401", edit: EDIT_PORT });
    minus!.click();
    expect(saves.pop()!.raw).toBe("4400");
    // A row WITHOUT declared bounds carries no min/max hints.
    expect(input.hasAttribute("min")).toBe(false);
    // Other rows keep their own controls (no shared state leak).
    expect(rowForKey(root, "prompts.displayPrompt").querySelector(".settings-edit-input")).toBeNull();
  });

  it("enum dropdown: picking an option saves immediately; re-picking the seed is silent", () => {
    const saves: Array<{ key: string; raw: string; edit: ConfigKeyEditWire }> = [];
    const root = renderPanel(CANNED, { onSaveEdit: (key, raw, edit) => saves.push({ key, raw, edit }) });
    const sel = rowForKey(root, "execFence").querySelector("select") as unknown as HTMLElement & { value: string };
    sel.value = "off";
    dispatch(sel, { type: "change", currentTarget: sel });
    expect(saves.pop()).toEqual({ key: "execFence", raw: "off", edit: EDIT_FENCE });
    // Back to the seed: unchanged vs the server-known value -> zero traffic.
    sel.value = "probe";
    dispatch(sel, { type: "change", currentTarget: sel });
    expect(saves).toHaveLength(0);
  });

  it("enum dropdown: a shipped value OUTSIDE the set rides verbatim as the current option", () => {
    // A hand-authored config the schema has since narrowed: the dropdown
    // never silently replaces the truth -- it carries it, marked.
    const stale = structuredClone(CANNED);
    const row = stale.sections[0]!.rows.find((r) => r.key === "execFence")!;
    row.file = "legacy-mode";
    row.resolved = "legacy-mode";
    const root = renderPanel(stale);
    const opts = rowForKey(root, "execFence").querySelectorAll("option");
    expect(Array.from(opts).map((o) => o.getAttribute("value"))).toEqual(["legacy-mode", "off", "probe"]);
    expect(opts[0]?.textContent).toBe("legacy-mode (current)");
    expect(opts[0]?.hasAttribute("selected")).toBe(true);
  });

  it("seeded string: inline input saving on blur/Enter with no wire traffic when unchanged", () => {
    const saves: Array<{ key: string; raw: string; edit: ConfigKeyEditWire }> = [];
    const root2 = renderPanel(
      {
        ...CANNED,
        sections: [{ name: "providers", rows: [{ key: "providers[0].url", description: "Provider base URL", file: "http://127.0.0.1:8000/v1", edit: { type: "string" } }] }],
      },
      { onSaveEdit: (key, raw, edit) => saves.push({ key, raw, edit }) },
    );
    const urlRow = rowForKey(root2, "providers[0].url");
    const input = urlRow.querySelector(".settings-edit-input") as unknown as HTMLElement & { value: string };
    expect(input.getAttribute("type")).toBe("text");
    expect(input.getAttribute("value")).toBe("http://127.0.0.1:8000/v1");
    input.value = "http://127.0.0.1:8000/v1"; // the browser's mounted state (see the blur note above)
    dispatch(input, { type: "blur" });
    expect(saves).toHaveLength(0); // unchanged blur: nothing on the wire
    input.value = "http://127.0.0.1:9100/v1";
    dispatch(input, { type: "keydown", key: "Enter" });
    expect(saves).toEqual([
      { key: "providers[0].url", raw: "http://127.0.0.1:9100/v1", edit: { type: "string" } },
    ]);
    // And the parse puts the string on the `value` channel (a scalar).
    expect(parseEditValue({ type: "string" }, "x")).toEqual({ ok: true, payload: { value: "x" } });
  });

  it("seedless lossy string: EMPTY box with the honest placeholder; saves only when non-empty", () => {
    const saves: Array<{ key: string; raw: string; edit: ConfigKeyEditWire }> = [];
    const root = renderPanel(CANNED, { onSaveEdit: (key, raw, edit) => saves.push({ key, raw, edit }) });
    const row = rowForKey(root, "systemPromptTemplate");
    const input = row.querySelector(".settings-edit-input") as unknown as HTMLElement & { value: string };
    expect(input).toBeTruthy();
    // The shipped form is a truncation; it must NOT ride into the input as a
    // seed (saving that back would write the stub over the real prose).
    expect(input.getAttribute("value") ?? "").toBe("");
    expect(input.value ?? "").toBe("");
    const ph = input.getAttribute("placeholder") ?? "";
    expect(ph).toContain("full replacement");
    expect(ph).not.toContain("truncated"); // the placeholder explains, not leaks
    // An empty blur/Enter NEVER fires (an empty replace would wipe the value).
    dispatch(input, { type: "blur" });
    dispatch(input, { type: "keydown", key: "Enter" });
    expect(saves).toHaveLength(0);
    // A typed replacement saves on Enter...
    input.value = "A brand new prompt.";
    dispatch(input, { type: "keydown", key: "Enter" });
    expect(saves).toEqual([
      { key: "systemPromptTemplate", raw: "A brand new prompt.", edit: { type: "string", seedless: true } },
    ]);
    // ...and on blur.
    input.value = "Yet another prompt.";
    dispatch(input, { type: "blur" });
    expect(saves.pop()!.raw).toBe("Yet another prompt.");
  });

  it("writeOnly secret: a never-prefilled password REPLACE box + Set; empty Set refused LOCALLY", () => {
    const saves: Array<{ key: string; raw: string; edit: ConfigKeyEditWire }> = [];
    const root = renderPanel(CANNED, { onSaveEdit: (key, raw, edit) => saves.push({ key, raw, edit }) });
    const row = rowForKey(root, "webSearch.braveApiKey");
    const box = row.querySelector(".settings-edit-secret") as unknown as HTMLElement & { value: string };
    expect(box).toBeTruthy();
    expect(box.getAttribute("type")).toBe("password");
    // NEVER prefilled: no value attribute carries anything, and the display
    // cell keeps saying "set (redacted)".
    expect(box.getAttribute("value") ?? "").toBe("");
    expect(valueText(row)).toBe("set (redacted)");
    // An empty Set asks for the honest local refusal -- the app's parse
    // rejects it with "no new value entered" and NOTHING reaches the wire.
    buttonLabeled(row, "Set")!.click();
    expect(saves).toEqual([{ key: "webSearch.braveApiKey", raw: "", edit: { type: "string", writeOnly: true } }]);
    expect(parseEditValue({ type: "string", writeOnly: true }, "")).toEqual({ ok: false, error: "no new value entered" });
    // A typed Set rides valueText (via the parse) and the box CLEARS itself
    // the moment Set fires -- the typed bytes never linger on screen.
    box.value = "FRESH-SECRET";
    buttonLabeled(row, "Set")!.click();
    expect(saves.pop()).toEqual({
      key: "webSearch.braveApiKey",
      raw: "FRESH-SECRET",
      edit: { type: "string", writeOnly: true },
    });
    expect(box.value).toBe("");
    expect(parseEditValue({ type: "string", writeOnly: true }, "FRESH-SECRET")).toEqual({
      ok: true,
      payload: { valueText: "FRESH-SECRET" },
    });
    // Enter on the box = Set.
    box.value = "ENTERED-KEY";
    dispatch(box, { type: "keydown", key: "Enter" });
    expect(saves.pop()!.raw).toBe("ENTERED-KEY");
    // The optimistic queue NEVER displays the secret bytes.
    expect(pendingDisplay({ type: "string", writeOnly: true }, { valueText: "FRESH-SECRET" })).toBe("");
  });

  it("json row: Edit JSON reveals a monospace textarea seeded from the SHIPPED value; Enter does NOT save, Save sends the raw text", () => {
    const opens: string[] = [];
    const saves: Array<{ key: string; raw: string; edit: ConfigKeyEditWire }> = [];
    let cancels = 0;
    const root = renderPanel(CANNED, {
      editing: "workspace.paths",
      onEdit: (k) => opens.push(k),
      onSaveEdit: (key, raw, edit) => saves.push({ key, raw, edit }),
      onCancelEdit: () => cancels++,
    });
    const row = rowForKey(root, "workspace.paths");
    const area = row.querySelector("textarea.settings-edit-input") as unknown as HTMLElement & { value: string };
    expect(area).toBeTruthy();
    // Seeded from the row's shipped value, pretty-printed (what you edit is
    // what the server attests is on disk).
    expect(area.textContent).toBe('[\n  "/home/u/proj"\n]');
    // Enter in a textarea never saves (multi-line work); Escape collapses.
    dispatch(area, { type: "keydown", key: "Enter" });
    expect(saves).toHaveLength(0);
    dispatch(area, { type: "keydown", key: "Escape" });
    expect(cancels).toBe(1);
    // Save sends the raw textarea text with the json stamp.
    area.value = '["/srv/new"]';
    buttonLabeled(row, "Save")!.click();
    expect(saves).toEqual([{ key: "workspace.paths", raw: '["/srv/new"]', edit: { type: "json" } }]);
    // Collapsed, the row offers the opener again (and shows its value cell).
    const closed = renderPanel(CANNED, { onEdit: (k) => opens.push(k) });
    expect(buttonLabeled(rowForKey(closed, "workspace.paths"), "Edit JSON")).toBeTruthy();
    buttonLabeled(rowForKey(closed, "workspace.paths"), "Edit JSON")!.click();
    expect(opens).toEqual(["workspace.paths"]);
    expect(valueText(rowForKey(closed, "workspace.paths"))).toContain("/home/u/proj");
  });

  it("the json textarea keeps working while a save is in flight (a second Save updates the queue, not a parallel save)", () => {
    const saves: string[] = [];
    const root = renderPanel(CANNED, {
      editing: "workspace.paths",
      pendingSave: { key: "workspace.paths", reqId: 1, shown: "" },
      onSaveEdit: (key) => saves.push(key),
    });
    const row = rowForKey(root, "workspace.paths");
    expect(buttonLabeled(row, "Saving...")).toBeTruthy();
    buttonLabeled(row, "Saving...")!.click();
    expect(saves).toEqual(["workspace.paths"]); // the app queues it (pinned in the state section)
  });

  it("Escape on a scalar control does NOT stop the dialog handler (nothing to collapse)", () => {
    let closes = 0;
    let cancels = 0;
    const root = renderPanel(CANNED, { onClose: () => closes++, onCancelEdit: () => cancels++ });
    const input = rowForKey(root, "webui.port").querySelector(".settings-edit-input") as unknown as HTMLElement;
    dispatch(input, { type: "keydown", key: "Escape" });
    expect(cancels).toBe(0);
    expect(closes).toBe(1); // the dialog-level Escape fired (progressive retreat is for the JSON editor)
  });
});

// ── Rejection + restart honesty ──────────────────────────────────────────────

describe("settings editor rejection and restart", () => {
  it("server error text renders VERBATIM under the failing row", () => {
    const message = '"webui.port" must be >= 1 (got 0)';
    const root = renderPanel(CANNED, { editError: { key: "webui.port", message } });
    const err = rowForKey(root, "webui.port").querySelector(".settings-edit-error") as unknown as HTMLElement;
    expect(err).toBeTruthy();
    expect(err.textContent).toBe(message);
    expect(err.getAttribute("role")).toBe("alert");
    // Not on any other row.
    expect(rowForKey(root, "prompts.displayPrompt").querySelector(".settings-edit-error")).toBeNull();
  });

  it("an error reply LEAVES the control at the last server-known value (revert is the absence of pending state)", () => {
    // With the save pending the toggle showed the flip; once the reply fails
    // the pending state is gone, so the control re-seeds from the row (the
    // server-known value). This is the rendering half of the revert pin; the
    // state half lives in the doctrine section below.
    const pendingRoot = renderPanel(CANNED, { pendingSave: { key: "prompts.displayPrompt", reqId: 1, shown: "false" } });
    expect(rowForKey(pendingRoot, "prompts.displayPrompt").querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("false");
    const reverted = renderPanel(CANNED, { editError: { key: "prompts.displayPrompt", message: "no." } });
    expect(rowForKey(reverted, "prompts.displayPrompt").querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
  });

  it("the restart banner renders on needsRestart and persists across further edits", () => {
    const root = renderPanel(CANNED, { needsRestart: true });
    const banner = root.querySelector(".settings-restart") as unknown as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain("Restart required");
    expect(banner.getAttribute("role")).toBe("status");
    // Persists while a container is expanded (and while one is saved-pending).
    const editingAnother = renderPanel(CANNED, { needsRestart: true, editing: "workspace.paths", editedKeys: ["webui.port"] });
    expect(editingAnother.querySelector(".settings-restart")).toBeTruthy();
  });

  it("an edited row shows the persisted file echo with a restart-pending badge", () => {
    const patched: ConfigSnapshotResultWire = {
      ...CANNED,
      sections: CANNED.sections.map((s) => ({
        ...s,
        rows: s.rows.map((r) => (r.key === "webui.port" ? { ...r, file: 4399 } : r)),
      })),
    };
    const root = renderPanel(patched, { needsRestart: true, editedKeys: ["webui.port"] });
    const row = rowForKey(root, "webui.port");
    // The control re-seeds from the persisted file slot...
    expect((row.querySelector(".settings-edit-input") as unknown as HTMLElement).getAttribute("value")).toBe("4399");
    const badges = Array.from(row.querySelectorAll(".settings-badge")).map((b) => (b as unknown as HTMLElement).textContent);
    expect(badges).toContain("restart pending");
  });

  it("needsRestart:false persists WITHOUT claiming restart (no banner, no badge)", () => {
    const patched: ConfigSnapshotResultWire = {
      ...CANNED,
      sections: CANNED.sections.map((s) => ({
        ...s,
        rows: s.rows.map((r) => (r.key === "webui.port" ? { ...r, file: 4399 } : r)),
      })),
    };
    // The state half: applySetConfigReply gates on the reply's needsRestart.
    let s = openSettingsPanel(initialSettingsPanelState);
    s = applySnapshotReply(s, s.reqId, patched);
    const r = requestSettingsSave(s, "webui.port", { value: 4399 }, "4399");
    s = applySetConfigReply(r.state, r.send!.reqId, { type: "setConfigKeyResult", requestId: r.send!.reqId, ok: true, value: 4399 });
    expect(s.needsRestart).toBe(false);
    expect(s.editedKeys).toEqual([]);
    expect(s.snapshot!.sections.flatMap((x) => x.rows).find((row) => row.key === "webui.port")!.file).toBe(4399);
    // The render half: no banner, no badge on the row.
    const root = renderPanel(s.snapshot, { needsRestart: s.needsRestart, editedKeys: s.editedKeys });
    expect(root.querySelector(".settings-restart")).toBeNull();
    const badges = Array.from(rowForKey(root, "webui.port").querySelectorAll(".settings-badge")).map((b) => (b as unknown as HTMLElement).textContent);
    expect(badges).not.toContain("restart pending");
  });

  it("a busy row says so (pending marker on the row while its save is in flight)", () => {
    const root = renderPanel(CANNED, { pendingSave: { key: "webui.port", reqId: 1, shown: "4399" } });
    const row = rowForKey(root, "webui.port");
    expect(row.className).toContain("settings-row-pending");
    const badges = Array.from(row.querySelectorAll(".settings-badge")).map((b) => (b as unknown as HTMLElement).textContent);
    expect(badges).toContain("saving");
    // Other rows stay quiet.
    const others = rows(root).filter((r) => r !== row);
    for (const o of others) {
      const b = Array.from(o.querySelectorAll(".settings-badge")).map((x) => (x as unknown as HTMLElement).textContent);
      expect(b).not.toContain("saving");
    }
    expect(others.length).toBeGreaterThan(0);
  });
});

// ── Pure write-state doctrine (send-or-queue + needsRestart-driven marker) ──

describe("settings editor state doctrine", () => {
  const opened = (): SettingsPanelState => openSettingsPanel(initialSettingsPanelState);

  it("parseEditValue: scalars ride value; json and writeOnly ride valueText (bounds are the server's)", () => {
    expect(parseEditValue(EDIT_PORT, "4321")).toEqual({ ok: true, payload: { value: 4321 } });
    expect(parseEditValue(EDIT_PORT, "")).toMatchObject({ ok: false });
    expect(parseEditValue(EDIT_PORT, "abc")).toMatchObject({ ok: false });
    expect(parseEditValue({ type: "integer" }, "2.5")).toMatchObject({ ok: false });
    expect(parseEditValue(EDIT_BOOL, "true")).toEqual({ ok: true, payload: { value: true } });
    expect(parseEditValue(EDIT_BOOL, "false")).toEqual({ ok: true, payload: { value: false } });
    expect(parseEditValue(EDIT_BOOL, "banana")).toMatchObject({ ok: false });
    expect(parseEditValue({ type: "string" }, "  keeps spaces  ")).toEqual({ ok: true, payload: { value: "  keeps spaces  " } });
    // json: the raw text is sent verbatim once it PARSES (the server checks
    // the shape class; the client only keeps obvious garbage off the wire).
    expect(parseEditValue({ type: "json" }, '[1, 2]')).toEqual({ ok: true, payload: { valueText: "[1, 2]" } });
    expect(parseEditValue({ type: "json" }, "   ")).toMatchObject({ ok: false });
    const bad = parseEditValue({ type: "json" }, "{oops");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("invalid JSON");
    // writeOnly: an empty REPLACE is the classic no-typing mistake.
    expect(parseEditValue({ type: "string", writeOnly: true }, "new-key")).toEqual({ ok: true, payload: { valueText: "new-key" } });
    const empty = parseEditValue({ type: "string", writeOnly: true }, "");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toBe("no new value entered");
  });

  it("a free slot SENDS with a fresh id; a busy slot QUEUES (same path REPLACES the queued value -- no parallel second save)", () => {
    let s = opened();
    const snapshotReq = s.reqId;
    const first = requestSettingsSave(s, "webui.port", { value: 4399 }, "4399");
    expect(first.send).toEqual({ reqId: 1, key: "webui.port", payload: { value: 4399 } });
    expect(first.state.pendingSave).toEqual({ key: "webui.port", reqId: 1, shown: "4399" });
    s = first.state;
    // A snapshot refresh in flight does NOT invalidate the save...
    const refreshed = refreshSettingsPanel(s);
    expect(refreshed.pendingSave).toEqual(s.pendingSave);
    // ...and a second change on the SAME path updates the queue instead of
    // firing a parallel second save (the pin).
    const second = requestSettingsSave(s, "webui.port", { value: 4400 }, "4400");
    expect(second.send).toBeNull();
    expect(second.state.pendingSave).toEqual(s.pendingSave); // unchanged in-flight
    expect(second.state.saveReqId).toBe(1); // NO new id burned
    const third = requestSettingsSave(second.state, "webui.port", { value: 4401 }, "4401");
    expect(third.send).toBeNull();
    expect(third.state.queuedSaves).toEqual([{ key: "webui.port", payload: { value: 4401 }, shown: "4401" }]); // last-write-wins
    void snapshotReq;
  });

  it("the queue drains oldest-first after the in-flight save settles; a failed save still drains the newest intent", () => {
    let s = opened();
    const a = requestSettingsSave(s, "webui.port", { value: 1 }, "1");
    s = a.state;
    const b = requestSettingsSave(s, "prompts.displayPrompt", { value: false }, "false");
    s = b.state;
    expect(s.queuedSaves).toEqual([{ key: "prompts.displayPrompt", payload: { value: false }, shown: "false" }]);
    // The port save ok: its slot frees, the queued displayPrompt goes next.
    s = applySetConfigReply(s, a.send!.reqId, { type: "setConfigKeyResult", requestId: a.send!.reqId, ok: true, value: 1, needsRestart: true });
    const drained = flushSettingsSave(s);
    expect(drained.send).toEqual({ reqId: 2, key: "prompts.displayPrompt", payload: { value: false } });
    expect(drained.state.pendingSave).toEqual({ key: "prompts.displayPrompt", reqId: 2, shown: "false" });
    expect(drained.state.queuedSaves).toEqual([]);
    // A failed save ALSO drains (the queued value is the user's newest intent).
    let s2 = opened();
    const c = requestSettingsSave(s2, "loopDetect.repeatThreshold", { value: 4 }, "4");
    s2 = requestSettingsSave(c.state, "loopDetect.repeatThreshold", { value: 5 }, "5").state;
    s2 = applySetConfigReply(s2, c.send!.reqId, { type: "setConfigKeyResult", requestId: c.send!.reqId, ok: false, error: "nope" });
    expect(s2.editError).toEqual({ key: "loopDetect.repeatThreshold", message: "nope" });
    const drained2 = flushSettingsSave(s2);
    expect(drained2.send).toEqual({ reqId: 2, key: "loopDetect.repeatThreshold", payload: { value: 5 } });
    // The fresh attempt clears the stale error on the SAME path.
    expect(drained2.state.editError).toBeNull();
  });

  it("nothing drains while a save is still in flight (one write on the wire at a time)", () => {
    let s = opened();
    const a = requestSettingsSave(s, "webui.port", { value: 1 }, "1");
    s = a.state;
    s = requestSettingsSave(s, "webui.host", { value: "h" }, "h").state;
    expect(flushSettingsSave(s)).toEqual({ state: s, send: null });
  });

  it("applySetConfigReply: stale ids drop; ok patches the row + the REPLY's needsRestart drives the marker; refusal keeps the error on the row", () => {
    let s = opened();
    s = applySnapshotReply(s, s.reqId, CANNED);
    const a = requestSettingsSave(s, "webui.port", { value: 4399 }, "4399");
    s = a.state;

    // Stale (older id): nothing moves.
    const stale = applySetConfigReply(s, a.send!.reqId - 1, { type: "setConfigKeyResult", ok: true, value: 1 });
    expect(stale).toBe(s);

    // ok WITH needsRestart:true (what the server ships today): file slot from
    // the ECHO, banner up, row remembered.
    s = applySetConfigReply(s, a.send!.reqId, { type: "setConfigKeyResult", requestId: a.send!.reqId, ok: true, value: 4399, needsRestart: true });
    expect(s.needsRestart).toBe(true);
    expect(s.editing).toBeNull();
    expect(s.editedKeys).toContain("webui.port");
    const row = s.snapshot!.sections.flatMap((x) => x.rows).find((r) => r.key === "webui.port")!;
    expect(row.file).toBe(4399);
    // resolved stays honest (the running server still holds the old value).
    expect(row.resolved).toBe(4321);

    // The banner survives starting another edit + a refresh.
    s = startSettingsEdit(s, "workspace.paths");
    s = refreshSettingsPanel(s);
    expect(s.needsRestart).toBe(true);

    // A json save: the FILE slot updates from the PARSED echoed text; the
    // optimistic display never carries the container text.
    expect(pendingDisplay({ type: "json" }, { valueText: "[1]" })).toBe("");
    const j = requestSettingsSave(s, "workspace.paths", { valueText: '["/srv/new"]' }, "");
    s = applySetConfigReply(j.state, j.send!.reqId, {
      type: "setConfigKeyResult",
      requestId: j.send!.reqId,
      ok: true,
      valueText: '["/srv/new"]',
      needsRestart: true,
    });
    const jsonRow = s.snapshot!.sections.flatMap((x) => x.rows).find((r) => r.key === "workspace.paths")!;
    expect(jsonRow.file).toEqual(["/srv/new"]);
    expect(s.needsRestart).toBe(true);

    // A writeOnly secret save: value:null + redacted:true flips the row to
    // the honest "set (redacted)" state WITHOUT any value riding anything.
    const sec = requestSettingsSave(s, "webSearch.braveApiKey", { valueText: "new-key" }, "");
    s = applySetConfigReply(sec.state, sec.send!.reqId, {
      type: "setConfigKeyResult",
      requestId: sec.send!.reqId,
      ok: true,
      value: null,
      redacted: true,
      needsRestart: true,
    });
    const secretRow = s.snapshot!.sections.flatMap((x) => x.rows).find((r) => r.key === "webSearch.braveApiKey")!;
    expect(secretRow.redacted).toBe(true);
    expect(JSON.stringify(secretRow)).not.toContain("new-key"); // nothing echoes the secret
    expect(s.editedKeys).toContain("webSearch.braveApiKey"); // the pending marker works after a secret save
    // ...and the panel state never displays the secret text.
    expect(sec.state.pendingSave!.shown).toBe("");

    // refusal: verbatim error, banner untouched, slot freed.
    const bad = requestSettingsSave(s, "prompts.displayPrompt", { value: false }, "false");
    s = applySetConfigReply(bad.state, bad.send!.reqId, { type: "setConfigKeyResult", requestId: bad.send!.reqId, ok: false, error: "no." });
    expect(s.editError).toEqual({ key: "prompts.displayPrompt", message: "no." });
    expect(s.needsRestart).toBe(true); // from the earlier real saves, not this refusal
    expect(s.pendingSave).toBeNull();
  });

  it("a parse rejection never starts a save; cancel collapses the JSON editor and clears the error", () => {
    let s = opened();
    s = rejectSettingsSave(s, "webui.port", "not a number");
    expect(s.editError).toEqual({ key: "webui.port", message: "not a number" });
    expect(s.pendingSave).toBeNull();
    s = startSettingsEdit(s, "workspace.paths");
    s = rejectSettingsSave(s, "workspace.paths", "invalid JSON -- boom");
    expect(s.editing).toBe("workspace.paths"); // the textarea stays open with the hint
    s = cancelSettingsEdit(s);
    expect(s.editing).toBeNull();
    expect(s.editError).toBeNull();
  });
});

// ── The "(empty string)" leak is eliminated at the ROOT (owner 2026-11-11) ──
// No control SEED may ever come from the display formatter. A string whose real
// value is "" must seed the field with "", not the honest value-cell placeholder
// "(empty string)" -- which a plain blur would then write back to disk.

function snapWith(rows: unknown[]): ConfigSnapshotResultWire {
  return {
    type: "configSnapshotResult",
    ts: 1700000000000,
    configDir: "/home/u/.config/hotdog",
    files: [{ path: "/home/u/.config/hotdog/defaults.json", inUse: true, status: "ok" }],
    findings: [],
    sections: [{ name: "core", rows: rows as never }],
  } as ConfigSnapshotResultWire;
}

describe("seed formatter round-trips (the display placeholders never reach a control)", () => {
  it("a string row whose shipped value is \"\" seeds \"\" -- never \"(empty string)\" -- and an unchanged blur sends ZERO frames", () => {
    const saves: Array<{ key: string; raw: string }> = [];
    const emptyRow = { key: "core.empty", description: "An empty string setting", default: "", file: "", resolved: "", edit: { type: "string" } };
    const root = renderPanel(snapWith([emptyRow]), { onSaveEdit: (key, raw) => saves.push({ key, raw }) });
    const input = rowForKey(root, "core.empty").querySelector("input") as unknown as HTMLElement & { value: string };
    expect(input.getAttribute("value")).toBe("");
    expect(input.getAttribute("value")).not.toContain("(empty string)");
    // Blur WITHOUT typing: nothing changed, nothing goes out.
    dispatch(input, { type: "blur" });
    expect(saves).toHaveLength(0);
    // A real edit still saves.
    input.value = "hello";
    dispatch(input, { type: "blur" });
    expect(saves).toEqual([{ key: "core.empty", raw: "hello" }]);
  });

  it("parseEditValue(edit, editSeedText(row)) equals the shipped value for every stamped scalar kind", () => {
    const cases: Array<{ edit: ConfigKeyEditWire; value: unknown }> = [
      { edit: { type: "string" }, value: "hello world" },
      { edit: { type: "string" }, value: "" }, // the bug: empty string round-trips to ""
      { edit: { type: "number" }, value: 42 },
      { edit: { type: "integer" }, value: 0 },
      { edit: { type: "boolean" }, value: true },
      { edit: { type: "boolean" }, value: false },
    ];
    for (const { edit, value } of cases) {
      const row = { key: "core.x", edit, file: value, resolved: value } as never;
      const seed = editSeedText(row);
      const parsed = parseEditValue(edit, seed);
      expect(parsed.ok, `kind ${edit.type} value ${JSON.stringify(value)}`).toBe(true);
      if (parsed.ok) expect((parsed.payload as { value: unknown }).value).toBe(value);
    }
    // JSON containers seed from jsonSeedText (JSON.stringify), also faithful.
    const jrow = { key: "core.j", edit: { type: "json" }, file: ["/home/a", "/home/b"] } as never;
    const jparsed = parseEditValue({ type: "json" }, jsonSeedText(jrow));
    expect(jparsed.ok).toBe(true);
    if (jparsed.ok) expect(JSON.parse((jparsed.payload as { valueText: string }).valueText)).toEqual(["/home/a", "/home/b"]);
  });

  it("no control seed carries a display placeholder token (empty strings, long strings, secrets, containers)", () => {
    const LONG = "once upon a time, ".repeat(8); // > 80 chars, single line
    const rows: unknown[] = [
      { key: "core.emptyStr", default: "", file: "", resolved: "", edit: { type: "string" } },
      { key: "core.longStr", default: LONG, file: LONG, resolved: LONG, edit: { type: "string" } },
      { key: "core.nlStr", default: "a\nb", file: "a\nb", resolved: "a\nb", edit: { type: "string" } },
      { key: "core.seedless", default: null, file: "x".repeat(200), resolved: "x".repeat(200), edit: { type: "string", seedless: true } },
      { key: "core.bool", default: false, file: false, resolved: false, edit: { type: "boolean" } },
      { key: "core.enum", default: "off", file: "off", resolved: "off", edit: { type: "string", enum: ["off", "probe"] } },
      { key: "core.secret", default: null, file: null, redacted: true, edit: { type: "string", writeOnly: true } },
      { key: "core.container", default: {}, file: { a: 1 }, resolved: { a: 1 }, edit: { type: "json" } },
    ];
    const tokens = ["(empty string)", "(unset)", "(redacted)", "-char text omitted"];
    // The formatter itself never emits a placeholder for any stamped scalar row.
    for (const row of rows) {
      const edit = (row as { edit: ConfigKeyEditWire }).edit;
      if (edit.type === "json") continue; // json seeds via jsonSeedText, checked below
      for (const tok of tokens) expect(editSeedText(row as never), `seed for ${JSON.stringify((row as { key: string }).key)} must not hold ${tok}`).not.toContain(tok);
    }
    expect(jsonSeedText({ key: "c", edit: { type: "json" }, file: { a: "" } } as never)).not.toContain("(empty string)");
    // And rendered: the DOM controls never show a placeholder either.
    const root = renderPanel(snapWith(rows), { editing: "core.container" });
    for (const ctrl of Array.from(root.querySelectorAll(".settings-edit-input")) as unknown as HTMLElement[]) {
      const shown = `${ctrl.getAttribute("value") ?? ""}|${ctrl.textContent ?? ""}`;
      for (const tok of tokens) expect(shown, `a rendered control leaked ${tok}`).not.toContain(tok);
    }
  });
});

// ── Long / multi-line strings become textareas (owner 2026-11-11) ────────────

describe("long-string textareas", () => {
  const LONG = "the quick brown fox jumps over the lazy dog and then keeps running well past eighty characters"; // > 80, single line

  const rowFor = (key: string) => ({ key, description: "d", edit: { type: "string" } });

  it("a long single-line string renders a textarea (not an input); a short one renders an input", () => {
    const root = renderPanel(
      snapWith([
        { ...rowFor("core.long"), default: LONG, file: LONG, resolved: LONG },
        { ...rowFor("core.short"), default: "small", file: "small", resolved: "small" },
      ]),
    );
    expect(rowForKey(root, "core.long").querySelector("textarea")).toBeTruthy();
    expect(rowForKey(root, "core.long").querySelector("input")).toBeNull();
    expect(rowForKey(root, "core.short").querySelector("input")).toBeTruthy();
    expect(rowForKey(root, "core.short").querySelector("textarea")).toBeNull();
  });

  it("a short string that merely contains a newline renders a textarea", () => {
    const root = renderPanel(snapWith([{ ...rowFor("core.two"), default: "a\nb", file: "a\nb", resolved: "a\nb" }]));
    expect(rowForKey(root, "core.two").querySelector("textarea")).toBeTruthy();
  });

  it("blur saves the multi-line string byte-exact on the value channel, trailing newline included (no trim)", () => {
    const saves: Array<{ key: string; raw: string; edit: ConfigKeyEditWire }> = [];
    const root = renderPanel(snapWith([{ ...rowFor("core.long"), default: LONG, file: LONG, resolved: LONG }]), {
      onSaveEdit: (key, raw, edit) => saves.push({ key, raw, edit }),
    });
    const ta = rowForKey(root, "core.long").querySelector("textarea") as unknown as HTMLElement & { value: string };
    ta.value = "first line\nsecond line\n"; // a trailing newline that a trim would destroy
    dispatch(ta, { type: "blur" });
    expect(saves).toHaveLength(1);
    expect(saves[0]!.raw).toBe("first line\nsecond line\n");
    // Same wire channel as any short string: a string rides `value`.
    const parsed = parseEditValue({ type: "string" }, saves[0]!.raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.payload).toEqual({ value: "first line\nsecond line\n" });
  });

  it("an unchanged blur is zero-wire (compared byte-exact against the raw seed)", () => {
    const saves: string[] = [];
    const root = renderPanel(snapWith([{ ...rowFor("core.long"), default: LONG, file: LONG, resolved: LONG }]), {
      onSaveEdit: (key) => saves.push(key),
    });
    const ta = rowForKey(root, "core.long").querySelector("textarea") as unknown as HTMLElement & { value: string };
    ta.value = LONG; // exactly the seed
    dispatch(ta, { type: "blur" });
    expect(saves).toHaveLength(0);
  });

  it("Enter inside the textarea inserts a newline and sends NOTHING", () => {
    const saves: string[] = [];
    const root = renderPanel(snapWith([{ ...rowFor("core.long"), default: LONG, file: LONG, resolved: LONG }]), {
      onSaveEdit: (key) => saves.push(key),
    });
    const ta = rowForKey(root, "core.long").querySelector("textarea") as unknown as HTMLElement;
    dispatch(ta, { type: "keydown", key: "Enter" });
    expect(saves).toHaveLength(0);
  });

  it("Escape blurs the textarea WITHOUT closing the dialog (stopPropagation) and does not save by itself", () => {
    let closed = 0;
    const saves: string[] = [];
    const root = renderPanel(snapWith([{ ...rowFor("core.long"), default: LONG, file: LONG, resolved: LONG }]), {
      onSaveEdit: (key) => saves.push(key),
      onClose: () => { closed++; },
    });
    const ta = rowForKey(root, "core.long").querySelector("textarea") as unknown as HTMLElement;
    dispatch(ta, { type: "keydown", key: "Escape" });
    expect(closed, "Escape inside the textarea must not close the dialog").toBe(0);
    expect(saves, "Escape must not fire a save on its own").toHaveLength(0);
  });
});
