/** Inject markdown markers for a heading. */
function heading(el: Element, level: number): void {
  const prefix = "\n" + "#".repeat(level) + " ";
  el.before(prefix, { html: true } as Parameters<Element["before"]>[0]);
  el.after("\n");
}

/** Inject markdown markers for an inline element. */
function inline(el: Element, open: string, close: string): void {
  if (open) el.before(open);
  if (close) el.after(close);
}

function replaceWith(el: Element, replacement: string): void {
  el.remove();
  el.after(replacement);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

/**
 * Convert an HTML string to simplified GitHub Flavored Markdown.
 */
export function htmlToMarkdown(html: string): string {
  if (!html || typeof html !== "string") return "";

  // Shared mutable state for tracking context across handlers.
  const ctx: { inPre: boolean; olCount: number[] } = {
    inPre: false, // inside a <pre> block
    olCount: [], // per-<ol> item counter stack
  };

  // insert markdown syntax around html nodes
  const addMarkdownRewrite = new HTMLRewriter()
    .on("h1", { element: (el) => heading(el, 1) })
    .on("h2", { element: (el) => heading(el, 2) })
    .on("h3", { element: (el) => heading(el, 3) })
    .on("h4", { element: (el) => heading(el, 4) })
    .on("h5", { element: (el) => heading(el, 5) })
    .on("h6", { element: (el) => heading(el, 6) })

    .on("section, article, p", { element: (el) => inline(el, "\n", "\n") })
    .on("br", { element: (el) => replaceWith(el, "\n") })
    .on("hr", { element: (el) => replaceWith(el, "\n---\n") })

    .on("strong, b", { element: (el) => inline(el, "**", "**") })
    .on("em, i", { element: (el) => inline(el, "*", "*") })
    .on("del, s", { element: (el) => inline(el, "~~", "~~") })
    .on("code", {
      element: (el) => {
        // Skip backticks for <code> inside <pre> (handled by <pre>).
        if (!ctx.inPre) {
          inline(el, "`", "`");
        }
      },
    })

    .on("a", {
      element: (el) => {
        inline(el, "[", `](${el.getAttribute("href")})`);
      },
    })

    .on("img", {
      element: (el) => {
        const src = el.getAttribute("src") || "";
        const alt = (el.getAttribute("alt") || "").replace(/"/g, '\\"');
        el.remove();
        el.after(`![${alt}](${src})`, { html: true } as Parameters<Element["after"]>[0]);
      },
    })

    .on("ul", { element: (el) => inline(el, "\n", "\n") })
    .on("ol", {
      element: (el) => {
        inline(el, "\n", "\n");
        ctx.olCount.push(0);
        el.onEndTag(() => {
          ctx.olCount.pop();
        });
      },
    })
    .on("li", {
      element: (el) => {
        const isOl = ctx.olCount.length > 0;
        if (isOl) {
          ctx.olCount[ctx.olCount.length - 1]++;
          el.before(`\n${ctx.olCount[ctx.olCount.length - 1]}. `);
        } else {
          el.before("\n- ");
        }
      },
    })

    .on("blockquote", {
      element: (el) => {
        el.before("\n> ", { html: true } as Parameters<Element["before"]>[0]);
        el.after("\n");
      },
    })

    .on("pre", {
      element: (el) => {
        ctx.inPre = true;
        el.before("\n```\n", { html: true } as Parameters<Element["before"]>[0]);
        el.after("\n```\n", { html: true } as Parameters<Element["after"]>[0]);
        el.onEndTag(() => {
          ctx.inPre = false;
        });
      },
    })

    .on("table", { element: (el) => inline(el, "\n", "\n") })
    .on("tr", { element: (el) => inline(el, "\n", "|") })
    .on("th, td", { element: (el) => inline(el, "| ") })

    .on("head, script, style, meta, iframe, link, title, svg", {
      element: (el) => el.remove(),
    });

  const stripHtmlRewrite = new HTMLRewriter().on("*", {
    element: (el) => el.removeAndKeepContent(),
  });

  const markdown = stripHtmlRewrite.transform(
    addMarkdownRewrite.transform(html),
  );

  return decodeEntities(markdown)
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/^<!DOCTYPE[^>]*>/i, "")
    .trim();
}
