// Client mount tests. Bun has no DOM, so these run against a tiny fake DOM
// implementing exactly the structural surface client.ts depends on
// (insertBefore/remove ordering, attrs, listeners). This is a test double,
// not a mock.module -- real browser nodes satisfy the same shape.

import { describe, it, expect, spyOn } from "bun:test";
import { mount, createNode, type DomElement, type JsxChild } from "@utils/jsx/index.ts";
import { VOID_ELEMENTS } from "@utils/jsx/core.ts";

// A real browser throws IndexSizeError when children are inserted into void
// elements, so the fake must too. Importing the runtime's own set keeps the
// double from drifting from what mount() treats as void.

class FDocument {
  createElement(tag: string) { return new FElement(tag, this, VOID_ELEMENTS.has(tag)); }
  createTextNode(data: string) { return new FText(data, this); }
  createComment(data: string) { return new FComment(data, this); }
}

class FNode {
  parent: FNode | null = null;
  children: FNode[] = [];
  constructor(public ownerDocument: FDocument) {}
  get parentNode() { return this.parent; }
  get firstChild(): FNode | null { return this.children[0] ?? null; }
  get nextSibling(): FNode | null {
    const i = this.parent ? this.parent.children.indexOf(this) : -1;
    return i >= 0 && this.parent ? this.parent.children[i + 1] ?? null : null;
  }
  insertBefore(node: FNode, ref: FNode | null): void {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    const idx = ref == null ? this.children.length : this.children.indexOf(ref);
    node.parent = this;
    this.children.splice(idx < 0 ? this.children.length : idx, 0, node);
  }
  remove(): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

class FText extends FNode {
  constructor(public data: string, doc: FDocument) { super(doc); }
}

class FComment extends FNode {
  constructor(_data: string, doc: FDocument) { super(doc); }
}

class FElement extends FNode {
  attrs = new Map<string, string>();
  listeners = new Map<string, Set<(ev?: unknown) => void>>();
  constructor(public tag: string, doc: FDocument, public voidEl = false) { super(doc); }
  override insertBefore(node: FNode, ref: FNode | null): void {
    if (this.voidEl) throw new Error(`void element <${this.tag}> can't have children`);
    super.insertBefore(node, ref);
  }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  addEventListener(type: string, listener: (ev?: unknown) => void) {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(listener);
  }
  removeEventListener(type: string, listener: (ev?: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, ev?: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

function serialize(n: FNode): string {
  const e = n as FElement;
  if (n instanceof FText) return n.data;
  if (n instanceof FComment) return "<!---->";
  const attrs = [...e.attrs].map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${v}"`)).join("");
  return `<${e.tag}${attrs}>${n.children.map(serialize).join("")}</${e.tag}>`;
}

function setup() {
  const doc = new FDocument();
  const container = doc.createElement("div");
  return { doc, container, html: () => container.children.map(serialize).join("") };
}

describe("mount", () => {
  it("renders a JSX tree into the container", () => {
    const { container, html } = setup();
    mount(<div className="app" data-x={1}><h1>Hello</h1> world</div>, container);
    expect(html()).toBe('<div class="app" data-x="1"><h1>Hello</h1> world</div>');
  });

  it("maps booleans, styles, and renames like renderToString", () => {
    const { container, html } = setup();
    mount(<input disabled type="text" style={{ backgroundColor: "red", opacity: 0.5 }} />, container);
    expect(html()).toBe('<input disabled type="text" style="background-color:red;opacity:0.5"></input>');
  });

  it("renders components and fragments", () => {
    const { container, html } = setup();
    const Item = (p: { id: number }) => <li>{p.id}</li>;
    mount(<>{[1, 2].map((i) => <Item key={i} id={i} />)}<b />;</>, container);
    expect(html()).toBe("<li>1</li><li>2</li><b></b>;");
  });

  it("treats falsy children as comment placeholders", () => {
    const { container, html } = setup();
    mount(<p>{false}x{null}</p>, container);
    expect(html()).toBe("<p><!---->x<!----></p>");
  });

  it("wires on* props as event listeners and replaces them on re-render", () => {
    const { container } = setup();
    const calls: string[] = [];
    const m = mount(<button onClick={() => calls.push("first")} />, container);
    const btn = container.children[0] as FElement;
    btn.dispatch("click");
    expect(calls).toEqual(["first"]);
    m.render(<button onClick={() => calls.push("second")} />);
    btn.dispatch("click");
    expect(calls).toEqual(["first", "second"]);
    m.render(<button />);
    btn.dispatch("click");
    expect(calls).toHaveLength(2);
  });

  it("maps onDoubleClick to the real dblclick DOM event", () => {
    const { container } = setup();
    const calls: string[] = [];
    const m = mount(<button onDoubleClick={() => calls.push("dbl")} />, container);
    const btn = container.children[0] as FElement;
    btn.dispatch("dblclick");
    expect(calls).toEqual(["dbl"]);
    // Re-render replaces the listener under the same DOM event name.
    m.render(<button onDoubleClick={() => calls.push("again")} />);
    btn.dispatch("dblclick");
    expect(calls).toEqual(["dbl", "again"]);
  });

  it("reuses DOM nodes across renders and updates text in place", () => {
    const { container, html } = setup();
    const m = mount(<div><span>a</span><em>b</em></div>, container);
    const div = container.children[0] as FElement;
    const span = div.children[0] as FElement;
    m.render(<div><span>A</span><em>b</em></div>);
    expect(container.children[0]).toBe(div);
    expect(div.children[0]).toBe(span);
    expect((span.children[0] as FText).data).toBe("A");
    expect(html()).toBe("<div><span>A</span><em>b</em></div>");
  });

  it("moves keyed children instead of recreating them", () => {
    const { container } = setup();
    const row = (s: string) => <li key={s}>{s}</li>;
    const m = mount(<ul>{["a", "b", "c"].map(row)}</ul>, container);
    const ul = container.children[0] as FElement;
    const [a, b, c] = ul.children as unknown as [FNode, FNode, FNode];
    m.render(<ul>{["c", "a", "b"].map(row)}</ul>);
    expect(ul.children.map((n) => n.children[0] as FText).map((t) => t.data)).toEqual(["c", "a", "b"]);
    expect(ul.children).toEqual([c, a, b]);
  });

  it("does not double-reuse a sibling that matches both by position and by key", () => {
    // Without marking reused entries as consumed, the unkeyed <li>C</li> takes
    // entry 0 by position and the keyed <li key="k">D</li> takes the same
    // entry again, leaving the container one child short.
    const { container, html } = setup();
    const m = mount(<ul><li key="k">A</li><li>B</li></ul>, container);
    m.render(<ul><li>C</li><li key="k">D</li></ul>);
    expect(html()).toBe("<ul><li>C</li><li>D</li></ul>");
  });

  it("does not let a keyless unit hijack a keyed old entry's node", () => {
    // Positional fallback must skip keyed old entries: without it, the old
    // <li key="a"> node is patched to serve the keyless slot 0 and the keyed
    // unit below gets a fresh node, so node identity lands on the wrong item.
    const { container } = setup();
    const m = mount(<ul><li key="a">1</li><li>2</li></ul>, container);
    const ul = container.children[0] as FElement;
    const keyed = ul.children[0] as FElement;
    m.render(<ul><li>1</li><li key="a">2</li></ul>);
    expect(serialize(ul)).toBe("<ul><li>1</li><li>2</li></ul>");
    // The keyed node must stay bound to the keyed item: slot 1, showing "2".
    expect(ul.children.indexOf(keyed)).toBe(1);
    expect((keyed.children[0] as FText).data).toBe("2");
  });

  it("fires one click listener when case-variant on* props map to the same event", () => {
    // `onClick` and `onclick` both normalize to "click"; the events map is
    // keyed by DOM event type so the last prop wins instead of both firing.
    const calls: string[] = [];
    const { container } = setup();
    mount(
      createNode("button", { onClick: () => calls.push("a"), onclick: () => calls.push("b") }),
      container,
    );
    (container.children[0] as FElement).dispatch("click");
    expect(calls).toEqual(["b"]);
  });

  it("warns once per parent and per key on duplicated keys", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { container, html } = setup();
    const m = mount(<ul><li key="k">A</li><li key="k">B</li></ul>, container);
    expect(html()).toBe("<ul><li>A</li><li>B</li></ul>");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[jsx] duplicated key in children: "k"');
    // Same duplicate on re-render does not re-warn for the same parent.
    m.render(<ul><li key="k">A</li><li key="k">B</li></ul>);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(html()).toBe("<ul><li>A</li><li>B</li></ul>");
    // A different duplicated key warns again; repeats of it stay quiet.
    m.render(<ul><li key="a">x</li><li key="a">y</li><li key="a">z</li></ul>);
    expect(html()).toBe("<ul><li>x</li><li>y</li><li>z</li></ul>");
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("inserts a keyed node at the front without touching the rest", () => {
    const { container } = setup();
    const m = mount(<ul><li key="b">B</li></ul>, container);
    const ul = container.children[0] as FElement;
    const b = ul.children[0] as FElement;
    m.render(<ul><li key="a">A</li><li key="b">B</li></ul>);
    expect(ul.children[1]).toBe(b);
    expect(serialize(ul)).toBe("<ul><li>A</li><li>B</li></ul>");
  });

  it("replaces incompatible siblings and patches placeholders", () => {
    const { container, html } = setup();
    const m = mount(<p>{false}</p>, container);
    expect(html()).toBe("<p><!----></p>");
    m.render(<p><span>hi</span></p>);
    expect(html()).toBe("<p><span>hi</span></p>");
    m.render(<p>text</p>);
    expect(html()).toBe("<p>text</p>");
  });

  it("removes attributes whose value became null or false", () => {
    const { container, html } = setup();
    const m = mount(<a href="/x" title="t" disabled />, container);
    m.render(<a href="/y" title={null} disabled={false} />);
    expect(html()).toBe('<a href="/y"></a>');
    const a = container.children[0] as FElement;
    expect([...a.attrs]).toEqual([["href", "/y"]]);
  });

  it("drops unsafe urls on mount", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { container } = setup();
    mount(<a href="javascript:alert(1)">x</a>, container);
    const a = container.children[0] as FElement;
    expect(a.attrs.has("href")).toBe(false);
    warn.mockRestore();
  });

  it("drops unsafe urls under case-variant attribute names", () => {
    // Browsers normalize attribute names, so `HREF` must hit the same scheme guard.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { container } = setup();
    mount(createNode("a", { HrEf: "javascript:alert(1)", href: "/ok" }), container);
    const a = container.children[0] as FElement;
    expect(a.attrs.has("HrEf")).toBe(false);
    expect(a.attrs.get("href")).toBe("/ok");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("dropped unsafe url in HrEf");
    warn.mockRestore();
  });

  it("allows data:image on img only, on mount too", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { container, html } = setup();
    mount(
      <div>
        <img src="data:image/png;base64,AAAA" />
        <iframe src="data:image/png;base64,AAAA" />
      </div>,
      container,
    );
    // The fake serializer emits closing tags for every element, like real DOM child structure.
    expect(html()).toBe('<div><img src="data:image/png;base64,AAAA"></img><iframe></iframe></div>');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("serializes case-variant STYLE objects on mount", () => {
    const { container } = setup();
    mount(createNode("div", { STYLE: { backgroundColor: "red" } }), container);
    const div = container.children[0] as FElement;
    expect(div.attrs.get("STYLE")).toBe("background-color:red");
  });

  it("drops children on void elements and cleans them up on re-render", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { container, html } = setup();
    const m = mount(<div><input /><b>hi</b></div>, container);
    expect(html()).toBe('<div><input></input><b>hi</b></div>');
    expect(warn).not.toHaveBeenCalled();
    // The fake DOM throws on insertBefore into a void element, exactly like a
    // real browser -- this must drop the child and warn instead.
    m.render(<div><input>oops</input></div>);
    const div = container.children[0] as FElement;
    expect((div.children[0] as FElement).children).toHaveLength(0);
    expect(html()).toBe('<div><input></input></div>');
    // Warns once per node, not per render.
    m.render(<div><input>oops</input></div>);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("warns once per node for dangerouslySetInnerHTML across re-renders", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { container, html } = setup();
    const m = mount(<div dangerouslySetInnerHTML={{ __html: "x" }} />, container);
    m.render(<div dangerouslySetInnerHTML={{ __html: "x" }} />);
    m.render(<div dangerouslySetInnerHTML={{ __html: "x" }} />);
    expect(html()).toBe("<div></div>");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("drops invalid tag names and ignores dangerouslySetInnerHTML with warnings", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { container, html } = setup();
    const m = mount(createNode("bad tag", null), container);
    expect(html()).toBe("<!---->");
    m.render(<div dangerouslySetInnerHTML={{ __html: "<b>raw</b>" }} />);
    expect(html()).toBe("<div></div>");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("refuses to mount into a container that already has children", () => {
    const { doc, container } = setup();
    container.insertBefore(doc.createTextNode("stray"), null);
    expect(() => mount(<p>a</p>, container)).toThrow("[jsx] mount: container is not empty");
  });

  it("unmount removes everything it created", () => {
    const { container, html } = setup();
    const m = mount(<><p>a</p><p>b</p></>, container);
    m.unmount();
    expect(html()).toBe("");
    expect(container.children).toHaveLength(0);
  });

  it("throws on a cyclic component like renderToString's depth guard", () => {
    const { container } = setup();
    function Loop(_props: { depth?: number }): JsxChild {
      return <Loop depth={(_props.depth ?? 0) + 1} />;
    }
    expect(() => mount(<Loop />, container)).toThrow("Maximum JSX render depth exceeded");
  });

  it("leaves imperatively added children alone in a childless host element", () => {
    // The webui mounts its streaming markdown renderer inside a JSX-owned div
    // via ref; the diff must never touch children the tree did not create.
    const { doc, container, html } = setup();
    const m = mount(<div id="box"></div>, container);
    const box = container.children[0] as FElement;
    box.insertBefore(doc.createTextNode("imperative"), null);
    m.render(<div id="box"></div>);
    expect(html()).toBe('<div id="box">imperative</div>');
    expect(box.children).toHaveLength(1);
  });

  it("attaches refs on mount and nulls them on unmount", () => {
    const { container } = setup();
    const seen: (DomElement | null)[] = [];
    const ref = (el: DomElement | null) => { seen.push(el); };
    const m = mount(<div ref={ref}><span id="inner" /></div>, container);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(container.children[0] as FElement | undefined);
    m.unmount();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(null);
  });

  it("swaps refs when the ref prop identity changes across renders", () => {
    const { container } = setup();
    const calls: string[] = [];
    const refA = (el: DomElement | null) => calls.push(`a:${el ? "on" : "off"}`);
    const m = mount(<div ref={refA} />, container);
    // Same identity: no re-attach.
    m.render(<div ref={refA} className="x" />);
    expect(calls).toEqual(["a:on"]);
    m.render(<div ref={(el) => calls.push(`b:${el ? "on" : "off"}`)} />);
    expect(calls).toEqual(["a:on", "a:off", "b:on"]);
    // The DOM node was reused across the ref swap.
    expect(container.children).toHaveLength(1);
  });

  it("nulls nested refs when a subtree is removed", () => {
    const { container } = setup();
    const calls: (string | null)[] = [];
    const m = mount(<div><p ref={(el) => calls.push(el ? "p" : null)}>x</p></div>, container);
    expect(calls).toEqual(["p"]);
    m.render(<div />);
    expect(calls).toEqual(["p", null]);
  });
});
