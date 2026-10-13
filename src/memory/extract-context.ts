import { normalizeBullet } from "./memory-sections";
import { sanitizeBullet } from "./sanitize-bullet";

/** Chars of conversation text (newest end) the extractor looks at. */
export const EXTRACT_SOURCE_CHARS = 12_000;
/** Items kept per bucket (the newest). */
export const EXTRACT_MAX_ITEMS = 8;
/** Max chars of one extracted item. */
export const EXTRACT_ITEM_CHARS = 200;
/** A sentence shorter than this is noise ("ok, will use it"). */
const MIN_SENTENCE_CHARS = 15;

/** One chat message as plain text (tool calls and tool results are never part of it). */
export interface ChatText {
  role: "user" | "assistant";
  text: string;
}

/** The three buckets of an extract, oldest first. */
export interface ExtractedContext {
  decisions: string[];
  facts: string[];
  preferences: string[];
}

/*
 * Keyword lists, English + Vietnamese (accented and the common unaccented typing). No `\b` for Vietnamese: word
 * boundaries ignore non-ASCII letters. Crude on purpose: this is a no-LLM safety net, not a summarizer.
 */
const DECISION =
  /\b(?:decided|decision|we chose|i chose|chosen|will use|we'll use|going with|go with|the plan is|agreed|settled on)\b|quyết định|quyet dinh|đã chọn|da chon|sẽ dùng|se dung|sẽ sử dụng|kế hoạch|ke hoach|thống nhất|thong nhat/i;
/** Owner wishes and rules: counted only in USER text. */
const PREFERENCE =
  /\b(?:always|never|prefer|i like|i want|i don't want|do not|don't|must|should always)\b|luôn|luon |không bao giờ|khong bao gio|thích|thich |ưu tiên|uu tien|đừng|phải|phai /i;
const FACT =
  /\b(?:requires?|depends on|located|lives in|runs on|port|deadline|because|note that|is called|is named|uses|version)\b|yêu cầu|yeu cau|nằm ở|nam o|phụ thuộc|phu thuoc|lưu ý|luu y|hạn chót|han chot|bởi vì|boi vi|tên là|ten la/i;

/** Sentences of a text: code blocks dropped, split on line ends and sentence punctuation. */
function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .split(/\r?\n+|(?<=[.!?。])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pick decisions, facts and user preferences out of recent chat text by keyword. Pure, no LLM, no I/O. A
 * sentence goes to the first matching bucket (decision, then preference for the owner's own text, then fact);
 * questions are skipped. Items are cleaned by `sanitizeBullet` (secrets masked, one line, `EXTRACT_ITEM_CHARS`),
 * deduplicated, and the newest `EXTRACT_MAX_ITEMS` per bucket kept.
 */
export function extractContext(messages: readonly ChatText[]): ExtractedContext {
  const out: ExtractedContext = { decisions: [], facts: [], preferences: [] };
  const seen = new Set<string>();
  for (const m of messages) {
    for (const raw of sentences(m.text)) {
      if (raw.endsWith("?")) continue;
      const bucket = DECISION.test(raw)
        ? out.decisions
        : m.role === "user" && PREFERENCE.test(raw)
          ? out.preferences
          : FACT.test(raw)
            ? out.facts
            : undefined;
      if (!bucket) continue;
      const item = sanitizeBullet(raw, EXTRACT_ITEM_CHARS);
      const key = normalizeBullet(item);
      if (item.length < MIN_SENTENCE_CHARS || seen.has(key)) continue;
      seen.add(key);
      bucket.push(item);
    }
  }
  return {
    decisions: out.decisions.slice(-EXTRACT_MAX_ITEMS),
    facts: out.facts.slice(-EXTRACT_MAX_ITEMS),
    preferences: out.preferences.slice(-EXTRACT_MAX_ITEMS),
  };
}

/** Total items of an extract. */
export const extractSize = (e: ExtractedContext): number =>
  e.decisions.length + e.facts.length + e.preferences.length;
