import { expect, test } from "bun:test";
import { leadHarness, until } from "./lead-harness";

/* Acceptance index (brainstorm 5.13 / 10). Most checks live in a focused test file; this file holds the two that needed an
   end-to-end run of their own.
   1 DIRECT without a plan ............ lead-flow.test.ts
   2 DELEGATE items in parallel ........ dispatch-parallel.test.ts
   3 PLAN, one approval ................ plan-strategy-flow.test.ts, todo-app-scenario.test.ts
   4 worker NEEDS_PLANNING -> Orchestrate create_plan  (below)
   5 dispatch to the lead refused  plan-audit-gaps.test.ts, dispatch-policy.test.ts
   6 cycle refused ..................... lead-flow.test.ts, dispatch-policy.test.ts
   7 role / location outside the envelope  validate-plan.test.ts, dispatch-policy.test.ts
   8 restart resume mid-plan ........... recover-in-flight.test.ts, lead-boot-wake.test.ts
   9 plan revision while running ....... plan-lifecycle.test.ts
   10 cancel propagation (running items)  (below) */

test("a worker that reports NEEDS_PLANNING wakes the lead, which writes a plan (create_plan) in the open goal", async () => {
  const asked: unknown[] = [];
  let goalId = "";
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      await c.report("result", {
        title: "T",
        status: "NEEDS_PLANNING",
        summary: "too big for one run",
      });
      return "needs a plan";
    }
    if (c.prompt.includes("<owner_message>\nrewrite everything")) {
      const made = await c.orchestrate("dispatch", {
        strategy: "DIRECT",
        small: true,
        intent: "rewrite",
        reason: "try one worker",
        assignments: [
          {
            key: "main",
            subject: "task",
            role: "developer",
            brief: "rewrite it",
            location: "location",
            dependsOn: [],
          },
        ],
      });
      goalId = made.goalId;
      return "On it.";
    }
    if (/blocked/i.test(c.prompt) && asked.length === 0) {
      asked.push(
        await c.orchestrate("create_plan", {
          goalId,
          objective: "rewrite everything",
          spec: "# Spec\nThe goal.",
          plan: "# Plan\nThe steps.",
          items: [
            {
              key: "part1",
              subject: "first part",
              role: "developer",
              brief: "rewrite the first part",
              location: "location",
              dependsOn: [],
              risk: "R1",
            },
          ],
          acceptanceCriteria: [],
          envelope: {
            locations: ["location"],
            riskClasses: ["R0", "R1"],
            bounds: { maxItems: 4, maxGb: 1 },
          },
          effects: [],
        }),
      );
      return "Planned.";
    }
    return "";
  });
  await h.send("rewrite everything");
  await until(() => asked.length === 1, 10000);
  expect(asked[0]).toMatchObject({ ok: true, status: "valid" });
});

test("Orchestrate cancel of a goal with two running items cancels both, aborts their runs and closes the goal", async () => {
  const aborted: string[] = [];
  let goalId = "";
  const running = new Set<string>();
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      const key = /do (\w+)/.exec(c.prompt)?.[1] as string;
      running.add(key);
      const signal: AbortSignal = c.options.abortController.signal;
      await new Promise<void>((r) =>
        signal.aborted ? r() : signal.addEventListener("abort", () => r()),
      );
      aborted.push(key);
      return "stopped";
    }
    if (c.prompt.includes("<owner_message>\ntwo things")) {
      const r = await c.orchestrate("dispatch", {
        strategy: "DELEGATE",
        small: true,
        intent: "work",
        reason: "test",
        assignments: [
          { key: "a", subject: "task", role: "scout", brief: "do a", dependsOn: [] },
          { key: "b", subject: "task", role: "scout", brief: "do b", dependsOn: [] },
        ],
      });
      goalId = r.goalId;
      return "On it.";
    }
    if (c.prompt.includes("<owner_message>\ncancel it")) {
      await c.orchestrate("cancel", { taskId: goalId, reason: "owner asked" });
      return "Cancelled.";
    }
    return "";
  });
  await h.send("two things");
  await until(() => running.size === 2);
  await h.send("cancel it");
  await until(() => h.posts.includes("Cancelled."));
  await until(() => aborted.length === 2);
  const rows = h.env.db
    .query("SELECT item_key AS k, status FROM owned_tasks WHERE parent_id IS NOT NULL")
    .all() as { k: string; status: string }[];
  expect(rows.every((r) => r.status === "cancelled")).toBe(true);
  expect(h.env.db.query("SELECT status FROM owned_tasks WHERE parent_id IS NULL").all()).toEqual([
    { status: "cancelled" },
  ]);
});
