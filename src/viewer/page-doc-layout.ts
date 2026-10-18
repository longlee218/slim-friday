import { DOC_SCRIPT } from "./page-doc-script";
import { DOC_CSS } from "./page-doc-styles";
import { CSS } from "./page-styles";
import { esc, type TocEntry } from "./page-template";

/** Sidebar outline: h1-h3 as links to their ids, indented by level (`l1`..`l3`); empty when under 2 entries. */
function outline(toc: TocEntry[]): string {
  const items = toc.filter((t) => t.level <= 3 && t.id);
  if (items.length < 2) return "";
  const lis = items
    .map((t) => `<li class="l${t.level}"><a href="#${esc(t.id)}">${t.html}</a></li>`)
    .join("");
  return `<aside id="side"><nav aria-label="Contents"><p class="label">On this page</p><ul>${lis}</ul></nav></aside>`;
}

/**
 * Documentation-style page of a markdown artifact: top bar (menu button, title, kind), sticky outline sidebar (a drawer
 * on phones), reading-width content, back-to-top. `body` is the rendered (escaped) markdown; the only script is the
 * static `DOC_SCRIPT`, so nothing of the artifact reaches executable text.
 */
export function docPage(title: string, kind: string, body: string, toc: TocEntry[]): string {
  const side = outline(toc);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}${DOC_CSS}</style></head>
<body><header class="topbar"><button id="menu" type="button" aria-label="Contents">&#9776;</button>
<span class="name">${esc(title)}</span><span class="badge">${esc(kind)}</span></header>
<div id="veil"></div>
<div class="layout${side ? "" : " solo"}">${side}<main>${body}</main></div>
<button id="top" type="button" aria-label="Back to top">&#8593;</button>
<script>${DOC_SCRIPT}</script></body></html>`;
}
