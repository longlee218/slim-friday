import type { MdNode } from "./remark-ticket-refs";

/** GitHub-style alert markers mapped to a callout tone. */
const TONES: Record<string, "info" | "risk"> = {
  NOTE: "info",
  TIP: "info",
  IMPORTANT: "info",
  WARNING: "risk",
  CAUTION: "risk",
};
const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\r?\n?/i;

/** Mark one blockquote when its first text starts with an alert marker; strips the marker. */
function mark(quote: MdNode): void {
  const first = quote.children?.[0]?.children?.[0];
  if (first?.type !== "text" || !first.value) return;
  const m = MARKER.exec(first.value);
  const tone = m?.[1] ? TONES[m[1].toUpperCase()] : undefined;
  if (!m || !tone) return;
  first.value = first.value.slice(m[0].length);
  // An emptied first text node would leave a stray empty node; drop it.
  if (!first.value) quote.children?.[0]?.children?.shift();
  // `hProperties` becomes an HTML attribute that the `blockquote` renderer reads.
  quote.data = { ...quote.data, hProperties: { "data-callout": tone } };
}

/** Walk the tree and mark every alert blockquote. */
function walk(node: MdNode): void {
  if (node.type === "blockquote") mark(node);
  for (const child of node.children ?? []) walk(child);
}

/** Remark plugin: `> [!NOTE]` / `> [!WARNING]` blockquotes become tone-tagged callouts. */
export function remarkCallouts() {
  return (tree: MdNode) => walk(tree);
}
