/**
 * Minimal best-effort shell tokenizer for the Bash guardrail. Splits a command line into
 * simple-command segments (&&, ||, ;, |, &, newline, parentheses) and extracts $(...) and
 * backtick substitutions as extra segments. Variables are NOT expanded. Throws on unbalanced
 * quotes/parens so the caller can fall back to "ask".
 */

/** One simple command: unquoted words plus flags the policy cares about. */
export interface Segment {
  words: string[];
  /** Fed by a pipe from the previous segment (`a | this`). */
  piped: boolean;
  /** Has an unquoted output redirection (`>`, `>>`, `&>`) to a file. */
  redirect: boolean;
  /** The words that follow a `>`, `>>`, `&>` or `N>` operator (the files written; also in the glued form `>path`). */
  redirectTargets: string[];
  /** Operator that ends this segment: `&&` `||` `;` `\n` `|` `&` `(` `)`; "" at the end of the line. */
  next: string;
  /** Nesting: 0 = top level; > 0 inside `( )` or a `$()` / backtick substitution. */
  depth: number;
}

/** Index of the `)` matching the `(` just before `start`; throws if unbalanced. */
function findParenClose(src: string, start: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && quote !== "'") i++;
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

/** Parse a command line into segments. Throws when it cannot be tokenized safely. */
export function parseCommand(src: string): Segment[] {
  const out: Segment[] = [];
  const subs: Segment[] = [];
  let words: string[] = [];
  let buf = "";
  let inWord = false;
  let piped = false;
  let redirect = false;
  let targets: string[] = [];
  let expectTarget = false; // the next word completed is a redirect target
  let depth = 0;
  let quote: "'" | '"' | null = null;

  const endWord = () => {
    if (inWord) {
      words.push(buf);
      if (expectTarget) targets.push(buf);
      expectTarget = false;
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
    out.push({ words, piped, redirect, redirectTargets: targets, next: op, depth });
    words = [];
    redirect = false;
    targets = [];
    expectTarget = false;
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
      if (next === undefined) throw new Error("trailing backslash");
      // A line continuation could split an operator (`<\<`): the line is not judged (it asks).
      if (next === "\n") throw new Error("line continuation");
      if (next !== "\n") {
        // Inside double quotes only a few chars are escapable; otherwise keep the backslash.
        buf += quote === '"' && !'$`"\\'.includes(next) ? `\\${next}` : next;
        inWord = true;
      }
      i++;
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
    else if (c === "\n") endSeg(false, "\n");
    else if (c === "#" && !inWord) {
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
      else redirect = expectTarget = true;
      if (next === ">") i++;
    } else if (c === "<" && next === "<" && src[i + 2] !== "<") {
      // A heredoc body would be tokenized as commands (a `cd` in it never runs): the line cannot be judged.
      throw new Error("heredoc");
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
