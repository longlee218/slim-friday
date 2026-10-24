import type { MemoryOwner } from "../ports/memory";
import type { MemorySearcher } from "../ports/memory-recall";
import { MEMORY_LABEL } from "./memory-label";

/** Shortest message text that triggers a recall (a greeting finds only noise). */
const MIN_TEXT = 8;

/** Text compared without case and with spaces collapsed, so a hit matches its bullet in memory. */
const plain = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** One line of a note: no line breaks, and no `<` / `>` that could close or open a tag. */
const escapeLine = (s: string): string =>
  s.replace(/\s+/g, " ").trim().replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The `<recalled_memory>` block for a turn: hits for `text` from each owner (bot first, then group) whose text is not
 * already in `shown` (the memory the bot was given, so a capped MEMORY.md still recalls its hidden notes); the same
 * text once; at most `recallNotes` whole lines within `recallChars`. Undefined when the text is short, there is no
 * searcher, nothing is left, or the search fails (a recall must never block a turn).
 */
export async function recalledBlock(
  recall: MemorySearcher | undefined,
  owners: MemoryOwner[],
  text: string,
  shown: string,
  limits: { recallNotes: number; recallChars: number },
): Promise<string | undefined> {
  if (!recall || text.trim().length < MIN_TEXT) return undefined;
  let found: Awaited<ReturnType<MemorySearcher["search"]>>[];
  try {
    found = await Promise.all(owners.map((o) => recall.search(o, text, limits.recallNotes)));
  } catch {
    return undefined;
  }
  const seen = plain(shown);
  const used = new Set<string>();
  const lines: string[] = [];
  let chars = 0;
  for (const h of found.flat()) {
    const key = plain(h.text);
    if (!key || used.has(key) || seen.includes(key)) continue;
    used.add(key);
    const line = `- [${h.at ?? h.where}] ${escapeLine(h.text)}`;
    if (lines.length >= limits.recallNotes || chars + line.length + 1 > limits.recallChars) break;
    lines.push(line);
    chars += line.length + 1;
  }
  if (!lines.length) return undefined;
  return `<recalled_memory>\n${MEMORY_LABEL}\n${lines.join("\n")}\n</recalled_memory>`;
}
