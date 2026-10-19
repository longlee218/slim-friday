import type { OwnerLanguage, UserNotice } from "./user-copy";

/** Notices about the plan lifecycle: a plan that did not start, a revision that changed agreed work. */
export type PlanNotice = Extract<
  UserNotice,
  { kind: "plan-not-started" | "plan-revised" | "plan-supersede-ask" }
>;

/** Type guard: true for the notices this module renders. */
export const isPlanNotice = (event: UserNotice): event is PlanNotice =>
  event.kind === "plan-not-started" ||
  event.kind === "plan-revised" ||
  event.kind === "plan-supersede-ask";

/** [vi, en] pairs by cause (no ids, no internal messages). */
const NOT_STARTED = {
  closed: [
    "Kế hoạch chưa bắt đầu vì việc này đã đóng hoặc không còn là việc đang mở.",
    "The plan did not start because its goal is closed or no longer the open one.",
  ],
  budget: [
    "Kế hoạch chưa bắt đầu vì ngân sách đã dùng hết.",
    "The plan did not start because the budget is already used up.",
  ],
  other: ["Kế hoạch chưa bắt đầu được.", "The plan could not start."],
} as const;

/** Render a plan notice in the owner's language. */
export function renderPlanNotice(event: PlanNotice, language: OwnerLanguage): string {
  const say = (vi: string, en: string) => (language === "vi" ? vi : en);
  if (event.kind === "plan-not-started") {
    const [vi, en] = NOT_STARTED[event.cause];
    return say(vi, en);
  }
  if (event.kind === "plan-supersede-ask") {
    const what = event.intent ? ` "${event.intent}"` : "";
    return say(
      `Hủy kế hoạch${what}, các việc đang chạy và kế hoạch của nó, rồi bắt đầu việc mới?`,
      `Cancel the plan goal${what}, its running work and its plan, and start a new goal instead?`,
    );
  }
  // One short line: "Plan v1 → v2: +a, −b, ~c", the cancelled work named, a changed criteria list flagged.
  const counts = `+${event.added.length}, −${event.cancelled.length}, ~${event.modified.length}`;
  const cancelled = event.cancelled.length
    ? say(` (đã hủy: ${event.cancelled.join(", ")})`, ` (cancelled: ${event.cancelled.join(", ")})`)
    : "";
  const criteria = event.criteriaChanged
    ? say('; tiêu chí "xong khi" đã đổi', '; "done when" criteria changed')
    : "";
  return `${say("Kế hoạch", "Plan")} v${event.from} → v${event.to}: ${counts}${cancelled}${criteria}`;
}
