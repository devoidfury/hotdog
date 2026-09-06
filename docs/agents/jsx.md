# JSX Runtime (`src/utils/jsx/`)

Zero-dependency JSX for hotdog: an element factory, a server-side `renderToString`, and a client `mount` with a minimal keyed DOM diff. No React, no DOM lib types. Intended consumer is the webui; nothing in core uses it yet.

## Setup

`.tsx`/`.jsx` compile via the automatic transform configured in `tsconfig.json`:

```json
"jsx": "react-jsx",
"jsxImportSource": "@utils/jsx"
```

The transform emits calls into `src/utils/jsx/jsx-runtime.ts` (prod) and `jsx-dev-runtime.ts` (dev). Those files are fixed-path entrypoints Bun requires; application code never imports them directly. Import from the package root instead:

```ts
import { renderToString, mount, Fragment } from "@utils/jsx";
```

## API

Exported from `src/utils/jsx/index.ts`:

| Export | Purpose |
|---|---|
| `renderToString(node)` | Render a JSX tree (or bare value) to an HTML string |
| `mount(node, container)` | Render into a live DOM node; returns `{ render(next), unmount() }` |
| `Fragment` | Groups children without a host element. A `Symbol.for` identity shared across both runtime entrypoints |
| `createNode(type, props?, key?)` | Build an element by hand (same shape the transform emits) |
| `Component`, `ComponentProps`, `JsxChild`, `JsxNode` | Element-model types |
| `Mounted`, `DomDocument`, `DomElement`, `DomNode`, `DomText` | Client/DOM types |

A `Component` is `(props) => JsxChild`; there is no class-component or lifecycle concept. `JsxChild` covers nodes, arrays (nested arbitrarily), strings, numbers, booleans, and nullish values.

## SSR semantics (`renderToString`, core.ts)

- Text (strings and numbers) is HTML-escaped. `null`, `undefined`, `false`, and `[]` render nothing.
- Prop renames: `className` → `class`, `htmlFor` → `for`.
- Booleans: `true` renders the bare attribute name for known boolean attributes (`disabled`, `checked`, ...), otherwise `attr="true"` (React parity). `false`, `null`, and `undefined` omit the attribute.
- Function props are dropped (handlers are SSR no-ops). `key` is never emitted as an attribute.
- `style` objects serialize to minimal CSS: kebab-cased keys, values as-is (no `px` inference).
- `dangerouslySetInnerHTML={{__html}}` emits raw, unescaped HTML — trusted input only. Specifying it alongside real children throws.
- Void elements (`<br>`, `<img>`, ...) never render children; requesting them warns and drops.
- Recursive component output is bounded by `MAX_RENDER_DEPTH` (1000) — a self-returning component would otherwise loop forever, since JSC applies proper tail calls in strict ESM. Exceeding it throws.

## Security guards (shared by SSR and mount)

These exist because prop keys and dynamic tag names can come from untrusted data (spread objects, data-driven renderers):

- **Tag names** must match `VALID_TAG_NAME` or the element is dropped with a warning (a `>` or space in a dynamic tag would inject markup).
- **Attribute names** must match `VALID_ATTR_NAME` or the attribute is dropped.
- **`on*` props** are dropped wholesale in SSR (`EVENT_ATTR` also drops non-handler names starting with "on", e.g. `once`; erring safe is deliberate). In `mount`, function values become real listeners instead.
- **URL attributes** (`href`, `src`, `action`, `formaction`, `xlink:href`) are scheme-checked via `isSafeUrl()`: schemeless values (relative paths, `#anchor`, `//host`) and `https?`/`mailto`/`tel`/`blob` pass; `data:` passes only for `data:image/*` on `<img>` (script-disabled there, live on an iframe). Everything else, including `javascript:`, is dropped with a warning. Control chars/whitespace are stripped before the check (`jav\tascript:` is live in browsers) and attribute lookup is case-insensitive (`HREF` from an untrusted spread hits the guard too).

Warnings use bare `console.warn`, not the core logger: the module is isomorphic and must stay importable in the browser without hook plumbing.

## Client mount and diffing (client.ts)

```ts
const app = mount(<App />, document.getElementById("root"));
app.render(<App again />);  // patches in place where possible
app.unmount();
```

- Re-renders are explicit (`app.render`). Compose with `reactiveState` from `@utils/reactive-state` for automatic updates: `count.effect(() => app.render(<View count={count()} />))`.
- The container must be empty at mount; mount throws otherwise (foreign children confuse ordering). `unmount()` removes everything the mount created but keeps the container.
- Before diffing, the tree is flattened so each unit (host element, text, placeholder) maps to exactly one DOM node. Components are called during flattening — they hold no state; only their DOM output is diffed.
- Falsy children (`{cond && <x/>}`) become comment placeholders so positional diffing keeps siblings aligned across renders.
- Child matching: by `key` when present, otherwise by position. A keyless unit can only consume an unkeyed old entry, so it cannot hijack a keyed node. Duplicate keys warn (once per parent per key).
- Events: `onClick` → `click` (suffix lowercased); `onDoubleClick` → `dblclick`. Listeners are keyed by DOM event type, so `onClick` and `onclick` share a slot (last wins) instead of both firing. Changing the function rebinds the listener.
- `dangerouslySetInnerHTML` is ignored by mount (warns once); it is SSR-only.
- Each warning fires at most once per node so static warnings do not repeat every render.
- The DOM is touched only through the minimal structural interfaces `DomNode`/`DomText`/`DomElement`/`DomDocument` — the file typechecks without the DOM lib, and tests run mount against a fake DOM under Bun. Real browser nodes satisfy the interfaces structurally.

## Known ceilings

- The global `JSX` namespace (`jsx.d.ts`) is deliberately permissive: any tag accepts any props bag and any children; typechecking will not catch a wrong attribute name. Tightening is deferred until the webui consumes it (TODO in that file).
- `MAX_RENDER_DEPTH` bounds tree depth, not sibling count.
- `data:` URLs are dropped on `<picture><source>` and `<input type="image">` (only `<img>` is excepted).
- Style object numbers get no unit (`width: 10` → `width:10`, not `10px`).
- SSR counts `[false]` (array of only-falsy entries) as children for the void-element / raw-HTML checks.

## Tests

`tests/utils/jsx/` — `element.test.ts` (factory + Fragment identity), `render.test.tsx` (real JSX through the Bun transform: escaping, URL scheme sanitization, boolean attrs, void warnings), `mount.test.tsx` (diffing against a hand-rolled fake DOM; no `mock.module`, per project rules).
