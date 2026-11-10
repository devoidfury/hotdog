/// <reference lib="dom" />
// Icon-mount pins on the dom-helper: the static TOOL_ICONS set (tool-block's
// prose posture) must mount to a real SVG-namespaced subtree. Before the
// runtime learned createElementNS, every inline <svg> here was an
// HTMLUnknownElement rendering nothing. Not an app.tsx importer (single-booter
// doctrine lives in app.test.tsx).

import { describe, it, expect, afterEach } from "bun:test";
import { TOOL_ICONS } from "@extensions/webui/ui/icons.tsx";
import { mount, type DomNode, type Mounted } from "@utils/jsx";
import { SVG_NS } from "./index.ts";

let current: Mounted | null = null;

afterEach(() => {
  current?.unmount();
  current = null;
});

describe("TOOL_ICONS mount", () => {
  it("hourglass mounts to an SVG-namespaced subtree", () => {
    const host = document.createElement("div");
    current = mount(TOOL_ICONS.hourglass!(), host as unknown as DomNode);
    const svg = host.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.namespaceURI).toBe(SVG_NS);
    const paths = host.querySelectorAll("path");
    expect(paths).toHaveLength(4);
    for (const p of paths) expect(p.namespaceURI).toBe(SVG_NS);
    // Stroke attrs ride through as plain attributes (currentColor idiom).
    expect(svg!.getAttribute("stroke")).toBe("currentColor");
  });
});
