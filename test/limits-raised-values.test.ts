import { expect, test } from "bun:test";
import { z } from "zod";
import { CHAIN_CAP, DELEGATE_MAX, PLAN_MAX_ITEMS } from "../src/config/lead-caps";
import type { Route } from "../src/config/model-routing";
import { TASK_BUDGET_USD } from "../src/config/model-routing";
import { goalRoute } from "../src/orchestrator/budget/task-budget";
import { BRIEF_MAX_CHARS, MAX_ASSIGNMENTS } from "../src/orchestrator/lead/lead-limits";
import { buildEnvelope, toPlanItem } from "../src/orchestrator/plan/plan-doc";
import { renderPlan, renderPlanStem } from "../src/orchestrator/plan/plan-render";
import { CREATE_PLAN_SHAPE, PROPOSE_REVISION_SHAPE } from "../src/orchestrator/plan/plan-schemas";
import type { PlanDoc } from "../src/orchestrator/plan/plan-types";
import { validatePlan } from "../src/orchestrator/plan/validate-plan";
import { answerOutput } from "../src/orchestrator/run/answer-output";
import { buildChoicePrompt, SUMMARY_MAX } from "../src/providers/discord/approval/approval-text";
import { ROLES } from "../src/roles/role-registry";
import type { RunAgentResult } from "../src/runtime/run-agent";
import { insertOwnedTask, linkTurn } from "../src/storage/owned-task-store";
import { insertRun } from "../src/storage/run-metrics-store";
import { insertTurn } from "../src/storage/run-store";
import { makeEnv } from "./helpers";

/* Phase 3 of the limits plan: relations between the raised limits, the goal-left cap and a large plan. */

test("invariants between limits", () => {
  expect(MAX_ASSIGNMENTS).toBeGreaterThan(DELEGATE_MAX); // a bigger request than DELEGATE_MAX needs a plan
  expect(CHAIN_CAP).toBeGreaterThanOrEqual(DELEGATE_MAX);
  // The zod items bound is PLAN_MAX_ITEMS: exactly that many valid items parse, one more fails on the cap.
  const valid = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      key: `k${i}`,
      subject: "task",
      role: "scout",
      brief: "b",
      risk: "R0",
    }));
  const items = CREATE_PLAN_SHAPE.items;
  expect(items.safeParse(valid(PLAN_MAX_ITEMS)).success).toBe(true);
  const over = items.safeParse(valid(PLAN_MAX_ITEMS + 1));
  expect(over.success).toBe(false);
  expect(over.error?.issues.map((x) => x.code)).toEqual(["too_big"]);
  const env = CREATE_PLAN_SHAPE.envelope.shape.bounds.shape.maxItems;
  expect(env.safeParse(PLAN_MAX_ITEMS).success).toBe(true);
  expect(env.safeParse(PLAN_MAX_ITEMS + 1).success).toBe(false);
  for (const r of Object.values(ROLES)) expect(r.budgetUsd).toBeLessThanOrEqual(TASK_BUDGET_USD);
});

test("goalRoute: capUsd is what the goal has left, over every item's runs", () => {
  const { db } = makeEnv();
  insertOwnedTask(db, {
    id: "g",
    threadId: "th",
    ownerRole: "lead",
    status: "running",
    scope: "g",
    correlationId: "c",
  });
  for (const id of ["i1", "i2"]) {
    insertOwnedTask(db, {
      id,
      threadId: "th",
      ownerRole: "developer",
      status: "running",
      scope: id,
      correlationId: "c",
      parentId: "g",
      itemKey: id,
    });
    insertTurn(db, {
      id: `t-${id}`,
      threadId: "th",
      source: "t",
      location: "l",
      role: "developer",
    });
    linkTurn(db, `t-${id}`, id);
    insertRun(db, {
      id: `r-${id}`,
      turnId: `t-${id}`,
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 5,
      turns: 1,
      durationMs: 1,
      outcome: "success",
      compactions: 0,
    });
  }
  // Two parallel items that spent 5 each: a third run gets at most what is left of the goal budget.
  expect(goalRoute(db, "g").capUsd).toBeCloseTo(TASK_BUDGET_USD - 10);
  expect(goalRoute(db, "none").capUsd).toBe(TASK_BUDGET_USD); // nothing spent
});

test(`a ${PLAN_MAX_ITEMS}-item plan with ${BRIEF_MAX_CHARS}-char briefs validates and is sent as an attachment`, () => {
  const items = Array.from({ length: PLAN_MAX_ITEMS }, (_, i) =>
    toPlanItem({
      key: `k${i}`,
      subject: "task",
      role: "scout",
      brief: "x".repeat(BRIEF_MAX_CHARS),
      dependsOn: [],
      risk: "R0",
    }),
  );
  const envelope = buildEnvelope(
    { locations: [], riskClasses: ["R0"], bounds: { maxItems: PLAN_MAX_ITEMS, maxGb: 1 } },
    items,
    TASK_BUDGET_USD,
    [],
  );
  const doc: PlanDoc = { spec: "", plan: "", items, acceptanceCriteria: ["done"], envelope };
  // No body size cap: more than the old 16 KB validates.
  expect(JSON.stringify({ items }).length).toBeGreaterThan(16 * 1024);
  expect(
    validatePlan(doc, {
      workerRoles: ["scout"],
      locations: [],
      existingKeys: [],
      revisions: 0,
    }),
  ).toEqual([]);
  const text = renderPlan({ version: 1, objective: "big", doc });
  const q = buildChoicePrompt(text, ["Approve plan", "Reject plan"], "en");
  expect(q.detail).toBe(text); // the full text goes as the attachment
  expect(q.text.length).toBeLessThan(SUMMARY_MAX); // the stem stays one short message above the buttons
  // A caller's stem (the plan summary) replaces the clipped first lines; the attachment is still the full text.
  const s = buildChoicePrompt(
    text,
    ["Approve plan", "Reject plan"],
    "en",
    renderPlanStem({ version: 1, objective: "big", doc }),
  );
  expect(s.text).toContain("Steps:");
  expect(s.detail).toBe(text);
  expect(s.text.length).toBeLessThan(SUMMARY_MAX);
});

test("revision cancel and modify take as many keys as a plan holds", () => {
  const keys = Array.from({ length: PLAN_MAX_ITEMS }, (_, i) => `k${i}`);
  const base = { planId: "p", baseVersion: 1, reason: "r" };
  const parse = (o: object) =>
    z.object(PROPOSE_REVISION_SHAPE).safeParse({ ...base, ...o }).success;
  expect(parse({ cancel: keys })).toBe(true);
  expect(parse({ cancel: [...keys, "extra"] })).toBe(false);
  const mods = keys.map((key) => ({ key, brief: "b" }));
  expect(parse({ modify: mods })).toBe(true);
  expect(parse({ modify: [...mods, { key: "extra" }] })).toBe(false);
});

const fakeRun = (costUsd: number) =>
  ({ outcome: "error", sessionId: "s", text: "", usage: { costUsd } }) as unknown as RunAgentResult;

test("supervisor rerun: the goal-left cap shrinks by the first run's spend", async () => {
  const reruns: (Route | undefined)[] = [];
  const go = (capUsd: number, first: number) =>
    answerOutput({
      run: async (r) => {
        reruns.push(r);
        return fakeRun(r ? 0 : first);
      },
      route: { capUsd },
      recover: () => "hint",
    });
  await go(5, 5); // goal used up: no rerun
  expect(reruns).toEqual([undefined]);
  reruns.length = 0;
  await go(5, 2); // $3 left for the rerun
  expect(reruns).toHaveLength(2);
  expect(reruns[1]?.capUsd).toBeCloseTo(3);
});
