import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { renderPlanFacts } from "../src/ingress/plan-copy";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { approveVersion, createPlan, rejectVersion } from "../src/orchestrator/plan/plan-lifecycle";
import { createPlanLookup } from "../src/orchestrator/turns/plan-live";
import { recordBotThread } from "../src/storage/thread-store";
import { makeEnv, TEST_CHANNEL } from "./helpers";
import { ENV, item, TH } from "./waves-fixture";

/* Phase 5 gap tests for `/plan`: thread scope, no viewer, rejected and re-planned versions, a long plan, language. */

const VIEWER = {
  port: 1,
  baseUrl: "https://v.example",
  secret: "s".repeat(32),
  linkTtlMs: 3_600_000,
};
const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 20, maxGb: 1 },
};

let db: Database;
afterEach(() => db?.close());

/** A goal of `threadId` (mapped to the test channel) with its plan `items` stored; approved when `approve`. */
function goalWithPlan(
  home: string,
  threadId: string,
  o: { objective?: string; items?: ReturnType<typeof item>[]; approve?: boolean } = {},
) {
  recordBotThread(db, threadId, TEST_CHANNEL, "main", threadId);
  const w = createPlanPort(db, threadId).requestPlan({ key: `k-${threadId}`, objective: "goal" });
  if (!w.ok) throw new Error("no goal");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: o.objective ?? `objective of ${threadId}`,
    items: o.items ?? [item(`${threadId}-own`)],
    acceptanceCriteria: ["works"],
    envelope: ENVELOPE,
    budgetUsd: 3,
    effects: [],
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  if (o.approve) approveVersion(db, r.plan.id, 1);
  return { goalId: w.goalId, planId: r.plan.id, home };
}

test("/plan shows the plan of its own thread only, not a newer plan of another thread", () => {
  const env = makeEnv();
  db = env.db;
  goalWithPlan(env.home, TH, { approve: true });
  goalWithPlan(env.home, "t2", { items: [item("other")], approve: true });
  const lookup = createPlanLookup({ db, home: env.home, viewer: VIEWER });
  const mine = renderPlanFacts(lookup(TH, false), "en");
  expect(mine).toContain('- t-own "Do t-own": ready');
  expect(mine).not.toContain("other");
  const theirs = renderPlanFacts(lookup("t2", false), "en");
  expect(theirs).toContain('- other "Do other": ready');
  expect(theirs).not.toContain("t-own");
  expect(renderPlanFacts(lookup("t3", true), "en")).toBe("This thread has no plan yet.");
});

test("/plan with the viewer off: the current version and items, no link line", () => {
  const env = makeEnv();
  db = env.db;
  goalWithPlan(env.home, TH, { approve: true });
  const text = renderPlanFacts(createPlanLookup({ db, home: env.home })(TH, false), "en");
  expect(text).toBe(`Plan v1 (approved)\nGoal: objective of t\n- t-own "Do t-own": ready`);
  expect(renderPlanFacts(createPlanLookup({ db, home: env.home })(TH, true), "en")).not.toContain(
    "Open the plan",
  );
});

test("/plan of a goal with no plan: none; a goal with a plan is found through its thread", () => {
  const env = makeEnv();
  db = env.db;
  recordBotThread(db, TH, TEST_CHANNEL, "main", "x");
  createPlanPort(db, TH).requestPlan({ key: "k0", objective: "no plan yet" });
  const lookup = createPlanLookup({ db, home: env.home, viewer: VIEWER });
  expect(lookup(TH, false)).toEqual({ kind: "none" });
  expect(lookup(TH, true)).toEqual({ kind: "none" });
});

test("/plan after a rejection: the rejected version is shown with its reason; history lists it before the re-plan", () => {
  const env = makeEnv();
  db = env.db;
  const g = goalWithPlan(env.home, TH);
  rejectVersion(db, g.planId, 1, "too broad");
  createPlan(db, {
    goalId: g.goalId,
    objective: "smaller",
    items: [item("n1")],
    acceptanceCriteria: ["works"],
    envelope: ENVELOPE,
    budgetUsd: 3,
    effects: [],
    env: ENV,
  });
  const lookup = createPlanLookup({ db, home: env.home, viewer: VIEWER });
  const cur = renderPlanFacts(lookup(TH, false), "en");
  expect(cur.split("\n")[0]).toBe("Plan v2 (valid)");
  const hist = renderPlanFacts(lookup(TH, true), "en").split("\n");
  expect(hist[2]).toMatch(/^- v1 rejected, \d{4}-\d\d-\d\d \d\d:\d\d: too broad$/);
  expect(hist[3]).toMatch(/^- v2 valid, /);
});

test("/plan of a version rejected with no re-plan shows the rejected status", () => {
  const env = makeEnv();
  db = env.db;
  const g = goalWithPlan(env.home, TH);
  rejectVersion(db, g.planId, 1, "no");
  const text = renderPlanFacts(createPlanLookup({ db, home: env.home })(TH, false), "en");
  expect(text.split("\n")[0]).toBe("Plan v1 (rejected)");
});

test("/plan with 20 items of max-length keys keeps the link line (the reply is cut at CHUNK_MAX)", () => {
  const env = makeEnv();
  db = env.db;
  const items = Array.from({ length: 20 }, (_, n) =>
    // A key of the max length (32 chars, KEY schema) and a subject clipped to 60 chars.
    item(`step-${String(n + 1).padStart(2, "0")}-${"z".repeat(20)}`, { subject: "s".repeat(120) }),
  );
  goalWithPlan(env.home, TH, { items, approve: true });
  const text = renderPlanFacts(
    createPlanLookup({ db, home: env.home, viewer: VIEWER })(TH, false),
    "en",
  );
  // BUG (expected to fail): the 20 item lines plus the signed link exceed CHUNK_MAX (1900) and the slice drops the link.
  expect(text.length).toBeLessThanOrEqual(1900);
  expect(text).toContain("Open the plan: https://v.example/a/");
});

test("/plan text is worded in the chosen language (vi / en) and keeps the link in both", () => {
  const f = {
    kind: "current" as const,
    version: 1,
    status: "approved",
    items: [{ key: "a", subject: "Do a", status: "running" }],
    url: "https://v.example/a/x",
  };
  expect(renderPlanFacts(f, "vi").split("\n")).toEqual([
    "Kế hoạch v1 (approved)",
    '- a "Do a": running',
    "Mở kế hoạch: https://v.example/a/x",
  ]);
  expect(renderPlanFacts(f, "en").split("\n")).toEqual([
    "Plan v1 (approved)",
    '- a "Do a": running',
    "Open the plan: https://v.example/a/x",
  ]);
});

test("/plan of a valid (not approved) version shows its version status for every item, not a live one", () => {
  const env = makeEnv();
  db = env.db;
  goalWithPlan(env.home, TH, { items: [item("p")] });
  const text = renderPlanFacts(createPlanLookup({ db, home: env.home })(TH, false), "en");
  expect(text.split("\n")[0]).toBe("Plan v1 (valid)");
  expect(text).toContain('- p "Do p": valid');
});
