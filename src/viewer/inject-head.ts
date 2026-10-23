/** Leading noise a doctype may follow: BOM, whitespace and comments (none of them change the parser's mode). */
const TEAMMATE = String.raw`(?:﻿|\s|<!--[\s\S]*?-->)*`;

/** The artifact's own doctype (case-insensitive) after the leading noise: match = everything up to and including it. */
const DOCTYPE = new RegExp(`^${TEAMMATE}<!doctype[^>]*>`, "i");

/** Optional `<html ...>` then optional `<head ...>` right after the doctype (only whitespace and comments between). */
const HTML_HEAD =
  /^((?:\s|<!--[\s\S]*?-->)*(?:<html(?:\s[^>]*)?>(?:\s|<!--[\s\S]*?-->)*)?(?:<head(?:\s[^>]*)?>)?)/i;

/**
 * Put `head` (our CSP meta + frame script) into an html artifact WITHOUT losing standards mode: a doctype must be the
 * first thing the parser sees, or the frame renders in quirks mode.
 * - Artifact with a doctype: `head` goes right after it, and after `<html>` / `<head>` when those open the document, so
 *   the doctype stays first and `head` still runs before any artifact script.
 * - No doctype: `<!DOCTYPE html>` and `head` are prepended (the artifact asked for nothing, standards mode is the default).
 */
export function injectHead(text: string, head: string): string {
  const doctype = DOCTYPE.exec(text);
  if (!doctype) return `<!DOCTYPE html>${head}${text}`;
  const rest = text.slice(doctype[0].length);
  const opening = HTML_HEAD.exec(rest)?.[0] ?? ""; // always matches (every part is optional)
  return `${doctype[0]}${opening}${head}${rest.slice(opening.length)}`;
}
