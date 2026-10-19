import type { PlannerCtx } from "../../../../orchestrator/plan/planner-handlers";
import { createActionTool } from "../../../action-tool/create-action-tool";
import { PLAN_TOOL } from "./constants";
import { PLAN_ACTIONS } from "./plan-actions";
import { PLAN_INTRO } from "./prompt";

/** The `Plan` tool: a thin dispatcher from `{ action, params }` to the planner handlers. */
export const createPlanTool = (ctx: PlannerCtx) =>
  createActionTool({ name: PLAN_TOOL, intro: PLAN_INTRO, ctx, actions: PLAN_ACTIONS });
