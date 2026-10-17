import type { ArtifactKind } from "../artifacts/artifact-kinds";
import { esc, framePage, pageHtml, type TocEntry } from "./page-template";

/** A rendered artifact page and the Content-Security-Policy its response must carry. */
export interface Rendered {
  html: string;
  csp: string;
}

/**
 * Policy of the html artifact's own document (inner, a `<meta>` first in `srcdoc`): its inline script and style run,
 * nothing leaves (no connect-src, fonts, frames, forms, base; images only inline `data:`).
 */
const INNER_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/** Policy of the static pages (md, text kinds): no script at all. */
const STATIC_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Policy of the html wrapper page. A `srcdoc` frame INHERITS the embedder's policy, so the wrapper must allow the inner
 * script and style too; the wrapper itself has no script and puts the artifact only in an escaped attribute.
 */
const FRAME_CSP = `${INNER_CSP}; frame-src 'self'; frame-ancestors 'none'`;

/** `href` that is safe to follow: http(s), mailto or an in-page anchor; anything else (javascript:, data:) is dropped. */
function safeHref(raw: string): string | undefined {
  if (raw.startsWith("#")) return raw;
  try {
    const p = new URL(raw).protocol;
    return p === "http:" || p === "https:" || p === "mailto:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Plain tag wrapper for the callbacks below. */
const tag = (name: string, inner: string, attrs = ""): string =>
  `<${name}${attrs}>${inner}</${name}>\n`;

/** `style` for a table cell alignment (a closed list, never the raw value). */
const alignStyle = (a?: string): string =>
  a === "left" || a === "center" || a === "right" ? ` style="text-align:${a}"` : "";

/**
 * Markdown to HTML with Bun's built-in renderer and a callback for EVERY node, so nothing passes through raw: every
 * text node (inline HTML tags arrive as text) and every raw HTML block is escaped, links keep http(s)/mailto/anchor
 * only, images only inline `data:image/`. Returns the HTML and the headings for the table of contents.
 */
export function markdownToHtml(md: string): { html: string; toc: TocEntry[] } {
  const toc: TocEntry[] = [];
  const html = Bun.markdown.render(
    md,
    {
      heading: (c, m) => {
        const id = String(m?.id ?? "");
        const level = Number(m?.level ?? 1);
        toc.push({ level, id, html: c.replace(/<[^>]*>/g, "") });
        return tag(`h${level}`, c, id ? ` id="${esc(id)}"` : "");
      },
      paragraph: (c) => tag("p", c),
      blockquote: (c) => tag("blockquote", c),
      code: (c, m) =>
        tag(
          "pre",
          `<code>${c}</code>`,
          m?.language ? ` data-lang="${esc(String(m.language))}"` : "",
        ),
      list: (c, m) =>
        m?.ordered
          ? tag("ol", c, m.start && m.start !== 1 ? ` start="${Number(m.start)}"` : "")
          : tag("ul", c),
      listItem: (c, m) =>
        tag("li", `${m?.checked === undefined ? "" : m.checked ? "&#9745; " : "&#9744; "}${c}`),
      hr: () => "<hr>\n",
      table: (c) => tag("table", c),
      thead: (c) => tag("thead", c),
      tbody: (c) => tag("tbody", c),
      tr: (c) => tag("tr", c),
      th: (c, m) => tag("th", c, alignStyle(m?.align as string | undefined)),
      td: (c, m) => tag("td", c, alignStyle(m?.align as string | undefined)),
      strong: (c) => `<strong>${c}</strong>`,
      emphasis: (c) => `<em>${c}</em>`,
      strikethrough: (c) => `<del>${c}</del>`,
      codespan: (c) => `<code>${c}</code>`,
      link: (c, m) => {
        const href = safeHref(String(m?.href ?? ""));
        return href ? `<a href="${esc(href)}" rel="noopener noreferrer nofollow">${c}</a>` : c;
      },
      image: (c, m) => {
        const src = String(m?.src ?? "");
        return /^data:image\/(png|jpeg|gif|webp);/i.test(src)
          ? `<img src="${esc(src)}" alt="${esc(c)}">`
          : esc(c);
      },
      text: (c) => esc(c),
      html: (c) => tag("pre", c), // a raw HTML block: its children are text nodes (escaped above), shown, never parsed
    },
    { headings: true },
  );
  return { html, toc };
}

/** Render one artifact by its kind: md -> HTML page with a TOC, html -> sandboxed frame, diff/csv/txt -> escaped `<pre>`. */
export function renderArtifact(kind: ArtifactKind, title: string, text: string): Rendered {
  if (kind === "md") {
    const { html, toc } = markdownToHtml(text);
    return { html: pageHtml(title, html, toc), csp: STATIC_CSP };
  }
  if (kind === "html") {
    const inner = `<meta http-equiv="Content-Security-Policy" content="${esc(INNER_CSP)}">${text}`;
    return { html: framePage(title, inner), csp: FRAME_CSP };
  }
  return {
    html: pageHtml(title, `<h1>${esc(title)}</h1><pre>${esc(text)}</pre>`),
    csp: STATIC_CSP,
  };
}
