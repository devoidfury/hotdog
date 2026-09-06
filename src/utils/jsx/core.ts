/**
 * hotdog JSX runtime (core) -- element model + render to HTML string.
 *
 * Bun compiles `.tsx`/`.jsx` into calls into `./jsx-runtime.ts` and `./jsx-dev-runtime.ts`
 * both entrypoints delegate here. (see tsconfig: `jsx: "react-jsx"`, `jsxImportSource: "@utils/jsx"`)
 */

// Shared identity across both runtime entrypoints, even if they end up in separate module instances.
// Use Symbol.for so every copy resolves to one id.
// React precedent: React.Fragment is a symbol at runtime but typed as a component so `<Fragment>` typechecks.
export const Fragment: Component = Symbol.for("hotdog.jsx.Fragment") as unknown as Component;

export type ComponentProps = Record<string, unknown> & { children?: unknown };

export interface JsxNode {
  type: string | Component;
  props: ComponentProps;
  key: string | number | null;
}

/** Anything that can appear as a node or inside children. Arrays nest arbitrarily (nested maps). */
export type JsxChild =
  | JsxNode
  | JsxChild[]
  | string
  | number
  | boolean
  | null
  | undefined;

export type Component = (props: ComponentProps) => JsxChild;

export function createNode(
  type: JsxNode["type"],
  props?: ComponentProps | null,
  key?: string | number | null,
): JsxNode {
  return { type, props: props ?? {}, key: key ?? null };
}

/* ------------------------------- rendering ------------------------------- */

export const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

// Attribute names must match this or they are dropped: prop keys can come from
// spread objects of untrusted data, and a key containing `>` or whitespace would
// break out of the tag and inject raw markup.
export const VALID_ATTR_NAME = /^[A-Za-z_:][A-Za-z0-9_:.:-]*$/;

// Same reasoning for tag names: a dynamic `type` (component registries, markdown renderers mapping data -> tag)
// containing whitespace or `>` would inject attributes or markup through the tag itself.
export const VALID_TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*$/;

// Event handler attributes. Functions are already SSR no-ops, but a *string*
// under an `on*` key from an untrusted spread would execute in a served document, so drop the name entirely.
// Note this also drops non-handler names starting with "on" (e.g. `once`); erring safe is deliberate.
export const EVENT_ATTR = /^on[a-z]/i;

// JSX/React camelCase prop names that map to a different HTML attribute name.
export const ATTR_RENAMES: Record<string, string> = {
  className: "class",
  htmlFor: "for",
};

// Scheme check URL-valued attributes so `href="javascript:..."` from untrusted data cannot produce a clickable XSS vector.
// Everything without a scheme (relative paths, `//host/path`, `#anchor`) is allowed;
// `data:` is blocked on purpose (data:text/html in href executes scripts).
// Lookup is case-insensitive: HTML attribute names are ASCII case-insensitive, so an
// untrusted spread's `HREF` must hit the guard too, not just lowercase `href`.
// Note: only these attribute names are checked; a custom element's URL-like prop is the caller's responsibility.
export const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href"]);

// Browsers' URL parser strips ASCII whitespace and control chars before resolving, so `jav\tascript:` is live. Scheme-check the stripped form.
const CONTROL_CHARS = /[\x00-\x20\x7f]+/g;
const HAS_SCHEME = /^[a-z][a-z\d+.-]*:/i;
// blob: is same-origin and only resolves against a live object the page itself created, so it is safe in href/src (client-side downloads, previews).
const SAFE_SCHEMES = /^(?:https?|mailto|tel|blob):/i;

// One `data:` exception: inline images on <img>, the one common legitimate use.
// Browsers never run scripts from an <img> src (SVG loaded via <img> is script-disabled),
// but the same URL on iframe/embed src would be a live document, so the allowance is per-tag, not per-scheme.
// Known ceiling: data: urls on <picture><source> and <input type="image"> are dropped.
const SAFE_DATA_IMG_TAGS = new Set(["img"]);
const DATA_IMAGE = /^data:image\//i;

// Presence-only HTML attributes: `true` renders the bare name.
// Everything else renders `attr="true"` (React parity), so `width={true}` does not silently produce a valueless `width`.
// `false` is always omitted.
export const BOOLEAN_ATTRS = new Set([
  "allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls",
  "default", "defer", "disabled", "formnovalidate", "hidden", "inert", "ismap",
  "itemscope", "loop", "multiple", "muted", "nomodule", "novalidate", "open",
  "playsinline", "readonly", "required", "reversed", "selected",
]);

// Ceiling on render recursion. A component returning itself (or a mutual cycle) recurses through tail calls,
// and JSC applies proper tail calls in strict ESM, so the stack never overflows: without this the renderer loops
// forever with no diagnostics (React's depth guard, same reasoning).
// Known ceiling: bounds tree depth, not sibling count.
export const MAX_RENDER_DEPTH = 1000;

/** Render an element tree (or a bare value) to an HTML string. */
export function renderToString(node: JsxChild): string {
  return renderNode(node);
}

function renderNode(node: JsxChild, depth = 0): string {
  if (depth > MAX_RENDER_DEPTH) {
    throw new Error(`Maximum JSX render depth exceeded (${MAX_RENDER_DEPTH})`);
  }
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return escapeHtml(node);
  if (typeof node === "number") return escapeHtml(String(node));
  if (Array.isArray(node)) return node.map((c) => renderNode(c, depth + 1)).join("");
  // Terminal guard: anything reaching here must be a real element. Without it, a stray function/symbol/malformed object
  // dies deep inside renderAttrs with a confusing `Object.entries` TypeError (or silently renders <undefined>).
  if (
    typeof node.type === "string" ||
    typeof node.type === "function" ||
    node.type === Fragment
  ) {
    return renderElement(node, depth);
  }
  throw new Error(
    `Invalid JSX child of type ${typeof node}: ${String(node).slice(0, 40)}`,
  );
}

function renderElement(node: JsxNode, depth: number): string {
  const { type, props } = node;
  if (type === Fragment) return renderNode(props.children as JsxChild, depth + 1);
  if (typeof type === "function") return renderNode(type(props), depth + 1);
  return renderHost(String(type), props, depth);
}

// Whether a children value is actual content. `null`, `undefined`, `false` and `[]` render nothing,
// so they are not children for the void-element warning or the dangerouslySetInnerHTML throw.
// Known ceiling: an array of only-falsy entries (`[false]`) still counts.
export function childrenPresent(children: unknown): boolean {
  if (children == null || typeof children === "boolean") return false;
  if (Array.isArray(children)) return children.length > 0;
  return true;
}

function renderHost(rawTag: string, props: ComponentProps, depth: number): string {
  // HTML tag names are ASCII case-insensitive and HTML parsers lowercase them,
  // so a dynamic <IMG> must hit the same void-element table (and render the same
  // way) as <img>.
  const tag = rawTag.toLowerCase();
  if (!VALID_TAG_NAME.test(tag)) {
    // Bare console.warn, not the core logger: this module is isomorphic and
    // must stay importable in the browser without pulling in hook plumbing.
    console.warn(`[jsx] dropped invalid tag name: ${JSON.stringify(tag.slice(0, 80))}`);
    return "";
  }
  const rawHtml = props.dangerouslySetInnerHTML;
  const hasRawHtml = rawHtml != null && typeof rawHtml === "object" && "__html" in rawHtml;
  const kids = childrenPresent(props.children);
  const open = `<${tag}${renderAttrs(props, tag)}>`;
  if (VOID_ELEMENTS.has(tag)) {
    if (kids || hasRawHtml) {
      console.warn(`[jsx] <${tag}> is a void element, its children were dropped`);
    }
    return open;
  }

  if (hasRawHtml) {
    // React parity: specifying both children and __html is ambiguous, throw. `{false}`/`{null}`/`[]` render nothing, so they do not count as children.
    if (kids) {
      throw new Error("Can only set one of `children` or `props.dangerouslySetInnerHTML`.");
    }
    return `${open}${String((rawHtml as { __html: unknown }).__html ?? "")}</${tag}>`; // trusted, emitted raw
  }
  return `${open}${renderNode(props.children as JsxChild, depth + 1)}</${tag}>`;
}

function renderAttrs(props: ComponentProps, tag: string): string {
  let out = "";
  for (const [name, value] of Object.entries(props)) {
    // `key` is a node field, not an attribute; the transform hoists it out of
    // props for real JSX, but hand-built createNode props can still carry one.
    // `ref` is a client-only handle (see client.ts); SSR ignores it like handlers.
    if (name === "children" || name === "key" || name === "ref" || name === "dangerouslySetInnerHTML") continue;
    if (EVENT_ATTR.test(name)) continue;
    if (value == null) continue;
    if (typeof value === "function") continue; // on* handlers are SSR no-ops
    const attr = ATTR_RENAMES[name] ?? name;
    if (!VALID_ATTR_NAME.test(attr)) continue;
    if (typeof value === "boolean") {
      if (!value) continue;
      out += BOOLEAN_ATTRS.has(attr) ? ` ${attr}` : ` ${attr}="true"`;
      continue;
    }
    const text = serializeValue(name, value);
    if (URL_ATTRS.has(attr.toLowerCase()) && !isSafeUrl(text, tag)) {
      console.warn(`[jsx] dropped unsafe url in ${attr}: ${JSON.stringify(text.slice(0, 80))}`);
      continue;
    }
    out += ` ${attr}="${escapeHtml(text)}"`;
  }
  return out;
}

// `tag` is the host element's name (case-insensitive), needed only for the <img> data: exception.
export function isSafeUrl(value: string, tag = ""): boolean {
  const stripped = value.replace(CONTROL_CHARS, "");
  if (!HAS_SCHEME.test(stripped)) return true;
  return (
    SAFE_SCHEMES.test(stripped) ||
    (SAFE_DATA_IMG_TAGS.has(tag.toLowerCase()) && DATA_IMAGE.test(stripped))
  );
}

export function serializeValue(name: string, value: unknown): string {
  // Case-insensitive: browsers normalize attribute names, so a spread's `STYLE`
  // lands as the style attribute too and deserves the same object serialization.
  if (name.toLowerCase() === "style" && value != null && typeof value === "object") {
    // Minimal CSS from a style object: kebab-cased keys, no unit inference.
    // Known ceiling: numbers are emitted as-is (no auto-px).
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v != null && v !== false)
      .map(([k, v]) => `${toKebab(k)}:${String(v)}`)
      .join(";");
  }
  return String(value);
}

function toKebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&#34;")
    .replace(/'/g, "&#39;");
}
