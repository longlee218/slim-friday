import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { writeArtifact } from "../src/artifacts/artifact-writer";
import { renderPlanFacts } from "../src/ingress/plan-copy";
import { pinThreadLanguage } from "../src/ingress/user-copy";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { syncPlanArtifacts } from "../src/orchestrator/plan/plan-artifact";
import { approveVersion, createPlan, rejectVersion } from "../src/orchestrator/plan/plan-lifecycle";
import { diffVersions, isNoop, type RevisionDiff } from "../src/orchestrator/plan/plan-revised";
import { createPlanLookup } from "../src/orchestrator/turns/plan-live";
import { digestFacts } from "../src/orchestrator/worker/digest-facts";
import { createSlashHandler } from "../src/providers/discord/ingress/slash-interaction";
import { listByGoal } from "../src/storage/artifact-store";
import { recordBotThread } from "../src/storage/thread-store";
import { makeEnv, TEST_CHANNEL } from "./helpers";
import { createPlanHandlerFor, plannerCtxOf } from "./plan-visibility-helpers";
import { ENV, item, TH } from "./waves-fixture";

/* Phase 5 fix round: own-artifact rule, lost file, /plan goal choice, failure and language, in-force digest version, real `from`. */

const VIEWER = {
  port: 1,
  baseUrl: "https://v.example",
  secret: "s".repeat(32),
  linkTtlMs: 3_600_000,
};
const ENVELOPE = {
  locations: ["repo"],
  riskClasses: ["R0", "R1"],
  bounds: { maxItems: 8, maxGb: 1 },
};

let db: Database;
afterEach(() => db?.close());

/** A goal of TH with a stored plan v1 (approved when asked). */
function world(o: { key?: string; objective?: string; approve?: boolean } = {}) {
  const env = makeEnv();
  db = env.db;
  recordBotThread(db, TH, TEST_CHANNEL, "main", "x");
  const w = goal(o.key ?? "k1", o.objective ?? "build it", o.approve);
  return { env, ...w, deps: { db, home: env.home, viewer: VIEWER } };
}

function goal(key: string, objective: string, approve = false) {
  const w = createPlanPort(db, TH).requestPlan({ key, objective });
  if (!w.ok) throw new Error("no goal");
  const r = createPlan(db, {
    goalId: w.goalId,
    objective,
    items: [item("a")],
    acceptanceCriteria: ["works"],
    envelope: ENVELOPE,
    effects: [],
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  if (approve) approveVersion(db, r.plan.id, 1);
  return { goalId: w.goalId, planId: r.plan.id };
}

test("M4: a worker-made artifact titled like a plan is neither reused nor rewritten", () => {
  const { goalId, deps, env } = world({ approve: true });
  const mine = writeArtifact(db, env.home, {
    workspace: "main",
    channel: "main",
    goalId,
    threadId: TH,
    title: `Plan ${goalId.slice(0, 8)} v1`,
    kind: "md",
    body: "worker text",
    producerRole: "developer",
  });
  const infos = syncPlanArtifacts(deps, TH, goalId);
  expect(infos[0]?.artifactId).not.toBe(mine.id);
  expect(readFileSync(mine.path, "utf8")).toBe("worker text");
  expect(listByGoal(db, goalId)).toHaveLength(2);
});

test("L1: a lost artifact file is recreated, the link never points at the dead id", () => {
  const { goalId, deps } = world({ approve: true });
  const first = syncPlanArtifacts(deps, TH, goalId)[0]!;
  const old = listByGoal(db, goalId)[0]!;
  require("node:fs").rmSync(old.path);
  const again = syncPlanArtifacts(deps, TH, goalId)[0]!;
  expect(again.artifactId).not.toBeNull();
  expect(again.artifactId).not.toBe(first.artifactId);
  expect(existsSync(listByGoal(db, goalId).find((a) => a.id === again.artifactId)!.path)).toBe(
    true,
  );
});

test("M3: /plan shows the open goal's plan over a newer plan of a closed goal, and labels the goal", () => {
  const { deps, goalId } = world({ objective: "open goal work", approve: true });
  const closed = goal("k2", "closed goal work", true);
  db.query("UPDATE owned_tasks SET status = 'completed' WHERE id = ?").run(closed.goalId);
  const text = renderPlanFacts(createPlanLookup(deps)(TH, false), "en");
  expect(text.split("\n")[1]).toBe("Goal: open goal work");
  expect(goalId).not.toBe(closed.goalId);
  // No open goal: the newest plan of the thread.
  db.query("UPDATE owned_tasks SET status = 'completed' WHERE id = ?").run(goalId);
  const after = renderPlanFacts(createPlanLookup(deps)(TH, true), "en");
  expect(after).toContain("Goal: closed goal work");
});

test("an expired plan version shows its status in the artifact and in /plan history", () => {
  const { goalId, planId, deps } = world();
  rejectVersion(db, planId, 1, "expired");
  syncPlanArtifacts(deps, TH, goalId);
  const text = readFileSync(listByGoal(db, goalId)[0]!.path, "utf8");
  expect(text).toContain("Status: rejected");
  expect(text).toContain("expired");
  const hist = renderPlanFacts(createPlanLookup(deps)(TH, true), "en");
  expect(hist).toMatch(/- v1 rejected, \d{4}-\d\d-\d\d \d\d:\d\d: expired/);
});

test("the digest shows the version in force while a newer one awaits approval", () => {
  const { goalId, planId } = world({ approve: true });
  const r = createPlanHandlerFor(plannerCtxOf({ db }, goalId), planId, {
    add: [item("z")],
    grow: true,
  });
  expect(r).toMatchObject({ ok: true, version: 2, status: "valid" });
  expect(digestFacts(db, goalId, "build it", 1).planVersion).toBe(1);
});

test("M6: a re-plan names the real prior version; a reorder or a no-field-change posts nothing", () => {
  const { goalId, planId } = world();
  rejectVersion(db, planId, 1, "no");
  const diffs: RevisionDiff[] = [];
  const app = plannerCtxOf({ db }, goalId, { notify: (d) => diffs.push(d) });
  expect(createPlanHandlerFor(app, planId, { replan: [item("n")] })).toMatchObject({ version: 2 });
  rejectVersion(db, planId, 2, "no");
  expect(createPlanHandlerFor(app, planId, { replan: [item("m")] })).toMatchObject({ version: 3 });
  expect(diffs.map((d) => [d.from, d.version])).toEqual([
    [1, 2],
    [2, 3],
  ]);
  const doc = { items: [item("a"), item("b")], acceptanceCriteria: ["w"] } as never;
  const flipped = { items: [item("b"), item("a")], acceptanceCriteria: ["w"] } as never;
  const d = diffVersions(doc, flipped, { from: 1, version: 2, reason: "r" });
  expect(isNoop(d)).toBe(true);
});

/** A fake `/plan` interaction. */
function fakePlan(channelId = TH) {
  const replies: any[] = [];
  const i: any = {
    id: "I1",
    commandName: "plan",
    user: { id: "111", bot: false },
    channelId,
    channel: undefined,
    isChatInputCommand: () => true,
    options: { get: () => null },
    reply: async (o: any) => void replies.push(o),
  };
  return { i, replies };
}

test("M1: a failing /plan lookup is a private failure notice, not a thrown error", async () => {
  const handle = createSlashHandler({
    ownerId: "111",
    onMessage: async () => {},
    plan: () => {
      throw new Error("boom");
    },
  });
  const f = fakePlan();
  await handle(f.i);
  expect(f.replies).toHaveLength(1);
  expect(f.replies[0].flags).toBe(64);
});

test("/plan answers in the thread's pinned language when one is known", async () => {
  const handle = createSlashHandler({
    ownerId: "111",
    onMessage: async () => {},
    plan: () => ({ kind: "none" }),
  });
  pinThreadLanguage("t-pinned", "en");
  const f = fakePlan("t-pinned");
  await handle(f.i);
  expect(f.replies[0].content).toBe("This thread has no plan yet.");
});
