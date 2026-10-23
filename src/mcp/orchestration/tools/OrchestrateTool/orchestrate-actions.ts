import { z } from "zod";
import type { LeadToolContext } from "../../../../orchestrator/lead/lead-call";
import {
  handleAskOwner,
  handleCancel,
  handleDispatch,
  handleForward,
  handleSteer,
} from "../../../../orchestrator/lead/lead-handlers";
import { handleRegisterLocation } from "../../../../orchestrator/lead/lead-location-handler";
import {
  handleApprovePlan,
  handleCreatePlan,
  handleRevisePlan,
} from "../../../../orchestrator/lead/lead-plan-handlers";
import { handleRetry } from "../../../../orchestrator/lead/lead-retry-handler";
import {
  ASK_OWNER_SHAPE,
  CANCEL_TASK_SHAPE,
  DISPATCH_AGENT_SHAPE,
  FORWARD_RESULT_SHAPE,
  REGISTER_LOCATION_SHAPE,
  RETRY_TASK_SHAPE,
  STEER_TASK_SHAPE,
} from "../../../../orchestrator/lead/lead-schemas";
import { handleAdd, handleUpdate } from "../../../../orchestrator/lead/lead-task-handlers";
import { ADD_ITEM_SHAPE, UPDATE_ITEM_SHAPE } from "../../../../orchestrator/lead/task-schemas";
import {
  APPROVE_PLAN_SHAPE,
  CREATE_LEAD_PLAN_SHAPE,
  PROPOSE_REVISION_SHAPE,
} from "../../../../orchestrator/plan/plan-schemas";
import { defineAction } from "../../../action-tool/action-types";
import {
  ORCHESTRATE_ACTION_ADD,
  ORCHESTRATE_ACTION_APPROVE_PLAN,
  ORCHESTRATE_ACTION_ASK_OWNER,
  ORCHESTRATE_ACTION_CANCEL,
  ORCHESTRATE_ACTION_CREATE_PLAN,
  ORCHESTRATE_ACTION_DISPATCH,
  ORCHESTRATE_ACTION_FORWARD,
  ORCHESTRATE_ACTION_REGISTER_LOCATION,
  ORCHESTRATE_ACTION_RETRY,
  ORCHESTRATE_ACTION_REVISE_PLAN,
  ORCHESTRATE_ACTION_SET_TITLE,
  ORCHESTRATE_ACTION_STEER,
  ORCHESTRATE_ACTION_UPDATE,
} from "./action-names";
import type { OrchestrateCtx } from "./orchestrate-ctx";
import { handleSetTitle } from "./set-title-handler";

/* The `Orchestrate` action table: each row binds an existing lead handler (the rules live there) to its schema. */

/** Binds a lead handler (it takes the lead ctx) to the tool's ctx. */
const onLead =
  <P>(fn: (ctx: LeadToolContext, params: P) => ReturnType<typeof handleDispatch>) =>
  (c: OrchestrateCtx, params: P) =>
    fn(c.lead, params);

const TASK = { taskId: "task-1" };
const SET_TITLE_SHAPE = {
  title: z.string().describe("Thread title: at most 6 words."),
  digest: z.string().describe("1-2 short lines on what the thread is about."),
};

/** Every action of the lead's `Orchestrate` tool. */
export const ORCHESTRATE_ACTIONS = [
  defineAction<OrchestrateCtx, typeof DISPATCH_AGENT_SHAPE>({
    name: ORCHESTRATE_ACTION_DISPATCH,
    schema: z.object(DISPATCH_AGENT_SHAPE),
    example: {
      strategy: "DIRECT",
      intent: "Fix the login bug",
      reason: "one developer covers it",
      assignments: [
        {
          key: "main",
          subject: "Fix the login bug",
          role: "developer",
          brief: "Fix the login bug in <location>.",
        },
      ],
    },
    run: onLead(handleDispatch),
  }),
  defineAction<OrchestrateCtx, typeof ADD_ITEM_SHAPE>({
    name: ORCHESTRATE_ACTION_ADD,
    schema: z.object(ADD_ITEM_SHAPE),
    example: {
      key: "docs",
      subject: "Update the docs",
      role: "humanizer-writer",
      brief: "Update the README for the new login flow.",
      dependsOn: ["main"],
    },
    run: onLead(handleAdd),
  }),
  defineAction<OrchestrateCtx, typeof UPDATE_ITEM_SHAPE>({
    name: ORCHESTRATE_ACTION_UPDATE,
    schema: z.object(UPDATE_ITEM_SHAPE),
    example: { ...TASK, priority: 10 },
    run: onLead(handleUpdate),
  }),
  defineAction<OrchestrateCtx, typeof STEER_TASK_SHAPE>({
    name: ORCHESTRATE_ACTION_STEER,
    schema: z.object(STEER_TASK_SHAPE),
    example: { ...TASK, text: "Use the staging db." },
    run: onLead(handleSteer),
  }),
  defineAction<OrchestrateCtx, typeof RETRY_TASK_SHAPE>({
    name: ORCHESTRATE_ACTION_RETRY,
    schema: z.object(RETRY_TASK_SHAPE),
    example: { ...TASK, note: "Re-run after fixing the import." },
    run: onLead(handleRetry),
  }),
  defineAction<OrchestrateCtx, typeof CANCEL_TASK_SHAPE>({
    name: ORCHESTRATE_ACTION_CANCEL,
    schema: z.object(CANCEL_TASK_SHAPE),
    example: { ...TASK, reason: "The owner dropped it." },
    run: onLead(handleCancel),
  }),
  defineAction<OrchestrateCtx, typeof FORWARD_RESULT_SHAPE>({
    name: ORCHESTRATE_ACTION_FORWARD,
    schema: z.object(FORWARD_RESULT_SHAPE),
    example: { ...TASK, mode: "verbatim" },
    run: onLead(handleForward),
  }),
  defineAction<OrchestrateCtx, typeof ASK_OWNER_SHAPE>({
    name: ORCHESTRATE_ACTION_ASK_OWNER,
    schema: z.object(ASK_OWNER_SHAPE),
    example: { question: "Which branch?", kind: "select", options: ["main", "release"] },
    run: onLead(handleAskOwner),
  }),
  defineAction<OrchestrateCtx, typeof CREATE_LEAD_PLAN_SHAPE>({
    name: ORCHESTRATE_ACTION_CREATE_PLAN,
    schema: z.object(CREATE_LEAD_PLAN_SHAPE),
    example: {
      objective: "Add OAuth login to the app",
      spec: "# Spec\nWhat is built and why ...",
      plan: "# Plan\n## Login\nSteps, files, checks ...",
      items: [
        {
          key: "build-login",
          subject: "Build OAuth login",
          role: "developer",
          brief: "goal: ...\ninputs: ...\ndeliver: ...\ndone when: ...",
          section: "Login",
          location: "app",
          dependsOn: [],
          risk: "R1",
        },
      ],
      acceptanceCriteria: ["go test ./... passes", "login redirects to /home"],
      envelope: {
        locations: ["app"],
        riskClasses: ["R0", "R1"],
        bounds: { maxItems: 3, maxGb: 1 },
      },
      effects: [],
    },
    run: onLead(handleCreatePlan),
  }),
  defineAction<OrchestrateCtx, typeof PROPOSE_REVISION_SHAPE>({
    name: ORCHESTRATE_ACTION_REVISE_PLAN,
    schema: z.object(PROPOSE_REVISION_SHAPE),
    example: {
      planId: "plan-1",
      baseVersion: 1,
      cancel: ["old-step"],
      reason: "the owner dropped it",
    },
    run: onLead(handleRevisePlan),
  }),
  defineAction<OrchestrateCtx, typeof APPROVE_PLAN_SHAPE>({
    name: ORCHESTRATE_ACTION_APPROVE_PLAN,
    schema: z.object(APPROVE_PLAN_SHAPE),
    example: { planId: "plan-1", version: 1 },
    run: onLead(handleApprovePlan),
  }),
  defineAction<OrchestrateCtx, typeof SET_TITLE_SHAPE>({
    name: ORCHESTRATE_ACTION_SET_TITLE,
    schema: z.object(SET_TITLE_SHAPE),
    example: { title: "Fix login bug", digest: "Owner asks about the login bug." },
    run: handleSetTitle,
  }),
  defineAction<OrchestrateCtx, typeof REGISTER_LOCATION_SHAPE>({
    name: ORCHESTRATE_ACTION_REGISTER_LOCATION,
    schema: z.object(REGISTER_LOCATION_SHAPE),
    example: { create: true, name: "todo-app" },
    run: (c, p) => handleRegisterLocation(c.lead, p),
  }),
];
