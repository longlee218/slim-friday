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

/** A plain full HTML page (text kinds): `body` is ready (already escaped) HTML, no script. */
export function pageHtml(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>${body}</main></body></html>`;
}

/**
 * Wrapper page of an html artifact: the artifact runs in a sandboxed iframe (scripts yes, same origin NO) from `srcdoc`.
 * `allow-popups` + `allow-popups-to-escape-sandbox` only let an external link open in a new tab (the frame script sets
 * `target=_blank`); the new tab is a normal page, never the sandboxed artifact. No `allow-same-origin`, no top navigation.
 */
export function framePage(title: string, innerDoc: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="bar">&nbsp;${esc(title)}</div>
<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" srcdoc="${esc(innerDoc)}"></iframe></body></html>`;
}
