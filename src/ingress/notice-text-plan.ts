import type { OwnerLanguage, UserNotice } from "./user-copy";

/** Notices about the plan lifecycle: a plan that did not start, a revision that changed agreed work. */
export type PlanNotice = Extract<UserNotice, { kind: "plan-not-started" | "plan-revised" }>;

/** Type guard: true for the notices this module renders. */
export const isPlanNotice = (event: UserNotice): event is PlanNotice =>
  event.kind === "plan-not-started" || event.kind === "plan-revised";

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
  const parts = [
    ...(event.cancelled.length
      ? [say(`đã hủy: ${event.cancelled.join(", ")}`, `cancelled: ${event.cancelled.join(", ")}`)]
      : []),
    ...(event.added.length
      ? [say(`đã thêm: ${event.added.join(", ")}`, `added: ${event.added.join(", ")}`)]
      : []),
    ...(event.modified.length
      ? [say(`đã đổi: ${event.modified.join(", ")}`, `changed: ${event.modified.join(", ")}`)]
      : []),
    ...(event.criteriaChanged
      ? [say('tiêu chí "xong khi" đã đổi', 'the "done when" criteria changed')]
      : []),
  ];
  return say(
    `Kế hoạch đã thay đổi: ${parts.join("; ")}. Lý do: ${event.reason}. Bạn nói nếu muốn hoàn tác.`,
    `The plan changed: ${parts.join("; ")}. Reason: ${event.reason}. Tell me if you want any of it undone.`,
  );
}
