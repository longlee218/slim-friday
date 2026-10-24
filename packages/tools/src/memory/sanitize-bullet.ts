import { MEMORY_NOTE_MAX_CHARS } from "@friday/core";
import { redactText } from "../text/redact";

/** Role prefix an injected line could use to look like a chat turn. */
const ROLE_PREFIX = /^(?:system|assistant|user|human)\s*:\s*/i;
/**
 * Leading markdown that could turn a bullet into a heading, quote or list of its own. Heading and list
 * markers count only before whitespace (so `-5`, `#1`, `1.5x`, `*args` stay); a quote marker needs none.
 */
const LEADING_MARKUP = /^(?:#+\s+|>+\s*|[-*+]\s+|\d+[.)]\s+)/;

/** Strip leading heading/quote/list markers and role prefixes until nothing more matches. */
function stripLeading(line: string): string {
  let cur = line.trim();
  for (let prev = ""; prev !== cur; ) {
    prev = cur;
    cur = cur.replace(LEADING_MARKUP, "").replace(ROLE_PREFIX, "").trim();
  }
  return cur;
}

/**
 * Make agent-written text safe to store as one memory bullet (it is later read into a prompt):
 * secrets redacted (before the cut, so none straddles the limit), HTML comments, real tags and `<|...|>` tokens removed,
 * code fences and backtick runs removed, one line (each line loses leading `#`/`>`/list markers and
 * `system:`/`assistant:`/`user:` prefixes), at most `max` chars. "" when nothing is left.
 */
export { MEMORY_NOTE_MAX_CHARS };

export function sanitizeBullet(text: string, max = MEMORY_NOTE_MAX_CHARS): string {
  const flat = redactText(text)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ") // comments, also an unterminated one
    .replace(/<\|[^|>\n]*\|>/g, " ") // chat-template tokens such as <|im_start|>
    // Real tags only (closing `>` on the same line; an opening tag not glued to a word, so `Vec<String>` and `i<n and a>b` stay).
    .replace(/(?:(?<!\w)<[A-Za-z]|<\/[A-Za-z])[^<>\n]*>/g, " ")
    .replace(/`+|~{3,}/g, " ") // fences and backtick runs
    .split(/\r?\n/)
    .map(stripLeading)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.slice(0, max).trim();
}
