import type { ArtifactKind } from "../artifacts/artifact-kinds";
import { FRAME_LINK_SCRIPT } from "./frame-link-script";
import { markdownToHtml } from "./markdown-render";
import { docPage } from "./page-doc-layout";
import { DOC_SCRIPT_CSP_SOURCE } from "./page-doc-script";
import { esc, framePage, pageHtml } from "./page-template";

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

/** Policy of a markdown page: static policy plus its one script, allowed by hash only (no `unsafe-inline`). */
const DOC_CSP = `${STATIC_CSP}; script-src ${DOC_SCRIPT_CSP_SOURCE}`;

/**
 * Policy of the html wrapper page. A `srcdoc` frame INHERITS the embedder's policy, so the wrapper must allow the inner
 * script and style too; the wrapper itself has no script and puts the artifact only in an escaped attribute.
 */
const FRAME_CSP = `${INNER_CSP}; frame-src 'self'; frame-ancestors 'none'`;

/** Render one artifact by its kind: md -> documentation page (outline sidebar), html -> sandboxed frame, diff/csv/txt -> escaped `<pre>`. */
export function renderArtifact(kind: ArtifactKind, title: string, text: string): Rendered {
  if (kind === "md") {
    const { html, toc } = markdownToHtml(text);
    return { html: docPage(title, kind, html, toc), csp: DOC_CSP };
  }
  if (kind === "html") {
    const inner = `<meta http-equiv="Content-Security-Policy" content="${esc(INNER_CSP)}">${FRAME_LINK_SCRIPT}${text}`;
    return { html: framePage(title, inner), csp: FRAME_CSP };
  }
  return {
    html: pageHtml(title, `<h1>${esc(title)}</h1><pre>${esc(text)}</pre>`),
    csp: STATIC_CSP,
  };
}
