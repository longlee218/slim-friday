import type { enPlan } from "../en/plan";

export const viPlan: Record<keyof typeof enPlan, string> = {
  "plan.notStarted.closed":
    "Kế hoạch chưa chạy được vì việc này đã đóng hoặc không còn là việc đang mở.",
  "plan.notStarted.budget": "Kế hoạch chưa chạy được vì ngân sách đã hết.",
  "plan.notStarted.other": "Kế hoạch chưa chạy được.",
  "plan.supersede":
    "Hủy kế hoạch{intent} cùng các việc đang chạy của nó, rồi bắt đầu việc mới nhé?",
  "plan.revised": "Kế hoạch v{from} → v{to}: {counts}{cancelled}{criteria}",
  "plan.revised.cancelled": " (đã hủy: {keys})",
  "plan.revised.criteria": '; tiêu chí "xong khi" đã đổi',
  "plan.none": "Thread này chưa có kế hoạch nào.",
  "plan.goal": "Mục tiêu: {goal}",
  "plan.open": "Mở kế hoạch: {url}",
  "plan.versions": "Các phiên bản của kế hoạch:",
  "plan.current": "Kế hoạch v{version} ({status})",
  "plan.more": "… và {count} dòng nữa",
};
