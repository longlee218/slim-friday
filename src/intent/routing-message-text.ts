import { redactText } from "../observability/redact";

/* The owner message as routing engines see it (Haiku L3, Jev): clipped and redacted. Kept apart from the L3
 * prompt so Jev and ingress do not depend on the classifier prompt. */

/** Longest owner message sent to the classifier (a pasted log must not buy tokens). */
const MESSAGE_MAX_CHARS = 2000;

/** Typed head and attachment head of the message (the ingress block starts with this line): both always fit. */
export const TYPED_HEAD_CHARS = 1000;
/** 2 chars: the blank line joining the two parts, so the total stays MESSAGE_MAX_CHARS. */
export const ATTACHMENT_HEAD_CHARS = MESSAGE_MAX_CHARS - TYPED_HEAD_CHARS - 2;
/** First line of an attachment block appended by ingress (`attachment-text.ts` builds it). */
export const ATTACHMENT_BLOCK_START = "Attached file ";

/**
 * The message as L3 sees it, <= MESSAGE_MAX_CHARS: plain text is cut at the cap; a message with attachment blocks
 * is typed head + attachment head, so a long typed text cannot push the file's summary out (nor the reverse).
 */
export function l3MessageText(text: string): string {
  const at = text.startsWith(ATTACHMENT_BLOCK_START)
    ? 0
    : text.indexOf(`\n\n${ATTACHMENT_BLOCK_START}`);
  if (at < 0) return text.slice(0, MESSAGE_MAX_CHARS);
  const typed = text.slice(0, at).slice(0, TYPED_HEAD_CHARS);
  const files = text.slice(at).trimStart().slice(0, ATTACHMENT_HEAD_CHARS);
  return typed ? `${typed}\n\n${files}` : files;
}

/**
 * The message as every routing engine sees it (Haiku L3 and Jev): clipped (`l3MessageText`) AND redacted, so no
 * secret in the owner's text reaches a model or a third party. The one place both engines take the text from.
 */
export const routingMessageText = (text: string): string => redactText(l3MessageText(text));
