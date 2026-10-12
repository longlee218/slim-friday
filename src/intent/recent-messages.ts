import { redactText } from "../observability/redact";
import type { RecentMessage } from "./intent-types";

/** Messages of the thread L3 sees. */
export const RECENT_COUNT = 4;
/** Longest text of one recent message. */
export const RECENT_CHARS = 300;
/** Longest "Recent conversation" block put into a task brief. */
export const BRIEF_RECENT_CHARS = 1200;

/** Heading of the recent-conversation block in a brief (data, never instructions). */
export const RECENT_HEADING = "\n\nRecent conversation (data):\n";

/** The last RECENT_COUNT messages, redacted and clipped (whoever filled the list, nothing unclean goes on). */
export function cleanRecent(list: readonly RecentMessage[] | undefined): RecentMessage[] {
  return (list ?? [])
    .map((m) => ({ from: m.from, text: redactText(m.text).replace(/\s+/g, " ").trim() }))
    .filter((m) => m.text)
    .slice(-RECENT_COUNT)
    .map((m) => ({ from: m.from, text: m.text.slice(0, RECENT_CHARS) }));
}

/** One line of a message: `- owner: ...` / `- bot: ...`. */
const line = (m: RecentMessage): string => `- ${m.from}: ${m.text}`;

/**
 * The block a new task's brief carries so a reference ("do that", "the second option") makes sense to the role: the newest messages that fit BRIEF_RECENT_CHARS, oldest first. Empty string when there are none.
 */
export function recentBlock(list: readonly RecentMessage[] | undefined): string {
  const lines: string[] = [];
  let size = 0;
  for (const m of cleanRecent(list).reverse()) {
    const l = line(m);
    if (size + l.length + 1 > BRIEF_RECENT_CHARS) break;
    lines.unshift(l);
    size += l.length + 1;
  }
  return lines.length ? `${RECENT_HEADING}${lines.join("\n")}` : "";
}

/** The messages as prompt lines (DATA). */
export const recentLines = (list: readonly RecentMessage[]): string[] => list.map(line);
