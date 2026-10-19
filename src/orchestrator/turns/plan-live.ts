import type { PlanFacts, PlanLookup } from "../../ingress/plan-copy";
import { redactClip } from "../../observability/redact";
import { childrenOf } from "../../storage/owned-item-store";
import { planGoalOfThread, planIdOfGoal, planVersions } from "../../storage/work-plan-store";
import {
  currentVersion,
  type PlanViewDeps,
  planUrl,
  syncPlanArtifacts,
} from "../plan/plan-artifact";
import { docOfRow } from "../plan/plan-doc";

/* Facts of `/plan`: the thread's open goal that has a plan (else the newest plan), its current version with a live status per item, or all versions. */

/** Chars of a version's reason and of an item subject shown in the reply. */
const REASON_CHARS = 100;
const SUBJECT_CHARS = 60;
const GOAL_CHARS = 80;

/** Date and minute of an epoch ms, UTC (`2026-10-19 14:39`). */
const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** `/plan` over the db: also saves/refreshes the plan artifacts, so the link opens the current state. */
export function createPlanLookup(d: PlanViewDeps): PlanLookup {
  return (threadId, history): PlanFacts => {
    const found = planGoalOfThread(d.db, threadId);
    const goalId = found?.goalId;
    const planId = goalId && planIdOfGoal(d.db, goalId);
    if (!goalId || !planId) return { kind: "none" };
    const goal = redactClip(found.objective.replace(/\s+/g, " ").trim(), GOAL_CHARS);
    const infos = syncPlanArtifacts(d, threadId, goalId);
    const url = planUrl(d, infos);
    if (history)
      return {
        kind: "history",
        goal,
        versions: infos.map((v) => ({
          version: v.version,
          status: v.status,
          at: stamp(v.createdAt),
          reason: v.reason ? redactClip(v.reason, REASON_CHARS) : null,
        })),
        url,
      };
    const cur = currentVersion(infos);
    const row = planVersions(d.db, planId).find((r) => r.version === cur?.version);
    if (!cur || !row) return { kind: "none" };
    const live = new Map(childrenOf(d.db, goalId).map((i) => [i.itemKey ?? i.id, i.status]));
    return {
      kind: "current",
      version: cur.version,
      status: cur.status,
      goal,
      items: docOfRow(row).items.map((i) => ({
        key: i.key,
        subject: redactClip(i.subject, SUBJECT_CHARS),
        status: cur.status === "approved" ? (live.get(i.key) ?? "not started") : cur.status,
      })),
      url,
    };
  };
}
