/* Plan texts: lifecycle notices (`notice-text-plan.ts`) and `/plan` (`plan-copy.ts`). */
export const enPlan = {
  "plan.notStarted.closed":
    "The plan didn't start: its goal is closed, or it's no longer the open one.",
  "plan.notStarted.budget": "The plan didn't start: the budget is already used up.",
  "plan.notStarted.other": "The plan couldn't start.",
  "plan.supersede":
    "Cancel the plan goal{intent} along with its running work and plan, and start a new goal instead?",
  "plan.revised": "Plan v{from} → v{to}: {counts}{cancelled}{criteria}",
  "plan.revised.cancelled": " (cancelled: {keys})",
  "plan.revised.criteria": '; the "done when" criteria changed',
  "plan.none": "This thread has no plan yet.",
  "plan.goal": "Goal: {goal}",
  "plan.open": "Open the plan: {url}",
  "plan.versions": "Plan versions:",
  "plan.current": "Plan v{version} ({status})",
  "plan.more": "… and {count} more",
} as const;
