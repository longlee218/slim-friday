import { DEFAULT_LANGUAGE } from "../../i18n/languages";
import { type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { postTo, type TeammateRuntime, type TeammateThreadCtx } from "../teammate/teammate-runtime";
import { planLinks, planUrlOfGoal, syncPlanArtifacts } from "./plan-artifact";
import { type RevisionDiff, revisionNotice } from "./plan-revised";

/** Logger of this module. */
const log = logger.child({ module: "plan-side-effects" });

/** What the teammate's plan actions do beyond the db write: the plan artifacts of the channel and the one owner line. */
export interface PlanSideEffects {
  /** A plan version was stored: save it as an artifact. Never throws. */
  onVersion(goalId: string): void;
  /** An applied re-plan or revision: one line "Plan vN → vM" with the viewer link (a failed post is only logged). */
  notify(goalId: string, diff: RevisionDiff, language?: OwnerLanguage): void;
}

/** The side effects of the plan actions of one thread. */
export function planSideEffects(
  rt: TeammateRuntime,
  ctx: TeammateThreadCtx,
  threadId: string,
): PlanSideEffects {
  const { db } = rt.deps;
  const view = { db, home: rt.deps.config.agentHome, viewer: rt.deps.config.viewer };
  return {
    onVersion: (goalId) => void syncPlanArtifacts(view, threadId, goalId),
    notify: (goalId, diff, language) => {
      const url = planUrlOfGoal(view, threadId, goalId);
      void postTo(ctx, renderUserNotice(revisionNotice(diff), language ?? DEFAULT_LANGUAGE), {
        links: planLinks(url),
      }).catch((err: unknown) =>
        logEvent(log, "plan.notice_failed", { threadId, err: errText(err) }, "warn"),
      );
    },
  };
}
