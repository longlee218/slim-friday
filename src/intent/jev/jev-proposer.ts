import { ROLES } from "../../roles/role-registry";
import type { RoleDefinition } from "../../roles/role-types";
import type { ProposeInput, RouteProposal, RouteProposer } from "../../routing/route-proposer";
import { parseJevAnswers } from "./jev-answer-schema";
import { decideBands } from "./jev-bands";
import { type JevClient, JevError } from "./jev-client";
import { JEV_UNCLEAR } from "./jev-constants";
import { buildJevQuestions } from "./jev-questions";
import { buildJevState } from "./jev-state";

/**
 * Route proposer over Jev (TypeSafe System One): ONE request per call (state + typed questions), zod-checked
 * answers, decision bands. Never throws: a timeout, an error, an abort or an invalid answer is an `undecided`
 * proposal with a reason, so the policy runs the Haiku fallback. `roles` is read per call (registry data, no names).
 */
export function createJevProposer(
  client: JevClient,
  roles: () => RoleDefinition[] = () => Object.values(ROLES),
): RouteProposer {
  return {
    async propose(input: ProposeInput, signal?: AbortSignal): Promise<RouteProposal> {
      const t0 = Date.now();
      const all = roles();
      const byName = new Map(all.filter((r) => r.whenToUse).map((r) => [r.name, r]));
      const undecided = (reason: string): RouteProposal => ({
        kind: "undecided",
        reason,
        scores: { band: `undecided:${reason}`, ms: Date.now() - t0 },
      });
      try {
        const questions = buildJevQuestions(all, {
          hasTask: !!input.task,
          lastRole: input.lastRole ? ROLES[input.lastRole] : undefined,
        });
        const raw = await client.ask(buildJevState(input), questions, signal);
        const answers = parseJevAnswers(raw.answers, new Set([...byName.keys(), JEV_UNCLEAR]));
        if (!answers) return undecided("invalid_answer");
        const p = decideBands(answers, byName);
        return { ...p, scores: { ...p.scores, ms: Date.now() - t0 } };
      } catch (err) {
        return undecided(err instanceof JevError ? err.reason : "error");
      }
    },
  };
}
