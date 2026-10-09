/** An output bullet must share at least this share of its content words with its best-matching input bullet. */
const MIN_OVERLAP = 0.5;
/** An input bullet joins a merge when the output carries at least this share of its words that the best match lacks. */
const SOURCE_COVER = 0.5;

/** Words that carry no fact (English + Vietnamese); ignored by the content-word overlap. */
const STOP_WORDS = new Set(
  "the and for with that this from are was were has have had but you your our all any can will use uses used when then than into onto its their they them his her she him who what which where how why và của cho các một những được là có khi thì này trong với để cũng đã sẽ rất hay hoặc nhưng".split(
    " ",
  ),
);

/**
 * Negation and modality words. They flip or bound the meaning of a line, so they are REQUIRED tokens: the
 * set in an output bullet must equal the set in its sources (a dropped `không` turns "must not delete" into
 * "may delete"). A reword that swaps `never` for `not` is therefore rejected (accepted false abort).
 */
const SIGNAL_WORDS = new Set(
  "không chưa đừng chẳng cấm phải chỉ luôn never not no don't dont doesn't doesnt didn't can't cant cannot won't shouldn't mustn't must only always without nor none".split(
    " ",
  ),
);

/** Normalize for comparison: NFC (macOS can send decomposed accents) + lowercase + curly apostrophes. */
const norm = (s: string): string => s.normalize("NFC").toLowerCase().replace(/[’‘]/g, "'");

/** What a bullet says: facts (content words), numbers (any length, versions/ports) and signal words. */
interface Tokens {
  words: Set<string>;
  numbers: Set<string>;
  signals: Set<string>;
}

/** Split a bullet into content words, numbers and negation/modality words. */
function tokens(bullet: string): Tokens {
  const text = norm(bullet);
  const all = text.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const signals = new Set(all.filter((w) => SIGNAL_WORDS.has(w)));
  const words = new Set(
    all.filter(
      (w) => w.length >= 3 && !STOP_WORDS.has(w) && !SIGNAL_WORDS.has(w) && !/^\d+$/.test(w),
    ),
  );
  return { words, numbers: new Set(text.match(/\d+(?:[.,]\d+)*/g) ?? []), signals };
}

/** Share of `a` that is also in `b` (0 when `a` is empty). */
const share = (a: Set<string>, b: Set<string>): number =>
  a.size ? [...a].filter((w) => b.has(w)).length / a.size : 0;

/** True when two sets hold exactly the same members. */
const sameSet = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Derivability check. Returns the output bullets that cannot be derived from the input (empty = all fine).
 * For each output bullet:
 * 1. its best-matching input bullet must share >= 50% of the output's content words (else invented);
 * 2. SOURCES = the best match plus every other input bullet whose words that the best match lacks are >= 50%
 *    present in the output (a merge draws on several bullets);
 * 3. the output's set of numbers and its set of signal words must EQUAL the union over the sources (for a copy
 *    or reword: the best match alone): a changed port or version, or a dropped `không`/`never`/`must`, is a
 *    changed fact even when every other word matches.
 * A bullet with no content word cannot be verified and counts as offending. Heuristic: a legitimate reword that
 * drops a number or a signal word aborts the file (the owner reruns or edits by hand); `.bak` covers false accepts.
 */
export function nonDerivable(input: string[], output: string[]): string[] {
  const src = input.map(tokens);
  return output.filter((b) => {
    const out = tokens(b);
    if (out.words.size === 0) return true;
    const scores = src.map((s) => share(out.words, s.words));
    const bestAt = scores.indexOf(Math.max(...scores));
    if (bestAt < 0 || (scores[bestAt] ?? 0) < MIN_OVERLAP) return true;
    const best = src[bestAt] as Tokens;
    // A merge also draws on other bullets: those whose words NOT already in the best match show up in the
    // output. Near-duplicates (same words, other value) add no novel words the output uses, so they never count.
    const sources = src.filter((x, i) => {
      if (i === bestAt) return true;
      const novel = new Set([...x.words].filter((w) => !best.words.has(w)));
      return novel.size > 0 && share(novel, out.words) >= SOURCE_COVER;
    });
    const union = (key: "numbers" | "signals") => new Set(sources.flatMap((x) => [...x[key]]));
    return !(sameSet(out.numbers, union("numbers")) && sameSet(out.signals, union("signals")));
  });
}
