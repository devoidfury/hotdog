// Tests for src/utils/jsx -- element model and factory behavior.

import { describe, it, expect } from "bun:test";
import {
  createNode,
  Fragment,
  jsx,
  jsxs,
} from "@utils/jsx/index.ts";
import {
  Fragment as FragmentDev,
  jsxDEV,
} from "@utils/jsx/jsx-dev-runtime.ts";
import { Fragment as FragmentProd } from "@utils/jsx/jsx-runtime.ts";

describe("createNode", () => {
  it("builds a node with type, props, and key", () => {
    expect(createNode("div", { id: "x" }, "k")).toEqual({
      type: "div",
      props: { id: "x" },
      key: "k",
    });
  });

  it("defaults props to {} and key to null", () => {
    expect(createNode("div")).toEqual({ type: "div", props: {}, key: null });
  });

  it("accepts a component function as type", () => {
    const C = () => null;
    const node = createNode(C, { a: 1 });
    expect(node.type).toBe(C);
  });
});

describe("jsx / jsxs / jsxDEV", () => {
  it("jsx delegates to createNode", () => {
    expect(jsx("p", { className: "c" }, 1)).toEqual({
      type: "p",
      props: { className: "c" },
      key: 1,
    });
  });

  it("jsxs handles a children array", () => {
    const node = jsxs("div", { children: ["a", "b"] });
    expect(node.props.children).toEqual(["a", "b"]);
  });

  it("jsxDEV ignores the dev-only trailing args", () => {
    const node = jsxDEV("span", { x: 2 }, "key", true, { line: 1 }, null);
    expect(node).toEqual({ type: "span", props: { x: 2 }, key: "key" });
  });

  it("null props become an empty object", () => {
    expect(jsx("i", null)).toEqual({ type: "i", props: {}, key: null });
  });
});

describe("Fragment", () => {
  it("is a stable global symbol shared across entrypoints", () => {
    // Symbol.for resolves to the same id independently of module instance.
    expect(FragmentProd).toBe(FragmentDev);
    expect(String(Fragment)).toBe("Symbol(hotdog.jsx.Fragment)");
  });
});
