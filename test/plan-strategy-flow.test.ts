import { expect, test } from "bun:test";
import { listUndelivered } from "../src/storage/thread-event-store";
import { leadHarness, until } from "./lead-harness";

/* End to end with a fake query: owner asks something big -> lead RequestPlan -> planner (GetProjectContext, CreatePlan,
   ValidatePlan, ReportResult) -> announce of plan-ready -> lead ApprovePlan -> ONE owner question -> the 3 items run one
   after another -> announce of the result. The lead never plans: the plan comes only from the planner's tools. */

const GOAL = /Goal id: ([0-9a-f-]{36})/;
const PLAN_ID = /"planId":"([0-9a-f-]{36})"/;
const item = (key: string, dependsOn: string[] = []) => ({
  key,
  role: "developer",
  brief: `do ${key}`,
  location: "location",
  dependsOn,
  risk: "R1",
});

test("owner big ask -> RequestPlan -> planner plan -> one approval -> items run in order -> announce", async () => {
  const questions: { question: string; options: string[] }[] = [];
  const order: string[] = [];
  const leadTools: string[] = [];
  const h = leadHarness(
    async (c) => {
      if (c.kind === "planner") {
        const goalId = GOAL.exec(c.prompt)?.[1] as string;
        expect((await c.tool("GetProjectContext", { goalId })).request).toContain("todo app");
        expect((await c.tool("GetAgentCapabilities", {})).roles.map((r: any) => r.name)).toContain(
          "developer",
        );
        const made = await c.tool("CreatePlan", {
          goalId,
          items: [item("model"), item("api", ["model"]), item("ui", ["api"])],
          acceptanceCriteria: ["the app runs"],
          envelope: {
            locations: ["location"],
            riskClasses: ["R0", "R1"],
            bounds: { maxItems: 8, maxGb: 1 },
          },
          budgetUsd: 4,
          effects: [],
        });
        expect(made).toMatchObject({ ok: true, version: 1, status: "valid" });
        expect((await c.tool("ValidatePlan", { planId: made.planId, version: 1 })).valid).toBe(
          true,
        );
        await c.tool("ReportResult", { status: "COMPLETED", summary: `plan ${made.planId} v1` });
        return "planned";
      }
      if (c.kind === "worker") {
        order.push(/do (\w+)/.exec(c.prompt)?.[1] ?? "?");
        await c.tool("ReportResult", { status: "COMPLETED", summary: "done" });
        return "worker done";
      }
      if (c.prompt.includes("Owner message:\nbuild a todo app")) {
        // The lead's only move is RequestPlan: it has no plan tool and a direct dispatch would be NEEDS_PLAN.
        leadTools.push("RequestPlan");
        expect(
          await c.tool("RequestPlan", { objective: "build a todo app", findings: "empty repo" }),
        ).toMatchObject({ ok: true });
        return "Planning it.";
      }
      const plan = PLAN_ID.exec(c.prompt)?.[1];
      if (plan && !leadTools.includes("ApprovePlan")) {
        leadTools.push("ApprovePlan");
        const r = await c.tool("ApprovePlan", { planId: plan, version: 1 });
        expect(r).toMatchObject({ ok: true, status: "approved", items: ["model", "api", "ui"] });
        return "Plan approved, running.";
      }
      return c.prompt.includes('"key":"ui"') ? "All three steps are done." : "";
    },
    undefined,
    {
      askChoice: async (a) => {
        questions.push({ question: a.question, options: a.options });
        return "Approve plan";
      },
    },
  );
  await h.send("build a todo app");
  await until(() => h.posts.includes("All three steps are done."), 15000);
  expect(h.posts[0]).toBe("Planning it.");
  expect(h.posts).toContain("Plan approved, running.");
  // One owner question for the whole plan, listing the steps and the limits.
  expect(questions).toHaveLength(1);
  expect(questions[0]!.question).toContain("1. model");
  expect(questions[0]!.question).toContain("3. ui");
  expect(questions[0]!.question).toContain("delivery: keep");
  // Sequential, in dependency order; the planner ran once and never did the work.
  expect(order).toEqual(["model", "api", "ui"]);
  expect(h.ofKind("planner")).toHaveLength(1);
  const rows = h.env.db
    .query(
      "SELECT item_key AS k, status FROM owned_tasks WHERE parent_id IS NOT NULL ORDER BY rowid",
    )
    .all();
  expect(rows).toEqual([
    { k: "planner", status: "completed" },
    { k: "model", status: "completed" },
    { k: "api", status: "completed" },
    { k: "ui", status: "completed" },
  ]);
  expect(h.env.db.query("SELECT status FROM owned_tasks WHERE parent_id IS NULL").all()).toEqual([
    { status: "completed" },
  ]);
  expect(h.env.db.query("SELECT status, version FROM work_plans").all()).toEqual([
    { status: "approved", version: 1 },
  ]);
  expect(listUndelivered(h.env.db, "t1").filter((e) => e.kind !== "start")).toEqual([]);
});

test("owner rejects the plan -> no item runs, the goal is cancelled, the lead says so", async () => {
  const h = leadHarness(
    async (c) => {
      if (c.kind === "planner") {
        const goalId = GOAL.exec(c.prompt)?.[1] as string;
        const made = await c.tool("CreatePlan", {
          goalId,
          items: [item("only")],
          acceptanceCriteria: [],
          envelope: {
            locations: ["location"],
            riskClasses: ["R1"],
            bounds: { maxItems: 2, maxGb: 1 },
          },
          budgetUsd: 1,
          effects: [],
        });
        await c.tool("ReportResult", { status: "COMPLETED", summary: `plan ${made.planId}` });
        return "planned";
      }
      if (c.kind === "worker") throw new Error("no item may run");
      if (c.prompt.includes("Owner message:\nbuild")) {
        await c.tool("RequestPlan", { objective: "build it" });
        return "Planning.";
      }
      const plan = PLAN_ID.exec(c.prompt)?.[1];
      if (plan) {
        expect(await c.tool("ApprovePlan", { planId: plan, version: 1 })).toMatchObject({
          ok: true,
          status: "rejected",
        });
        return "Understood, plan dropped.";
      }
      return "";
    },
    undefined,
    { askChoice: async () => "Reject plan" },
  );
  await h.send("build it");
  await until(() => h.posts.includes("Understood, plan dropped."), 15000);
  expect(h.ofKind("worker")).toHaveLength(0);
  expect(h.env.db.query("SELECT status FROM work_plans").all()).toEqual([{ status: "rejected" }]);
  expect(h.env.db.query("SELECT status FROM owned_tasks WHERE parent_id IS NULL").all()).toEqual([
    { status: "cancelled" },
  ]);
});
