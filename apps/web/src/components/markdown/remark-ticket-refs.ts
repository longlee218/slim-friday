/** Minimal mdast node shape the plugins here need (avoids a direct `mdast` type dependency). */
export interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/** Node types whose text must stay untouched: code, links and their definitions. */
const SKIP = new Set(["code", "inlineCode", "link", "linkReference", "definition", "html"]);

/** `FRI-<n>` as a whole token, never inside a longer word or id. */
const TICKET = /(?<![\w-])FRI-(\d+)(?![\w-])/g;

/** Split one text node into text and link nodes around every ticket ref. */
function split(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(TICKET)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ type: "text", value: value.slice(last, start) });
    out.push({
      type: "link",
      url: `/tickets/${m[0]}`,
      children: [{ type: "text", value: m[0] }],
    });
    last = start + m[0].length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** Walk the tree in place; text children of a non-skipped parent are replaced by split(). */
function walk(node: MdNode): void {
  if (!node.children || SKIP.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      next.push(...split(child.value));
    } else {
      walk(child);
      next.push(child);
    }
  }
  node.children = next;
}

/**
 * Remark plugin: turns `FRI-<n>` in plain text into a link to `/tickets/FRI-<n>`
 * (the `a` renderer maps those links to `TicketLink`). Code and existing links are skipped.
 */
export function remarkTicketRefs() {
  return (tree: MdNode) => walk(tree);
}
