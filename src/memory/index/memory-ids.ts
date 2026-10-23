import { createHash } from "node:crypto";
import { MEMORY_SECTION_HEADINGS, normalizeBullet } from "../memory-sections";

/**
 * Entry ids of the memory read tools. An id is a POINTER, never a path: it is parsed with strict regexes and
 * re-resolved against the CURRENT file by position, then by content hash.
 *
 *   root#<Section>:<n>~<h>   channel/<name>#<Section>:<n>~<h>
 *   journal/<channel>/<YYYY-MM-DD>#<HH:MM>:<n>~<h>   summary/<threadId>@<cycle>
 *
 * Section = a kind heading (Decisions...), `Other` (bullets outside kind sections) or `Text` (prose paragraphs).
 * n = 1-based position among entries of that section (journal: among blocks with the same HH:MM).
 * h = first 6 hex of sha1 of the normalized text (journal: of the block label + body, so an edited block no longer resolves).
 */

export type { Source } from "../memory-limits";

/** Section tokens other than the kind headings. */
export const OTHER_TOKEN = "Other";
export const TEXT_TOKEN = "Text";
const FILE_TOKENS: readonly string[] = [...MEMORY_SECTION_HEADINGS, OTHER_TOKEN, TEXT_TOKEN];

/** Longest id accepted (hostile input is refused before any regex runs). */
const ID_MAX_CHARS = 200;
const FILE_ID =
  /^(root|channel\/([a-z0-9][a-z0-9-]{0,63}))#([A-Za-z]{1,16}):(\d{1,5})~([0-9a-f]{6})$/;
const JOURNAL_ID =
  /^journal\/([a-z0-9][a-z0-9-]{0,63})\/(\d{4}-\d{2}-\d{2})#(\d{2}:\d{2}):(\d{1,5})~([0-9a-f]{6})$/;
const SUMMARY_ID = /^summary\/([A-Za-z0-9_.-]{1,80})@(\d{1,9})$/;
/** Thread ids that can be put in an id (anything else is not indexed). */
export const THREAD_ID = /^[A-Za-z0-9_.-]{1,80}$/;

/** First 6 hex of sha1 over the normalized text. */
export const hash6 = (text: string): string =>
  createHash("sha1").update(normalizeBullet(text)).digest("hex").slice(0, 6);

/** `prefix` is `root`, `channel/<name>` or `journal/<channel>/<date>`. */
export const makeId = (prefix: string, token: string, n: number, hash: string): string =>
  `${prefix}#${token}:${n}~${hash}`;

export type ParsedId =
  | {
      type: "file";
      source: "root" | "channel";
      channel?: string;
      token: string;
      n: number;
      hash: string;
    }
  | { type: "journal"; channel: string; date: string; token: string; n: number; hash: string }
  | { type: "summary"; threadId: string; cycle: number };

/** Parse an id; null for anything that is not exactly the grammar (never throws). */
export function parseId(id: unknown): ParsedId | null {
  if (typeof id !== "string" || id.length > ID_MAX_CHARS) return null;
  let m = FILE_ID.exec(id);
  if (m) {
    const [, head, channel, token, n, hash] = m as unknown as string[];
    if (!FILE_TOKENS.includes(token as string)) return null;
    return {
      type: "file",
      source: head === "root" ? "root" : "channel",
      channel,
      token: token as string,
      n: Number(n),
      hash: hash as string,
    };
  }
  m = JOURNAL_ID.exec(id);
  if (m)
    return {
      type: "journal",
      channel: m[1] as string,
      date: m[2] as string,
      token: m[3] as string,
      n: Number(m[4]),
      hash: m[5] as string,
    };
  m = SUMMARY_ID.exec(id);
  if (m) return { type: "summary", threadId: m[1] as string, cycle: Number(m[2]) };
  return null;
}
