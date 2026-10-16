/** Replies longer than this (chars), or with a table or a long code block, go out as a `reply.md` attachment. */
export const ATTACH_MIN = 800;
/** A reply is sent as at most this many chat messages (extra paragraphs are joined into the last one). */
export const MAX_BUBBLES = 4;
/** A fenced code block with more lines than this counts as "long": the reply becomes an attachment. */
export const CODE_LINES_MAX = 10;
/** Typing pause before a bubble: BASE + PER_CHAR * chars, clamped to [MIN, MAX]. */
const PAUSE_BASE_MS = 400;
const PAUSE_PER_CHAR_MS = 25;
const PAUSE_MIN_MS = 800;
const PAUSE_MAX_MS = 2000;
/** Total pause over one reply; later bubbles wait less, then not at all. */
export const PACE_TOTAL_MAX_MS = 6000;

/** The line that separates the chat part of a reply from its details (sent as a file). */
const SEPARATOR = "---";

/** True for a line that opens or closes a ``` code fence. */
const isFence = (line: string): boolean => line.trimStart().startsWith("```");

/**
 * Split a reply at its first `---` line that is outside a code fence.
 * `split` is false when there is no such line (then `chat` is the whole text and `detail` is empty).
 */
export function splitReply(text: string): { chat: string; detail: string; split: boolean } {
  const lines = text.split("\n");
  let inFence = false;
  for (const [i, line] of lines.entries()) {
    if (isFence(line)) inFence = !inFence;
    if (!inFence && line.trim() === SEPARATOR)
      return {
        chat: lines.slice(0, i).join("\n").trim(),
        detail: lines
          .slice(i + 1)
          .join("\n")
          .trim(),
        split: true,
      };
  }
  return { chat: text.trim(), detail: "", split: false };
}

/** Paragraphs = blocks separated by a blank line; a blank line inside a code fence does not split. */
export function paragraphs(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = () => {
    if (cur.length) out.push(cur.join("\n"));
    cur = [];
  };
  for (const line of text.split("\n")) {
    if (isFence(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") flush();
    else cur.push(line);
  }
  flush();
  return out;
}

/** The paragraphs as chat messages: at most MAX_BUBBLES, the surplus is joined into the last one. */
export function toBubbles(text: string): string[] {
  const parts = paragraphs(text);
  if (parts.length <= MAX_BUBBLES) return parts;
  return [...parts.slice(0, MAX_BUBBLES - 1), parts.slice(MAX_BUBBLES - 1).join("\n\n")];
}

/** A Markdown table: a pipe row followed by a `|---|---|` separator row. */
const TABLE = /^\s*\|.*\|\s*\n\s*\|?[\s:|-]*-{3}[\s:|-]*$/m;
/** A fenced code block (an unclosed one runs to the end); group 1 is its body. */
const CODE_BLOCK = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;

/** True when the reply is too long or too structured for chat: long text, a table, or a long code block. */
export function needsFile(text: string): boolean {
  if (text.length > ATTACH_MIN || TABLE.test(text)) return true;
  for (const m of text.matchAll(CODE_BLOCK))
    if (m[1]!.trimEnd().split("\n").length > CODE_LINES_MAX) return true;
  return false;
}

/** How long to show "typing" before a bubble of `chars` characters (about a second of "typing" for a sentence). */
export function pauseMs(chars: number): number {
  return Math.min(PAUSE_MAX_MS, Math.max(PAUSE_MIN_MS, PAUSE_BASE_MS + PAUSE_PER_CHAR_MS * chars));
}
