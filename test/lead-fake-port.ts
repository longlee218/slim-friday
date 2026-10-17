import type {
  DispatchResult,
  DispatchWrite,
  EffectPort,
  NewEvent,
  OwnerAnswer,
  OwnerQuestion,
  PlanDecision,
  PlanRequestWrite,
  PlanView,
  Post,
  SteerReply,
  TaskSnapshot,
} from "../src/orchestrator/goal/effect-port";
import type { LeadToolContext } from "../src/orchestrator/lead/lead-call";
import type { GoalState, PolicyEnv } from "../src/orchestrator/strategy/caps";
import type { ItemRow } from "../src/storage/owned-item-store";

/** In-memory EffectPort for handler tests: records every effect, answers reads from fields the test sets. */
export class FakePort implements EffectPort {
  memo = new Map<string, string>();
  events: NewEvent[] = [];
  posts: Post[] = [];
  goals: { id: string; intent: string; supersedes?: string }[] = [];
  added: { goalId: string; keys: string[] }[] = [];
  cancelled: string[] = [];
  steered: { taskId: string; text: string }[] = [];
  asked: OwnerQuestion[] = [];
  /** Test-set reads. */
  goalState: GoalState = { items: [] };
  capsNow = { chainCount: 0, leadSpentTodayUsd: 0 };
  envNow: PolicyEnv = { workerRoles: ["developer", "scout"], locations: ["repo"] };
  rows = new Map<string, ItemRow>();
  steerReply: SteerReply = "queued";
  answer: OwnerAnswer = { answer: "yes", timedOut: false };

  recall = (key: string) => this.memo.get(key);
  /** Audit rows written by `remember` (scope / grantor overrides included). */
  audits: { key: string; tool?: string; scope?: string; grantedBy?: string }[] = [];
  remember = (
    key: string,
    e: { reply: string; tool?: string; scope?: string; grantedBy?: string },
  ) => {
    this.memo.set(key, e.reply);
    this.audits.push({ key, tool: e.tool, scope: e.scope, grantedBy: e.grantedBy });
  };
  state = () => this.goalState;
  caps = () => this.capsNow;
  env = () => this.envNow;
  snapshot = (taskId?: string): TaskSnapshot | undefined =>
    taskId && !this.rows.has(taskId) ? undefined : { goalId: "g1", intent: "do it", items: [] };
  item = (id: string) => this.rows.get(id);
  dispatch = (x: DispatchWrite): DispatchResult => {
    if (x.supersedes && x.supersedes !== this.goalState.openGoalId)
      return { ok: false, code: "BAD_TASK", message: "not this thread's goal" };
    const goalId = `goal${this.goals.length + 1}`;
    this.goals.push({
      id: goalId,
      intent: x.intent,
      ...(x.supersedes && { supersedes: x.supersedes }),
    });
    this.added.push({ goalId, keys: x.items.map((i) => i.key) });
    const itemIds = x.items.map((i) => `${goalId}-${i.key}`);
    for (const [i, it] of x.items.entries())
      this.events.push({
        id: `${x.key}:${i}`,
        kind: "start",
        taskId: goalId,
        itemId: itemIds[i],
        payload: { role: it.role, by: "lead" },
      });
    this.memo.set(x.key, JSON.stringify({ ok: true, goalId, itemIds }));
    return { ok: true, goalId, itemIds };
  };
  planRequests: PlanRequestWrite[] = [];
  plans = new Map<string, PlanView>();
  decisions: { planId: string; version: number; approve: boolean }[] = [];
  requestPlan = (w: PlanRequestWrite): DispatchResult => {
    if (w.goalId && w.goalId !== this.goalState.openGoalId)
      return { ok: false, code: "BAD_TASK", message: "not this thread's goal" };
    this.planRequests.push(w);
    return { ok: true, goalId: w.goalId ?? "goal-p", itemIds: ["planner-item"] };
  };
  plan = (planId: string, version: number) => this.plans.get(`${planId}:${version}`);
  decidePlan = (planId: string, version: number, approve: boolean): PlanDecision => {
    this.decisions.push({ planId, version, approve });
    return { ok: true, created: approve ? ["a", "b"] : [] };
  };
  appendEvent = (e: NewEvent) => (this.events.push(e), true);
  steer = (taskId: string, text: string) => (this.steered.push({ taskId, text }), this.steerReply);
  cancel = (taskId: string) => (this.cancelled.push(taskId), [taskId]);
  askOwner = async (q: OwnerQuestion) => (this.asked.push(q), this.answer);
  post = async (p: Post) => void this.posts.push(p);
}

/** One item row with defaults. */
export const itemRow = (over: Partial<ItemRow> = {}): ItemRow => ({
  id: "t1",
  parentId: "g1",
  itemKey: "main",
  status: "running",
  dependsOn: [],
  attempt: 0,
  dispatchCount: 1,
  ownerRole: null,
  location: null,
  brief: null,
  resultKind: null,
  resultPath: null,
  resultExcerpt: null,
  ...over,
});

/** A lead tool context over a fake port; `inputId` = the lead input, `leadTurnId` = this run. */
export const leadCtx = (
  port: FakePort,
  inputId = "in1",
  leadTurnId = `lt-${inputId}`,
): LeadToolContext => ({
  port,
  threadId: "th1",
  leadTurnId,
  inputId,
  run: { dispatched: 0 },
});
