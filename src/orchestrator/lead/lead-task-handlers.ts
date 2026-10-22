import {
  ORCHESTRATE_ACTION_ADD,
  ORCHESTRATE_ACTION_GET,
  ORCHESTRATE_ACTION_SEARCH,
  ORCHESTRATE_ACTION_UPDATE,
} from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import { excerpt } from "../../observability/logger";
import { SCOPE_CHARS } from "../../tasks/task-resolver";
import { duplicateRefusal } from "../goal/task-reads";
import { type Reply, refuse } from "../reply";
import { checkAdd, checkUpdate, type GoalView } from "../strategy/add-policy";
import { type LeadToolContext, leadCall } from "./lead-call";
import { badTask } from "./lead-handlers";
import type { AddItemInput, GetTaskInput, SearchTasksInput, UpdateItemInput } from "./task-schemas";

/* The lead's task-tool handlers: add a task to its open goal, change one that has not started, read one, search.
   Pure over the `EffectPort`: they check the structure owner, the caps and the registries, then act through the port. */

const GOAL_NOT_OPEN = "GOAL_NOT_OPEN";

/** The goal facts the policy reads, for goal `goalId` (the thread's open goal); a refusal when it is not that goal. */
function goalView(ctx: LeadToolContext, goalId: string): GoalView | Reply {
  const { port } = ctx;
  const meta = port.goal(goalId);
  if (!meta) return badTask(goalId);
  const state = port.state();
  if (state.openGoalId !== goalId)
    return refuse(
      GOAL_NOT_OPEN,
      `Goal ${goalId} is not this thread's open goal: dispatch new work instead.`,
    );
  return {
    owner: meta.structureOwner,
    items: state.items,
    chainCount: port.caps().chainCount,
    overBudget: meta.overBudget,
    env: port.env(),
  };
}

/** True when `v` is a refusal reply (not a goal view). */
const isReply = (v: GoalView | Reply): v is Reply => "ok" in v;

/**
 * Orchestrate add: one task in the thread's open goal. Refused: NOT_STRUCTURE_OWNER (a PLAN goal), GOAL_NOT_OPEN, NOT_WORKER,
 * BAD_LOCATION, DUPLICATE_KEY, UNKNOWN_DEP, DEAD_DEPENDENCY, CYCLE, NEEDS_PLAN (goal full), CHAIN_CAP, OVER_BUDGET and
 * DUPLICATE_SUSPECT (a similar open or recent task; `confirmNew` repeats the call). The next dispatch pass starts it.
 */
export const handleAdd = (ctx: LeadToolContext, input: AddItemInput): Promise<Reply> =>
  leadCall(ctx, ORCHESTRATE_ACTION_ADD, input, (key) => {
    const goalId = input.goalId ?? ctx.port.state().openGoalId;
    if (!goalId)
      return { reply: refuse(GOAL_NOT_OPEN, "The thread has no open goal: dispatch instead.") };
    const view = goalView(ctx, goalId);
    if (isReply(view)) return { reply: view };
    const checked = checkAdd(view, {
      key: input.key,
      subject: input.subject,
      priority: input.priority,
      role: input.role,
      brief: input.brief,
      ...(input.location && { location: input.location }),
      dependsOn: input.dependsOn,
    });
    if (!checked.ok) return { reply: refuse(checked.code, checked.message) };
    if (!input.confirmNew) {
      const dup = duplicateRefusal(
        ctx.port.similar([{ subject: input.subject, brief: input.brief }]),
      );
      if (dup) return { reply: dup };
    }
    const itemId = ctx.port.addItem({ key, goalId, item: checked.item });
    return {
      reply: { ok: true, goalId, itemId, status: checked.item.status },
      goalId,
      itemId,
      recorded: true,
    };
  });

/**
 * Orchestrate update: change a task that has not started. Refused: BAD_TASK (a goal, another thread), NOT_STRUCTURE_OWNER,
 * ITEM_STARTED (running or ended: use steer / retry / cancel), NO_CHANGE, NOT_WORKER, UNKNOWN_DEP, DEAD_DEPENDENCY, CYCLE.
 * New dependencies move the task to `pending` (something to wait for) or `ready` (nothing left).
 */
export const handleUpdate = (ctx: LeadToolContext, input: UpdateItemInput): Promise<Reply> =>
  leadCall(
    ctx,
    ORCHESTRATE_ACTION_UPDATE,
    input,
    () => {
      const item = ctx.port.item(input.taskId);
      if (!item?.parentId) return { reply: badTask(input.taskId) };
      const { taskId: _id, ...fields } = input;
      if (!Object.values(fields).some((v) => v !== undefined))
        return {
          reply: refuse(
            "NO_CHANGE",
            "Give at least one of subject, brief, priority, dependsOn, role.",
          ),
        };
      const view = goalView(ctx, item.parentId);
      if (isReply(view)) return { reply: view };
      const checked = checkUpdate(view, item, { role: input.role, dependsOn: input.dependsOn });
      if (!checked.ok) return { reply: refuse(checked.code, checked.message) };
      const moved = ctx.port.editItem(item.id, {
        subject: input.subject,
        brief: input.brief,
        ...(input.brief && { scope: excerpt(input.brief, SCOPE_CHARS) }),
        priority: input.priority,
        ownerRole: input.role,
        dependsOn: input.dependsOn,
        status: checked.status,
      });
      // The task started between the check and the write: nothing changed.
      if (!moved)
        return {
          reply: refuse(
            "ITEM_STARTED",
            "The task started meanwhile: nothing changed. Steer it while it runs, retry it if held, or cancel it.",
          ),
        };
      return { reply: { ok: true, updated: item.id }, itemId: item.id };
    },
    { fresh: true },
  ); // an update can be undone by the next one: never replay a stored result inside one run

/** Orchestrate get: one task or goal of this thread in full. A pure read. */
export const handleGet = (ctx: LeadToolContext, input: GetTaskInput): Promise<Reply> =>
  leadCall(ctx, ORCHESTRATE_ACTION_GET, input, () => ({ reply: ctx.port.detail(input.taskId) }), {
    read: true,
  });

/** Orchestrate search: this thread's goals and tasks by words. A pure read. */
export const handleSearch = (ctx: LeadToolContext, input: SearchTasksInput): Promise<Reply> =>
  leadCall(ctx, ORCHESTRATE_ACTION_SEARCH, input, () => ({ reply: ctx.port.search(input.query) }), {
    read: true,
  });
