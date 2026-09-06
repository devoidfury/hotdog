/**
 * hotdog JSX client runtime -- mount a JSX tree into a live DOM and keep it updated with a minimal keyed diff.
 *
 *   const app = mount(<App />, document.getElementById("root"));
 *   app.render(<App again />);   // patches in place where possible
 *   app.unmount();
 *
 * Re-renders are explicit (`render`); compose with `reactiveState` from
 * `@utils/reactive-state` (`count.effect(() => app.render(<View/>))`) for
 * automatic updates.
 *
 * The DOM is only touched through the minimal structural interfaces below, so
 * this file typechecks without the DOM lib (the project tsconfig has none) and
 * tests can run it against a fake DOM under Bun. Real browser nodes satisfy
 * these interfaces structurally.
 */
import {
  ATTR_RENAMES,
  BOOLEAN_ATTRS,
  EVENT_ATTR,
  Fragment,
  MAX_RENDER_DEPTH,
  URL_ATTRS,
  VALID_ATTR_NAME,
  VALID_TAG_NAME,
  VOID_ELEMENTS,
  childrenPresent,
  isSafeUrl,
  serializeValue,
  type ComponentProps,
  type JsxChild,
  type JsxNode,
} from "./core.ts";

/* ------------------------------ DOM surface ------------------------------ */

export interface DomNode {
  readonly parentNode: DomNode | null;
  readonly firstChild: DomNode | null;
  readonly nextSibling: DomNode | null;
  readonly ownerDocument: DomDocument | null;
  insertBefore(node: DomNode, ref: DomNode | null): void;
  remove(): void;
}

export interface DomText extends DomNode {
  data: string;
}

export interface DomElement extends DomNode {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: DomListener): void;
  removeEventListener(type: string, listener: DomListener): void;
}

export interface DomDocument {
  createElement(tag: string): DomElement;
  createTextNode(data: string): DomText;
  createComment(data: string): DomNode;
}

export type DomListener = (event?: unknown) => void;

/* ------------------------------ unit model ------------------------------- */

// A child slot after flattening arrays/Fragments and calling function components:
// exactly one unit produces exactly one DOM node. Entries below hold only these,
// so diffing never sees components (they have no state to preserve; their output is diffed as plain DOM).
type HostUnit = { kind: "host"; vnode: JsxNode };
type Unit = { kind: "text"; value: string } | { kind: "placeholder" } | HostUnit;

// Falsy children (`{cond && <x/>}`, `{null}`) get a comment placeholder instead of nothing
// so positional diffing keeps siblings aligned across renders.
function flatten(node: JsxChild, depth: number, out: Unit[]): void {
  if (depth > MAX_RENDER_DEPTH) {
    throw new Error(`Maximum JSX render depth exceeded (${MAX_RENDER_DEPTH})`);
  }
  if (node == null || typeof node === "boolean") {
    out.push({ kind: "placeholder" });
    return;
  }
  if (typeof node === "string" || typeof node === "number") {
    out.push({ kind: "text", value: String(node) });
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) flatten(c, depth + 1, out);
    return;
  }
  const { type, props } = node;
  if (type === Fragment) {
    flatten(props.children as JsxChild, depth + 1, out);
    return;
  }
  if (typeof type === "function") {
    flatten(type(props), depth + 1, out);
    return;
  }
  if (typeof type === "string") {
    if (!VALID_TAG_NAME.test(String(type))) {
      console.warn(`[jsx] dropped invalid tag name: ${JSON.stringify(String(type).slice(0, 80))}`);
      out.push({ kind: "placeholder" });
      return;
    }
    out.push({ kind: "host", vnode: node });
    return;
  }
  throw new Error(`Invalid JSX child of type ${typeof node}: ${String(node).slice(0, 40)}`);
}

function unitKey(u: Unit): string | null {
  return u.kind === "host" && u.vnode.key != null ? String(u.vnode.key) : null;
}

function compatible(a: Unit, b: Unit): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "host" && b.kind === "host") return a.vnode.type === b.vnode.type;
  return true;
}

/* -------------------------------- entries -------------------------------- */

interface Entry {
  unit: Unit;
  dom: DomNode;
  kids?: Entry[]; // host elements only
  events?: Map<string, DomListener>; // host elements only, keyed by DOM event type (evtType(propName))
  warned?: Set<string>; // host elements only: warning names already emitted
}

// Each warning fires at most once per node, so a static tree with an ignored prop does not re-warn on every render.
function warnOnce(entry: Entry, key: string, message: string): void {
  const warned = (entry.warned ??= new Set<string>());
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function warnVoidDropped(entry: Entry, tag: string): void {
  warnOnce(entry, "void", `[jsx] <${tag}> is a void element, its children were dropped`);
}

// Duplicated keys in one children list cannot be matched unambiguously (the second
// occurrence creates a fresh node), so warn like React -- once per parent node, per key.
const dupKeyWarned = new WeakMap<DomNode, Set<string>>();
function warnDupKey(parent: DomNode, key: string): void {
  let warned = dupKeyWarned.get(parent);
  if (warned?.has(key)) return;
  (warned ??= new Set<string>()).add(key);
  dupKeyWarned.set(parent, warned);
  console.warn(`[jsx] duplicated key in children: ${JSON.stringify(key.slice(0, 80))}`);
}

function checkDupKeys(parent: DomNode, units: Unit[]): void {
  const seen = new Set<string>();
  for (const u of units) {
    const k = unitKey(u);
    if (k == null) continue;
    if (seen.has(k)) warnDupKey(parent, k);
    seen.add(k);
  }
}

function create(u: Unit, doc: DomDocument, depth: number): Entry {
  if (u.kind === "placeholder") return { unit: u, dom: doc.createComment("") };
  if (u.kind === "text") return { unit: u, dom: doc.createTextNode(u.value) };
  // Lowercase: HTML tag names are case-insensitive and browsers lowercase them,
  // so a dynamic <IMG> must hit the same void-element table as <img>.
  const tag = String(u.vnode.type).toLowerCase();
  const el = doc.createElement(tag);
  const entry: Entry = { unit: u, dom: el, kids: [], events: new Map() };
  applyProps(el, {}, u.vnode.props, entry, tag);
  const isVoid = VOID_ELEMENTS.has(tag);
  if (isVoid) {
    // void elements never carry child nodes, so warn and drop.
    if (childrenPresent(u.vnode.props.children)) warnVoidDropped(entry, tag);
  } else if (u.vnode.props.children !== undefined) {
    const kids: Unit[] = [];
    flatten(u.vnode.props.children as JsxChild, depth + 1, kids);
    checkDupKeys(el, kids);
    for (const ku of kids) {
      const kid = create(ku, doc, depth + 1);
      el.insertBefore(kid.dom, null);
      entry.kids!.push(kid);
    }
  }
  return entry;
}

// React prop suffixes whose DOM event name is not a plain lowercase
// (React's own mapping table; the rest are lowercase, e.g. onClick -> "click").
const EVENT_RENAMES: Record<string, string> = { DoubleClick: "dblclick" };

const evtType = (propName: string): string => {
  const suffix = propName.slice(2);
  return EVENT_RENAMES[suffix] ?? suffix.toLowerCase();
};

// Sync attributes and event listeners from old props to new props, in place.
// Attribute rules mirror renderToString (renames, booleans, invalid names, unsafe URLs);
// `on*` props become real listeners instead of being dropped.
function applyProps(el: DomElement, oldProps: ComponentProps, newProps: ComponentProps, entry: Entry, tag: string): void {
  const events = entry.events!;
  for (const [name, value] of Object.entries(oldProps)) {
    if (name === "children" || name === "key" || name === "dangerouslySetInnerHTML") continue;
    if (EVENT_ATTR.test(name)) {
      if (typeof value === "function" && newProps[name] !== value) {
        const type = evtType(name);
        const h = events.get(type);
        if (h) {
          el.removeEventListener(type, h);
          events.delete(type);
        }
      }
      continue;
    }
    const attr = ATTR_RENAMES[name] ?? name;
    if (!VALID_ATTR_NAME.test(attr)) continue;
    if (!(name in newProps)) el.removeAttribute(attr);
  }

  for (const [name, value] of Object.entries(newProps)) {
    if (name === "children" || name === "key") continue;
    if (name === "dangerouslySetInnerHTML") {
      warnOnce(entry, "rawHtml", "[jsx] dangerouslySetInnerHTML is ignored by client mount");
      continue;
    }
    if (EVENT_ATTR.test(name)) {
      if (typeof value === "function" && oldProps[name] !== value) {
        // Keyed by DOM event type, not prop name: `onClick` and `onclick` map to
        // the same "click" listener slot, so the last one wins instead of both firing.
        const type = evtType(name);
        const prev = events.get(type);
        if (prev) el.removeEventListener(type, prev);
        const handler = value as DomListener;
        events.set(type, handler);
        el.addEventListener(type, handler);
      }
      continue;
    }
    const attr = ATTR_RENAMES[name] ?? name;
    if (!VALID_ATTR_NAME.test(attr)) continue;
    if (value == null || value === false || typeof value === "function") {
      el.removeAttribute(attr);
      continue;
    }
    if (typeof value === "boolean") {
      el.setAttribute(attr, BOOLEAN_ATTRS.has(attr) ? "" : "true");
      continue;
    }
    const text = serializeValue(name, value);
    // Case-insensitive lookup: browsers normalize attribute names, so setAttribute("HREF", ...)
    // lands as `href` and must pass the same scheme guard (see core.ts URL_ATTRS).
    if (URL_ATTRS.has(attr.toLowerCase()) && !isSafeUrl(text, tag)) {
      console.warn(`[jsx] dropped unsafe url in ${attr}: ${JSON.stringify(text.slice(0, 80))}`);
      el.removeAttribute(attr);
      continue;
    }
    el.setAttribute(attr, text);
  }
}

/* ------------------------------- diffing --------------------------------- */

function patch(e: Entry, u: Unit, doc: DomDocument, depth: number): Entry {
  if (u.kind === "placeholder") return e;
  if (u.kind === "text") {
    if (e.unit.kind === "text" && e.unit.value !== u.value) {
      (e.dom as DomText).data = u.value;
    }
    e.unit = u;
    return e;
  }
  const el = e.dom as DomElement;
  const tag = String(u.vnode.type).toLowerCase();
  // reconcile() only patches compatible units -- for hosts that means the same tag
  // -- so e is always a host entry here.
  const old = e.unit as HostUnit;
  applyProps(el, old.vnode.props, u.vnode.props, e, tag);
  e.unit = u;
  if (VOID_ELEMENTS.has(tag)) {
    // Re-render onto the same (now void) tag: a real DOM cannot hold children there, if any were requested warn and drop.
    if (childrenPresent(u.vnode.props.children)) warnVoidDropped(e, tag);
    for (const k of e.kids ?? []) k.dom.remove();
    e.kids = [];
    return e;
  }
  e.kids = reconcile(el, e.kids ?? [], u.vnode.props.children as JsxChild, doc, depth);
  return e;
}

// Diff old child entries against a new child tree. Matching is by `key` when present, otherwise by position.
function reconcile(
  parent: DomNode,
  oldKids: Entry[],
  child: JsxChild,
  doc: DomDocument,
  depth: number,
): Entry[] {
  const units: Unit[] = [];
  // Same rule as create(): a host element without a children prop has no child slots at all.
  // `undefined` only becomes a placeholder when it is an explicit entry in a children array.
  if (child !== undefined) flatten(child, depth + 1, units);

  const byKey = new Map<string, Entry>();
  for (const e of oldKids) {
    const k = unitKey(e.unit);
    if (k != null) byKey.set(k, e);
  }

  checkDupKeys(parent, units);

  const newKids: Entry[] = [];
  const consumed = new Set<Entry>();
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    const key = unitKey(u);
    let reuse: Entry | undefined;
    if (key != null) {
      const c = byKey.get(key);
      if (c && !consumed.has(c) && compatible(c.unit, u)) reuse = c;
    } else {
      // Positional fallback may only consume UNKEYED old entries: a keyed entry
      // is reserved for its key, so a keyless unit cannot hijack its node
      // (otherwise the later keyed unit finds it consumed and gets a fresh node,
      // and node identity lands on the wrong logical item).
      const c = oldKids[i];
      if (c && unitKey(c.unit) == null && !consumed.has(c) && compatible(c.unit, u)) reuse = c;
    }
    // Track it so a later unit in this same reconcile cannot reuse the same entry (an old child can match a new one by key AND by position)
    //  and the removal pass below does not drop it even though it was just patched.
    if (reuse) consumed.add(reuse);
    newKids.push(reuse ? patch(reuse, u, doc, depth + 1) : create(u, doc, depth + 1));
  }

  for (const e of oldKids) {
    if (!consumed.has(e)) e.dom.remove();
  }

  // Order pass: walk the new list and insert each dom at position i. Nothing moves when the order already matches; each mismatch is one insertBefore.
  let prev: DomNode | null = null;
  for (const e of newKids) {
    const expected: DomNode | null = prev ? prev.nextSibling : parent.firstChild;
    if (e.dom !== expected) parent.insertBefore(e.dom, expected);
    prev = e.dom;
  }
  return newKids;
}

/* --------------------------------- mount --------------------------------- */

export interface Mounted {
  /** Re-render, patching the container's children in place where possible. */
  render(node: JsxChild): void;
  /** Remove everything this mount created (the container itself is kept). */
  unmount(): void;
}

/**
 * Mount a JSX tree into `container`. The container's children are treated as owned by this mount;
 * non-JSX children already inside it confuse re-render ordering, so mount into empty containers.
 */
export function mount(node: JsxChild, container: DomNode): Mounted {
  if (container.firstChild != null) {
    throw new Error("[jsx] mount: container is not empty, mount into an empty container");
  }
  const doc = container.ownerDocument ?? (globalThis as { document?: DomDocument }).document;
  if (!doc) throw new Error("[jsx] mount: no document available");
  let kids = reconcile(container, [], node, doc, 0);
  return {
    render(next: JsxChild) {
      kids = reconcile(container, kids, next, doc, 0);
    },
    unmount() {
      for (const e of kids) e.dom.remove();
      kids = [];
    },
  };
}
