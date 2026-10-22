import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHAIN_CAP } from "../src/config/lead-caps";
import { SONNET_MODEL } from "../src/config/model-ids";
import { CREATE_PULL_REQUEST_TOOL } from "../src/mcp/effects/tools/CreatePullRequestTool/constants";
import { GIT_PUSH_TOOL } from "../src/mcp/effects/tools/GitPushTool/constants";
import { buildServers } from "../src/mcp/mcp-servers";
import { mcpToolName, ORCHESTRATION_MCP_SERVER, PLAN_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { ORCHESTRATE_TOOL } from "../src/mcp/orchestration/tools/OrchestrateTool/constants";
import { PLAN_TOOL } from "../src/mcp/plan/tools/PlanTool/constants";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { handleApprovePlan, handleRequestPlan } from "../src/orchestrator/lead/lead-plan-handlers";
import { renderPlan } from "../src/orchestrator/plan/plan-render";
import type { DeliveryEffect } from "../src/orchestrator/plan/plan-types";
import type { PlannerCtx } from "../src/orchestrator/plan/planner-handlers";
import { checkPlanRequest } from "../src/orchestrator/strategy/plan-policy";
import { checkToolCall, guardFor } from "../src/policy/check-tool-call";
import { ROLES } from "../src/roles/role-registry";
import { buildRoleSkills } from "../src/runtime/skills-plugin/role-skills";
import { openDb } from "../src/storage/db";
import { appendEvent } from "../src/storage/thread-event-store";
import { makeEnv } from "./helpers";
import { FakePort } from "./lead-fake-port";
import { PLAN_TOOLS } from "./mcp-ctx-fixture";

/* The planner's seven tools through the real MCP server (the handlers the SDK would call), the lead's two plan tools
   over the fake port, the plan policy and the planner role's skills. */

let db: Database;
afterEach(() => db?.close());
const item = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  subject: `Do ${key}`,
  role: "developer",
  brief: `do ${key}`,
  dependsOn: [],
  risk: "R1",
  ...over,
});
const PLAN = (goalId: string, over: Record<string, unknown> = {}) => ({
  goalId,
  items: [item("a"), item("b", { dependsOn: ["a"] })],
  acceptanceCriteria: ["works"],
  envelope: {
    locations: ["location"],
    riskClasses: ["R0", "R1"],
    bounds: { maxItems: 8, maxGb: 1 },
  },
  budgetUsd: 3,
  effects: [],
  ...over,
});

/** A goal + planner item, the planner server over it, and a caller of its tools (parsed JSON replies). */
function setup() {
  db = openDb(":memory:");
  const w = createPlanPort(db, "th1").requestPlan({
    key: "k1",
    objective: "build it",
    findings: "see x",
  });
  if (!w.ok) throw new Error("no goal");
  const ctx: PlannerCtx = {
    db,
    threadId: "th1",
    goalId: w.goalId,
    workers: [ROLES.developer!, ROLES.scout!],
    locations: [{ name: "location", path: "/tmp/loc" }],
    channelDigest: () => "03-01 earlier thread",
  };
  const server = buildServers(ROLES.planner!, { plan: ctx })[PLAN_MCP_SERVER] as unknown as {
    instance: {
      _registeredTools: Record<string, { handler: (a: object, e: object) => Promise<any> }>;
    };
  };
  /** Call an action of the `Plan` tool; returns the parsed JSON reply. */
  const call = async (action: string, params: object) =>
    JSON.parse(
      (await server.instance._registeredTools[PLAN_TOOL]!.handler({ action, params }, {}))
        .content[0].text,
    );
  return { goalId: w.goalId, call, ctx, server };
}

test("the plan server exposes exactly the Plan action tool", () => {
  const { server } = setup();
  expect(Object.keys(server.instance._registeredTools).sort()).toEqual([...PLAN_TOOLS].sort());
});

test("Plan context + capabilities: request, locations, digest, roles; another goal is refused", async () => {
  const { goalId, call } = setup();
  const c = await call("context", { goalId });
  expect(c).toMatchObject({
    ok: true,
    locations: [{ name: "location" }],
    channelDigest: "03-01 earlier thread",
  });
  expect(c.request).toContain("build it");
  expect(c.request).toContain("see x");
  expect(await call("context", { goalId: "other" })).toMatchObject({
    ok: false,
    code: "BAD_TASK",
  });
  const caps = await call("capabilities", {});
  expect(caps.roles.map((r: { name: string }) => r.name)).toEqual(["developer", "scout"]);
  expect(caps.roles[0]).toHaveProperty("whenToUse");
  // Code computes the plan budget from the role ceilings: the planner does not see them.
  for (const r of caps.roles) expect(r).not.toHaveProperty("budgetUsd");
});

test("Plan create -> valid; coded errors; validate; the planner cannot name itself or the lead", async () => {
  const { goalId, call } = setup();
  const bad = await call("create", PLAN(goalId, { items: [item("a", { role: "planner" })] }));
  expect(bad).toMatchObject({ ok: false, code: "INVALID" });
  expect(bad.message).toContain("UNKNOWN_ROLE");
  const cyc = await call(
    "create",
    PLAN(goalId, { items: [item("a", { dependsOn: ["b"] }), item("b", { dependsOn: ["a"] })] }),
  );
  expect(cyc.message).toContain("CYCLE");
  const ok = await call("create", PLAN(goalId));
  expect(ok).toMatchObject({ ok: true, version: 1, status: "valid" });
  expect(await call("validate", { planId: ok.planId, version: 1 })).toEqual({
    ok: true,
    valid: true,
    errors: [],
  });
  expect(await call("create", PLAN(goalId))).toMatchObject({ ok: false, code: "PLAN_EXISTS" });
  expect(await call("validate", { planId: "nope", version: 1 })).toMatchObject({
    code: "NO_PLAN",
  });
});

test("Plan revise: new version; stale baseVersion refused; list reads the goal and the cause of a failed item", async () => {
  const { goalId, call } = setup();
  const { planId } = await call("create", PLAN(goalId));
  const rev = await call("revise", {
    planId,
    baseVersion: 1,
    add: [item("c")],
    cancel: [],
    modify: [],
    reason: "more",
  });
  expect(rev).toMatchObject({ ok: true, version: 2, status: "valid" });
  const stale = await call("revise", {
    planId,
    baseVersion: 1,
    add: [],
    cancel: [],
    modify: [],
    reason: "x",
  });
  expect(stale).toMatchObject({ ok: false, code: "STALE_VERSION" });
  const prog = await call("list", { goalId });
  expect(prog.items.map((i: { key: string }) => i.key)).toEqual(["planner"]);
  expect(prog.items[0]).not.toHaveProperty("cause"); // not blocked, failed or waiting: no cause
  db.query("UPDATE owned_tasks SET status = 'failed' WHERE item_key = 'planner'").run();
  const failed = await call("list", { goalId });
  expect(failed.items).toMatchObject([{ key: "planner", status: "failed" }]);
  // The cause of a failed item is the last failure-like event on it.
  const planner = db.query("SELECT id FROM owned_tasks WHERE item_key = 'planner'").get() as {
    id: string;
  };
  appendEvent(db, {
    id: "e1",
    threadId: "th1",
    itemId: planner.id,
    kind: "failure",
    payload: "boom",
  });
  const withCause = await call("list", { goalId });
  expect(withCause.items[0].cause.kind).toBe("failure");
  expect(withCause.items[0].cause.detail).toContain("boom");
});

/** Lead context over the fake port. */
const lead = (port: FakePort, dispatched = 0) => ({
  port,
  threadId: "t",
  leadTurnId: "lt",
  inputId: "in1",
  run: { dispatched },
});

test("Orchestrate request_plan: starts the planner; one per run; open goal needs goalId; bad goal refused", async () => {
  const port = new FakePort();
  const ctx = lead(port);
  const r = await handleRequestPlan(ctx, { objective: "big thing" });
  expect(r).toMatchObject({ ok: true, goalId: "goal-p" });
  expect(port.planRequests).toHaveLength(1);
  expect(await handleRequestPlan(ctx, { objective: "again" })).toMatchObject({
    code: "ONE_PER_RUN",
  });
  port.goalState = { openGoalId: "g9", items: [] };
  expect(await handleRequestPlan(lead(port), { objective: "x" })).toMatchObject({
    code: "GOAL_OPEN",
  });
  expect(await handleRequestPlan(lead(port), { objective: "x", goalId: "zzz" })).toMatchObject({
    code: "BAD_TASK",
  });
  expect(await handleRequestPlan(lead(port), { objective: "x", goalId: "g9" })).toMatchObject({
    ok: true,
    goalId: "g9",
  });
});

test("Orchestrate request_plan: chain cap refuses before any write", () => {
  const caps = { chainCount: CHAIN_CAP, dispatchedThisRun: 0 };
  expect(checkPlanRequest({ items: [] }, {}, caps)).toMatchObject({ code: "CHAIN_CAP" });
});

/** A plan view for the fake port. */
function view(status = "valid") {
  const doc = {
    items: [
      {
        key: "a",
        subject: "task",
        role: "developer",
        brief: "do a",
        dependsOn: [],
        risk: "R1" as const,
      },
    ],
    acceptanceCriteria: ["works"],
    envelope: {
      roles: ["developer"],
      locations: ["location"],
      riskClasses: ["R1" as const],
      bounds: { maxItems: 8, maxGb: 1 },
      budgetUsd: 3,
      effects: [GIT_PUSH_TOOL, CREATE_PULL_REQUEST_TOOL] as DeliveryEffect[],
    },
  };
  return { planId: "p1", version: 1, status, goalId: "g1", objective: "build it", doc };
}

test("Orchestrate approve_plan: one question with the whole plan; yes approves, no rejects, timeout / unclear change nothing", async () => {
  const port = new FakePort();
  port.plans.set("p1:1", view());
  port.answer = { answer: "Approve plan", timedOut: false };
  expect(await handleApprovePlan(lead(port), { planId: "p1", version: 1 })).toMatchObject({
    ok: true,
    status: "approved",
    items: ["a", "b"],
  });
  expect(port.asked).toHaveLength(1);
  expect(port.asked[0]!.question).toContain("Plan v1: build it");
  expect(port.asked[0]!.question).toContain("delivery: GitPush, CreatePullRequest");
  expect(port.asked[0]!.options).toEqual(["Approve plan", "Reject plan"]);
  port.answer = { answer: "Reject plan", timedOut: false };
  expect(
    await handleApprovePlan({ ...lead(port), inputId: "in2" }, { planId: "p1", version: 1 }),
  ).toMatchObject({ ok: true, status: "rejected" });
  port.answer = { timedOut: true };
  expect(
    await handleApprovePlan({ ...lead(port), inputId: "in3" }, { planId: "p1", version: 1 }),
  ).toMatchObject({ code: "TIMEOUT" });
  port.answer = { answer: "maybe", timedOut: false };
  expect(
    await handleApprovePlan({ ...lead(port), inputId: "in4" }, { planId: "p1", version: 1 }),
  ).toMatchObject({ code: "UNCLEAR" });
  expect(port.decisions.map((d) => d.approve)).toEqual([true, false]); // timeout and unclear decided nothing
});

test("Orchestrate approve_plan refuses a plan that is not valid or unknown, without asking the owner", async () => {
  const port = new FakePort();
  port.plans.set("p1:1", view("approved"));
  expect(await handleApprovePlan(lead(port), { planId: "p1", version: 1 })).toMatchObject({
    code: "PLAN_NOT_VALID",
  });
  expect(await handleApprovePlan(lead(port), { planId: "p2", version: 1 })).toMatchObject({
    code: "NO_PLAN",
  });
  expect(port.asked).toHaveLength(0);
});

test("renderPlan lists steps with dependencies, criteria and the limits", () => {
  const v = view();
  const text = renderPlan({
    version: 2,
    objective: v.objective,
    doc: {
      ...v.doc,
      items: [
        ...v.doc.items,
        {
          key: "b",
          subject: "task",
          role: "developer",
          brief: "x".repeat(500),
          dependsOn: ["a"],
          risk: "R1",
        },
      ],
    },
  });
  expect(text).toContain('1. a "task" [developer, risk R1]: do a');
  expect(text).toContain('2. b "task" [developer, risk R1] after a:');
  expect(text).toContain("Done when:");
  expect(text).toContain("budget $3");
  // The brief is carried in full (the worker receives it whole); the card stem is renderPlanStem.
  expect(text.split("\n").find((l) => l.startsWith("2. b"))).toContain("x".repeat(500));
  expect(text).not.toContain("Full briefs are in the attachment");
});

test("the planner role loads only the app's plan-work skill (no publisher skill)", () => {
  const env = makeEnv();
  const r = buildRoleSkills(ROLES.planner!, "main", env.home);
  try {
    expect(r.skills.map((n) => n.split(":").at(-1))).toEqual(["plan-work"]);
    expect(r.dirs.some((d) => existsSync(join(d, "skills", "plan-work", "SKILL.md")))).toBe(true);
  } finally {
    r.cleanup();
  }
});

test("planner tools are allowed for the planner only; the planner holds no lead tool, no write tool and is not dispatchable", () => {
  const scope = { readPaths: ["/r"] };
  const allowed = (role: string, tool: string) =>
    checkToolCall(tool, {}, guardFor(ROLES[role]!, scope)).decision === "allow";
  for (const name of Object.keys(ROLES)) {
    for (const t of PLAN_TOOLS)
      expect([name, allowed(name, mcpToolName(PLAN_MCP_SERVER, t))]).toEqual([
        name,
        name === "planner",
      ]);
  }
  expect(allowed("planner", mcpToolName(ORCHESTRATION_MCP_SERVER, ORCHESTRATE_TOOL))).toBe(false);
  expect(ROLES.planner!.dispatchable).toBeFalsy();
  expect(ROLES.planner!.sideEffects).toBe("none");
  expect(ROLES.planner!.capabilities).not.toContain("write");
  expect(ROLES.planner!.model).toBe(SONNET_MODEL);
});
