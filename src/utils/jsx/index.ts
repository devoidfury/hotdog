/**
 * Public entry for the hotdog JSX runtime. Import the render helper and types from here (e.g. `import { renderToString } from "@utils/jsx"`).
 * The `jsx-runtime`/`jsx-dev-runtime` files are Bun's transform entrypoints and are not meant to be imported directly by application code.
 */
export { Fragment, createNode, renderToString } from "./core.ts";
export { jsx, jsxs } from "./jsx-runtime.ts";
export { mount } from "./client.ts";
export type { Mounted, DomDocument, DomElement, DomNode, DomText, Ref } from "./client.ts";
export type { Component, ComponentProps, JsxChild, JsxNode } from "./core.ts";
