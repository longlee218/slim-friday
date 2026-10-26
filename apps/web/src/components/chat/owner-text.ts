/** A piece of an owner message: plain text, an inline `code` span or a fenced code block. */
export type OwnerPart =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "fence"; text: string };

/** A fenced block (``` or ~~~, optional language) on its own lines; an unclosed fence runs to the end. */
const FENCE = /(^|\n)(```|~~~)[^\n]*\n([\s\S]*?)(?:\n\2[ \t]*(?=\n|$)|$)/g;
/** Inline code: one or more backticks around text on one line. */
const INLINE = /(`+)([^`\n]+?)\1/g;

/** Splits plain text into text and inline code parts. */
function inlineParts(text: string): OwnerPart[] {
  const parts: OwnerPart[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) parts.push({ kind: "text", text: text.slice(at, m.index) });
    parts.push({ kind: "code", text: m[2] ?? "" });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts;
}

/**
 * The owner's text with its code marked, and nothing else parsed (no full markdown): fenced
 * blocks become `fence` parts (language line dropped), backtick spans `code` parts, the rest text.
 */
export function ownerTextParts(text: string): OwnerPart[] {
  const parts: OwnerPart[] = [];
  let at = 0;
  for (const m of text.matchAll(FENCE)) {
    const start = m.index + (m[1] ?? "").length;
    if (start > at) parts.push(...inlineParts(text.slice(at, start).replace(/\n+$/, "")));
    parts.push({ kind: "fence", text: m[3] ?? "" });
    at = m.index + m[0].length;
    if (text[at] === "\n") at += 1;
  }
  if (at < text.length) parts.push(...inlineParts(text.slice(at)));
  return parts;
}
