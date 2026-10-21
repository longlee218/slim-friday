import { jaccard } from "../orchestrator/goal/task-match";
import { bulletTokens, bulletWords, SIMILAR } from "./dream-sections";
import { chunkMemory } from "./index/memory-chunker";
import { MEMORY_SECTION_HEADINGS } from "./memory-sections";

/** Fewest content words either bullet needs for the near-duplicate check; a shorter one is judged by exact text only. */
const MIN_TOKENS = 3;

/** Where an existing bullet sits: the pieces of its entry id (`channel/<name>#<token>:<n>~<hash>`). */
export interface BulletRef {
  token: string;
  n: number;
  /** First 6 hex of the id hash. */
  hash: string;
}

/**
 * The bullet of a MEMORY.md text that `clean` (sanitized text, no date) most resembles, or null: token Jaccard >=
 * SIMILAR (the dream and work-item threshold). Only bullets inside the kind sections count (the only ones
 * `MemoryEdit` may change), so a refusal always names a bullet the lead can edit. Equal normalized text scores 1.
 */
export function findSimilarBullet(text: string, clean: string): BulletRef | null {
  // Too short to judge (fewer than MIN_TOKENS content words): never a near-duplicate.
  if (bulletWords(clean).size < MIN_TOKENS) return null;
  const mine = bulletTokens(clean);
  let best: BulletRef | null = null;
  let top = SIMILAR - Number.EPSILON;
  for (const c of chunkMemory(text, "")) {
    if (!MEMORY_SECTION_HEADINGS.includes(c.token)) continue;
    if (bulletWords(c.text).size < MIN_TOKENS) continue;
    const score = jaccard(mine, bulletTokens(c.text));
    if (score > top) {
      top = score;
      best = { token: c.token, n: c.n, hash: c.hash };
    }
  }
  return best;
}
