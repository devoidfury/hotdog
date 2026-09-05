/** Global JSX namespace so `.tsx`/`.jsx` files typecheck under `jsx: "react-jsx"` with `jsxImportSource: "@utils/jsx"`.
 *
 * Deliberately permissive: every host tag accepts an open prop bag and any children type.
 * 
 * TODO: clean this up (per-tag attribute types, `ComponentProps` instead of `unknown`)
 *       once the webui is reworked as a consumer and we know which tags/props actually need checking.
 */
import type { JsxChild } from "./core.ts";

declare global {
  namespace JSX {
    // Same union core uses for anything renderable; recursive since JsxChild is.
    type Element = JsxChild;

    interface IntrinsicAttributes {
      key?: string | number;
    }

    interface IntrinsicElements {
      [elemName: string]: { [prop: string]: unknown };
    }
  }
}

export {};
