import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { StateCore, Token } from "markdown-it";
import MarkdownIt from "markdown-it";
import { esc, type TocEntry } from "./page-template";

/** The small language set that is highlighted (server side); an unknown fence language stays plain escaped text. */
const LANGUAGES = {
  bash,
  diff,
  dockerfile,
  go,
  ini,
  javascript,
  json,
  markdown,
  python,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def);
// Common fence names that are not the registered ids.
for (const [alias, name] of Object.entries({
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  js: "javascript",
  ts: "typescript",
  py: "python",
  yml: "yaml",
  html: "xml",
  toml: "ini",
  md: "markdown",
  docker: "dockerfile",
}))
  hljs.registerAliases(alias, { languageName: name });

/** `href` that is safe to follow: http(s), mailto or an in-page anchor; anything else is dropped. */
function safeHref(raw: string): boolean {
  if (raw.startsWith("#")) return true;
  try {
    const p = new URL(raw).protocol;
    return p === "http:" || p === "https:" || p === "mailto:";
  } catch {
    return false;
  }
}

/** Only inline raster `data:` images are rendered; everything else (remote, svg) is blocked by CSP anyway. */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);/i;

/** URL-safe, ASCII id of a heading ("Lộ trình 1" -> "lo-trinh-1"); diacritics and `đ` folded, empty falls back to "section". */
function slugify(text: string): string {
  const s = text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "section";
}

/** Fenced code: server-side highlight.js for a known language, plain escaped text otherwise (no client script). */
function highlight(code: string, lang: string): string {
  const language = lang.trim().split(/\s+/)[0] ?? "";
  if (!language || !hljs.getLanguage(language)) return "";
  try {
    const out = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    return `<pre><code class="hljs language-${esc(language)}">${out}</code></pre>`;
  } catch {
    return "";
  }
}

/** Core rule: heading ids (deduplicated) and the TOC entries (collected into `env.toc`). */
function headingIds(state: StateCore): void {
  const seen = new Map<string, number>();
  const toc: TocEntry[] = [];
  state.tokens.forEach((tok, i) => {
    if (tok.type !== "heading_open") return;
    // Plain text of the heading (markup like `**x**` dropped), from the inline children.
    const text = (state.tokens[i + 1]?.children ?? [])
      .filter((c) => c.type === "text" || c.type === "code_inline")
      .map((c) => c.content)
      .join("");
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const id = n === 0 ? base : `${base}-${n}`;
    tok.attrSet("id", id);
    toc.push({ level: Number(tok.tag.slice(1)), id, html: esc(text) });
  });
  (state.env as { toc?: TocEntry[] }).toc = toc;
}

/** Core rule: GFM task list items become a disabled checkbox (`- [ ]` / `- [x]` at the start of the item). */
function taskLists(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline?.type !== "inline" || tokens[i - 1]?.type !== "paragraph_open") continue;
    if (tokens[i - 2]?.type !== "list_item_open") continue;
    const first = inline.children?.[0];
    const m = first?.type === "text" ? /^\[([ xX])\]\s+/.exec(first.content) : null;
    if (!first || !m) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" disabled${m[1] === " " ? "" : " checked"}> `;
    inline.children?.unshift(box);
    tokens[i - 2]?.attrJoin("class", "task");
  }
}

/** Core rule: unsafe links lose their `<a>`; images other than inline `data:` become their alt text. */
function sanitizeInline(state: StateCore): void {
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    const out: Token[] = [];
    let dropClose = 0;
    for (const t of block.children) {
      if (t.type === "link_open") {
        if (safeHref(String(t.attrGet("href") ?? ""))) {
          t.attrSet("rel", "noopener noreferrer nofollow");
          dropClose = 0;
        } else {
          dropClose++;
          continue;
        }
      } else if (t.type === "link_close" && dropClose > 0) {
        dropClose--;
        continue;
      } else if (t.type === "image" && !DATA_IMAGE.test(String(t.attrGet("src") ?? ""))) {
        const alt = new state.Token("text", "", 0);
        alt.content = t.content;
        out.push(alt);
        continue;
      }
      out.push(t);
    }
    block.children = out;
  }
}

/**
 * markdown-it instance: `html: false` escapes raw HTML (blocks and inline), `linkify` turns bare URLs into links
 * (no fuzzy `file.md` domains), GFM tables and strikethrough are built in. The rules above add heading ids, task lists
 * and the link/image policy; tables get a scroll wrapper for phones.
 */
const md = new MarkdownIt({ html: false, linkify: true, highlight });
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
md.core.ruler.push("heading_ids", headingIds);
md.core.ruler.push("task_lists", taskLists);
md.core.ruler.push("sanitize_inline", sanitizeInline);
md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
md.renderer.rules.table_close = () => "</table></div>\n";

/** Markdown to safe HTML plus the headings for the table of contents. */
export function markdownToHtml(source: string): { html: string; toc: TocEntry[] } {
  const env: { toc?: TocEntry[] } = {};
  const html = md.render(source, env);
  return { html, toc: env.toc ?? [] };
}
