/// <reference lib="dom.iterable" />
// Smoke tests for the minimal DOM in tests/dom-helper. These keep the test
// environment itself honest: message-list and chat tests lean on these
// behaviors (innerHTML round-trip, dataset proxy, bubbling events, selectors).
// Iteration over querySelector()/children results needs dom.iterable.

import { describe, it, expect } from "bun:test";
import { FakeWebSocket } from "./index.ts";

describe("dom-helper", () => {
  it("installs document and window globals", () => {
    expect(typeof document).toBe("object");
    expect(typeof window).toBe("object");
    expect(document.body.tagName).toBe("BODY");
  });

  it("creates, inserts, moves and removes nodes", () => {
    const el = document.createElement("div");
    const a = document.createElement("span");
    const b = document.createElement("b");
    el.appendChild(a);
    el.insertBefore(b, a);
    expect(el.innerHTML).toBe("<b></b><span></span>");
    b.remove();
    expect(el.children).toHaveLength(1);
    expect(a.parentNode).toBe(el);
  });

  it("parses innerHTML with attributes, entities, void tags and comments", () => {
    const el = document.createElement("div");
    el.innerHTML = `<p class="a b" data-x="1 &amp; 2">hi &lt;there&gt;<br><img src="/x.png"><!-- note --></p>`;
    const p = el.querySelector("p")!;
    expect(p.classList.contains("a")).toBe(true);
    expect(p.dataset.x).toBe("1 & 2");
    expect(p.textContent).toBe("hi <there>");
    expect([...p.children].map((c) => c.tagName)).toEqual(["BR", "IMG"]);
    expect(el.innerHTML).toContain("<!-- note -->");
  });

  it("textContent setter replaces children; getter concatenates", () => {
    const el = document.createElement("div");
    el.innerHTML = "<b>one</b><i>two</i>";
    expect(el.textContent).toBe("onetwo");
    el.textContent = "plain <tag>";
    expect(el.innerHTML).toBe("plain &lt;tag&gt;");
  });

  it("classList toggles and stays in sync with the class attribute", () => {
    const el = document.createElement("div");
    el.classList.add("x", "y");
    expect(el.getAttribute("class")).toBe("x y");
    el.classList.toggle("hidden");
    expect(el.classList.contains("hidden")).toBe(true);
    el.classList.remove("x", "hidden");
    expect(el.getAttribute("class")).toBe("y");
  });

  it("dataset proxies data-* attributes both directions", () => {
    const el = document.createElement("div");
    el.dataset.blockIndex = "3";
    expect(el.getAttribute("data-block-index")).toBe("3");
    expect(el.dataset.blockIndex).toBe("3");
    delete el.dataset.blockIndex;
    expect(el.hasAttribute("data-block-index")).toBe(false);
  });

  it("dispatches events with bubbling and removal", () => {
    const parent = document.createElement("div");
    const child = document.createElement("button");
    parent.appendChild(child);
    const seen: string[] = [];
    const onChild = () => seen.push("child");
    const onParent = () => seen.push("parent");
    child.addEventListener("click", onChild);
    parent.addEventListener("click", onParent);
    child.click();
    expect(seen).toEqual(["child", "parent"]);
    child.removeEventListener("click", onChild);
    child.click();
    expect(seen).toEqual(["child", "parent", "parent"]);
  });

  it("supports stopPropagation and preventDefault", () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);
    let parentFired = false;
    parent.addEventListener("click", () => (parentFired = true));
    child.addEventListener("click", (ev: unknown) => {
      (ev as { stopPropagation(): void }).stopPropagation();
      (ev as { preventDefault(): void }).preventDefault();
    });
    const handled = child.dispatchEvent(new Event("click"));
    expect(parentFired).toBe(false);
    expect(handled).toBe(false);
  });

  it("matches compound and :not selectors", () => {
    const el = document.createElement("div");
    el.innerHTML = `
      <div class="tool-call-block"><span>one</span></div>
      <div class="tool-call-block answered"><span>two</span></div>
      <div class="card question-card" data-task-id="t/1"></div>`;
    expect(el.querySelectorAll(".question-card")).toHaveLength(1);
    expect(el.querySelectorAll(".question-card:not(.answered)")).toHaveLength(1);
    expect(el.querySelectorAll('[data-task-id="t/1"]')).toHaveLength(1);
    expect(el.querySelector("span")!.textContent).toBe("one");
  });

  it("createDocumentFragment children move out on appendChild", () => {
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createElement("i"));
    frag.appendChild(document.createElement("b"));
    const host = document.createElement("div");
    while (frag.firstChild) host.appendChild(frag.firstChild);
    expect(host.innerHTML).toBe("<i></i><b></b>");
    expect(frag.childNodes).toHaveLength(0);
  });

  it("FakeWebSocket records sends and fires handlers", () => {
    const ws = new FakeWebSocket("ws://example/ws");
    let opened = false;
    ws.onopen = () => (opened = true);
    ws.fireOpen();
    expect(opened).toBe(true);
    ws.send(JSON.stringify({ a: 1 }));
    expect(ws.sent).toEqual(['{"a":1}']);
    ws.close();
    expect(ws.readyState).toBe(3);
  });
});
