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

/** Light and dark theme through `prefers-color-scheme`; the only styles of the viewer (no script anywhere). */
const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--mute:#656d76;--line:#d0d7de;--code:#f6f8fa}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mute:#8d96a0;--line:#30363d;--code:#161b22}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}
h1,h2,h3,h4{line-height:1.25}h2{border-bottom:1px solid var(--line);padding-bottom:.2em}
a{color:#0969da}pre,code{background:var(--code);border-radius:6px;font:14px ui-monospace,monospace}
pre{padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word}code{padding:.1em .3em}pre code{padding:0}
blockquote{margin:0;padding-left:1em;border-left:4px solid var(--line);color:var(--mute)}
table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid var(--line);padding:4px 10px}
img{max-width:100%}nav{border:1px solid var(--line);border-radius:6px;padding:4px 16px;margin-bottom:16px}
nav ul{list-style:none;padding-left:1em}nav>ul{padding-left:0}.bar{color:var(--mute);font-size:14px}
iframe{border:0;width:100%;height:calc(100vh - 40px)}
`;

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
