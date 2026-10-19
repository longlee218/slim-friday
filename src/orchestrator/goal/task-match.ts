/* Word overlap of two task texts (pure). Used by the duplicate check of `dispatch` / `add` / `Plan create` and by
   `search`. No model, no index: a thread holds few tasks, so a plain token compare is enough. */

/** Words that say nothing about the work (short words are dropped anyway). */
const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "you",
  "are",
  "not",
  "use",
  "using",
  "all",
  "any",
  "then",
  "when",
  "should",
  "must",
  "will",
  "can",
]);

/** Lower-cased words of at least 3 letters or digits (any script), without the stop words. */
export const tokensOf = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  );

/** Jaccard overlap of two token sets (0-1; 0 when either is empty). */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/** A task as the matcher reads it. */
export interface TaskText {
  subject: string;
  brief: string;
}

/**
 * How alike two tasks are (0-1): the better of the subjects alone and the whole texts (subject + brief). A short
 * subject that repeats an old one counts even when the briefs differ in length.
 */
export function similarity(a: TaskText, b: TaskText): number {
  return Math.max(
    jaccard(tokensOf(a.subject), tokensOf(b.subject)),
    jaccard(tokensOf(`${a.subject} ${a.brief}`), tokensOf(`${b.subject} ${b.brief}`)),
  );
}

/** Share (0-1) of the query's words that the task's subject + brief contain (0 for a query with no word). */
export function queryScore(query: string, t: TaskText): number {
  const q = tokensOf(query);
  if (!q.size) return 0;
  const have = tokensOf(`${t.subject} ${t.brief}`);
  let hit = 0;
  for (const w of q) if (have.has(w)) hit++;
  return hit / q.size;
}
