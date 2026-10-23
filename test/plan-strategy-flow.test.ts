import { expect, test } from "bun:test";
import { listUndelivered } from "../src/storage/thread-event-store";
import { leadHarness, until } from "./lead-harness";

/* End to end with a fake query: owner asks something big -> lead Orchestrate create_plan (it writes the plan itself) -> lead
   Orchestrate approve_plan -> ONE owner question -> the 3 items run one after another -> announce of the result. */

const item = (key: string, dependsOn: string[] = []) => ({
  key,
  subject: `Do ${key}`,
  role: "developer",
  brief: `do ${key}`,
  location: "location",
  dependsOn,
  risk: "R1",
});

test("owner big ask -> Orchestrate create_plan -> one approval -> items run in order -> announce", async () => {
  const questions: { question: string; options: string[] }[] = [];
  const order: string[] = [];
  const h = leadHarness(
    async (c) => {
      if (c.kind === "worker") {
        order.push(/\[brief\] lead: do (\w+)/.exec(c.prompt)?.[1] ?? "verify"); // the code-appended verify has no `do <key>` brief
        await c.report("result", { title: "T", status: "COMPLETED", summary: "done" });
        return "worker done";
      }
      if (c.prompt.includes("<owner_message>\nbuild a todo app")) {
        const made = await c.orchestrate("create_plan", {
          objective: "build a todo app",
          spec: "# Spec\nA todo app.",
          plan: "# Plan\nmodel, api, ui",
          items: [item("model"), item("api", ["model"]), item("ui", ["api"])],
          acceptanceCriteria: ["the app runs"],
          envelope: {
            locations: ["location"],
            riskClasses: ["R0", "R1"],
            bounds: { maxItems: 8, maxGb: 1 },
          },
          effects: [],
        });
        expect(made).toMatchObject({ ok: true, version: 1, status: "valid" });
        const r = await c.orchestrate("approve_plan", { planId: made.planId, version: 1 });
        expect(r).toMatchObject({ ok: true, status: "approved", items: ["model", "api", "ui"] });
        return "Plan approved, running.";
      }
      return c.prompt.includes('"key":"verify-1"') ? "All three steps are done." : "";
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
  expect(h.posts[0]).toBe("Plan approved, running.");
  // One owner question for the whole plan, listing the steps and the limits.
  expect(questions).toHaveLength(1);
  expect(questions[0]!.question).toContain("1. model");
  expect(questions[0]!.question).toContain("3. ui");
  expect(questions[0]!.question).toContain("delivery: keep");
  // Sequential, in dependency order; no planner run exists.
  expect(order).toEqual(["model", "api", "ui", "verify"]); // verify last, after every item
  const rows = h.env.db
    .query(
      "SELECT item_key AS k, status FROM owned_tasks WHERE parent_id IS NOT NULL ORDER BY rowid",
    )
    .all();
  expect(rows).toEqual([
    { k: "model", status: "completed" },
    { k: "api", status: "completed" },
    { k: "ui", status: "completed" },
    { k: "verify-1", status: "completed" },
  ]);
  expect(h.env.db.query("SELECT status FROM owned_tasks WHERE parent_id IS NULL").all()).toEqual([
    { status: "completed" },
  ]);
  expect(h.env.db.query("SELECT status, version FROM work_plans").all()).toEqual([
    { status: "approved", version: 1 },
  ]);
  expect(listUndelivered(h.env.db, "t1").filter((e) => e.kind !== "start")).toEqual([]);
});

test("owner rejects the plan -> no item runs, the goal stays open for a re-plan, the lead says so", async () => {
  const h = leadHarness(
    async (c) => {
      if (c.kind === "worker") throw new Error("no item may run");
      if (c.prompt.includes("<owner_message>\nbuild")) {
        const made = await c.orchestrate("create_plan", {
          objective: "build it",
          spec: "# Spec\nIt.",
          plan: "# Plan\nonly",
          items: [item("only")],
          acceptanceCriteria: [],
          envelope: {
            locations: ["location"],
            riskClasses: ["R1"],
            bounds: { maxItems: 2, maxGb: 1 },
          },
          effects: [],
        });
        expect(
          await c.orchestrate("approve_plan", { planId: made.planId, version: 1 }),
        ).toMatchObject({ ok: true, status: "rejected" });
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
    { status: "open" },
  ]);
});
