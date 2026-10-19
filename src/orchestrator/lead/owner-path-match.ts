/* Token match of a path inside the owner's message (the prompt-injection guard of Orchestrate register_location). Fails closed: a
   case difference, a unicode lookalike, a longer path that merely starts with the given one, or a parent of a longer
   typed path never matches. Leaf module (no imports). */

/** Characters that may stand right before a path token (besides the start of the text and whitespace). */
const OPEN = new Set(['"', "'", "`", "(", "[", "{", "<", "=", ","]);
/** Characters that may stand right after a path token: sentence punctuation and closers (not path chars). */
const CLOSE = new Set(['"', "'", "`", ")", "]", "}", ">", ",", ";", ":", "!", "?"]);
/** Whitespace or a quote: the only delimiters of a bare `~`, `/` or `$HOME` token. */
const STRICT = /[\s"'`]+/;

const isSpace = (c: string): boolean => /\s/.test(c);

/** True when the occurrence of `cand` at `i` in `text` is a whole token (see the file comment). */
function boundedAt(text: string, i: number, cand: string): boolean {
  const before = text[i - 1];
  if (before !== undefined && !isSpace(before) && !OPEN.has(before)) return false;
  let end = i + cand.length;
  // A trailing slash is fine only when it ends the token (path + "/" exactly), never a `/name` continuation.
  if (text[end] === "/") end += 1;
  const after = text[end];
  if (after === undefined || isSpace(after) || CLOSE.has(after)) return true;
  // A final "." is sentence punctuation unless a name char follows it (`shop.bak`).
  if (after === ".") {
    const next = text[end + 1];
    return next === undefined || isSpace(next) || CLOSE.has(next);
  }
  return false;
}

/**
 * True when `path` (or its `~/...` form, when it lies under `userHome`) stands in `text` as a whole token. A bare `~`, `/`
 * or `userHome` matches only as a token delimited by whitespace or quotes, so "~5 min" or any "/" in a sentence is not it.
 */
export function pathInText(path: string, text: string, userHome: string): boolean {
  if (!path.trim()) return false;
  if (path === "~" || path === "/" || path === userHome) return text.split(STRICT).includes(path);
  const forms = [path];
  if (path.startsWith(`${userHome}/`)) forms.push(`~${path.slice(userHome.length)}`);
  return forms.some((cand) => {
    for (let i = text.indexOf(cand); i >= 0; i = text.indexOf(cand, i + 1))
      if (boundedAt(text, i, cand)) return true;
    return false;
  });
}
