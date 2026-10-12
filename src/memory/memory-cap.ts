import { MEMORY_SECTION_HEADINGS } from "./memory-sections";

/** Share of the cap given to the header / owner prose / non-kind sections together; kind sections split the rest. */
export const OTHER_SHARE = 0.4;
/** Marker line shown under a kind heading whose older bullets were cut. */
const CUT_MARKER = "...";

/** True when a block (text from a `## ` line up to the next) is an exact kind section. */
const isKindBlock = (block: string): boolean =>
  MEMORY_SECTION_HEADINGS.some((h) => (block.split("\n")[0] ?? "").trimEnd() === `## ${h}`);

/** Newest whole lines of `lines` that fit in `budget` chars (each line costs its length + 1). */
function tailLines(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = (lines[i] ?? "").length + 1;
    if (used + cost > budget) break;
    used += cost;
    out.unshift(lines[i] ?? "");
  }
  return out;
}

/** Split `budget` over sizes equally; a size below its share keeps all and frees the rest for the others. */
function share(sizes: number[], budget: number): number[] {
  const out = sizes.map(() => 0);
  let left = budget;
  let todo = sizes.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s);
  while (todo.length) {
    const each = left / todo.length;
    const first = todo[0] as { s: number; i: number };
    if (first.s <= each) {
      out[first.i] = first.s;
      left -= first.s;
      todo = todo.slice(1);
    } else {
      for (const t of todo) out[t.i] = Math.floor(each);
      break;
    }
  }
  return out;
}

/** A kind section cut to `budget`: heading + marker + its newest whole bullets (heading always kept). */
function capKind(block: string, budget: number): string {
  const [heading = "", ...rest] = block.split("\n");
  if (block.length <= budget) return block;
  const keep = tailLines(rest, budget - heading.length - CUT_MARKER.length - 2);
  return [heading, CUT_MARKER, ...keep].join("\n");
}

/**
 * Cut a memory body to about `max` chars for the prompt. Without an exact kind heading (legacy file) it is the
 * old behavior: `...` + the last `max` chars. With kind sections (`## Decisions`...): the header, owner prose and
 * non-kind sections get up to OTHER_SHARE of the budget (newest whole blocks / lines first), kind sections share
 * the rest equally (an unused share flows to the others). Every kind section keeps its heading and its newest
 * bullets, cut at line borders, with a `...` line when older bullets are missing. Original order is kept.
 */
export function capMemory(body: string, max: number): string {
  if (body.length <= max) return body;
  const blocks = body.split(/\n(?=## )/);
  if (!blocks.some(isKindBlock)) return `...${body.slice(-max)}`;
  const kindIdx = blocks.flatMap((b, i) => (isKindBlock(b) ? [i] : []));
  const otherIdx = blocks.flatMap((_, i) => (kindIdx.includes(i) ? [] : [i]));
  const sizeOf = (ids: number[]) => ids.reduce((n, i) => n + (blocks[i] ?? "").length + 1, 0);
  const otherSize = sizeOf(otherIdx);
  const kindSizes = kindIdx.map((i) => (blocks[i] ?? "").length + 1);
  const kindTotal = kindSizes.reduce((a, b) => a + b, 0);
  // Unused share of one side flows to the other.
  const otherBudget = Math.min(otherSize, Math.max(Math.floor(max * OTHER_SHARE), max - kindTotal));
  const kindBudgets = share(kindSizes, max - otherBudget);
  const out = new Map<number, string>();
  kindIdx.forEach((bi, k) => {
    out.set(bi, capKind(blocks[bi] ?? "", (kindBudgets[k] ?? 0) - 1));
  });
  // Non-kind blocks: newest first, whole blocks; the first block that does not fit is tail-cut by lines.
  let left = otherBudget;
  for (const bi of [...otherIdx].reverse()) {
    const b = blocks[bi] ?? "";
    if (b.length + 1 <= left) {
      out.set(bi, b);
      left -= b.length + 1;
    } else {
      const lines = tailLines(b.split("\n"), left);
      if (lines.length) out.set(bi, [CUT_MARKER, ...lines].join("\n"));
      left = 0;
    }
  }
  return [...out.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => t)
    .join("\n");
}
