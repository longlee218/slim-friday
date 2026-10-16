/**
 * Minimal best-effort shell tokenizer for the Bash guardrail. Splits a command line into
 * simple-command segments (&&, ||, ;, |, &, newline, parentheses) and extracts $(...) and
 * backtick substitutions as extra segments. Variables are NOT expanded. Heredoc bodies are skipped, `<<<` is a plain
 * redirect and backslash-newline joins lines. Throws only on unbalanced quotes/parens/backticks: the caller then
 * falls back to a coarse raw-text check (bash-policy.ts).
 */

/** One simple command: unquoted words plus flags the policy cares about. */
export interface Segment {
  words: string[];
  /** Fed by a pipe from the previous segment (`a | this`). */
  piped: boolean;
  /** Has an unquoted output redirection (`>`, `>>`, `&>`) to a file. */
  redirect: boolean;
  /** Operator that ends this segment: `&&` `||` `;` `\n` `|` `&` `(` `)`; "" at the end of the line. */
  next: string;
  /** Nesting: 0 = top level; > 0 inside `( )` or a `$()` / backtick substitution. */
  depth: number;
}

/** True when a heredoc (`<<`, `<<-`; not the here-string `<<<`) starts at `i`. */
const isHeredocAt = (src: string, i: number): boolean =>
  src[i] === "<" && src[i + 1] === "<" && src[i + 2] !== "<" && src[i - 1] !== "<";

/**
 * Heredoc starting at `i`: `resume` = index of the last char of its delimiter word, `from` = the newline that ends
 * the current line (the body starts after it, -1 when there is no body), `to` = index of the newline after the
 * terminator line (or the end of the text; an unterminated body runs to the end).
 */
function heredocAt(src: string, i: number): { resume: number; from: number; to: number } {
  let j = i + 2;
  const dash = src[j] === "-";
  if (dash) j++;
  while (src[j] === " " || src[j] === "\t") j++;
  const q = src[j] === "'" || src[j] === '"' ? src[j] : "";
  const start = q ? j + 1 : j;
  let end = start;
  while (end < src.length && (q ? src[end] !== q : !/[\s;&|<>()]/.test(src[end]))) end++;
  const delim = src.slice(start, end);
  const resume = q ? end : end - 1;
  const from = src.indexOf("\n", resume);
  if (from < 0) return { resume, from: -1, to: src.length };
  for (let p = from + 1; p <= src.length; ) {
    const e = src.indexOf("\n", p);
    const lineEnd = e < 0 ? src.length : e;
    const line = src.slice(p, lineEnd);
    if ((dash ? line.replace(/^\t+/, "") : line) === delim) return { resume, from, to: lineEnd };
    if (e < 0) break;
    p = e + 1;
  }
  return { resume, from, to: src.length };
}

/** Index of the `)` matching the `(` just before `start`; throws if unbalanced. */
function findParenClose(src: string, start: number): number {
  let depth = 1;
  let quote: string | null = null;
  let skipFrom = -1; // a heredoc body from here...
  let skipTo = -1; // ...up to here is not shell syntax (its quotes and parens do not count)
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (i === skipFrom) i = skipTo;
    else if (!quote && isHeredocAt(src, i)) {
      const h = heredocAt(src, i);
      i = h.resume;
      if (h.from >= 0) [skipFrom, skipTo] = [h.from, h.to];
    } else if (c === "\\" && quote !== "'") i++;
    else if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  throw new Error("unbalanced parenthesis");
}

/** Index of the closing backtick starting the search at `start`; throws if missing. */
function findBacktickClose(src: string, start: number): number {
  for (let i = start; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "`") return i;
  }
  throw new Error("unbalanced backtick");
}

/** Parse a command line into segments. Throws when it cannot be tokenized (unbalanced quote, paren or backtick). */
export function parseCommand(src: string): Segment[] {
  const out: Segment[] = [];
  const subs: Segment[] = [];
  let words: string[] = [];
  let buf = "";
  let inWord = false;
  let piped = false;
  let redirect = false;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let skipFrom = -1; // a heredoc body from this newline...
  let skipTo = -1; // ...to the newline after its terminator line is skipped

  const endWord = () => {
    if (inWord) {
      words.push(buf);
    }
    buf = "";
    inWord = false;
  };
  // Close the current segment. An empty segment keeps a pending pipe (`a |\n sh`).
  const endSeg = (pipe: boolean, op = "") => {
    endWord();
    if (words.length === 0 && !redirect) {
      if (pipe) piped = true;
      return;
    }
    out.push({ words, piped, redirect, next: op, depth });
    words = [];
    redirect = false;
    piped = pipe;
  };
  // Parse a substitution body as its own commands; the outer word gets a placeholder.
  const substitute = (inner: string) => {
    subs.push(...parseCommand(inner));
    buf += "$SUBST";
    inWord = true;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else buf += c;
    } else if (c === "\\") {
      // A trailing backslash or a line continuation joins the lines (nothing is added to the word).
      if (next === undefined || next === "\n") i++;
      else {
        // Inside double quotes only a few chars are escapable; otherwise keep the backslash.
        buf += quote === '"' && !'$`"\\'.includes(next) ? `\\${next}` : next;
        inWord = true;
        i++;
      }
    } else if (c === "$" && next === "(") {
      const end = findParenClose(src, i + 2);
      substitute(src.slice(i + 2, end));
      i = end;
    } else if (c === "`") {
      const end = findBacktickClose(src, i + 1);
      substitute(src.slice(i + 1, end));
      i = end;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else buf += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === " " || c === "\t") endWord();
    else if (c === "\n") {
      endSeg(false, "\n");
      if (i === skipFrom) i = skipTo;
    } else if (c === "#" && !inWord) {
      while (i + 1 < src.length && src[i + 1] !== "\n") i++;
    } else if (c === "&") {
      const op = next === "&" ? "&&" : "&";
      if (next === "&") i++;
      if (next === ">") redirect = true;
      else endSeg(false, op);
    } else if (c === "|") {
      const pipe = next !== "|";
      const op = pipe ? "|" : "||";
      if (next === "|" || next === "&") i++;
      endSeg(pipe, op);
    } else if (c === ";") endSeg(false, ";");
    else if (c === "(" || c === ")") {
      endSeg(false, c);
      depth = c === "(" ? depth + 1 : Math.max(0, depth - 1);
    } else if (c === ">") {
      endWord();
      // `>&2` / `>&-` duplicate descriptors; anything else writes a file.
      if (next === "&" && /[\d-]/.test(src[i + 2] ?? "")) i++;
      else redirect = true;
      if (next === ">") i++;
    } else if (isHeredocAt(src, i)) {
      // The body is data, not commands: skip it. The rest of the line (`)" && rm x`) is still parsed.
      endWord();
      const h = heredocAt(src, i);
      i = h.resume;
      if (h.from >= 0) [skipFrom, skipTo] = [h.from, h.to];
    } else if (c === "<" && next === "<" && src[i + 2] === "<") {
      endWord(); // here-string `<<<`: a plain redirect from a word
      i += 2;
    } else if (c === "<") endWord();
    else {
      buf += c;
      inWord = true;
    }
  }
  if (quote) throw new Error("unbalanced quote");
  endSeg(false);
  return [...out, ...subs.map((s) => ({ ...s, depth: s.depth + 1 }))];
}
