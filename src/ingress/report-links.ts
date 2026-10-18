import { clip } from "../observability/redact";

/** A link offered as a Discord link button. */
export interface ReportLink {
  label: string;
  url: string;
}

/** Reports offer at most three links (Discord allows 5 buttons per row). */
const LINKS_MAX = 3;
/** Discord caps a button label at 80 chars. */
const LINK_LABEL_MAX = 80;

/** Discord rejects the whole message when a link button URL is over 512 chars. */
const LINK_URL_MAX = 512;

/** Normalized absolute http(s) URL of at most 512 chars, or undefined (local paths, `file:`, relative, `javascript:`, ...). */
function safeUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    const ok = u.protocol === "http:" || u.protocol === "https:";
    return ok && u.href.length <= LINK_URL_MAX ? u.href : undefined;
  } catch {
    return undefined; // relative paths and bare text do not parse as absolute URLs
  }
}

/** Keep only safe absolute links (deduped by URL, max three); a blank label falls back to the host. */
export function safeLinks(links: ReportLink[]): ReportLink[] {
  const out: ReportLink[] = [];
  for (const link of links) {
    const url = safeUrl(link.url.trim());
    if (!url || out.some((l) => l.url === url)) continue;
    const label = clip(link.label.trim() || new URL(url).host, LINK_LABEL_MAX);
    out.push({ label, url });
    if (out.length === LINKS_MAX) break;
  }
  return out;
}

/** Safe `[label](url)` links found in Markdown text; code is not special-cased (a link in a fence is still a link). */
export function markdownLinks(markdown: string): ReportLink[] {
  const found = [...markdown.matchAll(/(!?)\[([^\]\n]+)\]\((\S+?)\)/g)]
    .filter((m) => !m[1]) // `![alt](url)` is an image, not a link
    .map((m) => ({ label: m[2]!, url: m[3]! }));
  return safeLinks(found);
}
