import { redactText } from "../observability/redact";
import type { RecentMessage } from "./intent-types";

/** Messages of the thread L3 sees. */
export const RECENT_COUNT = 4;
/** Longest text of one recent message. */
const RECENT_CHARS = 300;
/** The last RECENT_COUNT messages (`count` / `chars` override: the rollover reads more), redacted and clipped (whoever filled the list, nothing unclean goes on). */
export function cleanRecent(
  list: readonly RecentMessage[] | undefined,
  count = RECENT_COUNT,
  chars = RECENT_CHARS,
): RecentMessage[] {
  return (list ?? [])
    .map((m) => ({ from: m.from, text: redactText(m.text).replace(/\s+/g, " ").trim() }))
    .filter((m) => m.text)
    .slice(-count)
    .map((m) => ({ from: m.from, text: m.text.slice(0, chars) }));
}

/** One line of a message: `- owner: ...` / `- bot: ...`. */
const line = (m: RecentMessage): string => `- ${m.from}: ${m.text}`;

/** The messages as prompt lines (DATA). */
export const recentLines = (list: readonly RecentMessage[]): string[] => list.map(line);
