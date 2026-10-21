import { redactText } from "../observability/redact";
import type { RecentMessage } from "./intent-types";

/** Messages of the thread L3 sees. */
export const RECENT_COUNT = 4;
/** Longest text of one recent message. */
const RECENT_CHARS = 300;
/** The last RECENT_COUNT messages, redacted and clipped (whoever filled the list, nothing unclean goes on). */
export function cleanRecent(list: readonly RecentMessage[] | undefined): RecentMessage[] {
  return (list ?? [])
    .map((m) => ({ from: m.from, text: redactText(m.text).replace(/\s+/g, " ").trim() }))
    .filter((m) => m.text)
    .slice(-RECENT_COUNT)
    .map((m) => ({ from: m.from, text: m.text.slice(0, RECENT_CHARS) }));
}
