/* Shape gate of the worker shell: a line is usable only when it is ONE simple command of plain words. Nothing is parsed or
   guessed: the whole line is matched against a short allowed alphabet, so every operator, redirect, quote, expansion,
   escape and non-ASCII char is refused by construction. Pure. */

/** Longest line (chars) the gate looks at. */
const MAX_LINE = 600;
/** The only chars of a line (after the commit message is lifted out): no `; & | < > ( ) { } $ ` " ' \ * ? [ ] ~ ! # newline`. */
const ALPHABET = /^[A-Za-z0-9 _./:,@%+=-]+$/;
/** A git rev word with a suffix (`HEAD~2`, `HEAD^`, `v1^1`): `~` / `^` after a word char cannot expand in a shell. Only `git` words are stripped. */
const REV_WORD = /^([A-Za-z0-9_][A-Za-z0-9_./:-]*)[~^]\d{0,3}$/;
/** Chars a commit message may not hold: they could expand inside it (`$`, backtick, `\`, `!`) or end its quote (the quote itself). */
const MSG_BAD_DOUBLE = /["$`\\!]/;
const MSG_BAD_SINGLE = /['$`\\!]/;
/** Printable ASCII only (no control char, no newline, no unicode). */
const PRINTABLE = /^[ -~]*$/;
/** Word that stands for the lifted commit message. */
export const MSG_WORD = "MSG";

/** The words of one allowed line. */
export interface Shaped {
  /** The command and its arguments; each commit message appears as `MSG_WORD`; a git rev suffix is already dropped. */
  words: string[];
  /** Original spelling of the git words whose rev suffix was dropped (`HEAD~2`): the caller refuses one that names a file. */
  revWords: string[];
}

/**
 * Lift EVERY quoted message of `git commit ... -m "<text>"` (a second `-m` is allowed) out of `line`. A double-quoted body may
 * hold `'`, a single-quoted one may hold `"`; neither may hold `$`, a backtick, `\` or `!`. Returns the line with each quote
 * replaced by `MSG_WORD`, or undefined when a message is unusable. No other quote is ever accepted.
 */
function liftMessages(line: string): string | undefined {
  let out = "";
  let from = 0;
  for (;;) {
    const at = line.indexOf(" -m ", from);
    if (at < 0) return out + line.slice(from);
    const q = line[at + 4];
    if (q !== '"' && q !== "'") {
      out += line.slice(from, at + 4);
      from = at + 4;
      continue;
    }
    const end = line.indexOf(q, at + 5);
    const bad = q === '"' ? MSG_BAD_DOUBLE : MSG_BAD_SINGLE;
    if (end < 0 || bad.test(line.slice(at + 5, end)) || (line[end + 1] ?? " ") !== " ")
      return undefined;
    out += `${line.slice(from, at)} -m ${MSG_WORD}`;
    from = end + 1;
  }
}

/** Split a line into words, or undefined when it is not one simple command of plain words (fail closed). */
export function shapeOf(line: string): Shaped | undefined {
  if (line.length > MAX_LINE || !PRINTABLE.test(line)) return undefined;
  // Quotes are never parsed. The one exception: the messages of `git commit -m "<text>"`.
  const isGit = line.startsWith("git ");
  const lifted = /^git commit /.test(line) ? liftMessages(line) : line;
  if (lifted === undefined) return undefined;
  const revWords: string[] = [];
  // A rev suffix is dropped on `git` words only; on any other command `~` / `^` stay and fail the alphabet.
  const plain = lifted
    .trim()
    .split(/ +/)
    .map((w) => {
      const m = isGit ? REV_WORD.exec(w) : null;
      if (m) revWords.push(w);
      return m ? m[1] : w;
    })
    .join(" ");
  if (plain === "" || !ALPHABET.test(plain)) return undefined;
  const words = plain.split(/ +/);
  // `=` is allowed only inside a long flag (`--max-count=5`): never a `VAR=value` assignment.
  if (words.some((w, i) => w.includes("=") && (i === 0 || !/^--[A-Za-z][\w-]*=/.test(w))))
    return undefined;
  return { words, revWords };
}
