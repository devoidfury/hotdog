/** Dev-mode JSX runtime entrypoint -- `jsxDEV`. The path `<jsxImportSource>/jsx-dev-runtime` is fixed by the transform so this file must exist. */
import { createNode, Fragment, type ComponentProps, type JsxNode } from "./core.ts";

export { Fragment };

export function jsxDEV(
  type: JsxNode["type"],
  props: ComponentProps | null,
  key?: string | number | null,
  _isStaticChildren?: boolean,
  _source?: unknown,
  _self?: unknown,
): JsxNode {
  return createNode(type, props, key);
}
