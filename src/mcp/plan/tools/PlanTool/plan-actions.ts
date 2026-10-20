import { z } from "zod";
import { GET_TASK_SHAPE, SEARCH_TASKS_SHAPE } from "../../../../orchestrator/lead/task-schemas";
import {
  CREATE_PLAN_SHAPE,
  GOAL_SHAPE,
  PROPOSE_REVISION_SHAPE,
  VALIDATE_PLAN_SHAPE,
} from "../../../../orchestrator/plan/plan-schemas";
import {
  createPlanHandler,
  getAgentCapabilities,
  getProjectContext,
  type PlannerCtx,
  proposeRevisionHandler,
  validatePlanHandler,
} from "../../../../orchestrator/plan/planner-handlers";
import {
  getTaskHandler,
  listGoalItems,
  searchTasksHandler,
} from "../../../../orchestrator/plan/progress-handlers";
import { defineAction } from "../../../action-tool/action-types";
import {
  PLAN_ACTION_CAPABILITIES,
  PLAN_ACTION_CONTEXT,
  PLAN_ACTION_CREATE,
  PLAN_ACTION_GET,
  PLAN_ACTION_LIST,
  PLAN_ACTION_REVISE,
  PLAN_ACTION_SEARCH,
  PLAN_ACTION_VALIDATE,
} from "./action-names";

/* The `Plan` action table: each row binds an existing planner handler (the rules live there) to its schema. */

const goal = z.object(GOAL_SHAPE);
const EXAMPLE_GOAL = { goalId: "goal-1" };
const EXAMPLE_ITEM = { key: "a", subject: "Do a", role: "developer", brief: "Do a", risk: "R1" };
const EXAMPLE_ENVELOPE = {
  locations: ["location"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};

/** Every action of the planner's `Plan` tool. */
export const PLAN_ACTIONS = [
  defineAction<PlannerCtx, typeof GOAL_SHAPE>({
    name: PLAN_ACTION_CONTEXT,
    schema: goal,
    example: EXAMPLE_GOAL,
    run: getProjectContext,
  }),
  defineAction<PlannerCtx, Record<string, never>>({
    name: PLAN_ACTION_CAPABILITIES,
    schema: z.object({}),
    example: {},
    run: (c) => getAgentCapabilities(c),
  }),
  defineAction<PlannerCtx, typeof CREATE_PLAN_SHAPE>({
    name: PLAN_ACTION_CREATE,
    schema: z.object(CREATE_PLAN_SHAPE),
    example: {
      ...EXAMPLE_GOAL,
      items: [EXAMPLE_ITEM],
      acceptanceCriteria: ["tests pass"],
      envelope: EXAMPLE_ENVELOPE,
      effects: [],
    },
    run: createPlanHandler,
  }),
  defineAction<PlannerCtx, typeof VALIDATE_PLAN_SHAPE>({
    name: PLAN_ACTION_VALIDATE,
    schema: z.object(VALIDATE_PLAN_SHAPE),
    example: { planId: "plan-1", version: 1 },
    run: validatePlanHandler,
  }),
  defineAction<PlannerCtx, typeof PROPOSE_REVISION_SHAPE>({
    name: PLAN_ACTION_REVISE,
    schema: z.object(PROPOSE_REVISION_SHAPE),
    example: { planId: "plan-1", baseVersion: 1, add: [EXAMPLE_ITEM], reason: "one more step" },
    run: proposeRevisionHandler,
  }),
  defineAction<PlannerCtx, typeof GOAL_SHAPE>({
    name: PLAN_ACTION_LIST,
    schema: goal,
    example: EXAMPLE_GOAL,
    run: listGoalItems,
  }),
  defineAction<PlannerCtx, typeof GET_TASK_SHAPE>({
    name: PLAN_ACTION_GET,
    schema: z.object(GET_TASK_SHAPE),
    example: { taskId: "task-1" },
    run: getTaskHandler,
  }),
  defineAction<PlannerCtx, typeof SEARCH_TASKS_SHAPE>({
    name: PLAN_ACTION_SEARCH,
    schema: z.object(SEARCH_TASKS_SHAPE),
    example: { query: "login" },
    run: searchTasksHandler,
  }),
];
