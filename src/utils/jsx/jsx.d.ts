/** Global JSX namespace so `.tsx`/`.jsx` files typecheck under `jsx: "react-jsx"` with `jsxImportSource: "@utils/jsx"`.
 *
 * Deliberately permissive: every host tag accepts an open prop bag and any children type.
 * 
 * TODO: per-tag attribute types, `ComponentProps` instead of `unknown` (the webui is the
 *       consumer now; only `ref` is typed precisely, so ref callbacks contextualize).
 */
import type { JsxChild } from "./core.ts";
import type { Ref } from "./client.ts";

declare global {
  namespace JSX {
    // Same union core uses for anything renderable; recursive since JsxChild is.
    type Element = JsxChild;

    interface IntrinsicAttributes {
      key?: string | number;
    }

    interface IntrinsicElements {
      // `ref` gets a real type so ref callbacks contextualize to
      // (el: DomElement | null); everything else stays open.
      [elemName: string]: { [prop: string]: unknown; ref?: Ref };
    }
  }
}

export {};
