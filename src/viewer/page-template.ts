import { CSS } from "./page-styles";

/** Escape text for an HTML text node or a quoted attribute. */
export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** One entry of the table of contents of a document. */
export interface TocEntry {
  level: number;
  id: string;
  /** Already escaped HTML text of the heading. */
  html: string;
}

/** Table of contents (h1-h3 with an anchor) as a nested-by-indent list; empty string when there are fewer than 2 entries. */
function tocHtml(toc: TocEntry[]): string {
  const items = toc.filter((t) => t.level <= 3 && t.id);
  if (items.length < 2) return "";
  const lis = items
    .map(
      (t) =>
        `<li style="margin-left:${(t.level - 1) * 12}px"><a href="#${esc(t.id)}">${t.html}</a></li>`,
    )
    .join("");
  return `<nav aria-label="Contents"><ul>${lis}</ul></nav>`;
}

/** A full HTML page: `body` is ready (already escaped / rendered) HTML. `toc` is shown above it when given. */
export function pageHtml(title: string, body: string, toc: TocEntry[] = []): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>${tocHtml(toc)}${body}</main></body></html>`;
}

/** Wrapper page of an html artifact: the artifact runs in a sandboxed iframe (scripts yes, same origin NO) from `srcdoc`. */
export function framePage(title: string, innerDoc: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="bar">&nbsp;${esc(title)}</div>
<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${esc(innerDoc)}"></iframe></body></html>`;
}
