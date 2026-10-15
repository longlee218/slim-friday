import type { RoleDefinition } from "../../roles/role-types";
import type { RouteProposal, RouteScores } from "./route-proposer";
import type { JevAnswers } from "./jev-answer-schema";
import {
  ACT_MIN,
  CONTINUE_MIN,
  JEV_UNCLEAR,
  MULTI_MIN,
  QUESTION_MIN,
  RATIO_CAP,
  RATIO_MIN,
  STOP_MAX,
} from "./jev-constants";

/**
 * Pure decision bands over the answers (numbers in, proposal out). Order: multi-intent -> question about the task -> continue the open task ->
 * `unclear` -> pick when the top probability clears the role's risk-scaled threshold AND leads the runner-up.
 * Anything else is `undecided` (the Haiku fallback follows). Every proposal carries the numbers behind it.
 */
export function decideBands(
  a: JevAnswers,
  roles: ReadonlyMap<string, RoleDefinition>,
): RouteProposal {
  // Role probabilities without the "none fits" option, best first.
  const ranked = Object.entries(a.role.probabilities)
    .filter(([name]) => name !== JEV_UNCLEAR)
    .sort((x, y) => y[1] - x[1]);
  const [best, next] = ranked;
  const top = a.role.probabilities[a.role.choice] ?? 0;
  // `second` includes the `unclear` probability on purpose: a strong "none fits" weakens the lead (stricter).
  const second = Math.max(
    0,
    ...Object.entries(a.role.probabilities)
      .filter(([name]) => name !== a.role.choice)
      .map(([, p]) => p),
  );
  const scores: RouteScores = {
    ranking: Object.fromEntries(ranked),
    top,
    ratio: second > 0 ? Math.min(top / second, RATIO_CAP) : RATIO_CAP,
    confidence: a.role.confidence,
    multiP: a.multi_intent.noul,
    ...(a.fits_last_role && { fitsLastP: a.fits_last_role.noul }),
    ...(a.asks_about_task && { questionP: a.asks_about_task.noul }),
    ...(a.continues_task && { continueP: a.continues_task.noul }),
  };
  const out = (p: RouteProposal, band: string): RouteProposal => ({
    ...p,
    scores: { ...scores, band },
  });
  const undecided = (reason: string) => out({ kind: "undecided", reason }, `undecided:${reason}`);

  if (a.multi_intent.noul >= MULTI_MIN && best && next)
    return out({ kind: "multi", roles: [best[0], next[0]] }, "multi");
  // A pure progress question beats `continue`: it must not resume the owner's task.
  if ((a.asks_about_task?.noul ?? 0) >= QUESTION_MIN) return out({ kind: "question" }, "question");
  const cont = a.continues_task?.noul;
  if (cont !== undefined) {
    if (cont >= CONTINUE_MIN) return out({ kind: "continue" }, "continue");
    if (cont > STOP_MAX) return undecided("low_confidence");
  }
  if (a.role.choice === JEV_UNCLEAR) return undecided("unclear");
  const role = roles.get(a.role.choice);
  if (!role) return undecided("unknown_role");
  if (top < ACT_MIN[role.sideEffects] || (scores.ratio ?? 0) < RATIO_MIN)
    return undecided("low_confidence");
  return out(
    {
      kind: "pick",
      role: role.name,
      alternatives: ranked.map(([n]) => n).filter((n) => n !== role.name),
    },
    "pick",
  );
}
