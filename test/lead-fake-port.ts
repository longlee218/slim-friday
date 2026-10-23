import type {
  DispatchResult,
  DispatchWrite,
  EffectPort,
  NewEvent,
  OwnerAnswer,
  OwnerQuestion,
  PlanDecision,
  PlanReviseWrite,
  PlanView,
  PlanWriteResult,
  Post,
  SteerReply,
  TaskSnapshot,
} from "../src/orchestrator/goal/effect-port";
import type { ForwardPlan } from "../src/orchestrator/goal/effect-port-forward";
import type { AddItemWrite, GoalFacts } from "../src/orchestrator/goal/effect-port-item-types";
import type { TaskMatch } from "../src/orchestrator/goal/task-reads";
import type { LeadToolContext } from "../src/orchestrator/lead/lead-call";
import type { CreateLeadPlanInput } from "../src/orchestrator/plan/plan-schemas";
import type { GoalState, PolicyEnv } from "../src/orchestrator/strategy/caps";
import type { ItemEdit } from "../src/storage/item-edit-store";
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
  capsNow = { chainCount: 0 };
  envNow: PolicyEnv = { workerRoles: ["developer", "scout"], locations: ["repo"] };
  rows = new Map<string, ItemRow>();
  steerReply: SteerReply = "queued";
  answer: OwnerAnswer = { answer: "yes", timedOut: false };

  /** Test-set forwards: what `forwardArtifacts` returns for a task. */
  forwards = new Map<string, ForwardPlan>();
  forwardArtifacts = (taskId: string) => this.forwards.get(taskId);
  /** Test-set result messages (the newest `result` message of a task). */
  results = new Map<string, { ref: string; text: string }>();
  resultMessage = (taskId: string) => this.results.get(taskId);

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
  plans = new Map<string, PlanView>();
  decisions: { planId: string; version: number; approve: boolean }[] = [];
  planCreates: CreateLeadPlanInput[] = [];
  planRevisions: PlanReviseWrite[] = [];
  /** Test-set reply of the next `createPlan` / `revisePlan` (default: stored as version 1 of a goal). */
  planWrite: PlanWriteResult | undefined;
  createPlan = (input: CreateLeadPlanInput): PlanWriteResult => {
    this.planCreates.push(input);
    return (
      this.planWrite ?? {
        ok: true,
        goalId: input.goalId ?? "goal-p",
        planId: "plan-p",
        version: 1,
        status: "valid",
      }
    );
  };
  revisePlan = (w: PlanReviseWrite): PlanWriteResult => {
    this.planRevisions.push(w);
    return (
      this.planWrite ?? {
        ok: true,
        goalId: this.goalState.openGoalId ?? "goal-p",
        planId: w.planId,
        version: w.baseVersion + 1,
        status: "valid",
      }
    );
  };
  plan = (planId: string, version: number) => this.plans.get(`${planId}:${version}`);
  /** Test-set plan version waiting for `approve_plan`. */
  pending: { planId: string; version: number } | undefined;
  pendingPlan = () => this.pending;
  decidePlan = (planId: string, version: number, approve: boolean): PlanDecision => {
    this.decisions.push({ planId, version, approve });
    return { ok: true, created: approve ? ["a", "b"] : [] };
  };
  appendEvent = (e: NewEvent) => (this.events.push(e), true);
  steer = (taskId: string, text: string) => (this.steered.push({ taskId, text }), this.steerReply);
  cancel = (taskId: string) => (this.cancelled.push(taskId), [taskId]);
  retried: { taskId: string; note: string }[] = [];
  retry = (taskId: string, note: string) => {
    this.retried.push({ taskId, note });
    return "ok" as const;
  };
  /** Task-tool reads and writes (test-set): goal facts, what `addItem` / `editItem` received, the matches `similar` returns. */
  goalFacts = new Map<string, GoalFacts>();
  addedItems: AddItemWrite[] = [];
  edits: { taskId: string; edit: ItemEdit }[] = [];
  matches: TaskMatch[] = [];
  goal = (id: string): GoalFacts | undefined =>
    this.goalFacts.get(id) ?? { structureOwner: "lead", overBudget: false };
  addItem = (w: AddItemWrite) => {
    this.addedItems.push(w);
    return `new-${this.addedItems.length}`;
  };
  editItem = (taskId: string, edit: ItemEdit) => {
    this.edits.push({ taskId, edit });
    return true;
  };
  similar = () => this.matches;
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
  subject: null,
  priority: 0,
  lastProgressAt: Date.now(),
  resultKind: null,
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
