import { expect, test } from "bun:test";
import { LEAD_OWNER_RUN_BUDGET_USD, LEAD_OWNER_RUN_MAX_TURNS } from "../src/config/lead-caps";
import { getRole } from "../src/roles/role-registry";
import { leadHarness, until } from "./lead-harness";

/* Lead limits per trigger: a run started by an owner message gets the owner-run turns and budget (it may write a spec,
   a plan and call create_plan + approve_plan); a run woken by worker events keeps the role's own figures. */

test("owner-message run: 60 turns / $5; announce run after a worker result: the role's 30 turns / $1.5", async () => {
  const seen: { trigger: "owner" | "announce"; maxTurns: number; maxBudgetUsd: number }[] = [];
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      await c.report("result", { title: "T", status: "COMPLETED", summary: "done" });
      return "worker done";
    }
    const owner = c.prompt.includes("<owner_message>");
    seen.push({
      trigger: owner ? "owner" : "announce",
      maxTurns: c.options.maxTurns,
      maxBudgetUsd: c.options.maxBudgetUsd,
    });
    if (owner) {
      await c.orchestrate("dispatch", {
        strategy: "DIRECT",
        small: true,
        intent: "one",
        reason: "r",
        assignments: [
          { key: "main", subject: "Main work", role: "scout", brief: "do main", dependsOn: [] },
        ],
      });
      return "Started.";
    }
    return "Done.";
  });
  await h.send("look at the repo");
  await until(() => seen.some((s) => s.trigger === "announce"), 15000);
  const lead = getRole("lead");
  expect(seen.find((s) => s.trigger === "owner")).toMatchObject({
    maxTurns: LEAD_OWNER_RUN_MAX_TURNS,
    maxBudgetUsd: LEAD_OWNER_RUN_BUDGET_USD,
  });
  expect(seen.find((s) => s.trigger === "announce")).toMatchObject({
    maxTurns: lead.limits.maxTurns,
    maxBudgetUsd: lead.budgetUsd,
  });
  expect([LEAD_OWNER_RUN_MAX_TURNS, LEAD_OWNER_RUN_BUDGET_USD]).toEqual([60, 5]);
}, 20000);
