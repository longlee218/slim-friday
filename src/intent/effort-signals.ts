import type { Effort, TaskClass } from "../config/model-routing";
import type { CompiledLexicon } from "./load-lexicon";
import { tokenizeMessage } from "./normalize-text";
import { groupFires } from "./phrase-matcher";

/** L2 result. Only an effort ADJUSTMENT: the resolver (`resolveEffort`) applies it; it never picks a role. */
export interface EffortSignals {
  /** Thread floor +N (complaint); 0 = none. */
  floorDelta: number;
  /** This turn's signed delta. */
  turnDelta: number;
  /** Effort at least this. */
  minEffort?: Effort;
  /** Task class hint (design). */
  classHint?: TaskClass;
  /** Web lookup wanted. */
  lookup: boolean;
  /** Fired group ids (no message text). */
  ruleIds: string[];
}

const LEVELS: readonly Effort[] = ["low", "medium", "high", "max"];
/** One message can move one turn by at most this much, however many groups fire. */
const MAX_TURN_DELTA = 2;

/**
 * Run the lexicon over a message. Combination: floor = the strongest group (a complaint is +1, not +2 for
 * two phrasings), turn deltas add up (clamped), min effort = the highest, class hint = the first, lookup = any.
 */
export function computeEffortSignals(text: string, lexicon: CompiledLexicon): EffortSignals {
  const tokens = tokenizeMessage(text);
  const out: EffortSignals = { floorDelta: 0, turnDelta: 0, lookup: false, ruleIds: [] };
  for (const g of lexicon.groups) {
    if (!groupFires(tokens, g.phrases, g.weak)) continue;
    const e = g.effect;
    out.ruleIds.push(g.id);
    out.floorDelta = Math.max(out.floorDelta, e.floorDelta ?? 0);
    out.turnDelta += e.turnDelta ?? 0;
    if (e.minEffort && LEVELS.indexOf(e.minEffort) > LEVELS.indexOf(out.minEffort ?? "low")) {
      out.minEffort = e.minEffort;
    }
    out.classHint ??= e.classHint;
    out.lookup ||= e.lookup === true;
  }
  out.turnDelta = Math.max(-MAX_TURN_DELTA, Math.min(MAX_TURN_DELTA, out.turnDelta));
  return out;
}
