// Render-to-HTML tests that write real JSX syntax, so they exercise Bun's
// compile step (jsxImportSource -> our jsx-dev-runtime) end to end, not just
// hand-built nodes.

import { describe, it, expect, spyOn } from "bun:test";
import {
  renderToString,
  createNode,
  Fragment,
} from "../../../src/utils/jsx/index.ts";

function Greeting(props: { name: string }) {
  return <span className="g">{props.name}</span>;
}

describe("renderToString (real JSX)", () => {
  it("renders a host element with text", () => {
    expect(renderToString(<div>hi</div>)).toBe("<div>hi</div>");
  });

  it("renames className/htmlFor and emits other attributes", () => {
    expect(renderToString(<a className="link" href="/x">Go</a>)).toBe(
      '<a class="link" href="/x">Go</a>',
    );
    expect(renderToString(<label htmlFor="id">L</label>)).toBe(
      '<label for="id">L</label>',
    );
  });

  it("omits null, undefined, false, and function props", () => {
    expect(
      renderToString(
        <div id={null} data-x={undefined} hidden={false} onClick={() => {}}>
          x
        </div>,
      ),
    ).toBe("<div>x</div>");
  });

  it("renders boolean true as a bare name", () => {
    expect(renderToString(<input type="text" disabled />)).toBe(
      '<input type="text" disabled>',
    );
  });

  it("renders void elements without a closing tag", () => {
    expect(renderToString(<img src="/a.png" />)).toBe('<img src="/a.png">');
    expect(renderToString(<br />)).toBe("<br>");
  });

  it("escapes text and attribute values", () => {
    expect(renderToString(<div title={'a "b" <c>'}>x & y</div>)).toBe(
      '<div title="a &#34;b&#34; &lt;c&gt;">x &amp; y</div>',
    );
  });

  it("renders components and passes children through props", () => {
    expect(renderToString(<Greeting name="world" />)).toBe(
      '<span class="g">world</span>',
    );
    expect(
      renderToString(
        <button onClick={() => {}}>
          tap
        </button>,
      ),
    ).toBe("<button>tap</button>");
  });

  it("renders lists from map, keyed or not", () => {
    expect(
      renderToString(<ul>{["a", "b"].map((x) => <li key={x}>{x}</li>)}</ul>),
    ).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("flattens nested arrays of children", () => {
    expect(
      renderToString(<div>{[["a"], ["b", <b>c</b>]]}</div>),
    ).toBe("<div>ab<b>c</b></div>");
  });

  it("renders a component returning an array", () => {
    const List = () => ["x", 1, null, [["deep"]]];
    expect(renderToString(createNode(List, {}))).toBe("x1deep");
  });

  it("flattens fragments (shorthand and explicit)", () => {
    expect(renderToString(<><p>1</p><p>2</p></>)).toBe("<p>1</p><p>2</p>");
    expect(renderToString(<Fragment><p>a</p></Fragment>)).toBe("<p>a</p>");
  });

  it("drops falsy children", () => {
    expect(
      renderToString(
        <div>
          {false && <p>no</p>}
          {null}
          {undefined}
          <b>yes</b>
        </div>,
      ),
    ).toBe("<div><b>yes</b></div>");
  });

  it("serializes style objects to CSS", () => {
    expect(
      renderToString(
        <div style={{ color: "red", marginTop: "4px", display: "none" }}>
          s
        </div>,
      ),
    ).toBe('<div style="color:red;margin-top:4px;display:none">s</div>');
  });

  it("serializes style objects under case-variant prop names", () => {
    // Browsers normalize attribute names, so a spread's `STYLE` lands as the style attribute.
    expect(renderToString(createNode("div", { STYLE: { backgroundColor: "red" } }))).toBe(
      '<div STYLE="background-color:red"></div>',
    );
  });

  it("emits dangerouslySetInnerHTML raw", () => {
    expect(
      renderToString(
        createNode("div", { dangerouslySetInnerHTML: { __html: "<b>raw</b>" } }),
      ),
    ).toBe("<div><b>raw</b></div>");
  });

  it("throws when dangerouslySetInnerHTML and children are both set", () => {
    // React parity: ambiguous which content wins, so fail loudly.
    expect(() =>
      renderToString(
        <div dangerouslySetInnerHTML={{ __html: "<b>raw</b>" }}>
          ignored
        </div>,
      ),
    ).toThrow("Can only set one of `children` or `props.dangerouslySetInnerHTML`");
  });

  it("does not throw when dangerouslySetInnerHTML is paired with renders-nothing children", () => {
    // {false}, {null} and [] render nothing, so they are not "both set".
    expect(
      renderToString(
        <div dangerouslySetInnerHTML={{ __html: "<b>r</b>" }}>{false}</div>,
      ),
    ).toBe("<div><b>r</b></div>");
    expect(
      renderToString(
        <div dangerouslySetInnerHTML={{ __html: "<b>r</b>" }}>{null}</div>,
      ),
    ).toBe("<div><b>r</b></div>");
    expect(
      renderToString(
        createNode("div", { dangerouslySetInnerHTML: { __html: "<b>r</b>" }, children: [] }),
      ),
    ).toBe("<div><b>r</b></div>");
  });

  it("drops on* attribute names, including string values from spreads", () => {
    // A string under an `on*` key would execute in a served document.
    expect(
      renderToString(
        createNode("div", {
          onclick: "fetch('//evil')",
          ONCLICK: "alert(2)",
          onClick: "alert(3)",
          "data-onclick": "fine",
        }),
      ),
    ).toBe('<div data-onclick="fine"></div>');
  });

  it("does not render key from props as an attribute", () => {
    // The transform hoists key out of props; hand-built nodes must not leak it.
    expect(renderToString(createNode("div", { key: "x", id: "keep" }))).toBe(
      '<div id="keep"></div>',
    );
  });

  it("drops invalid attribute names from spread props (no tag breakout)", () => {
    // Keys like `x>` would close the tag early and inject raw markup.
    expect(
      renderToString(
        createNode("div", {
          ["x>"]: "evil",
          ["onmouseover=alert(1)"]: "",
          ["data-ok"]: "yes",
          ["aria-label"]: "fine",
        }),
      ),
    ).toBe('<div data-ok="yes" aria-label="fine"></div>');
  });

  it("drops invalid tag names (no attribute injection via type)", () => {
    // A dynamic type like "img src=x onerror=..." would inject attributes
    // straight through the tag itself.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(renderToString(createNode("img src=x onerror=alert(1)"))).toBe("");
    expect(renderToString(createNode("div><b>"))).toBe("");
    expect(renderToString(createNode(""))).toBe("");
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]?.[0]).toContain("dropped invalid tag name");
    warn.mockRestore();
  });

  it("allows custom-element and hyphenated tag names", () => {
    expect(renderToString(createNode("my-widget-2", { a: "1" }))).toBe(
      '<my-widget-2 a="1"></my-widget-2>',
    );
  });

  it("emits nothing for dangerouslySetInnerHTML with null/undefined __html", () => {
    expect(
      renderToString(
        createNode("div", { dangerouslySetInnerHTML: { __html: undefined } }),
      ),
    ).toBe("<div></div>");
    expect(
      renderToString(createNode("div", { dangerouslySetInnerHTML: { __html: null } })),
    ).toBe("<div></div>");
  });

  it("omits style entries with null or false values", () => {
    expect(
      renderToString(<div style={{ color: null, width: 10, opacity: false }} />),
    ).toBe('<div style="width:10"></div>');
  });

  it("throws a named error on invalid children instead of crashing in renderAttrs", () => {
    expect(() => renderToString((() => "x") as never)).toThrow(
      "Invalid JSX child of type function",
    );
    expect(() => renderToString(Symbol("s") as never)).toThrow(
      "Invalid JSX child of type symbol",
    );
    expect(() => renderToString({} as never)).toThrow(
      "Invalid JSX child of type object",
    );
    // Malformed hand-built nodes must not render <undefined></undefined>.
    expect(() => renderToString({ type: undefined } as never)).toThrow(
      "Invalid JSX child",
    );
    // Reached through a real JSX subtree, not just a bare call.
    expect(() => renderToString(<div>{() => "x"}</div>)).toThrow(
      "Invalid JSX child of type function",
    );
  });

  it("renders empty elements and numeric children", () => {
    expect(renderToString(<div />)).toBe("<div></div>");
    expect(renderToString(<span>{42}</span>)).toBe("<span>42</span>");
  });

  it("throws on runaway component recursion instead of hanging", () => {
    // Tail-call recursion does not overflow the stack in JSC/ESM, so without
    // the depth guard these loop forever instead of erroring.
    const Self: any = () => createNode(Self, {});
    expect(() => renderToString(createNode(Self, {}))).toThrow(
      "Maximum JSX render depth exceeded",
    );
    // Mutual recursion through a host element (a non-tail leg per cycle).
    const A: any = () => <div>{createNode(B, {})}</div>;
    const B: any = () => createNode(A, {});
    expect(() => renderToString(createNode(A, {}))).toThrow(
      "Maximum JSX render depth exceeded",
    );
  });

  it("allows deep-but-legal recursion under the depth limit", () => {
    const Nest: any = (props: { n: number }) =>
      props.n > 0 ? createNode(Nest, { n: props.n - 1 }) : "leaf";
    expect(renderToString(createNode(Nest, { n: 900 }))).toBe("leaf");
  });
});

describe("url scheme sanitization", () => {
  it("drops javascript: urls, including mixed case and control-char obfuscation", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(renderToString(<a href="javascript:alert(1)">x</a>)).toBe("<a>x</a>");
    expect(renderToString(<a href="JaVaScRiPt:alert(1)">x</a>)).toBe("<a>x</a>");
    // Browsers strip whitespace/control chars when parsing URLs, so these are live.
    expect(renderToString(<a href={"jav\tascript:alert(1)"}>x</a>)).toBe("<a>x</a>");
    expect(renderToString(<a href={"  javascript:alert(1)"}>x</a>)).toBe("<a>x</a>");
    expect(renderToString(<img src="data:text/html,<script>alert(1)</script>" />)).toBe(
      "<img>",
    );
    // An object whose toString() yields a dangerous scheme is caught too.
    expect(
      renderToString(createNode("a", { href: { toString: () => "javascript:alert(1)" } })),
    ).toBe("<a></a>");
    expect(warn).toHaveBeenCalledTimes(6);
    expect(warn.mock.calls[0]?.[0]).toContain("dropped unsafe url in href");
    warn.mockRestore();
  });

  it("drops unsafe urls under case-variant attribute names", () => {
    // HTML attribute names are ASCII case-insensitive: an untrusted spread's
    // `HREF` is a live href to the browser, so the guard must match case-insensitively.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(renderToString(createNode("a", { HREF: "javascript:alert(1)" }))).toBe("<a></a>");
    expect(renderToString(createNode("img", { Src: "data:text/html,<script>" }))).toBe("<img>");
    // Safe values under odd casings still render (guard match is case-insensitive, output keeps the given case).
    expect(renderToString(createNode("a", { HREF: "/docs" }))).toBe('<a HREF="/docs"></a>');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain("dropped unsafe url in HREF");
    warn.mockRestore();
  });

  it("allows data:image urls on <img> only", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(renderToString(<img src="data:image/png;base64,AAAA" />)).toBe(
      '<img src="data:image/png;base64,AAAA">',
    );
    // HTML parsers lowercase tag names, so <IMG> renders as a lowercase void <img>.
    expect(renderToString(createNode("IMG", { src: "data:image/gif;base64,R0lGOD" }))).toBe(
      '<img src="data:image/gif;base64,R0lGOD">',
    );
    // Off-<img> the same url is a live-document vector (iframe/embed src);
    // non-image data: stays blocked on <img> too.
    expect(renderToString(<iframe src="data:image/svg+xml,<svg/>" />)).toBe("<iframe></iframe>");
    expect(renderToString(<a href="data:image/png;base64,AAAA">x</a>)).toBe("<a>x</a>");
    expect(renderToString(<img src="data:text/html,x" />)).toBe("<img>");
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("allows relative, protocol-relative, fragment, and safe-scheme urls", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(renderToString(<a href="/docs">x</a>)).toBe('<a href="/docs">x</a>');
    expect(renderToString(<a href="page.html#a">x</a>)).toBe('<a href="page.html#a">x</a>');
    expect(renderToString(<a href="#top">x</a>)).toBe('<a href="#top">x</a>');
    expect(renderToString(<img src="//cdn.example.com/a.png" />)).toBe(
      '<img src="//cdn.example.com/a.png">',
    );
    expect(renderToString(<a href="https://ok.example/x?a=b">x</a>)).toBe(
      '<a href="https://ok.example/x?a=b">x</a>',
    );
    expect(renderToString(<a href="HTTP://ok.example">x</a>)).toBe(
      '<a href="HTTP://ok.example">x</a>',
    );
    expect(renderToString(<a href="mailto:a@b.c">x</a>)).toBe('<a href="mailto:a@b.c">x</a>');
    expect(renderToString(<a href="tel:+15551234567">x</a>)).toBe(
      '<a href="tel:+15551234567">x</a>',
    );
    expect(renderToString(<a href="blob:https://x/550e8400-e29b">dl</a>)).toBe(
      '<a href="blob:https://x/550e8400-e29b">dl</a>',
    );
    expect(renderToString(<img src="blob:null/fake-uuid" />)).toBe(
      '<img src="blob:null/fake-uuid">',
    );
    expect(renderToString(<a href="">x</a>)).toBe('<a href="">x</a>');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("boolean attribute rendering", () => {
  it("renders known boolean attributes as bare names, others as attr=&quot;true&quot;", () => {
    expect(renderToString(<input disabled checked readOnly={false} />)).toBe(
      "<input disabled checked>",
    );
    // React parity: non-presence attributes keep an explicit value.
    expect(renderToString(<td width={true} align="center" />)).toBe(
      '<td width="true" align="center"></td>',
    );
    // aria-* booleans must stay string-valued, not presence-only.
    expect(renderToString(<div aria-hidden={true} />)).toBe('<div aria-hidden="true"></div>');
  });
});

describe("void element warnings", () => {
  it("warns when children or dangerouslySetInnerHTML are dropped", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(renderToString(<br>x</br>)).toBe("<br>");
    expect(
      renderToString(createNode("input", { children: "swallowed" })),
    ).toBe("<input>");
    expect(
      renderToString(createNode("br", { dangerouslySetInnerHTML: { __html: "<b>x</b>" } })),
    ).toBe("<br>");
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]?.[0]).toContain("<br> is a void element");
    // Plain void elements stay quiet.
    warn.mockClear();
    expect(renderToString(<img src="/a.png" />)).toBe('<img src="/a.png">');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stays quiet for renders-nothing children on void elements", () => {
    // {false}/{null}/[] never render, so dropping them is not worth a warning.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(renderToString(<br>{false}</br>)).toBe("<br>");
    expect(renderToString(<br>{null}</br>)).toBe("<br>");
    expect(renderToString(createNode("br", { children: [] }))).toBe("<br>");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
