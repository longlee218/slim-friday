import { expect, test } from "bun:test";
import { leadHarness, until } from "./lead-harness";

/* End to end with a fake query: a 45-item goal over 3 waves. The owner approves the plan ONCE; wave 2 and 3 apply at
   once (envelope unchanged); the verify item runs ONCE, after the last wave. A plan version holds 20 items, deferred
   ones included, so each wave names its next scope as deferred items and the full version drops its completed items. */

const GOAL = /Goal id: ([0-9a-f-]{36})/;
const PLAN_ID = /"planId":"([0-9a-f-]{36})"/;
const item = (key: string, extra: object = {}) => ({
  key,
  subject: `Do ${key}`,
  role: "developer",
  brief: `do ${key}`,
  location: "location",
  dependsOn: [] as string[],
  risk: "R1",
  ...extra,
});
const wave = (n: number, count: number) =>
  Array.from({ length: count }, (_, i) => item(`w${n}-${i}`));
const later = (n: number, count: number) =>
  Array.from({ length: count }, (_, i) => item(`later${n}-${i}`, { deferredScope: true }));
const ENVELOPE = {
  locations: ["location"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 20, maxGb: 1 },
};

test("45 items over 3 waves: one owner approval, waves start by code, ONE verify at the end", async () => {
  const questions: string[] = [];
  const order: string[] = [];
  let approved = false;
  const h = leadHarness(
    async (c) => {
      if (c.kind === "planner") {
        const goalId = GOAL.exec(c.prompt)?.[1] as string;
        const ctx = await c.plan("context", { goalId });
        if (!c.prompt.includes("Wave ")) {
          // Wave 1: 15 items now, 5 deferred placeholders for the rest (a version holds 20).
          const made = await c.plan("create", {
            goalId,
            items: [...wave(1, 15), ...later(2, 5)],
            acceptanceCriteria: ["everything works"],
            envelope: ENVELOPE,
            budgetUsd: 20,
            effects: [],
          });
          expect(made).toMatchObject({ ok: true, status: "valid" });
          await c.report("result", {
            title: "T",
            status: "COMPLETED",
            summary: `plan ${made.planId} v1`,
          });
          return "planned";
        }
        // A wave planner: reads the deferred scope, proposes ONE revision inside the approved envelope.
        const n = Number(/Wave (\d)/.exec(c.prompt)?.[1]);
        expect(ctx.deferredItems.length).toBe(5);
        const keys = ctx.deferredItems.map((d: { key: string }) => d.key);
        // Wave 2 activates its deferred items in place (modify); wave 3 swaps them for new ones (cancel + add).
        const r = await c.plan("revise", {
          planId: ctx.plan.planId,
          baseVersion: ctx.plan.version,
          cancel: n === 2 ? [] : keys,
          modify: n === 2 ? keys.map((key: string) => ({ key, deferredScope: false })) : [],
          add: n === 2 ? [...wave(n, 10), ...later(n + 1, 5)] : wave(n, 15),
          reason: `wave ${n}`,
        });
        expect(r).toMatchObject({ ok: true, status: "approved" }); // no owner question
        await c.report("result", {
          title: "T",
          status: "COMPLETED",
          summary: `wave ${n} planned`,
        });
        return "wave planned";
      }
      if (c.kind === "worker") {
        order.push(/^do ([\w-]+)/m.exec(c.prompt)?.[1] ?? "verify");
        await c.report("result", { title: "T", status: "COMPLETED", summary: "done" });
        return "worker done";
      }
      if (c.prompt.includes("Owner message:")) {
        await c.orchestrate("request_plan", { objective: "build the big thing" });
        return "Planning.";
      }
      const plan = PLAN_ID.exec(c.prompt)?.[1];
      if (plan && !approved) {
        approved = true;
        expect(await c.orchestrate("approve_plan", { planId: plan, version: 1 })).toMatchObject({
          ok: true,
        });
        return "Plan approved.";
      }
      return "";
    },
    undefined,
    {
      askChoice: async (a) => {
        questions.push(a.question);
        return "Approve plan";
      },
    },
  );
  await h.send("build the big thing");
  const goalStatus = () =>
    (
      h.env.db.query("SELECT status FROM owned_tasks WHERE parent_id IS NULL").get() as {
        status: string;
      } | null
    )?.status;
  await until(() => goalStatus() === "completed", 60000);
  expect(questions).toHaveLength(1); // the owner approved ONCE (wave 1)
  const rows = h.env.db
    .query(
      "SELECT item_key AS k, status FROM owned_tasks WHERE parent_id IS NOT NULL ORDER BY rowid",
    )
    .all() as { k: string; status: string }[];
  const done = rows.filter((r) => r.status === "completed");
  expect(done).toHaveLength(rows.length); // nothing failed or was cancelled
  expect(rows.filter((r) => !/^(planner|verify)/.test(r.k))).toHaveLength(45);
  expect(rows.filter((r) => r.k.startsWith("planner")).map((r) => r.k)).toEqual([
    "planner",
    "planner-2",
    "planner-3",
  ]);
  expect(rows.filter((r) => r.k.startsWith("verify")).map((r) => r.k)).toEqual(["verify-1"]); // ONE verify
  expect(order.at(-1)).toBe("verify"); // after every wave item
  expect(order.filter((k) => k === "verify")).toHaveLength(1);
  expect(h.ofKind("planner")).toHaveLength(3);
  // Plan versions: v1 (wave 1), v2 (wave 2), v3 (wave 3); one approved at the end, the others superseded.
  expect(h.env.db.query("SELECT version, status FROM work_plans ORDER BY version").all()).toEqual([
    { version: 1, status: "superseded" },
    { version: 2, status: "superseded" },
    { version: 3, status: "approved" },
  ]);
}, 70000);
