/** Production JSX runtime entrypoint. The automatic JSX transform uses fixed path `<jsxImportSource>/jsx-runtime` so this file must exist. */
import { createNode, Fragment, type ComponentProps, type JsxNode } from "./core.ts";

export { Fragment };

export function jsx(
  type: JsxNode["type"],
  props: ComponentProps | null,
  key?: string | number | null,
): JsxNode {
  return createNode(type, props, key);
}

export function jsxs(
  type: JsxNode["type"],
  props: ComponentProps | null,
  key?: string | number | null,
): JsxNode {
  return createNode(type, props, key);
}
