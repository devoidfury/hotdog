/**
 * dom-helper: a minimal DOM implementation for testing the webui frontend
 * (message-list, chat) under Bun, which has no DOM. Installed as a test
 * preload (see bunfig.toml).
 *
 * Scope is "what the frontend actually touches", not spec compliance:
 * element/text/comment nodes with insertion ordering, classList, dataset,
 * innerHTML for simple markup (the markdown renderer's output), textContent,
 * querySelector for a small selector grammar (tag / .class / [attr] / :not()),
 * event listeners with dispatchEvent + bubbling, and scroll geometry fields.
 *
 * Exposed as globals `document` and `window` (plus the constructors) only when
 * absent, so this never shadows a real DOM.
 */

import { afterEach, beforeEach } from "bun:test";

// ── Node hierarchy ──────────────────────────────────────────────────────────

class DNode {
  parentNode: DNode | null = null;
  childNodes: DNode[] = [];
  ownerDocument: DDocument;

  constructor(doc: DDocument) {
    this.ownerDocument = doc;
  }

  get firstChild(): DNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): DNode | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return i >= 0 ? this.parentNode.childNodes[i + 1] ?? null : null;
  }

  get children(): DElement[] {
    return this.childNodes.filter((c): c is DElement => c instanceof DElement);
  }

  insertBefore(node: DNode, ref: DNode | null): void {
    if (node instanceof DFragment) {
      // Real fragment semantics: its children move into the target.
      for (const child of [...node.childNodes]) this.insertBefore(child, ref);
      return;
    }
    if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    node.parentNode = this;
    const idx = ref == null ? this.childNodes.length : this.childNodes.indexOf(ref);
    this.childNodes.splice(idx < 0 ? this.childNodes.length : idx, 0, node);
  }

  appendChild<T extends DNode>(node: T): T {
    this.insertBefore(node, null);
    return node;
  }

  removeChild(node: DNode): void {
    const i = this.childNodes.indexOf(node);
    if (i < 0) throw new Error("removeChild: node is not a child");
    node.parentNode = null;
    this.childNodes.splice(i, 1);
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }

  set textContent(value: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (value !== "") this.appendChild(new DText(value, this.ownerDocument));
  }

  // Subclass hook: elements re-parse innerHTML on structural changes.
  _changed(): void {}
}

class DText extends DNode {
  data: string;
  nodeType = 3;

  constructor(data: string, doc: DDocument) {
    super(doc);
    this.data = data;
  }

  override get textContent(): string {
    return this.data;
  }

  override set textContent(value: string) {
    this.data = value;
  }
}

class DFragment extends DNode {
  nodeType = 11;
}

class DComment extends DNode {
  data: string;
  nodeType = 8;

  constructor(data: string, doc: DDocument) {
    super(doc);
    this.data = data;
  }

  override get textContent(): string {
    return "";
  }
}

// ── classList / dataset ─────────────────────────────────────────────────────

class DClassList {
  private tokens: Set<string>;

  constructor(private el: DElement) {
    this.tokens = new Set((el.getAttribute("class") || "").split(/\s+/).filter(Boolean));
  }

  private sync(): void {
    const v = [...this.tokens].join(" ");
    if (v) this.el.setAttribute("class", v);
    else this.el.removeAttribute("class");
  }

  add(...names: string[]): void {
    for (const n of names) this.tokens.add(n);
    this.sync();
  }

  remove(...names: string[]): void {
    for (const n of names) this.tokens.delete(n);
    this.sync();
  }

  contains(name: string): boolean {
    return this.tokens.has(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const want = force ?? !this.tokens.has(name);
    if (want) this.tokens.add(name);
    else this.tokens.delete(name);
    this.sync();
    return want;
  }

  _addSilent(name: string): void {
    this.tokens.add(name);
  }

  get value(): string {
    return [...this.tokens].join(" ");
  }
}

// ── Events ──────────────────────────────────────────────────────────────────

class DEvent {
  defaultPrevented = false;
  propagationStopped = false;

  constructor(
    public type: string,
    public target: DNode | null = null,
    public bubbles: boolean = true,
  ) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

type Listener = (ev?: unknown) => void;

// ── Elements ────────────────────────────────────────────────────────────────

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

class DElement extends DNode {
  nodeType = 1;
  tagName: string;
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<Listener>>();
  classList: DClassList;
  dataset: Record<string, string>;

  // Scroll geometry — plain fields tests can set to drive auto-scroll logic.
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;

  constructor(tag: string, doc: DDocument) {
    super(doc);
    this.tagName = tag.toUpperCase();
    this.classList = new DClassList(this);
    // dataset proxies to data-* attributes (camelCase → kebab-case).
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_t, prop: string) => this.getAttribute(`data-${kebab(prop)}`) ?? undefined,
      set: (_t, prop: string, value: string) => {
        this.setAttribute(`data-${kebab(prop)}`, String(value));
        return true;
      },
      has: (_t, prop: string) => this.attributes.has(`data-${kebab(prop)}`),
      deleteProperty: (_t, prop: string) => {
        this.removeAttribute(`data-${kebab(prop)}`);
        return true;
      },
      ownKeys: () =>
        [...this.attributes.keys()]
          .filter((a) => a.startsWith("data-"))
          .map((a) => camel(a.slice(5))),
      getOwnPropertyDescriptor: (_t, prop: string) => {
        const v = this.getAttribute(`data-${kebab(String(prop))}`);
        return v === null ? undefined : { value: v, enumerable: true, configurable: true };
      },
    });
  }

  override _changed(): void {
    this.classList = new DClassList(this);
  }

  get localName(): string {
    return this.tagName.toLowerCase();
  }

  get className(): string {
    return this.getAttribute("class") ?? "";
  }

  set className(value: string) {
    this.setAttribute("class", value);
  }

  setAttribute(name: string, value: string): void {
    const lower = name.toLowerCase();
    this.attributes.set(lower, String(value));
    if (lower === "class") this.classList = new DClassList(this);
  }

  getAttribute(name: string): string | null {
    const v = this.attributes.get(name.toLowerCase());
    return v === undefined ? null : v;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name.toLowerCase());
  }

  removeAttribute(name: string): void {
    const lower = name.toLowerCase();
    this.attributes.delete(lower);
    if (lower === "class") this.classList = new DClassList(this);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(ev: unknown): boolean {
    const event = ev instanceof DEvent ? ev : new DEvent(String((ev as { type?: string })?.type ?? ""));
    if (!event.target) event.target = this;
    // Capture-less bubbling walk up the parent chain.
    let node: DNode | null = this;
    while (node) {
      if (node instanceof DElement) {
        for (const l of [...(node.listeners.get(event.type) ?? [])]) l(event);
        if (event.propagationStopped) break;
        if (!event.bubbles) break;
      }
      node = node.parentNode;
    }
    return !event.defaultPrevented;
  }

  get innerHTML(): string {
    return this.childNodes.map(serializeNode).join("");
  }

  set innerHTML(html: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    for (const node of parseHtmlFragment(html, this.ownerDocument)) this.appendChild(node);
  }

  querySelector(sel: string): DElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }

  querySelectorAll(sel: string): DElement[] {
    const groups = compileSelector(sel);
    const out: DElement[] = [];
    for (const matchers of groups) {
      // Descendant combinators: candidates start at the whole subtree and
      // narrow through each compound in turn.
      let candidates: DElement[] = collectDescendants(this);
      let first = true;
      let satisfied: DElement[] = [];
      for (const compound of matchers) {
        const pool = first ? candidates : satisfied.flatMap((el) => collectDescendants(el));
        satisfied = pool.filter(compound);
        first = false;
      }
      for (const el of satisfied) if (!out.includes(el)) out.push(el);
    }
    return out;
  }

  click(): void {
    this.dispatchEvent(new DEvent("click", this));
  }
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function camel(s: string): string {
  return s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function serializeNode(n: DNode): string {
  if (n instanceof DText) return escapeText(n.data);
  if (n instanceof DComment) return `<!--${n.data}-->`;
  const el = n as DElement;
  const tag = el.localName;
  let attrs = "";
  for (const [k, v] of el.attributes) attrs += ` ${k}="${escapeAttr(v)}"`;
  if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${el.childNodes.map(serializeNode).join("")}</${tag}>`;
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

// ── HTML fragment parser (simple markup only) ───────────────────────────────
// Handles the shapes our code writes via innerHTML: tags with double-quoted
// or bare attributes, void elements, comments, entities. NOT a spec parser —
// malformed/unbalanced markup is accepted leniently (close tags for open
// elements that don't match are ignored).

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isNaN(cp) ? m : String.fromCodePoint(cp);
    }
    if (body.startsWith("#")) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isNaN(cp) ? m : String.fromCodePoint(cp);
    }
    return ENTITIES[body] ?? m;
  });
}

function parseHtmlFragment(html: string, doc: DDocument): DNode[] {
  const roots: DNode[] = [];
  const stack: DElement[] = [];
  const top = (): DElement | null => stack[stack.length - 1] ?? null;
  const push = (n: DNode): void => {
    const p = top();
    if (p) p.appendChild(n);
    else roots.push(n);
  };
  const addText = (raw: string): void => {
    if (!raw) return;
    push(new DText(decodeEntities(raw), doc));
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      addText(html.slice(i));
      break;
    }
    addText(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const data = html.slice(lt + 4, end < 0 ? html.length : end);
      push(new DComment(data, doc));
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt)) {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt < 0) {
      addText(html.slice(lt));
      break;
    }
    const inner = html.slice(lt + 1, gt);
    i = gt + 1;

    if (inner.startsWith("/")) {
      const tag = inner.slice(1).trim().toLowerCase();
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s]!.localName === tag) {
          stack.length = s;
          break;
        }
      }
      continue;
    }

    const m = /^([a-zA-Z][^\s/>]*)/.exec(inner);
    if (!m) continue;
    const el = doc.createElement(m[1]!);
    for (const attr of parseAttrs(inner.slice(m[0].length))) {
      el.setAttribute(attr.name, attr.value);
    }
    push(el);
    const selfClosing = inner.endsWith("/");
    if (!selfClosing && !VOID_TAGS.has(el.localName)) stack.push(el);
  }
  return roots;
}

// Finds the ">" that closes a tag, skipping over quoted attribute values.
function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < html.length; i++) {
    const c = html[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

function parseAttrs(s: string): Array<{ name: string; value: string }> {
  const attrs: Array<{ name: string; value: string }> = [];
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[0].trim() === "/") continue;
    const value = m[1] !== undefined ? m[2] ?? m[3] ?? m[4] ?? "" : "";
    attrs.push({ name: m[1]!, value: decodeEntities(value) });
  }
  return attrs;
}

// ── Selector grammar: comma groups of compound simple selectors ─────────────
// Supports tag, .class, #id, [attr], [attr="val"], :not(compound), and
// descendant combinators (".a .b").

type Matcher = (el: DElement) => boolean;

function collectDescendants(root: DNode): DElement[] {
  const out: DElement[] = [];
  const visit = (parent: DNode): void => {
    for (const child of parent.children) {
      out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

function compileSelector(sel: string): Matcher[][] {
  // Split on commas at depth 0 (:not() may contain one, though we don't emit any).
  const groups: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of sel) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      groups.push(cur);
      cur = "";
    } else cur += ch;
  }
  groups.push(cur);
  return groups.map((part) => part.trim().split(/\s+/).filter(Boolean).map(compileCompound));
}

function compileCompound(part: string): Matcher {
  const matchers: Matcher[] = [];
  let rest = part;
  while (rest.length > 0) {
    if (rest.startsWith("*")) {
      rest = rest.slice(1); // universal selector matches everything
      continue;
    }
    const m = /^([.#]?[\w-]+|:not\(([^)]*)\)|\[[^\]]*\])/.exec(rest);
    if (!m) throw new Error(`dom-helper: unsupported selector token in "${part}"`);
    const tok = m[0]!;
    if (tok.startsWith(":not(")) {
      const inner = compileCompound(m[2]!.trim());
      matchers.push((el) => !inner(el));
    } else if (tok.startsWith(".")) {
      const cls = tok.slice(1);
      matchers.push((el) => el.classList.contains(cls));
    } else if (tok.startsWith("#")) {
      const id = tok.slice(1);
      matchers.push((el) => el.getAttribute("id") === id);
    } else if (tok.startsWith("[")) {
      const am = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(tok);
      if (!am) throw new Error(`dom-helper: unsupported attribute selector "${tok}"`);
      const name = am[1]!;
      const value = am[2] ?? am[3] ?? am[4];
      matchers.push(
        value === undefined
          ? (el) => el.hasAttribute(name)
          : (el) => el.getAttribute(name) === value,
      );
    } else {
      const tag = tok.toLowerCase();
      matchers.push((el) => el.localName === tag);
    }
    rest = rest.slice(tok.length);
  }
  return (el) => matchers.every((m) => m(el));
}

// ── Document / window ───────────────────────────────────────────────────────

class DDocument extends DNode {
  documentElement: DElement;
  body: DElement;
  head: DElement;

  constructor() {
    super(null as unknown as DDocument);
    this.ownerDocument = this;
    this.documentElement = new DElement("html", this);
    this.documentElement.parentNode = this;
    this.childNodes.push(this.documentElement);
    this.head = new DElement("head", this);
    this.body = new DElement("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string): DElement {
    return new DElement(tag, this);
  }

  createTextNode(data: string): DText {
    return new DText(data, this);
  }

  createComment(data: string): DComment {
    return new DComment(data, this);
  }

  createDocumentFragment(): DNode {
    return new DFragment(this);
  }

  getElementById(id: string): DElement | null {
    return this.documentElement.querySelector(`#${id}`);
  }
}

// Minimal WebSocket double: never opens a socket. Tests drive onopen/onmessage
// directly and inspect `sent`. Instances are recorded in FakeWebSocket.instances
// so tests can reach the one createChat() opened on construction.
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = 1; // OPEN — send() is exercised without a real connection.
  sent: string[] = [];
  closed = 0;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    this.sent.push(String(data));
  }

  close(): void {
    this.closed++;
    this.readyState = 3;
  }

  // Test helpers.
  fireOpen(): void {
    this.onopen?.();
  }

  fireMessage(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  lastSent(): Record<string, unknown> | null {
    const s = this.sent[this.sent.length - 1];
    return s ? (JSON.parse(s) as Record<string, unknown>) : null;
  }
}

const g = globalThis as Record<string, unknown>;

if (g.document === undefined) {
  const doc = new DDocument();
  Object.defineProperty(g, "document", { value: doc, writable: true, configurable: true });
  g.DDocument = DDocument;
  g.DElement = DElement;
}

if (g.window === undefined) {
  const win: Record<string, unknown> = {
    location: { host: "localhost:0", search: "", pathname: "/", href: "http://localhost:0/" },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  win.window = win;
  Object.defineProperty(g, "window", { value: win, writable: true, configurable: true });
}

// Install/uninstall the FakeWebSocket global around a block of tests. Kept
// local (not preload-wide) so server tests can still open real sockets.
export function useFakeWebSocket(): void {
  const g = globalThis as Record<string, unknown>;
  let saved: unknown;
  beforeEach(() => {
    saved = g.WebSocket;
    g.WebSocket = FakeWebSocket;
    FakeWebSocket.instances.length = 0;
  });
  afterEach(() => {
    g.WebSocket = saved;
  });
}

export { DDocument, DElement, DText, DComment, DEvent, FakeWebSocket };
export const domHelper = { DDocument, DElement, DText, DComment, DEvent, FakeWebSocket };
